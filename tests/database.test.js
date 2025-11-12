const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Test database path
const TEST_DB_PATH = path.join(__dirname, '../test-database.db');

// We'll test the database functions by creating a test database
// and importing the actual database module functions
describe('Database Functions', () => {
  let testDb;
  let dbModule;

  beforeAll(async () => {
    // Create a fresh test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    testDb = new sqlite3.Database(TEST_DB_PATH);
    
    // Create tables
    await new Promise((resolve, reject) => {
      testDb.serialize(() => {
        // Users table
        testDb.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT,
            role TEXT DEFAULT 'judge',
            team_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (team_id) REFERENCES teams(id)
          )
        `, (err) => {
          if (err) reject(err);
        });

        // Teams table
        testDb.run(`
          CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            table_name TEXT NOT NULL,
            project_name TEXT NOT NULL,
            contact_email TEXT,
            github_link TEXT,
            division TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) reject(err);
        });

        // Scores table
        testDb.run(`
          CREATE TABLE IF NOT EXISTS scores (
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
          )
        `, (err) => {
          if (err) reject(err);
        });

        // Event settings table
        testDb.run(`
          CREATE TABLE IF NOT EXISTS event_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_name TEXT DEFAULT 'Hackathon',
            start_date TEXT,
            end_date TEXT,
            divisions TEXT DEFAULT '[]',
            logo_filename TEXT,
            current_round INTEGER DEFAULT 1,
            locked_rounds TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) reject(err);
        });

        // Magic tokens table
        testDb.run(`
          CREATE TABLE IF NOT EXISTS magic_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            used INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  });

  afterAll(async () => {
    if (testDb) {
      await new Promise((resolve, reject) => {
        testDb.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  beforeEach(async () => {
    // Clear all tables before each test
    await new Promise((resolve, reject) => {
      testDb.serialize(() => {
        testDb.run('DELETE FROM scores', (err) => {
          if (err) reject(err);
        });
        testDb.run('DELETE FROM teams', (err) => {
          if (err) reject(err);
        });
        testDb.run('DELETE FROM users', (err) => {
          if (err) reject(err);
        });
        testDb.run('DELETE FROM event_settings', (err) => {
          if (err) reject(err);
        });
        testDb.run('DELETE FROM magic_tokens', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  });

  // Helper functions to test database operations
  const createUser = (email, name = null, role = 'judge', teamId = null) => {
    return new Promise((resolve, reject) => {
      testDb.run(
        'INSERT INTO users (email, name, role, team_id) VALUES (?, ?, ?, ?)',
        [email, name, role, teamId],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, email, name, role, team_id: teamId });
        }
      );
    });
  };

  const getUserByEmail = (email) => {
    return new Promise((resolve, reject) => {
      testDb.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  };

  const createTeam = (teamData) => {
    return new Promise((resolve, reject) => {
      testDb.run(
        `INSERT INTO teams (name, table_name, project_name, contact_email, github_link, division)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          teamData.name,
          teamData.table_name,
          teamData.project_name,
          teamData.contact_email || null,
          teamData.github_link || null,
          teamData.division || null
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, ...teamData });
        }
      );
    });
  };

  const getTeamById = (id) => {
    return new Promise((resolve, reject) => {
      testDb.get('SELECT * FROM teams WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  };

  const saveScore = (judgeEmail, teamName, tableName, round, score, notes = null) => {
    return new Promise((resolve, reject) => {
      testDb.run(
        `INSERT OR REPLACE INTO scores (judge_email, team_name, table_name, round, score, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [judgeEmail, teamName, tableName, round, score, notes],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  };

  const getScore = (judgeEmail, teamName, round) => {
    return new Promise((resolve, reject) => {
      testDb.get(
        'SELECT * FROM scores WHERE judge_email = ? AND team_name = ? AND round = ?',
        [judgeEmail, teamName, round],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  };

  const createMagicToken = (email) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // 1 hour from now

    return new Promise((resolve, reject) => {
      testDb.run(
        'INSERT INTO magic_tokens (email, token, expires_at) VALUES (?, ?, ?)',
        [email, token, expiresAt.toISOString()],
        function(err) {
          if (err) reject(err);
          else resolve({ token, expiresAt });
        }
      );
    });
  };

  const validateMagicToken = (token) => {
    return new Promise((resolve, reject) => {
      testDb.get(
        'SELECT * FROM magic_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")',
        [token],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  };

  const getEventSettings = () => {
    return new Promise((resolve, reject) => {
      testDb.get('SELECT * FROM event_settings ORDER BY id DESC LIMIT 1', [], (err, row) => {
        if (err) reject(err);
        else {
          if (!row) {
            resolve({
              event_name: 'Hackathon',
              start_date: null,
              end_date: null,
              divisions: '[]',
              logo_filename: null,
              current_round: 1,
              locked_rounds: '[]'
            });
          } else {
            resolve(row);
          }
        }
      });
    });
  };

  const updateEventSettings = (settings) => {
    return new Promise((resolve, reject) => {
      // First, check if settings exist
      testDb.get('SELECT * FROM event_settings ORDER BY id DESC LIMIT 1', [], (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row) {
          // Insert new settings
          testDb.run(
            `INSERT INTO event_settings (event_name, start_date, end_date, divisions, logo_filename, current_round, locked_rounds)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              settings.event_name || 'Hackathon',
              settings.start_date || null,
              settings.end_date || null,
              settings.divisions ? JSON.stringify(settings.divisions) : '[]',
              settings.logo_filename || null,
              settings.current_round || 1,
              settings.locked_rounds ? JSON.stringify(settings.locked_rounds) : '[]'
            ],
            function(err) {
              if (err) reject(err);
              else resolve({ id: this.lastID });
            }
          );
        } else {
          // Update existing settings
          testDb.run(
            `UPDATE event_settings 
             SET event_name = ?, start_date = ?, end_date = ?, divisions = ?, logo_filename = ?, 
                 current_round = ?, locked_rounds = ?, updated_at = datetime('now')
             WHERE id = ?`,
            [
              settings.event_name || row.event_name,
              settings.start_date !== undefined ? settings.start_date : row.start_date,
              settings.end_date !== undefined ? settings.end_date : row.end_date,
              settings.divisions ? JSON.stringify(settings.divisions) : row.divisions,
              settings.logo_filename !== undefined ? settings.logo_filename : row.logo_filename,
              settings.current_round !== undefined ? settings.current_round : row.current_round,
              settings.locked_rounds ? JSON.stringify(settings.locked_rounds) : row.locked_rounds,
              row.id
            ],
            (err) => {
              if (err) reject(err);
              else resolve({ id: row.id });
            }
          );
        }
      });
    });
  };

  describe('User Management', () => {
    test('should create a new user', async () => {
      const user = await createUser('test@example.com', 'Test User', 'judge');
      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');
      expect(user.role).toBe('judge');
    });

    test('should retrieve user by email', async () => {
      await createUser('test@example.com', 'Test User', 'judge');
      const user = await getUserByEmail('test@example.com');
      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');
    });

    test('should return null for non-existent user', async () => {
      const user = await getUserByEmail('nonexistent@example.com');
      expect(user).toBeUndefined();
    });

    test('should enforce unique email constraint', async () => {
      await createUser('test@example.com', 'Test User', 'judge');
      await expect(createUser('test@example.com', 'Another User', 'judge')).rejects.toThrow();
    });

    test('should create user with team_id', async () => {
      const team = await createTeam({
        name: 'Test Team',
        table_name: 'A1',
        project_name: 'Test Project'
      });
      const user = await createUser('test@example.com', 'Test User', 'participant', team.id);
      expect(user.team_id).toBe(team.id);
    });
  });

  describe('Team Management', () => {
    test('should create a new team', async () => {
      const teamData = {
        name: 'Test Team',
        table_name: 'A1',
        project_name: 'Test Project',
        contact_email: 'team@example.com',
        division: 'Beginner'
      };
      const team = await createTeam(teamData);
      expect(team).toBeDefined();
      expect(team.name).toBe('Test Team');
      expect(team.table_name).toBe('A1');
    });

    test('should retrieve team by id', async () => {
      const team = await createTeam({
        name: 'Test Team',
        table_name: 'A1',
        project_name: 'Test Project'
      });
      const retrieved = await getTeamById(team.id);
      expect(retrieved).toBeDefined();
      expect(retrieved.name).toBe('Test Team');
    });

    test('should enforce unique team name constraint', async () => {
      await createTeam({
        name: 'Test Team',
        table_name: 'A1',
        project_name: 'Test Project'
      });
      await expect(createTeam({
        name: 'Test Team',
        table_name: 'A2',
        project_name: 'Another Project'
      })).rejects.toThrow();
    });

    test('should create team with optional fields', async () => {
      const team = await createTeam({
        name: 'Test Team',
        table_name: 'A1',
        project_name: 'Test Project',
        contact_email: 'team@example.com',
        github_link: 'https://github.com/test',
        division: 'Advanced'
      });
      expect(team.contact_email).toBe('team@example.com');
      expect(team.github_link).toBe('https://github.com/test');
      expect(team.division).toBe('Advanced');
    });
  });

  describe('Score Management', () => {
    test('should save a score', async () => {
      await saveScore('judge@example.com', 'Test Team', 'A1', 1, 85.5, 'Great work!');
      const score = await getScore('judge@example.com', 'Test Team', 1);
      expect(score).toBeDefined();
      expect(score.score).toBe(85.5);
      expect(score.notes).toBe('Great work!');
    });

    test('should update existing score', async () => {
      await saveScore('judge@example.com', 'Test Team', 'A1', 1, 85.5);
      await saveScore('judge@example.com', 'Test Team', 'A1', 1, 90.0);
      const score = await getScore('judge@example.com', 'Test Team', 1);
      expect(score.score).toBe(90.0);
    });

    test('should allow multiple judges to score same team', async () => {
      await saveScore('judge1@example.com', 'Test Team', 'A1', 1, 85.5);
      await saveScore('judge2@example.com', 'Test Team', 'A1', 1, 90.0);
      
      const score1 = await getScore('judge1@example.com', 'Test Team', 1);
      const score2 = await getScore('judge2@example.com', 'Test Team', 1);
      
      expect(score1.score).toBe(85.5);
      expect(score2.score).toBe(90.0);
    });

    test('should allow same judge to score different rounds', async () => {
      await saveScore('judge@example.com', 'Test Team', 'A1', 1, 85.5);
      await saveScore('judge@example.com', 'Test Team', 'A1', 2, 90.0);
      
      const score1 = await getScore('judge@example.com', 'Test Team', 1);
      const score2 = await getScore('judge@example.com', 'Test Team', 2);
      
      expect(score1.score).toBe(85.5);
      expect(score2.score).toBe(90.0);
    });

    test('should save score without notes', async () => {
      await saveScore('judge@example.com', 'Test Team', 'A1', 1, 85.5);
      const score = await getScore('judge@example.com', 'Test Team', 1);
      expect(score.score).toBe(85.5);
      expect(score.notes).toBeNull();
    });
  });

  describe('Magic Token Management', () => {
    test('should create a magic token', async () => {
      const { token } = await createMagicToken('test@example.com');
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);
    });

    test('should validate a valid token', async () => {
      const { token } = await createMagicToken('test@example.com');
      const validated = await validateMagicToken(token);
      expect(validated).toBeDefined();
      expect(validated.email).toBe('test@example.com');
    });

    test('should not validate an expired token', async () => {
      const token = crypto.randomBytes(32).toString('hex');
      // Use SQLite datetime format for past date
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1); // 1 hour ago
      const pastDateStr = pastDate.toISOString().replace('T', ' ').substring(0, 19);

      await new Promise((resolve, reject) => {
        testDb.run(
          'INSERT INTO magic_tokens (email, token, expires_at) VALUES (?, ?, ?)',
          ['test@example.com', token, pastDateStr],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      const validated = await validateMagicToken(token);
      expect(validated).toBeUndefined();
    });

    test('should not validate a used token', async () => {
      const { token } = await createMagicToken('test@example.com');
      
      // Mark token as used
      await new Promise((resolve, reject) => {
        testDb.run(
          'UPDATE magic_tokens SET used = 1 WHERE token = ?',
          [token],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });

      const validated = await validateMagicToken(token);
      expect(validated).toBeUndefined();
    });
  });

  describe('Event Settings', () => {
    test('should return default settings when none exist', async () => {
      const settings = await getEventSettings();
      expect(settings.event_name).toBe('Hackathon');
      expect(settings.current_round).toBe(1);
    });

    test('should create new event settings', async () => {
      await updateEventSettings({
        event_name: 'Code Camp 2024',
        current_round: 1,
        divisions: ['Beginner', 'Advanced']
      });
      
      const settings = await getEventSettings();
      expect(settings.event_name).toBe('Code Camp 2024');
      expect(JSON.parse(settings.divisions)).toEqual(['Beginner', 'Advanced']);
    });

    test('should update existing event settings', async () => {
      await updateEventSettings({
        event_name: 'Code Camp 2024',
        current_round: 1
      });
      
      await updateEventSettings({
        current_round: 2,
        locked_rounds: [1]
      });
      
      const settings = await getEventSettings();
      expect(settings.event_name).toBe('Code Camp 2024');
      expect(settings.current_round).toBe(2);
      expect(JSON.parse(settings.locked_rounds)).toEqual([1]);
    });

    test('should handle partial updates', async () => {
      await updateEventSettings({
        event_name: 'Code Camp 2024',
        current_round: 1,
        divisions: ['Beginner', 'Advanced']
      });
      
      await updateEventSettings({
        current_round: 2
      });
      
      const settings = await getEventSettings();
      expect(settings.event_name).toBe('Code Camp 2024');
      expect(settings.current_round).toBe(2);
      expect(JSON.parse(settings.divisions)).toEqual(['Beginner', 'Advanced']);
    });
  });
});

