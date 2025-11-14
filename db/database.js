const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'judging.db');

let db = null;

const init = () => {
  return new Promise((resolve, reject) => {
    // Ensure the db directory exists
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
      } catch (mkdirErr) {
        console.error('Error creating db directory:', mkdirErr);
        // Continue anyway, might already exist or have permission issues
      }
    }

    // Open database with explicit mode for creation
    db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) {
        console.error('Error opening database:', err);
        console.error('Database path:', DB_PATH);
        console.error('Directory exists:', fs.existsSync(dbDir));
        try {
          fs.accessSync(dbDir, fs.constants.W_OK);
          console.error('Directory is writable: true');
        } catch (accessErr) {
          console.error('Directory is writable: false', accessErr.message);
        }
        reject(err);
        return;
      }
      console.log('Connected to SQLite database at:', DB_PATH);
      // Enable foreign key constraints
      db.run('PRAGMA foreign_keys = ON', (err) => {
        if (err) {
          console.error('Error enabling foreign keys:', err);
        }
        createTables().then(resolve).catch(reject);
      });
    });
  });
};

const createTables = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Users table
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        role TEXT DEFAULT 'judge',
        team_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      )`, (err) => {
        if (err) {
          console.error('Error creating users table:', err);
          reject(err);
          return;
        }
        // Add policy acceptance and user preference columns (migration)
        // All required policy columns that must be present
        const requiredPolicyColumns = [
          { name: 'privacy_policy_accepted', def: 'INTEGER DEFAULT 0' },
          { name: 'terms_accepted', def: 'INTEGER DEFAULT 0' },
          { name: 'acceptable_use_accepted', def: 'INTEGER DEFAULT 0' },
          { name: 'policies_accepted_at', def: 'DATETIME' },
          { name: 'guardian_email', def: 'TEXT' },
          { name: 'email_preferences', def: 'INTEGER DEFAULT 0' },
          { name: 'is_under_18', def: 'INTEGER DEFAULT 0' }
        ];

        // Check all columns at once and add missing ones sequentially
        db.all(`PRAGMA table_info(users)`, [], (err, columns) => {
          if (err) {
            console.error(`Error checking users columns: ${err.message}`);
            return;
          }
          const existingColumns = columns.map(col => col.name);
          const columnsToAdd = requiredPolicyColumns.filter(col => !existingColumns.includes(col.name));

          if (columnsToAdd.length === 0) {
            // All columns already exist
            return;
          }

          console.log(`Adding ${columnsToAdd.length} missing policy columns to users table...`);

          // Add columns sequentially to ensure they complete
          let index = 0;
          const addNextColumn = () => {
            if (index >= columnsToAdd.length) {
              // Verify all columns were added
              db.all(`PRAGMA table_info(users)`, [], (verifyErr, verifyColumns) => {
                if (!verifyErr) {
                  const verifyExisting = verifyColumns.map(col => col.name);
                  const stillMissing = requiredPolicyColumns.filter(col => !verifyExisting.includes(col.name));
                  if (stillMissing.length > 0) {
                    console.error(`Warning: Some policy columns could not be added: ${stillMissing.map(c => c.name).join(', ')}`);
                  } else {
                    console.log('✓ All policy columns verified in users table');
                  }
                }
              });
              return; // All columns processed
            }
            const col = columnsToAdd[index];
            index++;

            db.run(`ALTER TABLE users ADD COLUMN ${col.name} ${col.def}`, (err) => {
              if (err) {
                if (err.message.includes('duplicate column')) {
                  // Column was added by another process, continue
                } else {
                  console.error(`Error adding column ${col.name}: ${err.message}`);
                }
              } else {
                console.log(`  ✓ Added column: ${col.name}`);
              }
              addNextColumn(); // Process next column
            });
          };

          addNextColumn(); // Start adding columns
        });
      });

      // Magic link tokens table
      db.run(`CREATE TABLE IF NOT EXISTS magic_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Error creating magic_tokens table:', err);
          reject(err);
          return;
        }
      });

      // Tables table (stores table names)
      db.run(`CREATE TABLE IF NOT EXISTS tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Error creating tables table:', err);
          reject(err);
          return;
        }
      });

      // Categories table (stores category names)
      db.run(`CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Error creating categories table:', err);
          reject(err);
          return;
        }
      });

      // Teams table (stores team registrations)
      db.run(`CREATE TABLE IF NOT EXISTS teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        table_name TEXT NOT NULL,
        project_name TEXT NOT NULL,
        contact_email TEXT,
        github_link TEXT,
        division TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (table_name) REFERENCES tables(name)
      )`, (err) => {
        if (err) {
          console.error('Error creating teams table:', err);
          reject(err);
          return;
        }
        // Add columns if they don't exist (migration)
        db.all(`PRAGMA table_info(teams)`, [], (err, columns) => {
          if (err) {
            console.error(`Error checking teams columns: ${err.message}`);
            return;
          }
          const existingColumns = columns.map(col => col.name);
          const columnsToAdd = [
            { name: 'division', def: 'TEXT' },
            { name: 'category_id', def: 'INTEGER' },
            { name: 'is_published', def: 'INTEGER DEFAULT 0' },
            { name: 'team_members', def: 'TEXT' },
            { name: 'website_link', def: 'TEXT' },
            { name: 'readme_content', def: 'TEXT' },
            { name: 'screenshots', def: 'TEXT' },
            { name: 'banner_image', def: 'TEXT' },
            { name: 'logo_image', def: 'TEXT' },
            { name: 'team_leader_email', def: 'TEXT' }
          ];

          columnsToAdd.forEach(col => {
            if (!existingColumns.includes(col.name)) {
              db.run(`ALTER TABLE teams ADD COLUMN ${col.name} ${col.def}`, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                  console.error(`Error adding column ${col.name}: ${err.message}`);
                }
              });
            }
          });
        });
      });

      // Team screenshots table (for better organization)
      db.run(`CREATE TABLE IF NOT EXISTS team_screenshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_filename TEXT,
        file_size INTEGER,
        display_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
      )`, (err) => {
        if (err) {
          console.error('Error creating team_screenshots table:', err);
        }
      });

      // Volunteers table
      db.run(`CREATE TABLE IF NOT EXISTS volunteers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        help_judging INTEGER DEFAULT 0,
        help_logistics INTEGER DEFAULT 0,
        help_mentor INTEGER DEFAULT 0,
        description TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME,
        reviewed_by TEXT,
        admin_notes TEXT,
        user_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`, (err) => {
        if (err) {
          console.error('Error creating volunteers table:', err);
        }
        // Add description column if it doesn't exist (migration)
        db.run(`ALTER TABLE volunteers ADD COLUMN description TEXT`, () => { });
        // Add admin_notes and user_id columns if they don't exist (migration)
        db.run(`ALTER TABLE volunteers ADD COLUMN admin_notes TEXT`, () => { });
        db.run(`ALTER TABLE volunteers ADD COLUMN user_id INTEGER`, () => { });
      });

      // Scores table (stores scores locally for editing)
      db.run(`CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        judge_email TEXT NOT NULL,
        team_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        score REAL NOT NULL,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(judge_email, team_name, round)
      )`, (err) => {
        if (err) {
          console.error('Error creating scores table:', err);
          reject(err);
          return;
        }
      });

      // Judge team assignments (tracks which judges have judged which teams)
      db.run(`CREATE TABLE IF NOT EXISTS judge_team_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        judge_email TEXT NOT NULL,
        team_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed BOOLEAN DEFAULT 0,
        UNIQUE(judge_email, team_name, round)
      )`, (err) => {
        if (err) {
          console.error('Error creating judge_team_assignments table:', err);
        }
      });

      // Event settings table
      db.run(`CREATE TABLE IF NOT EXISTS event_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT DEFAULT 'Hackathon',
        start_date TEXT,
        end_date TEXT,
        divisions TEXT,
        logo_filename TEXT,
        current_round INTEGER DEFAULT 1,
        locked_rounds TEXT DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) {
          console.error('Error creating event_settings table:', err);
          reject(err);
          return;
        }
        // Add new columns if they don't exist (migration)
        db.run(`ALTER TABLE event_settings ADD COLUMN current_round INTEGER DEFAULT 1`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN locked_rounds TEXT DEFAULT '[]'`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN hero_banner_image TEXT`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN hero_banner_link TEXT`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN landing_page_content TEXT`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN event_dates_text TEXT`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN judging_locked INTEGER DEFAULT 0`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN winners TEXT DEFAULT '{}'`, () => { });

        // Newsletter sends table (tracks newsletter sends to prevent duplicates)
        db.run(`CREATE TABLE IF NOT EXISTS newsletter_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        send_hash TEXT UNIQUE NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        recipients TEXT NOT NULL,
        recipient_count INTEGER NOT NULL,
        sent_count INTEGER NOT NULL,
        failed_count INTEGER NOT NULL,
        sent_by TEXT NOT NULL,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
          if (err) {
            console.error('Error creating newsletter_sends table:', err);
          }
        });

        // Initialize default settings if table is empty
        db.get('SELECT COUNT(*) as count FROM event_settings', [], (err, row) => {
          if (!err && row.count === 0) {
            db.run('INSERT INTO event_settings (event_name, divisions, current_round, locked_rounds) VALUES (?, ?, ?, ?)',
              ['Hackathon', '[]', 1, '[]'], () => { });
          }
        });
      });

      // Create indexes
      db.run(`CREATE INDEX IF NOT EXISTS idx_scores_judge ON scores(judge_email)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_scores_team ON scores(team_name, round)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_scores_table ON scores(table_name, round)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_teams_table ON teams(table_name)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_tokens_email ON magic_tokens(email, expires_at, used)`, () => {
        console.log('Database tables initialized');
        // Wait a bit for column migrations to complete, then initialize default admin
        // This ensures all ALTER TABLE statements have finished
        setTimeout(() => {
          initializeDefaultAdmin().then(() => {
            console.log('Database initialization complete');
            resolve();
          }).catch((err) => {
            console.error('Error during initialization:', err);
            resolve(); // Don't fail initialization if setup fails
          });
        }, 100); // Small delay to ensure migrations complete
      });
    });
  });
};

// Initialize default admin from .env (only once)
const initializeDefaultAdmin = async () => {
  const defaultAdminEmail = process.env.DEFAULT_ADMIN_EMAIL;

  if (!defaultAdminEmail) {
    return; // No default admin configured
  }

  const email = defaultAdminEmail.toLowerCase().trim();

  try {
    // Check if user already exists
    const existingUser = await getUserByEmail(email);

    // Policy data for admin - all policies accepted by default
    const policyData = {
      privacy_policy_accepted: true,
      terms_accepted: true,
      acceptable_use_accepted: true,
      policies_accepted_at: new Date().toISOString(),
      is_under_18: false,
      email_preferences: false
    };

    if (existingUser) {
      // Update existing user to admin if not already admin, and ensure policies are accepted
      const updates = { role: 'admin', ...policyData };
      await updateUser(email, updates);
      console.log(`Updated user ${email} to admin role with policies accepted`);
    } else {
      // Create new admin user with policies accepted
      await createUser(email, null, 'admin', null, policyData);
      console.log(`Created default admin user: ${email} with policies accepted`);
    }
  } catch (error) {
    console.error('Error initializing default admin:', error);
    throw error;
  }
};

const getDb = () => {
  if (!db) {
    throw new Error('Database not initialized. Call init() first.');
  }
  return db;
};

// User operations
const getUserByEmail = (email) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const createUser = (email, name = null, role = 'judge', teamId = null, policyData = {}) => {
  return new Promise((resolve, reject) => {
    const fields = ['email', 'name', 'role', 'team_id'];
    const values = [email, name, role, teamId];

    // Add policy acceptance fields if provided
    if (policyData.privacy_policy_accepted !== undefined) {
      fields.push('privacy_policy_accepted');
      values.push(policyData.privacy_policy_accepted ? 1 : 0);
    }
    if (policyData.terms_accepted !== undefined) {
      fields.push('terms_accepted');
      values.push(policyData.terms_accepted ? 1 : 0);
    }
    if (policyData.acceptable_use_accepted !== undefined) {
      fields.push('acceptable_use_accepted');
      values.push(policyData.acceptable_use_accepted ? 1 : 0);
    }
    if (policyData.policies_accepted_at) {
      fields.push('policies_accepted_at');
      values.push(policyData.policies_accepted_at);
    }
    if (policyData.guardian_email !== undefined) {
      fields.push('guardian_email');
      values.push(policyData.guardian_email || null);
    }
    if (policyData.email_preferences !== undefined) {
      fields.push('email_preferences');
      values.push(policyData.email_preferences ? 1 : 0);
    }
    if (policyData.is_under_18 !== undefined) {
      fields.push('is_under_18');
      values.push(policyData.is_under_18 ? 1 : 0);
    }

    const placeholders = fields.map(() => '?').join(', ');
    db.run(`INSERT INTO users (${fields.join(', ')}) VALUES (${placeholders})`,
      values,
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, email, name, role, team_id: teamId, ...policyData });
      }
    );
  });
};

const updateUser = (email, updates) => {
  return new Promise((resolve, reject) => {
    const fields = [];
    const values = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.role !== undefined) {
      fields.push('role = ?');
      values.push(updates.role);
    }
    if (updates.team_id !== undefined) {
      fields.push('team_id = ?');
      values.push(updates.team_id);
    }
    if (updates.privacy_policy_accepted !== undefined) {
      fields.push('privacy_policy_accepted = ?');
      values.push(updates.privacy_policy_accepted ? 1 : 0);
    }
    if (updates.terms_accepted !== undefined) {
      fields.push('terms_accepted = ?');
      values.push(updates.terms_accepted ? 1 : 0);
    }
    if (updates.acceptable_use_accepted !== undefined) {
      fields.push('acceptable_use_accepted = ?');
      values.push(updates.acceptable_use_accepted ? 1 : 0);
    }
    if (updates.policies_accepted_at !== undefined) {
      fields.push('policies_accepted_at = ?');
      values.push(updates.policies_accepted_at);
    }
    if (updates.guardian_email !== undefined) {
      fields.push('guardian_email = ?');
      values.push(updates.guardian_email || null);
    }
    if (updates.email_preferences !== undefined) {
      fields.push('email_preferences = ?');
      values.push(updates.email_preferences ? 1 : 0);
    }
    if (updates.is_under_18 !== undefined) {
      fields.push('is_under_18 = ?');
      values.push(updates.is_under_18 ? 1 : 0);
    }

    if (fields.length === 0) {
      return resolve();
    }

    values.push(email);

    db.run(`UPDATE users SET ${fields.join(', ')} WHERE email = ?`, values, function (err) {
      if (err) reject(err);
      else resolve({ email, ...updates });
    });
  });
};

const getUserRole = (email) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT role, team_id FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(row ? { role: row.role, team_id: row.team_id } : { role: 'judge', team_id: null });
    });
  });
};

const isAdmin = (email) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT role FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.role === 'admin' : false);
    });
  });
};

const getUserWithTeam = (email) => {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT u.*, t.name as team_name, t.table_name, t.project_name, t.contact_email, t.github_link
      FROM users u
      LEFT JOIN teams t ON u.team_id = t.id
      WHERE u.email = ?
    `, [email], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const getOrCreateUser = async (email, name = null) => {
  let user = await getUserByEmail(email);
  if (!user) {
    user = await createUser(email, name);
  }
  return user;
};

// Magic token operations
const createMagicToken = (email) => {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    db.run(
      'INSERT INTO magic_tokens (email, token, expires_at) VALUES (?, ?, ?)',
      [email, token, expiresAt.toISOString()],
      function (err) {
        if (err) reject(err);
        else resolve({ token, expiresAt });
      }
    );
  });
};

const validateMagicToken = (token) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM magic_tokens WHERE token = ? AND expires_at > datetime("now") AND used = 0',
      [token],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
};

const markTokenAsUsed = (token) => {
  return new Promise((resolve, reject) => {
    db.run('UPDATE magic_tokens SET used = 1 WHERE token = ?', [token], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

// Table operations
const syncTables = (tables) => {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO tables (name, updated_at) VALUES (?, datetime("now"))');

    tables.forEach(table => {
      stmt.run(table.name);
    });

    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

// Initialize chess board-style tables (A1-A10 through P1-P10)
const initializeChessBoardTables = () => {
  return new Promise((resolve, reject) => {
    const tables = [];
    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

    rows.forEach(row => {
      for (let col = 1; col <= 10; col++) {
        tables.push({ name: `${row}${col}` });
      }
    });

    syncTables(tables).then(resolve).catch(reject);
  });
};

const getTables = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tables ORDER BY name', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const getTableNames = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT name FROM tables ORDER BY name', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.name));
    });
  });
};

// Category operations
const syncCategories = (categories) => {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO categories (name, updated_at) VALUES (?, datetime("now"))');

    categories.forEach(category => {
      stmt.run(category.name);
    });

    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

const getCategories = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM categories ORDER BY name', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const getCategoryNames = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT name FROM categories ORDER BY name', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.name));
    });
  });
};

const getCategoryById = (id) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM categories WHERE id = ?', [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const getCategoryByName = (name) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM categories WHERE name = ?', [name], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Team operations
const createTeam = (teamData) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO teams (name, table_name, project_name, contact_email, github_link, division, category_id, is_published, team_members, website_link, readme_content, banner_image, logo_image, team_leader_email, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
      [
        teamData.name,
        teamData.table_name,
        teamData.project_name,
        teamData.contact_email || null,
        teamData.github_link || null,
        teamData.division || null,
        teamData.category_id || null,
        teamData.is_published !== undefined ? (teamData.is_published ? 1 : 0) : 0,
        teamData.team_members ? JSON.stringify(teamData.team_members) : null,
        teamData.website_link || null,
        teamData.readme_content || null,
        teamData.banner_image || null,
        teamData.logo_image || null,
        teamData.team_leader_email || null
      ],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, name: teamData.name, table_name: teamData.table_name, project_name: teamData.project_name, contact_email: teamData.contact_email, github_link: teamData.github_link, division: teamData.division || null, category_id: teamData.category_id || null, is_published: teamData.is_published || false });
      }
    );
  });
};

const syncTeams = (teams) => {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO teams (name, table_name, description, updated_at) VALUES (?, ?, ?, datetime("now"))');

    teams.forEach(team => {
      if (team.table_name) {
        stmt.run(team.name, team.table_name, team.description || '');
      }
    });

    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

const getTeams = (tableName = null, includeSensitive = false) => {
  return new Promise((resolve, reject) => {
    // Exclude team_leader_email unless explicitly requested (admin only)
    const sensitiveFields = includeSensitive ? ', t.team_leader_email' : '';
    let query = `SELECT t.id, t.name, t.table_name, t.project_name, t.contact_email, 
                        t.github_link, t.website_link, t.division, t.category_id, 
                        c.name as category_name, t.is_published, t.team_members, 
                        t.readme_content, t.banner_image, t.logo_image, t.screenshots, 
                        t.created_at, t.updated_at${sensitiveFields}
                 FROM teams t
                 LEFT JOIN categories c ON t.category_id = c.id`;
    const params = [];

    if (tableName) {
      query += ' WHERE t.table_name = ?';
      params.push(tableName);
    }

    query += ' ORDER BY t.table_name, t.name';

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      // Parse JSON fields for each team
      rows.forEach(row => {
        if (row.team_members) {
          try {
            row.team_members = JSON.parse(row.team_members);
          } catch (e) {
            row.team_members = [];
          }
        } else {
          row.team_members = [];
        }
        if (row.screenshots) {
          try {
            row.screenshots = JSON.parse(row.screenshots);
          } catch (e) {
            row.screenshots = [];
          }
        } else {
          row.screenshots = [];
        }
        // Convert is_published to boolean
        row.is_published = row.is_published === 1;
      });
      resolve(rows);
    });
  });
};

const getTeamTable = (teamName) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT table_name FROM teams WHERE name = ?', [teamName], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.table_name : null);
    });
  });
};

// Check if a user is the team leader (for authorization only, doesn't expose team_leader_email)
const isTeamLeader = (teamId, userEmail) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT contact_email, team_leader_email FROM teams WHERE id = ?',
      [teamId],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        if (!row) {
          resolve(false);
          return;
        }
        const email = userEmail.toLowerCase();
        const isLeader =
          (row.contact_email && row.contact_email.toLowerCase() === email) ||
          (row.team_leader_email && row.team_leader_email.toLowerCase() === email);
        resolve(isLeader);
      }
    );
  });
};

const getTeamById = (id, includeSensitive = false) => {
  return new Promise((resolve, reject) => {
    // Exclude team_leader_email unless explicitly requested (admin only)
    const sensitiveFields = includeSensitive ? ', t.team_leader_email' : '';
    const query = `SELECT t.id, t.name, t.table_name, t.project_name, t.contact_email, 
                          t.github_link, t.website_link, t.division, t.category_id,
                          c.name as category_name, t.is_published, t.team_members, 
                          t.readme_content, t.banner_image, t.logo_image, t.screenshots, 
                          t.created_at, t.updated_at${sensitiveFields}
                   FROM teams t
                   LEFT JOIN categories c ON t.category_id = c.id
                   WHERE t.id = ?`;
    db.get(query, [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (row) {
        // Parse JSON fields
        if (row.team_members) {
          try {
            row.team_members = JSON.parse(row.team_members);
          } catch (e) {
            row.team_members = [];
          }
        } else {
          row.team_members = [];
        }
        if (row.screenshots) {
          try {
            row.screenshots = JSON.parse(row.screenshots);
          } catch (e) {
            row.screenshots = [];
          }
        } else {
          row.screenshots = [];
        }
        // Convert is_published to boolean
        row.is_published = row.is_published === 1;
      }
      resolve(row);
    });
  });
};

const updateTeam = (id, teamData) => {
  return new Promise((resolve, reject) => {
    // Build dynamic update query to only update provided fields
    const updates = [];
    const values = [];

    if (teamData.name !== undefined) { updates.push('name = ?'); values.push(teamData.name); }
    if (teamData.table_name !== undefined) { updates.push('table_name = ?'); values.push(teamData.table_name); }
    if (teamData.project_name !== undefined) { updates.push('project_name = ?'); values.push(teamData.project_name); }
    if (teamData.contact_email !== undefined) { updates.push('contact_email = ?'); values.push(teamData.contact_email || null); }
    if (teamData.github_link !== undefined) { updates.push('github_link = ?'); values.push(teamData.github_link || null); }
    if (teamData.division !== undefined) { updates.push('division = ?'); values.push(teamData.division || null); }
    if (teamData.category_id !== undefined) { updates.push('category_id = ?'); values.push(teamData.category_id || null); }
    if (teamData.is_published !== undefined) { updates.push('is_published = ?'); values.push(teamData.is_published ? 1 : 0); }
    if (teamData.team_members !== undefined) { updates.push('team_members = ?'); values.push(teamData.team_members ? JSON.stringify(teamData.team_members) : null); }
    if (teamData.website_link !== undefined) { updates.push('website_link = ?'); values.push(teamData.website_link || null); }
    if (teamData.readme_content !== undefined) { updates.push('readme_content = ?'); values.push(teamData.readme_content || null); }
    if (teamData.banner_image !== undefined) { updates.push('banner_image = ?'); values.push(teamData.banner_image || null); }
    if (teamData.logo_image !== undefined) { updates.push('logo_image = ?'); values.push(teamData.logo_image || null); }
    if (teamData.team_leader_email !== undefined) { updates.push('team_leader_email = ?'); values.push(teamData.team_leader_email || null); }

    updates.push('updated_at = datetime("now")');
    values.push(id);

    const query = `UPDATE teams SET ${updates.join(', ')} WHERE id = ?`;

    db.run(query, values, (err) => {
      if (err) reject(err);
      else resolve({ id, ...teamData });
    });
  });
};

const deleteTeam = (id) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM teams WHERE id = ?', [id], function (err) {
      if (err) reject(err);
      else resolve({ deleted: this.changes > 0 });
    });
  });
};

const getAllUsers = () => {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT u.*, t.name as team_name
      FROM users u
      LEFT JOIN teams t ON u.team_id = t.id
      ORDER BY u.created_at DESC
    `, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Score operations
const getScore = (judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM scores WHERE judge_email = ? AND team_name = ? AND round = ?',
      [judgeEmail, teamName, round],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
};

const saveScore = (judgeEmail, teamName, tableName, round, score, notes = null) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO scores (judge_email, team_name, table_name, round, score, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime("now"))
       ON CONFLICT(judge_email, team_name, round) 
       DO UPDATE SET score = ?, notes = ?, table_name = ?, updated_at = datetime("now")`,
      [judgeEmail, teamName, tableName, round, score, notes, score, notes, tableName],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID });
      }
    );
  });
};

const getJudgeScores = (judgeEmail, round = null, tableName = null) => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT s.*, t.division
      FROM scores s
      LEFT JOIN teams t ON s.team_name = t.name
      WHERE s.judge_email = ?
    `;
    const params = [judgeEmail];

    if (round) {
      query += ' AND s.round = ?';
      params.push(round);
    }

    if (tableName) {
      query += ' AND s.table_name = ?';
      params.push(tableName);
    }

    query += ' ORDER BY s.round DESC, s.team_name';

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Results/Leaderboard operations - Cumulative scoring across rounds
const getTableResults = (round, tableName = null) => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT 
        s.team_name,
        s.table_name,
        t.division,
        SUM(s.score) as total_score,
        COUNT(DISTINCT s.judge_email) as judge_count,
        COUNT(DISTINCT s.round) as rounds_completed
      FROM scores s
      LEFT JOIN teams t ON s.team_name = t.name
      WHERE s.round <= ?
    `;
    const params = [round];

    if (tableName) {
      query += ' AND s.table_name = ?';
      params.push(tableName);
    }

    query += `
      GROUP BY s.team_name, s.table_name, t.division
      ORDER BY t.division, total_score DESC
    `;

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else {
        // Group by division only and calculate rankings within each division
        const resultsByDivision = {};
        rows.forEach(row => {
          const division = row.division || 'Unassigned';
          if (!resultsByDivision[division]) {
            resultsByDivision[division] = [];
          }
          resultsByDivision[division].push(row);
        });

        // Add rankings within each division (1st, 2nd, 3rd, etc.)
        Object.keys(resultsByDivision).forEach(division => {
          resultsByDivision[division].forEach((team, index) => {
            if (index === 0) team.rank = 1;
            else if (index === 1) team.rank = 2;
            else if (index === 2) team.rank = 3;
            else team.rank = index + 1;
          });
        });

        resolve(resultsByDivision);
      }
    });
  });
};

// Event settings operations
const getEventSettings = () => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM event_settings ORDER BY id DESC LIMIT 1', [], (err, row) => {
      if (err) reject(err);
      else {
        if (!row) {
          // Return default settings if none exist
          resolve({
            event_name: 'Hackathon',
            start_date: null,
            end_date: null,
            divisions: '[]',
            logo_filename: null
          });
        } else {
          // Parse divisions JSON string
          let divisions = [];
          try {
            divisions = row.divisions ? JSON.parse(row.divisions) : [];
          } catch (e) {
            divisions = [];
          }
          // Parse winners JSON string
          let winners = {};
          try {
            winners = row.winners ? JSON.parse(row.winners) : {};
          } catch (e) {
            winners = {};
          }
          resolve({
            ...row,
            divisions,
            judging_locked: row.judging_locked === 1,
            winners
          });
        }
      }
    });
  });
};

const updateEventSettings = (settings) => {
  return new Promise((resolve, reject) => {
    const divisionsJson = Array.isArray(settings.divisions)
      ? JSON.stringify(settings.divisions)
      : (settings.divisions || '[]');

    db.run(
      `UPDATE event_settings 
       SET event_name = ?, start_date = ?, end_date = ?, divisions = ?, logo_filename = ?, 
           hero_banner_image = ?, hero_banner_link = ?, landing_page_content = ?, event_dates_text = ?,
           updated_at = datetime("now")
       WHERE id = (SELECT id FROM event_settings ORDER BY id DESC LIMIT 1)`,
      [
        settings.event_name || 'Hackathon',
        settings.start_date || null,
        settings.end_date || null,
        divisionsJson,
        settings.logo_filename || null,
        settings.hero_banner_image || null,
        settings.hero_banner_link || null,
        settings.landing_page_content || null,
        settings.event_dates_text || null
      ],
      function (err) {
        if (err) {
          reject(err);
          return;
        }

        // If no rows were updated, insert instead
        if (this.changes === 0) {
          db.run(
            `INSERT INTO event_settings (event_name, start_date, end_date, divisions, logo_filename, 
                                        hero_banner_image, hero_banner_link, landing_page_content, event_dates_text, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
            [
              settings.event_name || 'Hackathon',
              settings.start_date || null,
              settings.end_date || null,
              divisionsJson,
              settings.logo_filename || null,
              settings.hero_banner_image || null,
              settings.hero_banner_link || null,
              settings.landing_page_content || null,
              settings.event_dates_text || null
            ],
            function (insertErr) {
              if (insertErr) reject(insertErr);
              else resolve({ id: this.lastID, ...settings, divisions: Array.isArray(settings.divisions) ? settings.divisions : JSON.parse(divisionsJson) });
            }
          );
        } else {
          resolve({ ...settings, divisions: Array.isArray(settings.divisions) ? settings.divisions : JSON.parse(divisionsJson) });
        }
      }
    );
  });
};

const incrementRound = () => {
  return new Promise(async (resolve, reject) => {
    try {
      // Get current settings
      const settings = await getEventSettings();
      const currentRound = settings.current_round || 1;
      const lockedRounds = JSON.parse(settings.locked_rounds || '[]');

      // Lock the current round
      if (!lockedRounds.includes(currentRound)) {
        lockedRounds.push(currentRound);
      }

      // Increment to next round
      const nextRound = currentRound + 1;

      db.run(
        'UPDATE event_settings SET current_round = ?, locked_rounds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
        [nextRound, JSON.stringify(lockedRounds)],
        (err) => {
          if (err) reject(err);
          else resolve({ currentRound: nextRound, lockedRounds });
        }
      );
    } catch (error) {
      reject(error);
    }
  });
};

const isRoundLocked = (round) => {
  return new Promise(async (resolve, reject) => {
    try {
      const settings = await getEventSettings();
      const lockedRounds = JSON.parse(settings.locked_rounds || '[]');
      resolve(lockedRounds.includes(round));
    } catch (error) {
      reject(error);
    }
  });
};

// Lock or unlock judging
const setJudgingLocked = (locked) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE event_settings 
       SET judging_locked = ?, updated_at = datetime("now")
       WHERE id = (SELECT id FROM event_settings ORDER BY id DESC LIMIT 1)`,
      [locked ? 1 : 0],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ judging_locked: locked });
        }
      }
    );
  });
};

// Set winners for divisions
const setWinners = (winners) => {
  return new Promise((resolve, reject) => {
    const winnersJson = JSON.stringify(winners || {});
    db.run(
      `UPDATE event_settings 
       SET winners = ?, updated_at = datetime("now")
       WHERE id = (SELECT id FROM event_settings ORDER BY id DESC LIMIT 1)`,
      [winnersJson],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ winners });
        }
      }
    );
  });
};

// Get teams with scores for a division (for winner selection)
const getTeamsByDivisionWithScores = (division) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT 
        t.id,
        t.name,
        t.division,
        t.table_name,
        t.project_name,
        COALESCE(AVG(s.score), 0) as avg_score,
        COUNT(DISTINCT s.judge_email) as judge_count,
        COUNT(DISTINCT s.round) as rounds_judged
       FROM teams t
       LEFT JOIN scores s ON t.name = s.team_name
       WHERE t.division = ?
       GROUP BY t.id, t.name, t.division, t.table_name, t.project_name
       ORDER BY avg_score DESC, judge_count DESC, rounds_judged DESC`,
      [division],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => ({
            ...row,
            avg_score: parseFloat(row.avg_score) || 0,
            judge_count: parseInt(row.judge_count) || 0,
            rounds_judged: parseInt(row.rounds_judged) || 0
          })));
        }
      }
    );
  });
};

// Get top team per category (for leaderboard sidebar)
const getTopTeamPerCategory = (round) => {
  return new Promise((resolve, reject) => {
    // Get all teams with their scores grouped by category
    // Start from teams (not categories) to ensure we get teams with categories and scores
    db.all(
      `SELECT 
        c.id as category_id,
        c.name as category_name,
        t.id as team_id,
        t.name as team_name,
        t.table_name,
        t.project_name,
        COALESCE(SUM(s.score), 0) as total_score,
        COUNT(DISTINCT s.judge_email) as judge_count,
        COUNT(DISTINCT s.round) as rounds_completed
       FROM teams t
       INNER JOIN categories c ON t.category_id = c.id
       LEFT JOIN scores s ON t.name = s.team_name AND s.round <= ?
       WHERE t.category_id IS NOT NULL
       GROUP BY c.id, c.name, t.id, t.name, t.table_name, t.project_name
       HAVING total_score > 0 OR judge_count > 0
       ORDER BY c.name, total_score DESC, judge_count DESC`,
      [round],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          // Group by category and get the top team (first one, highest score) for each category
          const categoryLeaders = {};
          rows.forEach(row => {
            const categoryId = row.category_id;
            // Only take the first team for each category (which will be the highest scoring due to ORDER BY)
            if (!categoryLeaders[categoryId]) {
              categoryLeaders[categoryId] = {
                category_id: row.category_id,
                category_name: row.category_name,
                team_id: row.team_id,
                team_name: row.team_name,
                table_name: row.table_name,
                project_name: row.project_name,
                total_score: parseFloat(row.total_score) || 0,
                judge_count: parseInt(row.judge_count) || 0,
                rounds_completed: parseInt(row.rounds_completed) || 0
              };
            }
          });

          // Convert to array and sort by category name
          resolve(Object.values(categoryLeaders).sort((a, b) =>
            a.category_name.localeCompare(b.category_name)
          ));
        }
      }
    );
  });
};

const close = () => {
  return new Promise((resolve, reject) => {
    if (db) {
      db.close((err) => {
        if (err) reject(err);
        else {
          console.log('Database connection closed');
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
};

// Get the next team assignment for a judge in the current round
const getNextTeamForJudge = (judgeEmail, round) => {
  return new Promise((resolve, reject) => {
    // Get all teams
    db.all('SELECT name, table_name, division FROM teams ORDER BY name', [], (err, teams) => {
      if (err) {
        reject(err);
        return;
      }

      // Get all teams this judge has EVER judged (across all rounds)
      // This prevents a judge from judging the same team twice, ever
      db.all(
        'SELECT DISTINCT team_name FROM judge_team_assignments WHERE judge_email = ?',
        [judgeEmail],
        (err, judgedTeams) => {
          if (err) {
            reject(err);
            return;
          }

          const judgedTeamNames = new Set(judgedTeams.map(t => t.team_name));

          // Get how many judges each team has for the current round
          // Also check which teams this judge is already assigned to in this round
          db.all(
            `SELECT 
              team_name, 
              COUNT(*) as judge_count,
              SUM(CASE WHEN judge_email = ? THEN 1 ELSE 0 END) as already_assigned
             FROM judge_team_assignments 
             WHERE round = ? 
             GROUP BY team_name`,
            [judgeEmail, round],
            (err, teamCounts) => {
              if (err) {
                reject(err);
                return;
              }

              const teamCountMap = {};
              const alreadyAssignedSet = new Set();
              teamCounts.forEach(tc => {
                teamCountMap[tc.team_name] = tc.judge_count;
                if (tc.already_assigned > 0) {
                  alreadyAssignedSet.add(tc.team_name);
                }
              });

              // Get required judges per team from env (default to 2)
              const requiredJudgesPerTeam = parseInt(process.env.JUDGES_PER_TEAM || '2', 10);

              // Filter teams the judge hasn't judged yet AND isn't already assigned to in this round
              // AND that still need more judges
              const availableTeams = teams
                .filter(t => {
                  // Must not have judged this team ever
                  if (judgedTeamNames.has(t.name)) return false;
                  // Must not already be assigned to this team in current round
                  if (alreadyAssignedSet.has(t.name)) return false;
                  // Must still need more judges (prevent over-assignment)
                  const currentJudgeCount = teamCountMap[t.name] || 0;
                  if (currentJudgeCount >= requiredJudgesPerTeam) return false;
                  return true;
                })
                .map(t => ({
                  name: t.name,
                  table_name: t.table_name,
                  division: t.division,
                  judge_count: teamCountMap[t.name] || 0
                }))
                .sort((a, b) => {
                  // First priority: teams with fewer judges
                  if (a.judge_count !== b.judge_count) {
                    return a.judge_count - b.judge_count;
                  }
                  // Second priority: alphabetical by name
                  return a.name.localeCompare(b.name);
                });

              if (availableTeams.length === 0) {
                resolve(null); // No available teams for this judge
                return;
              }

              // Return the team with the fewest judges
              resolve(availableTeams[0]);
            }
          );
        }
      );
    });
  });
};

// Assign a judge to a team
const assignJudgeToTeam = (judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO judge_team_assignments (judge_email, team_name, round, completed) 
       VALUES (?, ?, ?, 0)`,
      [judgeEmail, teamName, round],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, judge_email: judgeEmail, team_name: teamName, round });
      }
    );
  });
};

// Mark a team assignment as completed
const markAssignmentCompleted = (judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE judge_team_assignments 
       SET completed = 1 
       WHERE judge_email = ? AND team_name = ? AND round = ?`,
      [judgeEmail, teamName, round],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
};

// Get judge queue statistics for current round (team-based)
const getJudgeQueueStats = (round) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT 
        t.name as team_name,
        t.table_name,
        t.division,
        COUNT(DISTINCT jta.judge_email) as judge_count,
        GROUP_CONCAT(DISTINCT jta.judge_email) as judges
       FROM teams t
       LEFT JOIN judge_team_assignments jta ON t.name = jta.team_name AND jta.round = ?
       GROUP BY t.name
       ORDER BY judge_count ASC, t.name`,
      [round],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// Get all teams a judge has judged (across all rounds)
const getJudgedTeamsByJudge = (judgeEmail) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT jta.team_name, jta.round, t.table_name, t.division 
       FROM judge_team_assignments jta
       LEFT JOIN teams t ON jta.team_name = t.name
       WHERE jta.judge_email = ? 
       ORDER BY jta.round, jta.team_name`,
      [judgeEmail],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// Screenshot management functions
const addTeamScreenshot = (teamId, filename, originalFilename, fileSize, displayOrder = 0) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO team_screenshots (team_id, filename, original_filename, file_size, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [teamId, filename, originalFilename, fileSize, displayOrder],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, filename, originalFilename, fileSize, displayOrder });
      }
    );
  });
};

const getTeamScreenshots = (teamId) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM team_screenshots WHERE team_id = ? ORDER BY display_order ASC, created_at ASC`,
      [teamId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

const getTeamScreenshotById = (screenshotId) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM team_screenshots WHERE id = ?`,
      [screenshotId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
};

const deleteTeamScreenshot = (screenshotId, teamId) => {
  return new Promise((resolve, reject) => {
    // First get the filename to delete the file
    db.get('SELECT filename FROM team_screenshots WHERE id = ? AND team_id = ?', [screenshotId, teamId], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row) {
        reject(new Error('Screenshot not found'));
        return;
      }

      // Delete from database
      db.run('DELETE FROM team_screenshots WHERE id = ? AND team_id = ?', [screenshotId, teamId], (err) => {
        if (err) reject(err);
        else resolve({ filename: row.filename });
      });
    });
  });
};

const updateScreenshotOrder = (teamId, screenshotOrders) => {
  return new Promise((resolve, reject) => {
    // screenshotOrders should be an array of {id: screenshotId, order: displayOrder}
    const stmt = db.prepare('UPDATE team_screenshots SET display_order = ? WHERE id = ? AND team_id = ?');

    let completed = 0;
    let hasError = false;

    if (!screenshotOrders || screenshotOrders.length === 0) {
      resolve();
      return;
    }

    screenshotOrders.forEach(({ id, order }) => {
      stmt.run([order, id, teamId], (err) => {
        if (err && !hasError) {
          hasError = true;
          reject(err);
          return;
        }
        completed++;
        if (completed === screenshotOrders.length && !hasError) {
          stmt.finalize((err) => {
            if (err) reject(err);
            else resolve();
          });
        }
      });
    });
  });
};

// Get all teams for public projects page (excludes sensitive fields like team_leader_email)
// Only returns published teams
const getAllTeamsForProjects = () => {
  return new Promise((resolve, reject) => {
    // Exclude contact_email for public access - sensitive data should only be shown to team owners or admins
    // Only show published teams
    db.all(
      `SELECT t.id, t.name, t.table_name, t.project_name, 
              t.github_link, t.website_link, t.division, t.category_id,
              c.name as category_name, t.team_members, 
              t.readme_content, t.banner_image, t.logo_image, t.screenshots, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM team_screenshots ts WHERE ts.team_id = t.id) as screenshot_count
       FROM teams t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.is_published = 1
       ORDER BY t.name`,
      [],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        // Parse JSON fields for each team
        rows.forEach(row => {
          if (row.team_members) {
            try {
              row.team_members = JSON.parse(row.team_members);
            } catch (e) {
              row.team_members = [];
            }
          } else {
            row.team_members = [];
          }
        });
        resolve(rows);
      }
    );
  });
};

// Get all user data for export
const getUserDataForExport = (email) => {
  return new Promise(async (resolve, reject) => {
    try {
      const user = await getUserByEmail(email);
      if (!user) {
        return reject(new Error('User not found'));
      }

      const userWithTeam = await getUserWithTeam(email);
      const scores = await getJudgeScores(email);

      // Get team data if user is a participant
      let teamData = null;
      if (user.team_id) {
        teamData = await getTeamById(user.team_id);
        if (teamData) {
          const screenshots = await getTeamScreenshots(user.team_id);
          teamData.screenshots = screenshots;
        }
      }

      const exportData = {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          created_at: user.created_at,
          privacy_policy_accepted: user.privacy_policy_accepted === 1,
          terms_accepted: user.terms_accepted === 1,
          acceptable_use_accepted: user.acceptable_use_accepted === 1,
          policies_accepted_at: user.policies_accepted_at,
          is_under_18: user.is_under_18 === 1,
          guardian_email: user.guardian_email,
          email_preferences: user.email_preferences === 1
        },
        team: teamData,
        scores: scores || [],
        exported_at: new Date().toISOString()
      };

      resolve(exportData);
    } catch (error) {
      reject(error);
    }
  });
};

// Delete user account and associated data
const deleteUserAccount = (email) => {
  return new Promise(async (resolve, reject) => {
    try {
      const user = await getUserByEmail(email);
      if (!user) {
        return reject(new Error('User not found'));
      }

      // Don't allow deletion of admin accounts (safety measure)
      if (user.role === 'admin') {
        return reject(new Error('Admin accounts cannot be deleted through this interface'));
      }

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Delete judge assignments
        db.run('DELETE FROM judge_team_assignments WHERE judge_email = ?', [email], (err) => {
          if (err) {
            db.run('ROLLBACK');
            return reject(err);
          }
        });

        // Delete scores (but keep team data for historical records)
        // Note: We keep scores for historical integrity, but could delete if needed
        // db.run('DELETE FROM scores WHERE judge_email = ?', [email], (err) => {
        //   if (err) {
        //     db.run('ROLLBACK');
        //     return reject(err);
        //   }
        // });

        // Delete magic tokens
        db.run('DELETE FROM magic_tokens WHERE email = ?', [email], (err) => {
          if (err) {
            db.run('ROLLBACK');
            return reject(err);
          }
        });

        // If user is team leader, handle team ownership
        if (user.team_id) {
          db.get('SELECT team_leader_email FROM teams WHERE id = ?', [user.team_id], (err, team) => {
            if (err) {
              db.run('ROLLBACK');
              return reject(err);
            }

            // If user is team leader, set team_leader_email to contact_email or null
            if (team && team.team_leader_email === email) {
              db.get('SELECT contact_email FROM teams WHERE id = ?', [user.team_id], (err, teamData) => {
                if (err) {
                  db.run('ROLLBACK');
                  return reject(err);
                }
                const newLeaderEmail = teamData?.contact_email || null;
                db.run('UPDATE teams SET team_leader_email = ? WHERE id = ?', [newLeaderEmail, user.team_id], (err) => {
                  if (err) {
                    db.run('ROLLBACK');
                    return reject(err);
                  }
                });
              });
            }
          });
        }

        // Delete volunteer record if user is linked (CASCADE should handle this, but explicit for safety)
        db.run('DELETE FROM volunteers WHERE user_id = (SELECT id FROM users WHERE email = ?)', [email], (err) => {
          if (err) {
            console.error('Error deleting volunteer record:', err);
            // Continue even if this fails
          }
        });

        // Delete user account
        db.run('DELETE FROM users WHERE email = ?', [email], (err) => {
          if (err) {
            db.run('ROLLBACK');
            return reject(err);
          }

          db.run('COMMIT', (err) => {
            if (err) {
              db.run('ROLLBACK');
              return reject(err);
            }
            resolve({ success: true, email });
          });
        });
      });
    } catch (error) {
      reject(error);
    }
  });
};

// Create a new volunteer
const createVolunteer = (volunteerData) => {
  return new Promise((resolve, reject) => {
    const { name, email, phone, company, help_judging, help_logistics, help_mentor, description } = volunteerData;

    db.run(
      `INSERT INTO volunteers (name, email, phone, company, help_judging, help_logistics, help_mentor, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        name,
        email,
        phone || null,
        company || null,
        help_judging ? 1 : 0,
        help_logistics ? 1 : 0,
        help_mentor ? 1 : 0,
        description || null
      ],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({
            id: this.lastID,
            name,
            email,
            phone,
            company,
            help_judging: help_judging ? 1 : 0,
            help_logistics: help_logistics ? 1 : 0,
            help_mentor: help_mentor ? 1 : 0,
            description: description || null,
            status: 'pending'
          });
        }
      }
    );
  });
};

// Get all volunteers (optionally filtered by status and search term)
const getVolunteers = (status = null, searchTerm = null) => {
  return new Promise((resolve, reject) => {
    let query = 'SELECT v.*, u.email as user_email FROM volunteers v LEFT JOIN users u ON v.user_id = u.id';
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('v.status = ?');
      params.push(status);
    }

    if (searchTerm) {
      conditions.push('(v.name LIKE ? OR v.email LIKE ? OR v.phone LIKE ? OR v.company LIKE ?)');
      const searchPattern = `%${searchTerm}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY v.created_at DESC';

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        // Convert integer fields to booleans
        const volunteers = rows.map(row => ({
          ...row,
          help_judging: row.help_judging === 1,
          help_logistics: row.help_logistics === 1,
          help_mentor: row.help_mentor === 1
        }));
        resolve(volunteers);
      }
    });
  });
};

// Get a single volunteer by ID
const getVolunteerById = (id) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT v.*, u.email as user_email FROM volunteers v LEFT JOIN users u ON v.user_id = u.id WHERE v.id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
      } else if (!row) {
        resolve(null);
      } else {
        resolve({
          ...row,
          help_judging: row.help_judging === 1,
          help_logistics: row.help_logistics === 1,
          help_mentor: row.help_mentor === 1
        });
      }
    });
  });
};

// Update volunteer status (approve/deny)
const updateVolunteerStatus = (id, status, reviewedBy, userId = null) => {
  return new Promise((resolve, reject) => {
    const updates = ['status = ?', 'reviewed_at = CURRENT_TIMESTAMP', 'reviewed_by = ?'];
    const params = [status, reviewedBy];

    if (userId !== null) {
      updates.push('user_id = ?');
      params.push(userId);
    }

    params.push(id);

    db.run(
      `UPDATE volunteers 
       SET ${updates.join(', ')}
       WHERE id = ?`,
      params,
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id, status, reviewedBy, userId });
        }
      }
    );
  });
};

// Update volunteer admin notes
const updateVolunteerNotes = (id, adminNotes) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE volunteers 
       SET admin_notes = ?
       WHERE id = ?`,
      [adminNotes || null, id],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id, admin_notes: adminNotes });
        }
      }
    );
  });
};

// Newsletter send tracking
const createNewsletterSendHash = (subject, content, recipients) => {
  const crypto = require('crypto');
  // Create a hash from subject, content, and sorted recipients
  const recipientsStr = Array.isArray(recipients) ? recipients.sort().join(',') : recipients;
  const hashInput = `${subject}|${content}|${recipientsStr}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
};

const checkNewsletterAlreadySent = (sendHash) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, sent_at, sent_by FROM newsletter_sends WHERE send_hash = ?', [sendHash], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
};

const logNewsletterSend = (sendHash, subject, content, recipients, recipientCount, sentCount, failedCount, sentBy) => {
  return new Promise((resolve, reject) => {
    const recipientsStr = Array.isArray(recipients) ? JSON.stringify(recipients) : recipients;
    db.run(
      `INSERT INTO newsletter_sends (send_hash, subject, content, recipients, recipient_count, sent_count, failed_count, sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
      [sendHash, subject, content, recipientsStr, recipientCount, sentCount, failedCount, sentBy],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id: this.lastID, send_hash: sendHash });
        }
      }
    );
  });
};

const getNewsletterSendHistory = (limit = 50) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, subject, recipient_count, sent_count, failed_count, sent_by, sent_at
       FROM newsletter_sends
       ORDER BY sent_at DESC
       LIMIT ?`,
      [limit],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
};

module.exports = {
  init,
  getDb,
  getUserByEmail,
  createUser,
  updateUser,
  getOrCreateUser,
  getUserRole,
  getUserWithTeam,
  isAdmin,
  isTeamLeader,
  getAllUsers,
  createMagicToken,
  validateMagicToken,
  markTokenAsUsed,
  syncTables,
  initializeChessBoardTables,
  getTables,
  getTableNames,
  syncCategories,
  getCategories,
  getCategoryNames,
  getCategoryById,
  getCategoryByName,
  createTeam,
  syncTeams,
  getTeams,
  getTeamById,
  getTeamTable,
  updateTeam,
  deleteTeam,
  getScore,
  saveScore,
  getJudgeScores,
  getTableResults,
  getEventSettings,
  updateEventSettings,
  incrementRound,
  setJudgingLocked,
  setWinners,
  getTeamsByDivisionWithScores,
  getTopTeamPerCategory,
  isRoundLocked,
  getNextTeamForJudge,
  assignJudgeToTeam,
  markAssignmentCompleted,
  getJudgeQueueStats,
  getJudgedTeamsByJudge,
  // Screenshot management
  addTeamScreenshot,
  getTeamScreenshots,
  getTeamScreenshotById,
  deleteTeamScreenshot,
  updateScreenshotOrder,
  getAllTeamsForProjects,
  // Account management
  getUserDataForExport,
  deleteUserAccount,
  // Volunteer management
  createVolunteer,
  getVolunteers,
  getVolunteerById,
  updateVolunteerStatus,
  updateVolunteerNotes,
  // Newsletter tracking
  createNewsletterSendHash,
  checkNewsletterAlreadySent,
  logNewsletterSend,
  getNewsletterSendHistory,
  close
};

