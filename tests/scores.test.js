const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, '../test-scores.db');

describe('Score Management Functions', () => {
  let testDb;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    testDb = new sqlite3.Database(TEST_DB_PATH);
    
    await new Promise((resolve, reject) => {
      testDb.serialize(() => {
        testDb.run(`
          CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            table_name TEXT NOT NULL,
            project_name TEXT NOT NULL,
            division TEXT
          )
        `, (err) => {
          if (err) reject(err);
        });

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
    await new Promise((resolve, reject) => {
      testDb.serialize(() => {
        testDb.run('DELETE FROM scores', (err) => {
          if (err) reject(err);
        });
        testDb.run('DELETE FROM teams', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  });

  const createTeam = (name, tableName, division = 'Beginner') => {
    return new Promise((resolve, reject) => {
      testDb.run(
        'INSERT INTO teams (name, table_name, project_name, division) VALUES (?, ?, ?, ?)',
        [name, tableName, 'Project', division],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, name, table_name: tableName, division });
        }
      );
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

  const getJudgeScores = (judgeEmail, round = null, tableName = null) => {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM scores WHERE judge_email = ?';
      const params = [judgeEmail];

      if (round !== null) {
        query += ' AND round = ?';
        params.push(round);
      }

      if (tableName !== null) {
        query += ' AND table_name = ?';
        params.push(tableName);
      }

      query += ' ORDER BY round, team_name';

      testDb.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  };

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

      testDb.all(query, params, (err, rows) => {
        if (err) reject(err);
        else {
          const resultsByDivision = {};
          rows.forEach(row => {
            const division = row.division || 'Unassigned';
            if (!resultsByDivision[division]) {
              resultsByDivision[division] = [];
            }
            resultsByDivision[division].push(row);
          });

          // Add rankings
          Object.keys(resultsByDivision).forEach(division => {
            resultsByDivision[division].forEach((team, index) => {
              team.rank = index + 1;
            });
          });

          resolve(resultsByDivision);
        }
      });
    });
  };

  describe('Cumulative Scoring', () => {
    test('should calculate cumulative scores across rounds', async () => {
      await createTeam('Team A', 'A1', 'Beginner');
      await createTeam('Team B', 'A2', 'Beginner');

      // Round 1 scores
      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge2@test.com', 'Team A', 'A1', 1, 85);
      await saveScore('judge1@test.com', 'Team B', 'A2', 1, 90);

      // Round 2 scores
      await saveScore('judge1@test.com', 'Team A', 'A1', 2, 85);
      await saveScore('judge2@test.com', 'Team A', 'A1', 2, 90);
      await saveScore('judge1@test.com', 'Team B', 'A2', 2, 95);

      const results = await getTableResults(2);
      const beginnerResults = results['Beginner'] || [];

      const teamA = beginnerResults.find(t => t.team_name === 'Team A');
      const teamB = beginnerResults.find(t => t.team_name === 'Team B');

      expect(teamA.total_score).toBe(340); // 80 + 85 + 85 + 90
      expect(teamB.total_score).toBe(185); // 90 + 95
    });

    test('should only include scores up to specified round', async () => {
      await createTeam('Team A', 'A1', 'Beginner');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge1@test.com', 'Team A', 'A1', 2, 85);
      await saveScore('judge1@test.com', 'Team A', 'A1', 3, 90);

      const resultsRound1 = await getTableResults(1);
      const resultsRound2 = await getTableResults(2);
      const resultsRound3 = await getTableResults(3);

      const teamARound1 = resultsRound1['Beginner']?.find(t => t.team_name === 'Team A');
      const teamARound2 = resultsRound2['Beginner']?.find(t => t.team_name === 'Team A');
      const teamARound3 = resultsRound3['Beginner']?.find(t => t.team_name === 'Team A');

      expect(teamARound1.total_score).toBe(80);
      expect(teamARound2.total_score).toBe(165); // 80 + 85
      expect(teamARound3.total_score).toBe(255); // 80 + 85 + 90
    });
  });

  describe('Judge Scores Retrieval', () => {
    test('should get all scores for a judge', async () => {
      await createTeam('Team A', 'A1');
      await createTeam('Team B', 'A2');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge1@test.com', 'Team B', 'A2', 1, 90);
      await saveScore('judge1@test.com', 'Team A', 'A1', 2, 85);

      const scores = await getJudgeScores('judge1@test.com');
      expect(scores.length).toBe(3);
    });

    test('should filter scores by round', async () => {
      await createTeam('Team A', 'A1');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge1@test.com', 'Team A', 'A1', 2, 85);

      const scoresRound1 = await getJudgeScores('judge1@test.com', 1);
      expect(scoresRound1.length).toBe(1);
      expect(scoresRound1[0].round).toBe(1);
    });

    test('should filter scores by table name', async () => {
      await createTeam('Team A', 'A1');
      await createTeam('Team B', 'A2');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge1@test.com', 'Team B', 'A2', 1, 90);

      const scores = await getJudgeScores('judge1@test.com', null, 'A1');
      expect(scores.length).toBe(1);
      expect(scores[0].table_name).toBe('A1');
    });
  });

  describe('Division-based Results', () => {
    test('should group results by division', async () => {
      await createTeam('Team A', 'A1', 'Beginner');
      await createTeam('Team B', 'A2', 'Advanced');
      await createTeam('Team C', 'A3', 'Beginner');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge1@test.com', 'Team B', 'A2', 1, 90);
      await saveScore('judge1@test.com', 'Team C', 'A3', 1, 85);

      const results = await getTableResults(1);
      expect(results['Beginner']).toBeDefined();
      expect(results['Advanced']).toBeDefined();
      expect(results['Beginner'].length).toBe(2);
      expect(results['Advanced'].length).toBe(1);
    });

    test('should rank teams within divisions', async () => {
      await createTeam('Team A', 'A1', 'Beginner');
      await createTeam('Team B', 'A2', 'Beginner');
      await createTeam('Team C', 'A3', 'Beginner');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 90);
      await saveScore('judge1@test.com', 'Team B', 'A2', 1, 80);
      await saveScore('judge1@test.com', 'Team C', 'A3', 1, 85);

      const results = await getTableResults(1);
      const beginnerResults = results['Beginner'];

      expect(beginnerResults[0].team_name).toBe('Team A');
      expect(beginnerResults[0].rank).toBe(1);
      expect(beginnerResults[1].team_name).toBe('Team C');
      expect(beginnerResults[1].rank).toBe(2);
      expect(beginnerResults[2].team_name).toBe('Team B');
      expect(beginnerResults[2].rank).toBe(3);
    });
  });

  describe('Judge Count and Rounds Completed', () => {
    test('should count unique judges per team', async () => {
      await createTeam('Team A', 'A1');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge2@test.com', 'Team A', 'A1', 1, 85);
      await saveScore('judge1@test.com', 'Team A', 'A1', 2, 90);

      const results = await getTableResults(2);
      // Teams without division will have null division, which becomes 'Unassigned' in the grouping
      const division = Object.keys(results)[0]; // Get first division (should be 'Unassigned' or null)
      const teamA = results[division]?.find(t => t.team_name === 'Team A');
      expect(teamA).toBeDefined();
      expect(parseInt(teamA.judge_count)).toBe(2);
    });

    test('should count rounds completed', async () => {
      await createTeam('Team A', 'A1');

      await saveScore('judge1@test.com', 'Team A', 'A1', 1, 80);
      await saveScore('judge1@test.com', 'Team A', 'A1', 2, 85);
      await saveScore('judge1@test.com', 'Team A', 'A1', 3, 90);

      const results = await getTableResults(3);
      // Teams without division will have null division, which becomes 'Unassigned' in the grouping
      const division = Object.keys(results)[0]; // Get first division (should be 'Unassigned' or null)
      const teamA = results[division]?.find(t => t.team_name === 'Team A');
      expect(teamA).toBeDefined();
      expect(parseInt(teamA.rounds_completed)).toBe(3);
    });
  });
});

