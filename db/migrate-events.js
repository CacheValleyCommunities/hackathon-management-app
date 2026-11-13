// One-time migration from a single global hackathon to isolated events.
// Existing rows are attached to the earliest event_settings record.

const runSql = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const allSql = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

const getSql = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const columnExists = async (db, table, column) => {
  const columns = await allSql(db, `PRAGMA table_info(${table})`);
  return columns.some((col) => col.name === column);
};

const addColumn = async (db, table, column, definition) => {
  if (await columnExists(db, table, column)) return;
  try {
    await runSql(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
};

const slugify = (value) => {
  const base = String(value || 'event')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'event';
};

const hasEventNameUnique = async (db, table) => {
  const indexes = await allSql(db, `PRAGMA index_list(${table})`);
  for (const index of indexes) {
    if (!index.unique) continue;
    const info = await allSql(db, `PRAGMA index_info(${index.name})`);
    const names = info.map((col) => col.name);
    if (names.includes('event_id') && names.includes('name')) return true;
  }
  return false;
};

const ensureDefaultEvent = async (db) => {
  await addColumn(db, 'event_settings', 'slug', 'TEXT');
  await addColumn(db, 'event_settings', 'status', "TEXT DEFAULT 'open'");
  await addColumn(db, 'event_settings', 'current_round', 'INTEGER DEFAULT 1');
  await addColumn(db, 'event_settings', 'locked_rounds', "TEXT DEFAULT '[]'");
  await addColumn(db, 'event_settings', 'hero_banner_image', 'TEXT');
  await addColumn(db, 'event_settings', 'hero_banner_link', 'TEXT');
  await addColumn(db, 'event_settings', 'landing_page_content', 'TEXT');
  await addColumn(db, 'event_settings', 'event_dates_text', 'TEXT');
  await addColumn(db, 'event_settings', 'judging_locked', 'INTEGER DEFAULT 0');
  await addColumn(db, 'event_settings', 'max_score', 'REAL DEFAULT 100');
  await addColumn(db, 'event_settings', 'judging_seconds', 'INTEGER DEFAULT 180');
  await addColumn(db, 'event_settings', 'winners', "TEXT DEFAULT '{}'");

  let event = await getSql(db, 'SELECT * FROM event_settings ORDER BY id ASC LIMIT 1');
  if (!event) {
    const slug = 'hackathon';
    await runSql(
      db,
      `INSERT INTO event_settings (event_name, divisions, current_round, locked_rounds, slug, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['Hackathon', '[]', 1, '[]', slug, 'open']
    );
    event = await getSql(db, 'SELECT * FROM event_settings ORDER BY id ASC LIMIT 1');
  }

  const events = await allSql(db, 'SELECT id, event_name, slug FROM event_settings ORDER BY id ASC');
  const used = new Set();
  for (const row of events) {
    let slug = row.slug && String(row.slug).trim() ? slugify(row.slug) : slugify(row.event_name);
    const original = slug;
    let n = 2;
    while (used.has(slug)) {
      slug = `${original}-${n}`;
      n += 1;
    }
    used.add(slug);
    if (slug !== row.slug) {
      await runSql(db, 'UPDATE event_settings SET slug = ? WHERE id = ?', [slug, row.id]);
    }
    await runSql(
      db,
      `UPDATE event_settings SET status = COALESCE(NULLIF(status, ''), 'open') WHERE id = ?`,
      [row.id]
    );
  }

  return event.id;
};

const rebuildScopedTables = async (db, eventId) => {
  await runSql(db, 'PRAGMA foreign_keys = OFF');

  await runSql(db, 'DROP TABLE IF EXISTS tables_new');
  await runSql(
    db,
    `CREATE TABLE tables_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, name),
      FOREIGN KEY (event_id) REFERENCES event_settings(id)
    )`
  );
  await runSql(
    db,
    `INSERT INTO tables_new (id, event_id, name, updated_at)
     SELECT id, ?, name, updated_at FROM tables`,
    [eventId]
  );
  await runSql(
    db,
    `INSERT OR IGNORE INTO tables_new (event_id, name)
     SELECT ?, table_name FROM teams WHERE table_name IS NOT NULL AND trim(table_name) != ''`,
    [eventId]
  );
  await runSql(db, 'DROP TABLE tables');
  await runSql(db, 'ALTER TABLE tables_new RENAME TO tables');

  await runSql(db, 'DROP TABLE IF EXISTS categories_new');
  await runSql(
    db,
    `CREATE TABLE categories_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, name),
      FOREIGN KEY (event_id) REFERENCES event_settings(id)
    )`
  );
  await runSql(
    db,
    `INSERT INTO categories_new (id, event_id, name, updated_at)
     SELECT id, ?, name, updated_at FROM categories`,
    [eventId]
  );
  await runSql(db, 'DROP TABLE categories');
  await runSql(db, 'ALTER TABLE categories_new RENAME TO categories');

  const teamColumns = [
    ['division', 'TEXT'],
    ['category_id', 'INTEGER'],
    ['is_published', 'INTEGER DEFAULT 0'],
    ['team_members', 'TEXT'],
    ['website_link', 'TEXT'],
    ['readme_content', 'TEXT'],
    ['screenshots', 'TEXT'],
    ['banner_image', 'TEXT'],
    ['logo_image', 'TEXT'],
    ['team_leader_email', 'TEXT']
  ];
  for (const [name, definition] of teamColumns) {
    await addColumn(db, 'teams', name, definition);
  }

  await runSql(db, 'DROP TABLE IF EXISTS teams_new');
  await runSql(
    db,
    `CREATE TABLE teams_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      contact_email TEXT,
      github_link TEXT,
      division TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      category_id INTEGER,
      is_published INTEGER DEFAULT 0,
      team_members TEXT,
      website_link TEXT,
      readme_content TEXT,
      screenshots TEXT,
      banner_image TEXT,
      logo_image TEXT,
      team_leader_email TEXT,
      owner_user_id INTEGER,
      registration_type TEXT DEFAULT 'individual',
      UNIQUE(event_id, name),
      FOREIGN KEY (event_id) REFERENCES event_settings(id),
      FOREIGN KEY (event_id, table_name) REFERENCES tables(event_id, name)
    )`
  );
  await runSql(
    db,
    `INSERT INTO teams_new (
      id, event_id, name, table_name, project_name, contact_email, github_link, division,
      created_at, updated_at, category_id, is_published, team_members, website_link,
      readme_content, screenshots, banner_image, logo_image, team_leader_email,
      owner_user_id, registration_type
    )
    SELECT
      t.id, ?, t.name, t.table_name, t.project_name, t.contact_email, t.github_link, t.division,
      t.created_at, t.updated_at, t.category_id, COALESCE(t.is_published, 0), t.team_members, t.website_link,
      t.readme_content, t.screenshots, t.banner_image, t.logo_image, t.team_leader_email,
      (SELECT u.id FROM users u WHERE u.team_id = t.id LIMIT 1),
      'individual'
    FROM teams t`,
    [eventId]
  );
  await runSql(db, 'DROP TABLE teams');
  await runSql(db, 'ALTER TABLE teams_new RENAME TO teams');

  await runSql(db, 'DROP TABLE IF EXISTS scores_new');
  await runSql(
    db,
    `CREATE TABLE scores_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      judge_email TEXT NOT NULL,
      team_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      round INTEGER NOT NULL,
      score REAL NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, judge_email, team_name, round),
      FOREIGN KEY (event_id) REFERENCES event_settings(id)
    )`
  );
  await runSql(
    db,
    `INSERT INTO scores_new (
      id, event_id, judge_email, team_name, table_name, round, score, notes, created_at, updated_at
    )
    SELECT id, ?, judge_email, team_name, table_name, round, score, notes, created_at, updated_at
    FROM scores`,
    [eventId]
  );
  await runSql(db, 'DROP TABLE scores');
  await runSql(db, 'ALTER TABLE scores_new RENAME TO scores');

  await addColumn(db, 'judge_team_assignments', 'locked_at', 'DATETIME');
  await runSql(db, 'DROP TABLE IF EXISTS assignments_new');
  await runSql(
    db,
    `CREATE TABLE assignments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      judge_email TEXT NOT NULL,
      team_name TEXT NOT NULL,
      round INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed BOOLEAN DEFAULT 0,
      locked_at DATETIME,
      UNIQUE(event_id, judge_email, team_name, round),
      FOREIGN KEY (event_id) REFERENCES event_settings(id)
    )`
  );
  await runSql(
    db,
    `INSERT INTO assignments_new (
      id, event_id, judge_email, team_name, round, assigned_at, completed, locked_at
    )
    SELECT id, ?, judge_email, team_name, round, assigned_at, completed, locked_at
    FROM judge_team_assignments`,
    [eventId]
  );
  await runSql(db, 'DROP TABLE judge_team_assignments');
  await runSql(db, 'ALTER TABLE assignments_new RENAME TO judge_team_assignments');

  const tieExists = await getSql(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='tie_breaks'`);
  if (tieExists) {
    await runSql(db, 'DROP TABLE IF EXISTS tie_breaks_new');
    await runSql(
      db,
      `CREATE TABLE tie_breaks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        division TEXT NOT NULL,
        team_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        UNIQUE(event_id, division, team_name, round),
        FOREIGN KEY (event_id) REFERENCES event_settings(id)
      )`
    );
    await runSql(
      db,
      `INSERT INTO tie_breaks_new (id, event_id, division, team_name, round, sort_order)
       SELECT id, ?, division, team_name, round, sort_order FROM tie_breaks`,
      [eventId]
    );
    await runSql(db, 'DROP TABLE tie_breaks');
    await runSql(db, 'ALTER TABLE tie_breaks_new RENAME TO tie_breaks');
  }

  await runSql(db, 'PRAGMA foreign_keys = ON');
};

const ensureIndexes = async (db) => {
  const statements = [
    'CREATE INDEX IF NOT EXISTS idx_scores_judge ON scores(event_id, judge_email)',
    'CREATE INDEX IF NOT EXISTS idx_scores_team ON scores(event_id, team_name, round)',
    'CREATE INDEX IF NOT EXISTS idx_scores_table ON scores(event_id, table_name, round)',
    'CREATE INDEX IF NOT EXISTS idx_score_criteria_score ON score_criteria(score_id)',
    'CREATE INDEX IF NOT EXISTS idx_teams_table ON teams(event_id, table_name)',
    'CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(event_id, owner_user_id)',
    'CREATE INDEX IF NOT EXISTS idx_memberships_user ON event_memberships(user_id, event_id)',
    'CREATE INDEX IF NOT EXISTS idx_tie_breaks_lookup ON tie_breaks(event_id, division, round)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON event_settings(slug)'
  ];
  for (const sql of statements) {
    try {
      await runSql(db, sql);
    } catch (err) {
      console.error('Index migration warning:', err.message);
    }
  }
};

const migrateEvents = async (db) => {
  await runSql(
    db,
    `CREATE TABLE IF NOT EXISTS event_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, event_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (event_id) REFERENCES event_settings(id) ON DELETE CASCADE
    )`
  );

  await addColumn(db, 'users', 'account_type', "TEXT DEFAULT 'individual'");
  await addColumn(db, 'users', 'school_name', 'TEXT');
  await runSql(
    db,
    `UPDATE users SET account_type = 'individual' WHERE account_type IS NULL OR account_type = ''`
  );

  const eventId = await ensureDefaultEvent(db);

  if (!(await hasEventNameUnique(db, 'teams'))) {
    await rebuildScopedTables(db, eventId);
  } else {
    await addColumn(db, 'teams', 'owner_user_id', 'INTEGER');
    await addColumn(db, 'teams', 'registration_type', "TEXT DEFAULT 'individual'");
    await runSql(
      db,
      `UPDATE teams SET registration_type = 'individual'
       WHERE registration_type IS NULL OR registration_type = ''`
    );
  }

  await addColumn(db, 'volunteers', 'event_id', 'INTEGER');
  await runSql(db, 'UPDATE volunteers SET event_id = ? WHERE event_id IS NULL', [eventId]);

  await addColumn(db, 'newsletter_sends', 'event_id', 'INTEGER');
  await runSql(db, 'UPDATE newsletter_sends SET event_id = ? WHERE event_id IS NULL', [eventId]);

  await runSql(
    db,
    `INSERT OR IGNORE INTO event_memberships (user_id, event_id, role)
     SELECT id, ?, role FROM users WHERE role IN ('judge', 'participant')`,
    [eventId]
  );
  await runSql(db, `UPDATE users SET role = 'user' WHERE role IN ('judge', 'participant')`);

  await runSql(
    db,
    `UPDATE teams
     SET owner_user_id = (SELECT u.id FROM users u WHERE u.team_id = teams.id LIMIT 1)
     WHERE owner_user_id IS NULL`
  );

  await runSql(
    db,
    `CREATE TABLE IF NOT EXISTS score_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      score_id INTEGER NOT NULL,
      criterion TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value >= 1 AND value <= 5),
      UNIQUE(score_id, criterion)
    )`
  );

  await ensureIndexes(db);
  return eventId;
};

module.exports = {
  migrateEvents,
  slugify
};
