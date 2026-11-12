const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { migrateEvents, slugify } = require('./migrate-events');

const DB_PATH = process.env.JUDGING_DB_PATH || path.join(__dirname, 'judging.db');

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
        role TEXT DEFAULT 'user',
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
          { name: 'is_under_18', def: 'INTEGER DEFAULT 0' },
          { name: 'account_type', def: "TEXT DEFAULT 'individual'" },
          { name: 'school_name', def: 'TEXT' }
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
        event_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id, name),
        FOREIGN KEY (event_id) REFERENCES event_settings(id)
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
        event_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id, name),
        FOREIGN KEY (event_id) REFERENCES event_settings(id)
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
            { name: 'team_leader_email', def: 'TEXT' },
            { name: 'owner_user_id', def: 'INTEGER' },
            { name: 'registration_type', def: "TEXT DEFAULT 'individual'" }
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
        event_id INTEGER NOT NULL,
        judge_email TEXT NOT NULL,
        team_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed BOOLEAN DEFAULT 0,
        locked_at DATETIME,
        UNIQUE(event_id, judge_email, team_name, round),
        FOREIGN KEY (event_id) REFERENCES event_settings(id)
      )`, (err) => {
        if (err) {
          console.error('Error creating judge_team_assignments table:', err);
        }
        // Add locked_at column if it doesn't exist (migration)
        db.run(`ALTER TABLE judge_team_assignments ADD COLUMN locked_at DATETIME`, () => { });
      });

      db.run(`CREATE TABLE IF NOT EXISTS tie_breaks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        division TEXT NOT NULL,
        team_name TEXT NOT NULL,
        round INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        UNIQUE(event_id, division, team_name, round),
        FOREIGN KEY (event_id) REFERENCES event_settings(id)
      )`, (err) => {
        if (err) {
          console.error('Error creating tie_breaks table:', err);
        }
      });

      // Event settings table
      db.run(`CREATE TABLE IF NOT EXISTS event_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT DEFAULT 'Hackathon',
        slug TEXT,
        status TEXT DEFAULT 'open',
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
        db.run(`ALTER TABLE event_settings ADD COLUMN slug TEXT`, () => { });
        db.run(`ALTER TABLE event_settings ADD COLUMN status TEXT DEFAULT 'open'`, () => { });

        // Newsletter sends table (tracks newsletter sends to prevent duplicates)
        db.run(`CREATE TABLE IF NOT EXISTS newsletter_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER,
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
      });

      // Create indexes
      db.run(`CREATE INDEX IF NOT EXISTS idx_tie_breaks_lookup ON tie_breaks(division, round)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_scores_judge ON scores(judge_email)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_scores_team ON scores(team_name, round)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_scores_table ON scores(table_name, round)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_teams_table ON teams(table_name)`, () => { });
      db.run(`CREATE INDEX IF NOT EXISTS idx_tokens_email ON magic_tokens(email, expires_at, used)`, () => {
        console.log('Database tables initialized');
        // Wait a bit for column migrations to complete, then initialize default admin
        // This ensures all ALTER TABLE statements have finished
        setTimeout(() => {
          migrateEvents(db).then(() => initializeDefaultAdmin()).then(() => {
            console.log('Database initialization complete');
            resolve();
          }).catch((err) => {
            console.error('Error during initialization:', err);
            resolve(); // Don't fail initialization if setup fails
          });
        }, 250); // Small delay to ensure column migrations complete
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

const createUser = (email, name = null, role = 'user', teamId = null, policyData = {}) => {
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
    if (policyData.account_type !== undefined) {
      fields.push('account_type');
      values.push(policyData.account_type || 'individual');
    }
    if (policyData.school_name !== undefined) {
      fields.push('school_name');
      values.push(policyData.school_name || null);
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
    if (updates.account_type !== undefined) {
      fields.push('account_type = ?');
      values.push(updates.account_type || 'individual');
    }
    if (updates.school_name !== undefined) {
      fields.push('school_name = ?');
      values.push(updates.school_name || null);
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
    db.get('SELECT role, team_id, account_type FROM users WHERE email = ?', [email], (err, row) => {
      if (err) reject(err);
      else resolve(row ? { role: row.role, team_id: row.team_id, account_type: row.account_type || 'individual' } : { role: 'user', team_id: null, account_type: 'individual' });
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
const syncTables = (eventId, tables) => {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR IGNORE INTO tables (event_id, name, updated_at) VALUES (?, ?, datetime("now"))');

    tables.forEach(table => {
      stmt.run(eventId, table.name);
    });

    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

// Initialize chess board-style tables (A1-A10 through P1-P10)
const initializeChessBoardTables = (eventId) => {
  return new Promise((resolve, reject) => {
    const tables = [];
    const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

    rows.forEach(row => {
      for (let col = 1; col <= 10; col++) {
        tables.push({ name: `${row}${col}` });
      }
    });

    syncTables(eventId, tables).then(resolve).catch(reject);
  });
};

const getTables = (eventId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tables WHERE event_id = ? ORDER BY name', [eventId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const getTableNames = (eventId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT name FROM tables WHERE event_id = ? ORDER BY name', [eventId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.name));
    });
  });
};

const deleteTable = (eventId, name) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM tables WHERE event_id = ? AND name = ?', [eventId, name], function (err) {
      if (err) reject(err);
      else resolve({ deleted: this.changes > 0 });
    });
  });
};

const deleteTables = (eventId, names) => {
  return new Promise((resolve, reject) => {
    if (!names.length) return resolve({ deleted: 0 });
    const placeholders = names.map(() => '?').join(',');
    db.run(
      `DELETE FROM tables WHERE event_id = ? AND name IN (${placeholders})`,
      [eventId, ...names],
      function (err) {
        if (err) reject(err);
        else resolve({ deleted: this.changes });
      }
    );
  });
};

// Category operations
const syncCategories = (eventId, categories) => {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare('INSERT OR IGNORE INTO categories (event_id, name, updated_at) VALUES (?, ?, datetime("now"))');

    categories.forEach(category => {
      stmt.run(eventId, category.name);
    });

    stmt.finalize((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

const getCategories = (eventId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM categories WHERE event_id = ? ORDER BY name', [eventId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const getCategoryNames = (eventId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT name FROM categories WHERE event_id = ? ORDER BY name', [eventId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.name));
    });
  });
};

const deleteCategory = (eventId, id) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM categories WHERE event_id = ? AND id = ?', [eventId, id], function (err) {
      if (err) reject(err);
      else resolve({ deleted: this.changes > 0 });
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

const getCategoryByName = (eventId, name) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM categories WHERE event_id = ? AND name = ?', [eventId, name], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Team operations
const createTeam = async (teamData) => {
  const registrationType = teamData.registration_type || 'individual';
  if (registrationType !== 'school' && teamData.owner_user_id) {
    const existing = await getIndividualTeam(teamData.event_id, teamData.owner_user_id);
    if (existing) {
      const error = new Error('This account already has a team for this event');
      error.code = 'INDIVIDUAL_TEAM_EXISTS';
      throw error;
    }
  }
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO teams (event_id, name, table_name, project_name, contact_email, github_link, division, category_id, is_published, team_members, website_link, readme_content, banner_image, logo_image, team_leader_email, owner_user_id, registration_type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
      [
        teamData.event_id,
        teamData.name,
        teamData.table_name,
        teamData.project_name,
        teamData.contact_email || null,
        teamData.github_link || null,
        teamData.division || null,
        teamData.category_id || null,
        teamData.is_published !== undefined ? (teamData.is_published ? 1 : 0) : 0,
        teamData.registration_type === 'school' ? null : (teamData.team_members ? JSON.stringify(teamData.team_members) : null),
        teamData.website_link || null,
        teamData.readme_content || null,
        teamData.banner_image || null,
        teamData.logo_image || null,
        teamData.team_leader_email || null,
        teamData.owner_user_id || null,
        teamData.registration_type || 'individual'
      ],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, ...teamData, registration_type: teamData.registration_type || 'individual' });
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

const getTeams = (eventId, tableName = null, includeSensitive = false) => {
  return new Promise((resolve, reject) => {
    // Exclude team_leader_email unless explicitly requested (admin only)
    const sensitiveFields = includeSensitive ? ', t.team_leader_email' : '';
    let query = `SELECT t.id, t.event_id, t.name, t.table_name, t.project_name, t.contact_email, 
                        t.github_link, t.website_link, t.division, t.category_id, 
                        c.name as category_name, t.is_published, t.team_members, 
                        t.readme_content, t.banner_image, t.logo_image, t.screenshots, 
                        t.owner_user_id, t.registration_type,
                        t.created_at, t.updated_at${sensitiveFields}
                 FROM teams t
                 LEFT JOIN categories c ON t.category_id = c.id
                 WHERE t.event_id = ?`;
    const params = [eventId];

    if (tableName) {
      query += ' AND t.table_name = ?';
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
        if (row.registration_type === 'school' && !includeSensitive) {
          row.team_members = [];
        }
      });
      resolve(rows);
    });
  });
};

const getTeamTable = (eventId, teamName) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT table_name FROM teams WHERE event_id = ? AND name = ?', [eventId, teamName], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.table_name : null);
    });
  });
};

// Check if a user is the team leader or the account that owns the team.
const isTeamLeader = (teamId, userEmail) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT t.contact_email, t.team_leader_email, t.owner_user_id, u.email AS owner_email
       FROM teams t
       LEFT JOIN users u ON u.id = t.owner_user_id
       WHERE t.id = ?`,
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
          (row.team_leader_email && row.team_leader_email.toLowerCase() === email) ||
          (row.owner_email && row.owner_email.toLowerCase() === email);
        resolve(isLeader);
      }
    );
  });
};

const getTeamById = (id, includeSensitive = false) => {
  return new Promise((resolve, reject) => {
    // Exclude team_leader_email unless explicitly requested (admin only)
    const sensitiveFields = includeSensitive ? ', t.team_leader_email' : '';
    const query = `SELECT t.id, t.event_id, t.name, t.table_name, t.project_name, t.contact_email, 
                          t.github_link, t.website_link, t.division, t.category_id,
                          c.name as category_name, t.is_published, t.team_members, 
                          t.readme_content, t.banner_image, t.logo_image, t.screenshots, 
                          t.owner_user_id, t.registration_type,
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
        if (row.registration_type === 'school' && !includeSensitive) {
          row.team_members = [];
        }
      }
      resolve(row);
    });
  });
};

const updateTeam = (id, teamData) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT registration_type FROM teams WHERE id = ?', [id], (lookupErr, existing) => {
      if (lookupErr) {
        reject(lookupErr);
        return;
      }
      if (existing && existing.registration_type === 'school') {
        teamData = { ...teamData, team_members: null };
      }
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

const getAllUsers = (eventId) => {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT u.*, m.role AS event_role, t.name AS team_name, t.id AS membership_team_id
      FROM event_memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN teams t ON t.event_id = m.event_id
        AND t.owner_user_id = u.id
        AND t.registration_type = 'individual'
      WHERE m.event_id = ?
      ORDER BY u.created_at DESC
    `, [eventId], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      db.all(`SELECT * FROM users WHERE role = 'admin' ORDER BY created_at DESC`, [], (adminErr, admins) => {
        if (adminErr) {
          reject(adminErr);
          return;
        }
        const seen = new Set((rows || []).map(row => row.id));
        const members = (rows || []).map(row => ({
          ...row,
          role: row.event_role || row.role
        }));
        (admins || []).forEach(admin => {
          if (!seen.has(admin.id)) {
            members.push({ ...admin, event_role: null, team_name: null });
          }
        });
        resolve(members);
      });
    });
  });
};

// Score operations
const getScore = (eventId, judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM scores WHERE event_id = ? AND judge_email = ? AND team_name = ? AND round = ?',
      [eventId, judgeEmail, teamName, round],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
};

const saveScore = (eventId, judgeEmail, teamName, tableName, round, score, notes = null) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO scores (event_id, judge_email, team_name, table_name, round, score, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime("now"))
       ON CONFLICT(event_id, judge_email, team_name, round) 
       DO UPDATE SET score = ?, notes = ?, table_name = ?, updated_at = datetime("now")`,
      [eventId, judgeEmail, teamName, tableName, round, score, notes, score, notes, tableName],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID });
      }
    );
  });
};

const getJudgeScores = (eventId, judgeEmail = null, round = null, tableName = null) => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT s.*, t.division
      FROM scores s
      LEFT JOIN teams t ON s.team_name = t.name AND t.event_id = s.event_id
      WHERE s.event_id = ?
    `;
    const params = [eventId];

    if (judgeEmail) {
      query += ' AND s.judge_email = ?';
      params.push(judgeEmail);
    }

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
const scoreKey = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

const getTableResults = (eventId, round, tableName = null) => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT 
        s.team_name,
        s.table_name,
        t.division,
        ROUND(SUM(s.score), 3) as total_score,
        COUNT(DISTINCT s.judge_email) as judge_count,
        COUNT(DISTINCT s.round) as rounds_completed,
        tb.sort_order as tie_sort_order
      FROM scores s
      LEFT JOIN teams t ON s.team_name = t.name AND t.event_id = s.event_id
      LEFT JOIN tie_breaks tb
        ON tb.event_id = s.event_id
       AND tb.team_name = s.team_name
       AND tb.round = ?
       AND tb.division = COALESCE(t.division, 'Unassigned')
      WHERE s.event_id = ? AND s.round <= ?
    `;
    const params = [round, eventId, round];

    if (tableName) {
      query += ' AND s.table_name = ?';
      params.push(tableName);
    }

    query += `
      GROUP BY s.team_name, s.table_name, t.division, tb.sort_order
      ORDER BY t.division, total_score DESC, COALESCE(tb.sort_order, 999999) ASC, s.team_name ASC
    `;

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else {
        const resultsByDivision = {};
        rows.forEach(row => {
          const division = row.division || 'Unassigned';
          if (!resultsByDivision[division]) {
            resultsByDivision[division] = [];
          }
          resultsByDivision[division].push({
            ...row,
            total_score: scoreKey(row.total_score),
            tie_sort_order: row.tie_sort_order == null ? null : Number(row.tie_sort_order)
          });
        });

        Object.keys(resultsByDivision).forEach(division => {
          const teams = resultsByDivision[division];
          teams.forEach((team, index) => {
            team.rank = index + 1;
            team.division_key = division;
          });

          let groupStart = 0;
          while (groupStart < teams.length) {
            let groupEnd = groupStart + 1;
            while (
              groupEnd < teams.length &&
              teams[groupEnd].total_score === teams[groupStart].total_score
            ) {
              groupEnd += 1;
            }
            const group = teams.slice(groupStart, groupEnd);
            const scoreTied = group.length > 1;
            const tieResolved = scoreTied && group.every(team => team.tie_sort_order != null);
            group.forEach((team, index) => {
              team.scoreTied = scoreTied;
              team.tieResolved = tieResolved;
              team.tieGroupFirst = index === 0;
              team.tieGroupLast = index === group.length - 1;
            });
            groupStart = groupEnd;
          }
        });

        resolve(resultsByDivision);
      }
    });
  });
};

// Event settings operations
const parseEventRow = (row) => {
  if (!row) return null;
  let divisions = [];
  try {
    divisions = row.divisions ? JSON.parse(row.divisions) : [];
  } catch (e) {
    divisions = [];
  }
  let winners = {};
  try {
    winners = row.winners ? JSON.parse(row.winners) : {};
  } catch (e) {
    winners = {};
  }
  return {
    ...row,
    divisions,
    judging_locked: row.judging_locked === 1,
    winners,
    status: row.status || 'open'
  };
};

const emptyEventSettings = () => ({
  id: null,
  event_name: 'Hackathon',
  slug: null,
  status: null,
  start_date: null,
  end_date: null,
  divisions: [],
  logo_filename: null,
  current_round: 1,
  locked_rounds: '[]',
  judging_locked: false,
  winners: {}
});

const getEventById = (eventId) => {
  return new Promise((resolve, reject) => {
    if (!eventId) {
      resolve(null);
      return;
    }
    db.get('SELECT * FROM event_settings WHERE id = ?', [eventId], (err, row) => {
      if (err) reject(err);
      else resolve(parseEventRow(row));
    });
  });
};

const getEventBySlug = (slug) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM event_settings WHERE slug = ?', [slug], (err, row) => {
      if (err) reject(err);
      else resolve(parseEventRow(row));
    });
  });
};

const listEvents = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM event_settings ORDER BY id ASC', [], (err, rows) => {
      if (err) reject(err);
      else resolve((rows || []).map(parseEventRow));
    });
  });
};

const listVisibleEvents = async (user) => {
  const events = await listEvents();
  if (user && user.role === 'admin') return events;
  let membershipEventIds = new Set();
  if (user && user.id) {
    const memberships = await getMembershipsForUser(user.id);
    membershipEventIds = new Set(memberships.map(membership => membership.event_id));
  }
  return events.filter(event => event.status === 'open' || membershipEventIds.has(event.id));
};

const uniqueEventSlug = (baseName, excludeId = null) => {
  return new Promise((resolve, reject) => {
    const base = slugify(baseName);
    const trySlug = (candidate, attempt) => {
      db.get('SELECT id FROM event_settings WHERE slug = ?', [candidate], (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        if (!row || (excludeId && row.id === excludeId)) {
          resolve(candidate);
          return;
        }
        trySlug(`${base}-${attempt + 1}`, attempt + 1);
      });
    };
    trySlug(base, 1);
  });
};

const createEvent = async (data) => {
  const slug = await uniqueEventSlug(data.slug || data.event_name || 'event');
  const divisionsJson = JSON.stringify(Array.isArray(data.divisions) ? data.divisions : []);
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO event_settings (
        event_name, slug, status, start_date, end_date, divisions, current_round, locked_rounds, winners, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, '[]', '{}', datetime("now"))`,
      [
        data.event_name || 'Hackathon',
        slug,
        data.status || 'draft',
        data.start_date || null,
        data.end_date || null,
        divisionsJson
      ],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, event_name: data.event_name || 'Hackathon', slug, status: data.status || 'draft' });
      }
    );
  });
};

const updateEventStatus = (eventId, status) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE event_settings SET status = ?, updated_at = datetime("now") WHERE id = ?`,
      [status, eventId],
      function (err) {
        if (err) reject(err);
        else resolve({ id: eventId, status, changes: this.changes });
      }
    );
  });
};

const getEventSettings = (eventId) => {
  return new Promise((resolve, reject) => {
    if (!eventId) {
      resolve(emptyEventSettings());
      return;
    }
    getEventById(eventId).then(resolve).catch(reject);
  });
};

const updateEventSettings = (eventId, settings) => {
  return new Promise((resolve, reject) => {
    const divisionsJson = Array.isArray(settings.divisions)
      ? JSON.stringify(settings.divisions)
      : (settings.divisions || '[]');

    const applyUpdate = (id, nextSlug) => {
      db.run(
        `UPDATE event_settings 
         SET event_name = ?, slug = ?, start_date = ?, end_date = ?, divisions = ?, logo_filename = ?, 
             hero_banner_image = ?, hero_banner_link = ?, landing_page_content = ?, event_dates_text = ?,
             updated_at = datetime("now")
         WHERE id = ?`,
        [
          settings.event_name || 'Hackathon',
          nextSlug,
          settings.start_date || null,
          settings.end_date || null,
          divisionsJson,
          settings.logo_filename || null,
          settings.hero_banner_image || null,
          settings.hero_banner_link || null,
          settings.landing_page_content || null,
          settings.event_dates_text || null,
          id
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ id, ...settings, slug: nextSlug, divisions: Array.isArray(settings.divisions) ? settings.divisions : JSON.parse(divisionsJson) });
        }
      );
    };

    uniqueEventSlug(settings.event_name || 'Hackathon', eventId)
      .then((nextSlug) => applyUpdate(eventId, nextSlug))
      .catch(reject);
  });
};

const incrementRound = (eventId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const settings = await getEventSettings(eventId);
      const currentRound = settings.current_round || 1;
      const lockedRounds = JSON.parse(settings.locked_rounds || '[]');

      if (!lockedRounds.includes(currentRound)) {
        lockedRounds.push(currentRound);
      }

      const nextRound = currentRound + 1;

      db.run(
        'UPDATE event_settings SET current_round = ?, locked_rounds = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [nextRound, JSON.stringify(lockedRounds), eventId],
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

const isRoundLocked = (eventId, round) => {
  return new Promise(async (resolve, reject) => {
    try {
      const settings = await getEventSettings(eventId);
      const lockedRounds = JSON.parse(settings.locked_rounds || '[]');
      resolve(lockedRounds.includes(parseInt(round, 10)));
    } catch (error) {
      reject(error);
    }
  });
};

const setJudgingLocked = (eventId, locked) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE event_settings 
       SET judging_locked = ?, updated_at = datetime("now")
       WHERE id = ?`,
      [locked ? 1 : 0, eventId],
      function (err) {
        if (err) reject(err);
        else resolve({ judging_locked: locked });
      }
    );
  });
};

const setWinners = (eventId, winners) => {
  return new Promise((resolve, reject) => {
    const winnersJson = JSON.stringify(winners || {});
    db.run(
      `UPDATE event_settings 
       SET winners = ?, updated_at = datetime("now")
       WHERE id = ?`,
      [winnersJson, eventId],
      function (err) {
        if (err) reject(err);
        else resolve({ winners });
      }
    );
  });
};

// Get teams with scores for a division (for winner selection)
const getTeamsByDivisionWithScores = (eventId, division) => {
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
       LEFT JOIN scores s ON t.name = s.team_name AND s.event_id = t.event_id
       WHERE t.event_id = ? AND t.division = ?
       GROUP BY t.id, t.name, t.division, t.table_name, t.project_name
       ORDER BY avg_score DESC, judge_count DESC, rounds_judged DESC`,
      [eventId, division],
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
const getTopTeamPerCategory = (eventId, round) => {
  return new Promise((resolve, reject) => {
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
       INNER JOIN categories c ON t.category_id = c.id AND c.event_id = t.event_id
       LEFT JOIN scores s ON t.name = s.team_name AND s.event_id = t.event_id AND s.round <= ?
       WHERE t.event_id = ? AND t.category_id IS NOT NULL
       GROUP BY c.id, c.name, t.id, t.name, t.table_name, t.project_name
       HAVING total_score > 0 OR judge_count > 0
       ORDER BY c.name, total_score DESC, judge_count DESC`,
      [round, eventId],
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
const getNextTeamForJudge = (eventId, judgeEmail, round) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT name, table_name, division FROM teams WHERE event_id = ? ORDER BY name', [eventId], (err, teams) => {
      if (err) {
        reject(err);
        return;
      }

      db.all(
        `SELECT DISTINCT team_name FROM judge_team_assignments WHERE event_id = ? AND judge_email = ?
         UNION
         SELECT DISTINCT team_name FROM scores WHERE event_id = ? AND judge_email = ?`,
        [eventId, judgeEmail, eventId, judgeEmail],
        (err, judgedTeams) => {
          if (err) {
            reject(err);
            return;
          }

          const judgedTeamNames = new Set(judgedTeams.map(t => t.team_name));

          // Get how many judges each team has for the current round
          // Also check which teams this judge is already assigned to in this round
          // And which teams are currently locked
          db.all(
            `SELECT
              t.name as team_name,
              (
                SELECT COUNT(*) FROM (
                  SELECT judge_email FROM judge_team_assignments
                  WHERE event_id = ? AND team_name = t.name AND round = ?
                  UNION
                  SELECT judge_email FROM scores
                  WHERE event_id = ? AND team_name = t.name AND round = ?
                )
              ) as judge_count,
              (
                SELECT COUNT(*) FROM judge_team_assignments
                WHERE event_id = ? AND team_name = t.name AND round = ? AND judge_email = ?
              ) as already_assigned,
              (
                SELECT COUNT(*) FROM judge_team_assignments
                WHERE event_id = ? AND team_name = t.name AND round = ?
                  AND completed = 0 AND locked_at IS NOT NULL AND judge_email != ?
              ) as is_locked
             FROM teams t
             WHERE t.event_id = ?`,
            [eventId, round, eventId, round, eventId, round, judgeEmail, eventId, round, judgeEmail, eventId],
            (err, teamCounts) => {
              if (err) {
                reject(err);
                return;
              }

              const teamCountMap = {};
              const alreadyAssignedSet = new Set();
              const lockedTeamsSet = new Set();
              teamCounts.forEach(tc => {
                teamCountMap[tc.team_name] = tc.judge_count;
                if (tc.already_assigned > 0) {
                  alreadyAssignedSet.add(tc.team_name);
                }
                if (tc.is_locked > 0) {
                  lockedTeamsSet.add(tc.team_name);
                }
              });

              // Get required judges per team from env (default to 2)
              const requiredJudgesPerTeam = parseInt(process.env.JUDGES_PER_TEAM || '2', 10);

              // Get last assignment times for round-robin ordering
              db.all(
                `SELECT team_name, MAX(assigned_at) as last_assigned
                 FROM judge_team_assignments
                 WHERE event_id = ? AND round = ? AND completed = 1
                 GROUP BY team_name`,
                [eventId, round],
                (err, lastAssignments) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  const lastAssignedMap = {};
                  lastAssignments.forEach(la => {
                    lastAssignedMap[la.team_name] = la.last_assigned || '';
                  });

                  // Filter teams the judge hasn't judged yet AND isn't already assigned to in this round
                  // AND that still need more judges AND are not currently locked
                  const availableTeams = teams
                    .filter(t => {
                      // Must not have judged this team ever
                      if (judgedTeamNames.has(t.name)) return false;
                      // Must not already be assigned to this team in current round
                      if (alreadyAssignedSet.has(t.name)) return false;
                      // Must not be locked by another judge
                      if (lockedTeamsSet.has(t.name)) return false;
                      // Must still need more judges (prevent over-assignment)
                      const currentJudgeCount = teamCountMap[t.name] || 0;
                      if (currentJudgeCount >= requiredJudgesPerTeam) return false;
                      return true;
                    })
                    .map(t => ({
                      name: t.name,
                      table_name: t.table_name,
                      division: t.division,
                      judge_count: teamCountMap[t.name] || 0,
                      last_assigned: lastAssignedMap[t.name] || ''
                    }))
                    .sort((a, b) => {
                      // First priority: teams with fewer judges
                      if (a.judge_count !== b.judge_count) {
                        return a.judge_count - b.judge_count;
                      }
                      // Second priority: round-robin - teams that haven't been assigned recently
                      // (for teams with same judge count, prefer ones not assigned recently)
                      if (a.last_assigned !== b.last_assigned) {
                        if (!a.last_assigned) return -1; // Never assigned gets priority
                        if (!b.last_assigned) return 1;
                        return a.last_assigned.localeCompare(b.last_assigned);
                      }
                      // Third priority: alphabetical by name
                      return a.name.localeCompare(b.name);
                    });

                  if (availableTeams.length === 0) {
                    resolve(null); // No available teams for this judge
                    return;
                  }

                  // Return the team with the fewest judges (round-robin style)
                  resolve(availableTeams[0]);
                }
              );
            }
          );
        }
      );
    });
  });
};

// Assign a judge to a team
// Note: For atomic locking, use lockTeamForJudge() instead
const assignJudgeToTeam = (eventId, judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO judge_team_assignments (event_id, judge_email, team_name, round, completed, locked_at) 
       VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
      [eventId, judgeEmail, teamName, round],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, judge_email: judgeEmail, team_name: teamName, round });
      }
    );
  });
};

// Mark a team assignment as completed
const markAssignmentCompleted = (eventId, judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO judge_team_assignments (event_id, judge_email, team_name, round, completed, locked_at)
       VALUES (?, ?, ?, ?, 1, NULL)
       ON CONFLICT(event_id, judge_email, team_name, round)
       DO UPDATE SET completed = 1`,
      [eventId, judgeEmail, teamName, round],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
};

// Get judge queue statistics for current round (team-based)
const getJudgeQueueStats = (eventId, round) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT
        t.name as team_name,
        t.table_name,
        t.division,
        (
          SELECT COUNT(*) FROM (
            SELECT judge_email FROM judge_team_assignments
            WHERE event_id = ? AND team_name = t.name AND round = ?
            UNION
            SELECT judge_email FROM scores
            WHERE event_id = ? AND team_name = t.name AND round = ?
          )
        ) as judge_count,
        (
          SELECT GROUP_CONCAT(judge_email) FROM (
            SELECT judge_email FROM judge_team_assignments
            WHERE event_id = ? AND team_name = t.name AND round = ?
            UNION
            SELECT judge_email FROM scores
            WHERE event_id = ? AND team_name = t.name AND round = ?
          )
        ) as judges
       FROM teams t
       WHERE t.event_id = ?
       ORDER BY judge_count ASC, t.name`,
      [eventId, round, eventId, round, eventId, round, eventId, round, eventId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// Get all teams a judge has judged (across all rounds)
const getJudgedTeamsByJudge = (eventId, judgeEmail) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT team_name, round, table_name, division FROM (
         SELECT jta.team_name as team_name, jta.round as round, t.table_name as table_name, t.division as division
         FROM judge_team_assignments jta
         LEFT JOIN teams t ON jta.team_name = t.name AND t.event_id = jta.event_id
         WHERE jta.event_id = ? AND jta.judge_email = ?
         UNION
         SELECT s.team_name, s.round, t.table_name, t.division
         FROM scores s
         LEFT JOIN teams t ON s.team_name = t.name AND t.event_id = s.event_id
         WHERE s.event_id = ? AND s.judge_email = ?
       )
       ORDER BY round, team_name`,
      [eventId, judgeEmail, eventId, judgeEmail],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// Get current incomplete assignments (locked but not completed) for a judge
const getCurrentAssignmentsForJudge = (eventId, judgeEmail, round) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT jta.team_name, jta.round, jta.locked_at, t.table_name, t.division 
       FROM judge_team_assignments jta
       LEFT JOIN teams t ON jta.team_name = t.name AND t.event_id = jta.event_id
       WHERE jta.event_id = ?
         AND jta.judge_email = ? 
         AND jta.round = ?
         AND jta.completed = 0
         AND jta.locked_at IS NOT NULL
       ORDER BY jta.locked_at DESC`,
      [eventId, judgeEmail, round],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
};

// Check if a team is currently locked by any judge
const isTeamLocked = (eventId, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT judge_email, locked_at 
       FROM judge_team_assignments 
       WHERE event_id = ?
         AND team_name = ? 
         AND round = ? 
         AND completed = 0 
         AND locked_at IS NOT NULL
       LIMIT 1`,
      [eventId, teamName, round],
      (err, row) => {
        if (err) reject(err);
        else resolve(!!row); // Return true if locked, false if not
      }
    );
  });
};

// Atomically lock a team for a judge
// Uses a transaction to prevent race conditions
const lockTeamForJudge = (eventId, judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    // Use a transaction to ensure atomicity
    db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
      if (beginErr) {
        reject(beginErr);
        return;
      }

      // Check if team is already locked by another judge
      db.get(
        `SELECT judge_email 
         FROM judge_team_assignments 
         WHERE event_id = ?
           AND team_name = ? 
           AND round = ? 
           AND completed = 0 
           AND locked_at IS NOT NULL
           AND judge_email != ?
         LIMIT 1`,
        [eventId, teamName, round, judgeEmail],
        (err, existingLock) => {
          if (err) {
            db.run('ROLLBACK', () => { });
            reject(err);
            return;
          }

          if (existingLock) {
            // Team is locked by another judge
            db.run('ROLLBACK', () => { });
            resolve({ success: false, reason: 'already_locked' });
            return;
          }

          db.get(
            `SELECT
               (SELECT COUNT(*) FROM (
                  SELECT judge_email FROM judge_team_assignments
                  WHERE event_id = ? AND team_name = ? AND round = ?
                  UNION
                  SELECT judge_email FROM scores
                  WHERE event_id = ? AND team_name = ? AND round = ?
                )) AS judge_count,
               (SELECT COUNT(*) FROM (
                  SELECT judge_email FROM judge_team_assignments
                  WHERE event_id = ? AND team_name = ? AND round = ? AND judge_email = ?
                  UNION
                  SELECT judge_email FROM scores
                  WHERE event_id = ? AND team_name = ? AND round = ? AND judge_email = ?
                )) AS already_here`,
            [eventId, teamName, round, eventId, teamName, round, eventId, teamName, round, judgeEmail, eventId, teamName, round, judgeEmail],
            (capErr, capRow) => {
              if (capErr) {
                db.run('ROLLBACK', () => { });
                reject(capErr);
                return;
              }

              const requiredJudges = getRequiredJudgesPerTeam();
              const judgeCount = capRow ? capRow.judge_count : 0;
              const alreadyHere = capRow ? capRow.already_here : 0;
              if (!alreadyHere && judgeCount >= requiredJudges) {
                db.run('ROLLBACK', () => { });
                resolve({ success: false, reason: 'team_full' });
                return;
              }

          // Try to insert or update the assignment with lock
          db.run(
            `INSERT INTO judge_team_assignments (event_id, judge_email, team_name, round, completed, locked_at) 
             VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
             ON CONFLICT(event_id, judge_email, team_name, round) 
             DO UPDATE SET locked_at = CURRENT_TIMESTAMP 
             WHERE completed = 0 AND locked_at IS NULL`,
            [eventId, judgeEmail, teamName, round],
            function (err) {
              if (err) {
                db.run('ROLLBACK', () => { });
                reject(err);
                return;
              }

              // Verify the lock was set (check if this judge now has the lock)
              db.get(
                `SELECT locked_at, id
                 FROM judge_team_assignments 
                 WHERE event_id = ?
                   AND judge_email = ? 
                   AND team_name = ? 
                   AND round = ? 
                   AND completed = 0 
                   AND locked_at IS NOT NULL`,
                [eventId, judgeEmail, teamName, round],
                (err, lockCheck) => {
                  if (err) {
                    db.run('ROLLBACK', () => { });
                    reject(err);
                    return;
                  }

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      db.run('ROLLBACK', () => { });
                      reject(commitErr);
                      return;
                    }

                    if (lockCheck) {
                      resolve({ success: true, id: lockCheck.id });
                    } else {
                      // Lock was not set (possibly due to race condition)
                      resolve({ success: false, reason: 'lock_failed' });
                    }
                  });
                }
              );
            }
          );
              }
            );
          }
        );
      });
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
const getAllTeamsForProjects = (eventId) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT t.id, t.event_id, t.name, t.table_name, t.project_name, 
              t.github_link, t.website_link, t.division, t.category_id,
              c.name as category_name, t.team_members, t.registration_type,
              t.readme_content, t.banner_image, t.logo_image, t.screenshots, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM team_screenshots ts WHERE ts.team_id = t.id) as screenshot_count
       FROM teams t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.event_id = ? AND t.is_published = 1
       ORDER BY t.name`,
      [eventId],
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
          if (row.registration_type === 'school') {
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
      const scores = await new Promise((resolveScores, rejectScores) => {
        db.all('SELECT * FROM scores WHERE judge_email = ? ORDER BY event_id, round, team_name', [email], (err, rows) => {
          if (err) rejectScores(err);
          else resolveScores(rows || []);
        });
      });
      const ownedTeams = await new Promise((resolveTeams, rejectTeams) => {
        db.all('SELECT * FROM teams WHERE owner_user_id = ? ORDER BY event_id, name', [user.id], (err, rows) => {
          if (err) rejectTeams(err);
          else resolveTeams(rows || []);
        });
      });

      let teamData = null;
      if (user.team_id) {
        teamData = await getTeamById(user.team_id, true);
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
          account_type: user.account_type || 'individual',
          school_name: user.school_name || null,
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
        teams: ownedTeams,
        profile: userWithTeam,
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
const createVolunteer = (eventId, volunteerData) => {
  return new Promise((resolve, reject) => {
    const { name, email, phone, company, help_judging, help_logistics, help_mentor, description } = volunteerData;

    db.run(
      `INSERT INTO volunteers (event_id, name, email, phone, company, help_judging, help_logistics, help_mentor, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        eventId,
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
const getVolunteers = (eventId, status = null, searchTerm = null) => {
  return new Promise((resolve, reject) => {
    let query = 'SELECT v.*, u.email as user_email FROM volunteers v LEFT JOIN users u ON v.user_id = u.id';
    const conditions = ['v.event_id = ?'];
    const params = [eventId];

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
const createNewsletterSendHash = (eventId, subject, content, recipients) => {
  const recipientsStr = Array.isArray(recipients) ? recipients.sort().join(',') : recipients;
  const hashInput = `${eventId}|${subject}|${content}|${recipientsStr}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
};

const checkNewsletterAlreadySent = (eventId, sendHash) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, sent_at, sent_by FROM newsletter_sends WHERE event_id = ? AND send_hash = ?', [eventId, sendHash], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
};

const logNewsletterSend = (eventId, sendHash, subject, content, recipients, recipientCount, sentCount, failedCount, sentBy) => {
  return new Promise((resolve, reject) => {
    const recipientsStr = Array.isArray(recipients) ? JSON.stringify(recipients) : recipients;
    db.run(
      `INSERT INTO newsletter_sends (event_id, send_hash, subject, content, recipients, recipient_count, sent_count, failed_count, sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
      [eventId, sendHash, subject, content, recipientsStr, recipientCount, sentCount, failedCount, sentBy],
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

const getNewsletterSendHistory = (eventId, limit = 50) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, subject, recipient_count, sent_count, failed_count, sent_by, sent_at
       FROM newsletter_sends
       WHERE event_id = ?
       ORDER BY sent_at DESC
       LIMIT ?`,
      [eventId, limit],
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

const getRequiredJudgesPerTeam = () => {
  const parsed = parseInt(process.env.JUDGES_PER_TEAM || '2', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 2;
  return parsed;
};

const getAssignment = (eventId, judgeEmail, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM judge_team_assignments
       WHERE event_id = ? AND judge_email = ? AND team_name = ? AND round = ?`,
      [eventId, judgeEmail, teamName, round],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
};

const getTeamJudgeEmails = (eventId, teamName, round) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT judge_email FROM judge_team_assignments WHERE event_id = ? AND team_name = ? AND round = ?
       UNION
       SELECT judge_email FROM scores WHERE event_id = ? AND team_name = ? AND round = ?`,
      [eventId, teamName, round, eventId, teamName, round],
      (err, rows) => {
        if (err) reject(err);
        else resolve((rows || []).map(row => row.judge_email));
      }
    );
  });
};

const teamHasRoomForJudge = async (eventId, teamName, round, judgeEmail) => {
  const emails = await getTeamJudgeEmails(eventId, teamName, round);
  const required = getRequiredJudgesPerTeam();
  const already = emails.includes(judgeEmail);
  return {
    allowed: already || emails.length < required,
    judgeCount: emails.length,
    already,
    required
  };
};

const canJudgeSubmitNewScore = async (eventId, judgeEmail, teamName, round) => {
  const existing = await getScore(eventId, judgeEmail, teamName, round);
  if (existing) {
    return { ok: true, reason: 'edit' };
  }
  const capacity = await teamHasRoomForJudge(eventId, teamName, round, judgeEmail);
  if (!capacity.allowed) {
    return { ok: false, reason: 'team_full' };
  }
  const assignment = await getAssignment(eventId, judgeEmail, teamName, round);
  if (!assignment) {
    return { ok: false, reason: 'not_assigned' };
  }
  return { ok: true, reason: 'assigned' };
};

const getScoreById = (id) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT s.*, t.division
       FROM scores s
       LEFT JOIN teams t ON s.team_name = t.name AND t.event_id = s.event_id
       WHERE s.id = ?`,
      [id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
};

const listScores = (eventId, filters = {}) => {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT s.*, t.division
      FROM scores s
      LEFT JOIN teams t ON s.team_name = t.name AND t.event_id = s.event_id
      WHERE s.event_id = ?
    `;
    const params = [eventId];

    if (filters.round) {
      query += ' AND s.round = ?';
      params.push(filters.round);
    }
    if (filters.teamName) {
      query += ' AND s.team_name LIKE ?';
      params.push(`%${filters.teamName}%`);
    }
    if (filters.judgeEmail) {
      query += ' AND s.judge_email LIKE ?';
      params.push(`%${filters.judgeEmail}%`);
    }

    query += ' ORDER BY s.round DESC, s.team_name, s.judge_email';

    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
};

const updateScoreById = (id, score, notes) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE scores
       SET score = ?, notes = ?, updated_at = datetime("now")
       WHERE id = ?`,
      [score, notes, id],
      function (err) {
        if (err) reject(err);
        else resolve({ changes: this.changes });
      }
    );
  });
};

const deleteScoreById = (id) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM scores WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row) {
        resolve(null);
        return;
      }

      db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
        if (beginErr) {
          reject(beginErr);
          return;
        }

        db.run('DELETE FROM scores WHERE id = ?', [id], (deleteErr) => {
          if (deleteErr) {
            db.run('ROLLBACK', () => { });
            reject(deleteErr);
            return;
          }

          db.run(
            `DELETE FROM judge_team_assignments
             WHERE event_id = ? AND judge_email = ? AND team_name = ? AND round = ?`,
            [row.event_id, row.judge_email, row.team_name, row.round],
            (assignmentErr) => {
              if (assignmentErr) {
                db.run('ROLLBACK', () => { });
                reject(assignmentErr);
                return;
              }

              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK', () => { });
                  reject(commitErr);
                  return;
                }
                resolve(row);
              });
            }
          );
        });
      });
    });
  });
};

const getMembership = (userId, eventId) => {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM event_memberships WHERE user_id = ? AND event_id = ?',
      [userId, eventId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
};

const getMembershipsForUser = (userId) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT m.*, e.event_name, e.slug, e.status
       FROM event_memberships m
       JOIN event_settings e ON e.id = m.event_id
       WHERE m.user_id = ?
       ORDER BY e.event_name`,
      [userId],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
};

const upsertMembership = (userId, eventId, role) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO event_memberships (user_id, event_id, role)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, event_id) DO UPDATE SET role = excluded.role`,
      [userId, eventId, role],
      function (err) {
        if (err) reject(err);
        else resolve({ user_id: userId, event_id: eventId, role });
      }
    );
  });
};

const getIndividualTeam = (eventId, userId) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id FROM teams
       WHERE event_id = ? AND owner_user_id = ? AND registration_type = 'individual'
       ORDER BY id ASC LIMIT 1`,
      [eventId, userId],
      (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else getTeamById(row.id, true).then(resolve).catch(reject);
      }
    );
  });
};

const getTeamsForOwner = (eventId, userId) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id FROM teams
       WHERE event_id = ? AND owner_user_id = ?
       ORDER BY name`,
      [eventId, userId],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        Promise.all((rows || []).map(row => getTeamById(row.id, true))).then(resolve).catch(reject);
      }
    );
  });
};

const countSchoolTeams = (userId) => {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) AS count FROM teams WHERE owner_user_id = ? AND registration_type = 'school'`,
      [userId],
      (err, row) => (err ? reject(err) : resolve(row ? row.count : 0))
    );
  });
};

const saveTieBreakOrder = (eventId, division, round, orderedTeamNames) => {
  return new Promise((resolve, reject) => {
    db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
      if (beginErr) {
        reject(beginErr);
        return;
      }

      const insertAt = (index) => {
        if (index >= orderedTeamNames.length) {
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              db.run('ROLLBACK', () => { });
              reject(commitErr);
              return;
            }
            resolve();
          });
          return;
        }

        db.run(
          `INSERT INTO tie_breaks (event_id, division, team_name, round, sort_order)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(event_id, division, team_name, round)
           DO UPDATE SET sort_order = excluded.sort_order`,
          [eventId, division, orderedTeamNames[index], round, index + 1],
          (insertErr) => {
            if (insertErr) {
              db.run('ROLLBACK', () => { });
              reject(insertErr);
              return;
            }
            insertAt(index + 1);
          }
        );
      };

      insertAt(0);
    });
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
  deleteTable,
  deleteTables,
  syncCategories,
  getCategories,
  getCategoryNames,
  deleteCategory,
  getCategoryById,
  getCategoryByName,
  createTeam,
  syncTeams,
  getTeams,
  getTeamById,
  getTeamTable,
  getIndividualTeam,
  getTeamsForOwner,
  countSchoolTeams,
  updateTeam,
  deleteTeam,
  getScore,
  getScoreById,
  listScores,
  updateScoreById,
  deleteScoreById,
  saveScore,
  getJudgeScores,
  getTableResults,
  saveTieBreakOrder,
  getRequiredJudgesPerTeam,
  getAssignment,
  teamHasRoomForJudge,
  canJudgeSubmitNewScore,
  getEventSettings,
  getEventById,
  getEventBySlug,
  listEvents,
  listVisibleEvents,
  createEvent,
  updateEventStatus,
  updateEventSettings,
  getMembership,
  getMembershipsForUser,
  upsertMembership,
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
  getCurrentAssignmentsForJudge,
  isTeamLocked,
  lockTeamForJudge,
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

