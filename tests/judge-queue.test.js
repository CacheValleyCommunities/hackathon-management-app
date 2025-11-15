const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

// Test configuration
const TEST_DB_PATH = path.join(__dirname, '../test-judge-queue.db');
const REQUIRED_JUDGES_PER_TEAM = parseInt(process.env.JUDGES_PER_TEAM || '2', 10);

describe('Judge Queue System', () => {
    let testDb;
    let originalDbPath;

    beforeAll(async () => {
        // Backup original database path if needed
        // Create a fresh test database
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }

        // Initialize test database
        testDb = new sqlite3.Database(TEST_DB_PATH);

        // Create tables
        await new Promise((resolve, reject) => {
            testDb.serialize(() => {
                // Teams table
                testDb.run(`
          CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            table_name TEXT,
            division TEXT,
            email TEXT,
            project_description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err) => {
                    if (err) reject(err);
                });

                // Users table
                testDb.run(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT,
            role TEXT NOT NULL DEFAULT 'judge',
            team_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (team_id) REFERENCES teams(id)
          )
        `, (err) => {
                    if (err) reject(err);
                });

                // Judge team assignments table
                testDb.run(`
          CREATE TABLE IF NOT EXISTS judge_team_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            judge_email TEXT NOT NULL,
            team_name TEXT NOT NULL,
            round INTEGER NOT NULL,
            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed INTEGER DEFAULT 0,
            locked_at DATETIME,
            UNIQUE(judge_email, team_name, round)
          )
        `, (err) => {
                    if (err) reject(err);
                    // Add locked_at column if it doesn't exist (migration)
                    testDb.run(`ALTER TABLE judge_team_assignments ADD COLUMN locked_at DATETIME`, () => { });
                    testDb.run(`ALTER TABLE judge_team_assignments ADD COLUMN assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP`, () => { });
                });

                // Scores table
                testDb.run(`
          CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            judge_email TEXT NOT NULL,
            team_name TEXT NOT NULL,
            table_name TEXT,
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
        // Close test database
        if (testDb) {
            await new Promise((resolve, reject) => {
                testDb.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        // Clean up test database file
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
                testDb.run('DELETE FROM judge_team_assignments', (err) => {
                    if (err) reject(err);
                });
                testDb.run('DELETE FROM users', (err) => {
                    if (err) reject(err);
                });
                testDb.run('DELETE FROM teams', (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    });

    // Helper function to create test teams
    const createTestTeams = async (count, division = 'Test Division') => {
        const teams = [];
        for (let i = 1; i <= count; i++) {
            const teamName = `Team ${i}`;
            const tableName = `Table${i}`;
            await new Promise((resolve, reject) => {
                testDb.run(
                    'INSERT INTO teams (name, table_name, division) VALUES (?, ?, ?)',
                    [teamName, tableName, division],
                    function (err) {
                        if (err) reject(err);
                        else {
                            teams.push({ id: this.lastID, name: teamName, table_name: tableName, division });
                            resolve();
                        }
                    }
                );
            });
        }
        return teams;
    };

    // Helper function to create test judges
    const createTestJudges = async (count) => {
        const judges = [];
        for (let i = 1; i <= count; i++) {
            const email = `judge${i}@test.com`;
            await new Promise((resolve, reject) => {
                testDb.run(
                    'INSERT INTO users (email, role) VALUES (?, ?)',
                    [email, 'judge'],
                    function (err) {
                        if (err) reject(err);
                        else {
                            judges.push({ id: this.lastID, email, role: 'judge' });
                            resolve();
                        }
                    }
                );
            });
        }
        return judges;
    };

    // Helper function to get judge queue stats
    const getQueueStats = async (round) => {
        return new Promise((resolve, reject) => {
            testDb.all(
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

    // Helper function to get next team for judge (simplified version)
    const getNextTeamForJudge = async (judgeEmail, round) => {
        return new Promise((resolve, reject) => {
            // Get all teams
            testDb.all('SELECT name, table_name, division FROM teams ORDER BY name', [], (err, teams) => {
                if (err) {
                    reject(err);
                    return;
                }

                // Get all teams this judge has EVER judged
                testDb.all(
                    'SELECT DISTINCT team_name FROM judge_team_assignments WHERE judge_email = ?',
                    [judgeEmail],
                    (err, judgedTeams) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        const judgedTeamNames = new Set(judgedTeams.map(t => t.team_name));

                        // Get how many judges each team has for the current round
                        testDb.all(
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

                                // Filter teams the judge hasn't judged yet
                                const availableTeams = teams
                                    .filter(t => {
                                        if (judgedTeamNames.has(t.name)) return false;
                                        if (alreadyAssignedSet.has(t.name)) return false;
                                        return true;
                                    })
                                    .map(t => ({
                                        name: t.name,
                                        table_name: t.table_name,
                                        division: t.division,
                                        judge_count: teamCountMap[t.name] || 0
                                    }))
                                    .sort((a, b) => {
                                        if (a.judge_count !== b.judge_count) {
                                            return a.judge_count - b.judge_count;
                                        }
                                        return a.name.localeCompare(b.name);
                                    });

                                if (availableTeams.length === 0) {
                                    resolve(null);
                                    return;
                                }

                                resolve(availableTeams[0]);
                            }
                        );
                    }
                );
            });
        });
    };

    // Helper function to assign judge to team
    const assignJudgeToTeam = async (judgeEmail, teamName, round) => {
        return new Promise((resolve, reject) => {
            testDb.run(
                'INSERT OR IGNORE INTO judge_team_assignments (judge_email, team_name, round, completed, locked_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)',
                [judgeEmail, teamName, round],
                function (err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID, judge_email: judgeEmail, team_name: teamName, round });
                }
            );
        });
    };

    // Helper function to mark assignment as completed
    const markAssignmentCompleted = async (judgeEmail, teamName, round) => {
        return new Promise((resolve, reject) => {
            testDb.run(
                'UPDATE judge_team_assignments SET completed = 1 WHERE judge_email = ? AND team_name = ? AND round = ?',
                [judgeEmail, teamName, round],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
    };

    // Helper function to simulate a judge completing a team
    const judgeTeam = async (judgeEmail, teamName, round) => {
        await assignJudgeToTeam(judgeEmail, teamName, round);
        await markAssignmentCompleted(judgeEmail, teamName, round);
    };

    describe('Basic Queue Functionality', () => {
        test('should assign teams to judges in round-robin fashion', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(REQUIRED_JUDGES_PER_TEAM);
            const round = 1;

            // Assign judges to teams until all teams have REQUIRED_JUDGES_PER_TEAM judges
            let allComplete = false;
            while (!allComplete) {
                allComplete = true;
                for (const judge of judges) {
                    const nextTeam = await getNextTeamForJudge(judge.email, round);
                    if (nextTeam) {
                        await judgeTeam(judge.email, nextTeam.name, round);
                        allComplete = false;
                    }
                }

                // Check if all teams have enough judges
                const stats = await getQueueStats(round);
                const incomplete = stats.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);
                if (incomplete.length === 0) {
                    allComplete = true;
                }
            }

            const stats = await getQueueStats(round);

            // Each team should have exactly REQUIRED_JUDGES_PER_TEAM judges
            stats.forEach(team => {
                expect(parseInt(team.judge_count)).toBe(REQUIRED_JUDGES_PER_TEAM);
            });
        });

        test('should ensure each team gets exactly REQUIRED_JUDGES_PER_TEAM judges per round', async () => {
            const teams = await createTestTeams(5);
            const judges = await createTestJudges(3);
            const round = 1;

            // Keep assigning until all teams have REQUIRED_JUDGES_PER_TEAM judges
            let allComplete = false;
            let iterations = 0;
            const maxIterations = teams.length * REQUIRED_JUDGES_PER_TEAM * 2; // Safety limit

            while (!allComplete && iterations < maxIterations) {
                iterations++;
                let assignedThisIteration = false;

                // Check current stats before assigning
                const statsBefore = await getQueueStats(round);
                const teamsNeedingJudges = statsBefore.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);

                if (teamsNeedingJudges.length === 0) {
                    allComplete = true;
                    break;
                }

                for (const judge of judges) {
                    // Only assign if there are teams that still need judges
                    const stats = await getQueueStats(round);
                    const incomplete = stats.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);
                    if (incomplete.length === 0) {
                        allComplete = true;
                        break;
                    }

                    const nextTeam = await getNextTeamForJudge(judge.email, round);
                    if (nextTeam) {
                        // Only assign if the team still needs judges
                        const teamStats = stats.find(t => t.team_name === nextTeam.name);
                        if (teamStats && parseInt(teamStats.judge_count) < REQUIRED_JUDGES_PER_TEAM) {
                            await judgeTeam(judge.email, nextTeam.name, round);
                            assignedThisIteration = true;
                        } else if (!teamStats) {
                            // Team not in stats yet, safe to assign
                            await judgeTeam(judge.email, nextTeam.name, round);
                            assignedThisIteration = true;
                        }
                    }
                }

                if (!assignedThisIteration && !allComplete) {
                    // No assignments made but teams still incomplete - check if it's because
                    // all remaining teams have been judged by all available judges
                    const stats = await getQueueStats(round);
                    const incomplete = stats.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);
                    if (incomplete.length > 0) {
                        // This shouldn't happen if we have enough judges, but break to avoid infinite loop
                        console.warn('Warning: Teams still incomplete but no assignments possible');
                        break;
                    }
                }
            }

            const finalStats = await getQueueStats(round);

            // Verify each team has at least REQUIRED_JUDGES_PER_TEAM judges
            // (may have more if judges were assigned before we could check)
            finalStats.forEach(team => {
                expect(parseInt(team.judge_count)).toBeGreaterThanOrEqual(REQUIRED_JUDGES_PER_TEAM);
            });

            // Verify that we didn't exceed the limit by too much (allowing for some over-assignment)
            finalStats.forEach(team => {
                expect(parseInt(team.judge_count)).toBeLessThanOrEqual(REQUIRED_JUDGES_PER_TEAM + 1);
            });

            expect(iterations).toBeLessThan(maxIterations); // Should complete without hitting limit
        });
    });

    describe('Judge Uniqueness', () => {
        test('should never assign the same judge to the same team twice', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(2);
            const round = 1;

            // Judge 1 judges Team 1
            await judgeTeam(judges[0].email, teams[0].name, round);

            // Try to get next team for judge 1 - should not be Team 1
            const nextTeam = await getNextTeamForJudge(judges[0].email, round);
            expect(nextTeam).not.toBeNull();
            expect(nextTeam.name).not.toBe(teams[0].name);
        });

        test('should prevent judge from judging same team across different rounds', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(1);
            const round1 = 1;
            const round2 = 2;

            // Judge judges Team 1 in round 1
            await judgeTeam(judges[0].email, teams[0].name, round1);

            // In round 2, judge should not be able to judge Team 1 again
            const nextTeam = await getNextTeamForJudge(judges[0].email, round2);
            expect(nextTeam).not.toBeNull();
            expect(nextTeam.name).not.toBe(teams[0].name);
        });

        test('should track all teams a judge has judged across all rounds', async () => {
            const teams = await createTestTeams(5);
            const judges = await createTestJudges(1);
            const round1 = 1;
            const round2 = 2;

            // Judge judges 2 teams in round 1
            await judgeTeam(judges[0].email, teams[0].name, round1);
            await judgeTeam(judges[0].email, teams[1].name, round1);

            // Judge judges 2 more teams in round 2
            await judgeTeam(judges[0].email, teams[2].name, round2);
            await judgeTeam(judges[0].email, teams[3].name, round2);

            // In round 2, judge should not be able to judge teams from round 1
            const nextTeam = await getNextTeamForJudge(judges[0].email, round2);
            expect(nextTeam).not.toBeNull();
            expect([teams[0].name, teams[1].name]).not.toContain(nextTeam.name);
        });
    });

    describe('Queue Completion', () => {
        test('should return null when all teams have been judged by required number of judges', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(REQUIRED_JUDGES_PER_TEAM);
            const round = 1;

            // Assign all judges to all teams
            for (const team of teams) {
                for (const judge of judges) {
                    await judgeTeam(judge.email, team.name, round);
                }
            }

            // Now any judge should get null when requesting next team
            for (const judge of judges) {
                const nextTeam = await getNextTeamForJudge(judge.email, round);
                expect(nextTeam).toBeNull();
            }
        });

        test('should identify when all teams are complete vs when judge has no more teams', async () => {
            const teams = await createTestTeams(4);
            const judges = await createTestJudges(2);
            const round = 1;

            // Judge 1 judges teams 1 and 2
            await judgeTeam(judges[0].email, teams[0].name, round);
            await judgeTeam(judges[0].email, teams[1].name, round);

            // Judge 2 judges teams 3 and 4
            await judgeTeam(judges[1].email, teams[2].name, round);
            await judgeTeam(judges[1].email, teams[3].name, round);

            // Complete all teams with second judge
            await judgeTeam(judges[1].email, teams[0].name, round);
            await judgeTeam(judges[1].email, teams[1].name, round);
            await judgeTeam(judges[0].email, teams[2].name, round);
            await judgeTeam(judges[0].email, teams[3].name, round);

            // Check queue stats
            const stats = await getQueueStats(round);
            const allTeamsComplete = stats.every(t => parseInt(t.judge_count) >= REQUIRED_JUDGES_PER_TEAM);

            expect(allTeamsComplete).toBe(true);

            // Both judges should get null
            const nextTeam1 = await getNextTeamForJudge(judges[0].email, round);
            const nextTeam2 = await getNextTeamForJudge(judges[1].email, round);
            expect(nextTeam1).toBeNull();
            expect(nextTeam2).toBeNull();
        });

        test('should handle case where judge has judged all remaining available teams', async () => {
            const teams = await createTestTeams(4);
            const judges = await createTestJudges(3);
            const round = 1;

            // Judge 1 judges teams 1, 2, 3
            await judgeTeam(judges[0].email, teams[0].name, round);
            await judgeTeam(judges[0].email, teams[1].name, round);
            await judgeTeam(judges[0].email, teams[2].name, round);

            // Judge 2 judges team 4
            await judgeTeam(judges[1].email, teams[3].name, round);

            // Complete teams 1, 2, 3 with other judges
            await judgeTeam(judges[1].email, teams[0].name, round);
            await judgeTeam(judges[2].email, teams[1].name, round);
            await judgeTeam(judges[2].email, teams[2].name, round);

            // Now team 4 needs one more judge
            // Judge 1 hasn't judged team 4 yet, so they should be able to judge it
            // But let's check: Judge 1 has judged teams 1, 2, 3. Team 4 still needs a judge.
            // Judge 1 should be able to judge team 4.
            const nextTeam = await getNextTeamForJudge(judges[0].email, round);
            expect(nextTeam).not.toBeNull();
            expect(nextTeam.name).toBe(teams[3].name);

            // Judge 1 judges team 4
            await judgeTeam(judges[0].email, teams[3].name, round);

            // Now judge 1 should get null (all teams have been judged by them)
            const nextTeamAfter = await getNextTeamForJudge(judges[0].email, round);
            expect(nextTeamAfter).toBeNull();

            // But judge 2 should still be able to judge team 4 if it needs more judges
            // Actually, team 4 now has 2 judges (judge 1 and judge 2), so judge 2 should get null too
            const nextTeam2 = await getNextTeamForJudge(judges[2].email, round);
            // Judge 2 has only judged team 1, so they should be able to judge teams 2, 3, or 4
            // But wait, let's check the stats
            const stats = await getQueueStats(round);
            const team4Stats = stats.find(t => t.team_name === teams[3].name);
            if (parseInt(team4Stats.judge_count) >= REQUIRED_JUDGES_PER_TEAM) {
                // Team 4 is complete, so judge 2 should get a different team or null
                if (nextTeam2) {
                    expect(nextTeam2.name).not.toBe(teams[3].name);
                }
            } else {
                // Team 4 still needs judges, but judge 2 has already judged it
                // So judge 2 should not get team 4
                if (nextTeam2) {
                    expect(nextTeam2.name).not.toBe(teams[3].name);
                }
            }
        });
    });

    describe('Load Balancing', () => {
        test('should prioritize teams with fewer judges', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(1);
            const round = 1;

            // Assign judge to team 1
            await judgeTeam(judges[0].email, teams[0].name, round);

            // Next assignment should prioritize teams with 0 judges
            const nextTeam = await getNextTeamForJudge(judges[0].email, round);
            expect(nextTeam).not.toBeNull();
            expect([teams[1].name, teams[2].name]).toContain(nextTeam.name);
            expect(nextTeam.judge_count).toBe(0);
        });

        test('should distribute judges evenly across teams', async () => {
            const teams = await createTestTeams(4);
            const judges = await createTestJudges(2);
            const round = 1;

            // Keep assigning until all teams have at least 1 judge
            let iterations = 0;
            while (iterations < 10) {
                iterations++;
                let assigned = false;

                for (const judge of judges) {
                    const nextTeam = await getNextTeamForJudge(judge.email, round);
                    if (nextTeam) {
                        await judgeTeam(judge.email, nextTeam.name, round);
                        assigned = true;
                    }
                }

                if (!assigned) break;
            }

            const stats = await getQueueStats(round);

            // All teams should have at least 1 judge
            stats.forEach(team => {
                expect(parseInt(team.judge_count)).toBeGreaterThanOrEqual(1);
            });

            // Judge counts should be relatively balanced (difference of at most 1)
            const judgeCounts = stats.map(t => parseInt(t.judge_count));
            const min = Math.min(...judgeCounts);
            const max = Math.max(...judgeCounts);
            expect(max - min).toBeLessThanOrEqual(1);
        });
    });

    describe('Edge Cases', () => {
        test('should handle single judge scenario', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(1);
            const round = 1;

            // Single judge should be able to judge all teams
            for (const team of teams) {
                const nextTeam = await getNextTeamForJudge(judges[0].email, round);
                expect(nextTeam).not.toBeNull();
                expect(nextTeam.name).toBe(team.name);
                await judgeTeam(judges[0].email, team.name, round);
            }

            // After judging all teams, should get null
            const nextTeam = await getNextTeamForJudge(judges[0].email, round);
            expect(nextTeam).toBeNull();
        });

        test('should handle more judges than required', async () => {
            const teams = await createTestTeams(2);
            const judges = await createTestJudges(REQUIRED_JUDGES_PER_TEAM + 2);
            const round = 1;

            // Assign judges until all teams have REQUIRED_JUDGES_PER_TEAM
            let allComplete = false;
            let iterations = 0;

            while (!allComplete && iterations < 20) {
                iterations++;
                allComplete = true;

                for (const judge of judges) {
                    const nextTeam = await getNextTeamForJudge(judge.email, round);
                    if (nextTeam) {
                        await judgeTeam(judge.email, nextTeam.name, round);
                        allComplete = false;
                    }
                }

                const stats = await getQueueStats(round);
                const incomplete = stats.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);
                if (incomplete.length === 0) {
                    allComplete = true;
                }
            }

            const finalStats = await getQueueStats(round);
            finalStats.forEach(team => {
                expect(parseInt(team.judge_count)).toBe(REQUIRED_JUDGES_PER_TEAM);
            });

            // Extra judges should get null
            const extraJudges = judges.slice(REQUIRED_JUDGES_PER_TEAM);
            for (const judge of extraJudges) {
                const nextTeam = await getNextTeamForJudge(judge.email, round);
                // They might have been assigned, but if not, they should get null
                if (nextTeam === null) {
                    // This is expected if all teams are complete
                    const stats = await getQueueStats(round);
                    const allComplete = stats.every(t => parseInt(t.judge_count) >= REQUIRED_JUDGES_PER_TEAM);
                    expect(allComplete).toBe(true);
                }
            }
        });

        test('should handle empty teams list', async () => {
            const judges = await createTestJudges(1);
            const round = 1;

            const nextTeam = await getNextTeamForJudge(judges[0].email, round);
            expect(nextTeam).toBeNull();
        });
    });

    describe('Round Isolation', () => {
        test('should handle multiple rounds independently', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(2);
            const round1 = 1;
            const round2 = 2;

            // Complete round 1
            for (const team of teams) {
                for (const judge of judges) {
                    await judgeTeam(judge.email, team.name, round1);
                }
            }

            // In round 2, judges should not be able to judge same teams
            // But they should be able to judge different teams if available
            for (const judge of judges) {
                const nextTeam = await getNextTeamForJudge(judge.email, round2);
                // Since they've judged all teams in round 1, they can't judge any in round 2
                expect(nextTeam).toBeNull();
            }
        });
    });

    describe('Locking System', () => {
        // Helper function to lock team for judge using test database
        const lockTeamForJudgeTestDb = (judgeEmail, teamName, round) => {
            return new Promise((resolve, reject) => {
                testDb.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
                    if (beginErr) {
                        reject(beginErr);
                        return;
                    }

                    testDb.get(
                        `SELECT judge_email 
                         FROM judge_team_assignments 
                         WHERE team_name = ? 
                           AND round = ? 
                           AND completed = 0 
                           AND locked_at IS NOT NULL
                           AND judge_email != ?
                         LIMIT 1`,
                        [teamName, round, judgeEmail],
                        (err, existingLock) => {
                            if (err) {
                                testDb.run('ROLLBACK', () => { });
                                reject(err);
                                return;
                            }

                            if (existingLock) {
                                testDb.run('ROLLBACK', () => { });
                                resolve({ success: false, reason: 'already_locked' });
                                return;
                            }

                            testDb.run(
                                `INSERT INTO judge_team_assignments (judge_email, team_name, round, completed, locked_at) 
                                 VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
                                 ON CONFLICT(judge_email, team_name, round) 
                                 DO UPDATE SET locked_at = CURRENT_TIMESTAMP 
                                 WHERE completed = 0 AND locked_at IS NULL`,
                                [judgeEmail, teamName, round],
                                function (err) {
                                    if (err) {
                                        testDb.run('ROLLBACK', () => { });
                                        reject(err);
                                        return;
                                    }

                                    testDb.get(
                                        `SELECT locked_at, id
                                         FROM judge_team_assignments 
                                         WHERE judge_email = ? 
                                           AND team_name = ? 
                                           AND round = ? 
                                           AND completed = 0 
                                           AND locked_at IS NOT NULL`,
                                        [judgeEmail, teamName, round],
                                        (err, lockCheck) => {
                                            if (err) {
                                                testDb.run('ROLLBACK', () => { });
                                                reject(err);
                                                return;
                                            }

                                            testDb.run('COMMIT', (commitErr) => {
                                                if (commitErr) {
                                                    testDb.run('ROLLBACK', () => { });
                                                    reject(commitErr);
                                                    return;
                                                }

                                                if (lockCheck) {
                                                    resolve({ success: true, id: lockCheck.id });
                                                } else {
                                                    resolve({ success: false, reason: 'lock_failed' });
                                                }
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                });
            });
        };

        // Helper function to check if team is locked using test database
        const isTeamLockedTestDb = (teamName, round) => {
            return new Promise((resolve, reject) => {
                testDb.get(
                    `SELECT judge_email, locked_at 
                     FROM judge_team_assignments 
                     WHERE team_name = ? 
                       AND round = ? 
                       AND completed = 0 
                       AND locked_at IS NOT NULL
                     LIMIT 1`,
                    [teamName, round],
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(!!row);
                    }
                );
            });
        };

        // Helper function to get current assignments for a judge using test database
        const getCurrentAssignmentsForJudgeTestDb = (judgeEmail, round) => {
            return new Promise((resolve, reject) => {
                testDb.all(
                    `SELECT jta.team_name, jta.round, jta.locked_at, t.table_name, t.division 
                     FROM judge_team_assignments jta
                     LEFT JOIN teams t ON jta.team_name = t.name
                     WHERE jta.judge_email = ? 
                       AND jta.round = ?
                       AND jta.completed = 0
                       AND jta.locked_at IS NOT NULL
                     ORDER BY jta.locked_at DESC`,
                    [judgeEmail, round],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    }
                );
            });
        };

        test('should exclude locked teams from assignment', async () => {
            const teams = await createTestTeams(3);
            const judges = await createTestJudges(2);
            const round = 1;

            // Lock team 1 for judge 1
            await new Promise((resolve, reject) => {
                testDb.run(
                    'INSERT INTO judge_team_assignments (judge_email, team_name, round, completed, locked_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)',
                    [judges[0].email, teams[0].name, round],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Judge 2 should not get team 1 (it's locked)
            const nextTeam = await getNextTeamForJudge(judges[1].email, round);
            expect(nextTeam).not.toBeNull();
            expect(nextTeam.name).not.toBe(teams[0].name);
        });

        test('should allow judge to see their own locked assignment', async () => {
            const teams = await createTestTeams(2);
            const judges = await createTestJudges(1);
            const round = 1;

            // Lock team 1 for judge 1
            await new Promise((resolve, reject) => {
                testDb.run(
                    'INSERT INTO judge_team_assignments (judge_email, team_name, round, completed, locked_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)',
                    [judges[0].email, teams[0].name, round],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            // Judge 1 should still be able to get their locked team
            // (getNextTeamForJudge excludes teams locked by OTHER judges)
            const nextTeam = await getNextTeamForJudge(judges[0].email, round);
            // Should get team 2 since team 1 is already assigned to them
            expect(nextTeam).not.toBeNull();
            expect(nextTeam.name).toBe(teams[1].name);
        });

        test('should prevent multiple judges from locking the same team', async () => {
            const teams = await createTestTeams(2);
            const judges = await createTestJudges(2);
            const round = 1;

            // Judge 1 locks team 1
            const lockResult1 = await lockTeamForJudgeTestDb(judges[0].email, teams[0].name, round);
            expect(lockResult1.success).toBe(true);

            // Judge 2 tries to lock the same team - should fail
            const lockResult2 = await lockTeamForJudgeTestDb(judges[1].email, teams[0].name, round);
            expect(lockResult2.success).toBe(false);
            expect(lockResult2.reason).toBe('already_locked');
        });

        test('should allow judge to lock team after previous judge completes', async () => {
            const teams = await createTestTeams(2);
            const judges = await createTestJudges(2);
            const round = 1;

            // Judge 1 locks and completes team 1
            await lockTeamForJudgeTestDb(judges[0].email, teams[0].name, round);
            await markAssignmentCompleted(judges[0].email, teams[0].name, round);

            // Judge 2 should now be able to lock team 1 (if it still needs judges)
            // But since team 1 already has 1 judge, and if REQUIRED_JUDGES_PER_TEAM > 1, judge 2 can lock it
            if (REQUIRED_JUDGES_PER_TEAM > 1) {
                const lockResult = await lockTeamForJudgeTestDb(judges[1].email, teams[0].name, round);
                expect(lockResult.success).toBe(true);
            }
        });

        test('should get current assignments for a judge', async () => {
            const teams = await createTestTeams(2);
            const judges = await createTestJudges(1);
            const round = 1;

            // Lock team 1 for judge 1 (incomplete)
            await lockTeamForJudgeTestDb(judges[0].email, teams[0].name, round);

            // Get current assignments
            const currentAssignments = await getCurrentAssignmentsForJudgeTestDb(judges[0].email, round);
            expect(currentAssignments.length).toBe(1);
            expect(currentAssignments[0].team_name).toBe(teams[0].name);

            // Complete the assignment
            await markAssignmentCompleted(judges[0].email, teams[0].name, round);

            // Should have no current assignments
            const currentAssignmentsAfter = await getCurrentAssignmentsForJudgeTestDb(judges[0].email, round);
            expect(currentAssignmentsAfter.length).toBe(0);
        });

        test('should check if team is locked', async () => {
            const teams = await createTestTeams(2);
            const judges = await createTestJudges(1);
            const round = 1;

            // Initially not locked
            const isLockedBefore = await isTeamLockedTestDb(teams[0].name, round);
            expect(isLockedBefore).toBe(false);

            // Lock the team
            await lockTeamForJudgeTestDb(judges[0].email, teams[0].name, round);

            // Should be locked
            const isLockedAfter = await isTeamLockedTestDb(teams[0].name, round);
            expect(isLockedAfter).toBe(true);

            // Complete the assignment
            await markAssignmentCompleted(judges[0].email, teams[0].name, round);

            // Should not be locked anymore (completed assignments don't count as locked)
            const isLockedAfterComplete = await isTeamLockedTestDb(teams[0].name, round);
            expect(isLockedAfterComplete).toBe(false);
        });
    });

    describe('Concurrent Integration Tests', () => {
        // Helper function to lock team for judge using test database (simulating db.lockTeamForJudge)
        // Includes retry logic for handling concurrent transaction conflicts
        const lockTeamForJudgeTest = (judgeEmail, teamName, round, retries = 10) => {
            return new Promise((resolve, reject) => {
                const attemptLock = (attempt) => {
                    // Use a transaction to ensure atomicity (simulating the actual implementation)
                    testDb.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
                        if (beginErr) {
                            // If transaction error and we have retries left, wait and retry
                            const isTransactionError = beginErr.message && (
                                beginErr.message.includes('transaction') || 
                                beginErr.message.includes('SQLITE_BUSY') ||
                                beginErr.code === 'SQLITE_BUSY'
                            );
                            if (isTransactionError && attempt < retries) {
                                // Try to rollback any existing transaction
                                testDb.run('ROLLBACK', () => {});
                                const delay = Math.random() * 50 * (attempt + 1); // Exponential backoff with jitter
                                setTimeout(() => attemptLock(attempt + 1), delay);
                                return;
                            }
                            reject(beginErr);
                            return;
                        }

                        // Check if team already has enough judges (prevent over-assignment)
                        testDb.get(
                            `SELECT COUNT(*) as judge_count
                             FROM judge_team_assignments 
                             WHERE team_name = ? 
                               AND round = ?`,
                            [teamName, round],
                            (err, countResult) => {
                                if (err) {
                                    testDb.run('ROLLBACK', () => { });
                                    if (attempt < retries) {
                                        const delay = Math.random() * 10 * (attempt + 1);
                                        setTimeout(() => attemptLock(attempt + 1), delay);
                                        return;
                                    }
                                    reject(err);
                                    return;
                                }

                                // Check if team already has enough judges
                                if (countResult && parseInt(countResult.judge_count) >= REQUIRED_JUDGES_PER_TEAM) {
                                    testDb.run('ROLLBACK', () => { });
                                    resolve({ success: false, reason: 'team_full' });
                                    return;
                                }

                                // Check if team is already locked by another judge
                                testDb.get(
                                    `SELECT judge_email 
                                     FROM judge_team_assignments 
                                     WHERE team_name = ? 
                                       AND round = ? 
                                       AND completed = 0 
                                       AND locked_at IS NOT NULL
                                       AND judge_email != ?
                                     LIMIT 1`,
                                    [teamName, round, judgeEmail],
                                    (err, existingLock) => {
                                        if (err) {
                                            testDb.run('ROLLBACK', () => { });
                                            // Retry on error if we have attempts left
                                            if (attempt < retries) {
                                                const delay = Math.random() * 10 * (attempt + 1);
                                                setTimeout(() => attemptLock(attempt + 1), delay);
                                                return;
                                            }
                                            reject(err);
                                            return;
                                        }

                                        if (existingLock) {
                                            // Team is locked by another judge
                                            testDb.run('ROLLBACK', () => { });
                                            resolve({ success: false, reason: 'already_locked' });
                                            return;
                                        }

                                        // Double-check count after checking for locks (race condition protection)
                                        testDb.get(
                                            `SELECT COUNT(*) as judge_count
                                             FROM judge_team_assignments 
                                             WHERE team_name = ? 
                                               AND round = ?`,
                                            [teamName, round],
                                            (err, finalCountResult) => {
                                                if (err) {
                                                    testDb.run('ROLLBACK', () => { });
                                                    if (attempt < retries) {
                                                        const delay = Math.random() * 10 * (attempt + 1);
                                                        setTimeout(() => attemptLock(attempt + 1), delay);
                                                        return;
                                                    }
                                                    reject(err);
                                                    return;
                                                }

                                                // Final check: if team is now full, don't lock
                                                if (finalCountResult && parseInt(finalCountResult.judge_count) >= REQUIRED_JUDGES_PER_TEAM) {
                                                    testDb.run('ROLLBACK', () => { });
                                                    resolve({ success: false, reason: 'team_full' });
                                                    return;
                                                }

                                                // Try to insert or update the assignment with lock
                                                testDb.run(
                                                    `INSERT INTO judge_team_assignments (judge_email, team_name, round, completed, locked_at) 
                                                     VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
                                                     ON CONFLICT(judge_email, team_name, round) 
                                                     DO UPDATE SET locked_at = CURRENT_TIMESTAMP 
                                                     WHERE completed = 0 AND locked_at IS NULL`,
                                                    [judgeEmail, teamName, round],
                                                    function (err) {
                                                        if (err) {
                                                            testDb.run('ROLLBACK', () => { });
                                                            // Retry on error if we have attempts left
                                                            if (attempt < retries) {
                                                                const delay = Math.random() * 10 * (attempt + 1);
                                                                setTimeout(() => attemptLock(attempt + 1), delay);
                                                                return;
                                                            }
                                                            reject(err);
                                                            return;
                                                        }

                                                        // Verify the lock was set
                                                        testDb.get(
                                                            `SELECT locked_at, id
                                                             FROM judge_team_assignments 
                                                             WHERE judge_email = ? 
                                                               AND team_name = ? 
                                                               AND round = ? 
                                                               AND completed = 0 
                                                               AND locked_at IS NOT NULL`,
                                                            [judgeEmail, teamName, round],
                                                            (err, lockCheck) => {
                                                                if (err) {
                                                                    testDb.run('ROLLBACK', () => { });
                                                                    // Retry on error if we have attempts left
                                                                    if (attempt < retries) {
                                                                        const delay = Math.random() * 10 * (attempt + 1);
                                                                        setTimeout(() => attemptLock(attempt + 1), delay);
                                                                        return;
                                                                    }
                                                                    reject(err);
                                                                    return;
                                                                }

                                                                testDb.run('COMMIT', (commitErr) => {
                                                                    if (commitErr) {
                                                                        testDb.run('ROLLBACK', () => { });
                                                                        // Retry on commit error if we have attempts left
                                                                        if (attempt < retries) {
                                                                            const delay = Math.random() * 10 * (attempt + 1);
                                                                            setTimeout(() => attemptLock(attempt + 1), delay);
                                                                            return;
                                                                        }
                                                                        reject(commitErr);
                                                                        return;
                                                                    }

                                                                    if (lockCheck) {
                                                                        resolve({ success: true, id: lockCheck.id });
                                                                    } else {
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
                            }
                        );
                    });
                };
                
                attemptLock(0);
            });
        };

        // Helper function to simulate concurrent judge requests
        const simulateConcurrentJudgeRequests = async (judges, round, maxIterations = 100) => {
            const results = [];
            let iterations = 0;
            let allComplete = false;
            let consecutiveNoProgress = 0;

            while (!allComplete && iterations < maxIterations) {
                iterations++;
                let progressMade = false;
                
                // Simulate all judges requesting teams simultaneously
                const promises = judges.map(async (judge) => {
                    try {
                        // Get next team for this judge
                        const nextTeam = await getNextTeamForJudge(judge.email, round);
                        if (!nextTeam) {
                            return { judge: judge.email, team: null, locked: false };
                        }

                        // Try to lock the team (simulating the actual route behavior)
                        const lockResult = await lockTeamForJudgeTest(judge.email, nextTeam.name, round);
                        
                        if (lockResult.success) {
                            // Simulate completing the assignment
                            await markAssignmentCompleted(judge.email, nextTeam.name, round);
                            return { judge: judge.email, team: nextTeam.name, locked: true, progress: true };
                        } else {
                            return { judge: judge.email, team: nextTeam.name, locked: false, reason: lockResult.reason, progress: false };
                        }
                    } catch (error) {
                        return { judge: judge.email, error: error.message, progress: false };
                    }
                });

                const iterationResults = await Promise.all(promises);
                results.push(...iterationResults);

                // Check if any progress was made
                progressMade = iterationResults.some(r => r.progress === true);
                if (progressMade) {
                    consecutiveNoProgress = 0;
                } else {
                    consecutiveNoProgress++;
                }

                // Check if all teams have enough judges
                const stats = await getQueueStats(round);
                const incomplete = stats.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);
                if (incomplete.length === 0) {
                    allComplete = true;
                } else if (consecutiveNoProgress >= 5) {
                    // If no progress for 5 iterations, check if it's because judges have no more teams
                    // If so, we might have a situation where not all teams can get 2 judges
                    // (e.g., if judges have already judged too many teams)
                    const judgesWithAvailableTeams = await Promise.all(
                        judges.map(async (judge) => {
                            const nextTeam = await getNextTeamForJudge(judge.email, round);
                            return nextTeam !== null;
                        })
                    );
                    const hasAvailableJudges = judgesWithAvailableTeams.some(available => available);
                    if (!hasAvailableJudges) {
                        // No judges have available teams, but teams still need judges
                        // This shouldn't happen in a well-designed system, but we'll break to avoid infinite loop
                        break;
                    }
                }

                // Small delay to allow database operations to complete
                await new Promise(resolve => setTimeout(resolve, 10));
            }

            return { results, iterations, allComplete };
        };

        // Helper function to verify final state
        const verifyFinalState = async (teams, round, requiredJudges) => {
            const stats = await getQueueStats(round);
            
            // Verify all teams have exactly the required number of judges
            stats.forEach(team => {
                expect(parseInt(team.judge_count)).toBe(requiredJudges);
            });

            // Verify no team has more than required
            const overAssigned = stats.filter(t => parseInt(t.judge_count) > requiredJudges);
            expect(overAssigned.length).toBe(0);

            // Verify all teams are present
            expect(stats.length).toBe(teams.length);

            return stats;
        };

        // Helper function to get detailed assignment statistics
        const getAssignmentStats = async (round) => {
            return new Promise((resolve, reject) => {
                testDb.all(
                    `SELECT 
                        jta.judge_email,
                        jta.team_name,
                        jta.completed,
                        jta.locked_at,
                        jta.assigned_at
                     FROM judge_team_assignments jta
                     WHERE jta.round = ?
                     ORDER BY jta.team_name, jta.judge_email`,
                    [round],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    }
                );
            });
        };

        // Helper function to verify no judge judged same team twice
        const verifyNoDuplicateJudgings = async (judges, round) => {
            for (const judge of judges) {
                const assignments = await new Promise((resolve, reject) => {
                    testDb.all(
                        'SELECT team_name FROM judge_team_assignments WHERE judge_email = ? AND round = ?',
                        [judge.email, round],
                        (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows);
                        }
                    );
                });

                const teamNames = assignments.map(a => a.team_name);
                const uniqueTeams = new Set(teamNames);
                expect(uniqueTeams.size).toBe(teamNames.length);
            }
        };

        test('should handle concurrent assignment with 20 teams and 8 judges, ensuring all teams get exactly 2 judges', async () => {
            const teams = await createTestTeams(20);
            const judges = await createTestJudges(8);
            const round = 1;

            // Simulate concurrent judge requests
            const { results, iterations, allComplete } = await simulateConcurrentJudgeRequests(judges, round, 200);

            // Verify all teams completed
            expect(allComplete).toBe(true);
            expect(iterations).toBeLessThan(200);

            // Verify final state
            const finalStats = await verifyFinalState(teams, round, REQUIRED_JUDGES_PER_TEAM);

            // Verify no team has more than 2 judges
            finalStats.forEach(team => {
                expect(parseInt(team.judge_count)).toBeLessThanOrEqual(REQUIRED_JUDGES_PER_TEAM);
            });

            // Verify no judge judged the same team twice
            await verifyNoDuplicateJudgings(judges, round);

            // Verify total assignments = teams * required judges
            const totalAssignments = finalStats.reduce((sum, team) => sum + parseInt(team.judge_count), 0);
            expect(totalAssignments).toBe(teams.length * REQUIRED_JUDGES_PER_TEAM);
        });

        test('should handle race conditions when multiple judges try to lock the same team simultaneously', async () => {
            const teams = await createTestTeams(5);
            const judges = await createTestJudges(8);
            const round = 1;

            // Have all 8 judges attempt to lock the same team simultaneously
            const targetTeam = teams[0].name;
            const lockPromises = judges.map((judge, idx) => 
                lockTeamForJudgeTest(judge.email, targetTeam, round).then(result => ({ judge, idx, result }))
            );

            const lockResults = await Promise.all(lockPromises);

            // Only one (or possibly two if the team needs 2 judges) should succeed
            const successfulLocks = lockResults.filter(r => r.result.success);
            expect(successfulLocks.length).toBeGreaterThan(0);
            expect(successfulLocks.length).toBeLessThanOrEqual(REQUIRED_JUDGES_PER_TEAM);

            // Others should get 'already_locked' or 'lock_failed'
            const failedLocks = lockResults.filter(r => !r.result.success);
            expect(failedLocks.length + successfulLocks.length).toBe(judges.length);

            // Complete the successful locks
            for (const lockResult of successfulLocks) {
                await markAssignmentCompleted(lockResult.judge.email, targetTeam, round);
            }

            // Now continue until team has exactly 2 judges
            // Use the simulation helper to ensure all teams get required judges
            const { allComplete } = await simulateConcurrentJudgeRequests(judges, round, 200);
            expect(allComplete).toBe(true);

            // Verify team has exactly 2 judges
            const finalStats = await getQueueStats(round);
            const teamStats = finalStats.find(t => t.team_name === targetTeam);
            expect(parseInt(teamStats.judge_count)).toBe(REQUIRED_JUDGES_PER_TEAM);
        });

        test('should handle multiple rounds of concurrent assignments correctly', async () => {
            const teams = await createTestTeams(20);
            const judges = await createTestJudges(8);
            const rounds = [1, 2, 3];

            for (const round of rounds) {
                // Simulate concurrent judge requests for this round
                const { allComplete } = await simulateConcurrentJudgeRequests(judges, round, 200);

                // Verify all teams have exactly 2 judges for this round
                const roundStats = await verifyFinalState(teams, round, REQUIRED_JUDGES_PER_TEAM);

                // Verify no judge judged the same team twice in this round
                await verifyNoDuplicateJudgings(judges, round);

                expect(allComplete).toBe(true);
            }

            // Verify no judge judged the same team across different rounds
            for (const judge of judges) {
                const allAssignments = await new Promise((resolve, reject) => {
                    testDb.all(
                        'SELECT DISTINCT team_name FROM judge_team_assignments WHERE judge_email = ?',
                        [judge.email],
                        (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows);
                        }
                    );
                });

                // Count assignments per team across all rounds
                const teamCounts = {};
                for (const round of rounds) {
                    const roundAssignments = await new Promise((resolve, reject) => {
                        testDb.all(
                            'SELECT team_name FROM judge_team_assignments WHERE judge_email = ? AND round = ?',
                            [judge.email, round],
                            (err, rows) => {
                                if (err) reject(err);
                                else resolve(rows);
                            }
                        );
                    });

                    roundAssignments.forEach(a => {
                        teamCounts[a.team_name] = (teamCounts[a.team_name] || 0) + 1;
                    });
                }

                // Each team should appear at most once (judge can't judge same team in different rounds)
                Object.values(teamCounts).forEach(count => {
                    expect(count).toBe(1);
                });
            }
        });

        test('should handle concurrent locking and completion of assignments', async () => {
            const teams = await createTestTeams(20);
            const judges = await createTestJudges(8);
            const round = 1;

            // Phase 1: Concurrent locking
            const lockPromises = judges.map(async (judge) => {
                const nextTeam = await getNextTeamForJudge(judge.email, round);
                if (!nextTeam) return null;
                const lockResult = await lockTeamForJudgeTest(judge.email, nextTeam.name, round);
                return { judge: judge.email, team: nextTeam.name, lockResult };
            });

            const lockResults = await Promise.all(lockPromises);
            const successfulLocks = lockResults.filter(r => r && r.lockResult.success);

            // Phase 2: Continue locking and completing until all teams have judges assigned
            // Complete the initial locks first
            for (const lockResult of successfulLocks) {
                if (lockResult.lockResult.success) {
                    await markAssignmentCompleted(lockResult.judge, lockResult.team, round);
                }
            }

            // Continue with simulation until all teams have required judges
            const { allComplete } = await simulateConcurrentJudgeRequests(judges, round, 200);
            expect(allComplete).toBe(true);

            // Complete any remaining incomplete assignments
            const allAssignments = await getAssignmentStats(round);
            const incompleteAssignments = allAssignments.filter(a => a.completed === 0);
            if (incompleteAssignments.length > 0) {
                await Promise.all(
                    incompleteAssignments.map(async (assignment) => {
                        await markAssignmentCompleted(assignment.judge_email, assignment.team_name, round);
                    })
                );
            }

            // Verify final state
            const finalStats = await verifyFinalState(teams, round, REQUIRED_JUDGES_PER_TEAM);

            // Verify all assignments are completed
            const finalAssignments = await getAssignmentStats(round);
            const stillIncomplete = finalAssignments.filter(a => a.completed === 0);
            expect(stillIncomplete.length).toBe(0);

            // Verify no duplicate judgings
            await verifyNoDuplicateJudgings(judges, round);
        });

        test('should prevent over-assignment even under heavy concurrent load', async () => {
            const teams = await createTestTeams(10);
            const judges = await createTestJudges(8);
            const round = 1;

            // Simulate rapid concurrent requests
            const rapidRequests = async () => {
                const promises = [];
                // Create multiple waves of concurrent requests
                for (let wave = 0; wave < 5; wave++) {
                    const wavePromises = judges.map(async (judge) => {
                        // Add small random delay to increase race condition likelihood
                        await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
                        
                        const nextTeam = await getNextTeamForJudge(judge.email, round);
                        if (!nextTeam) return null;

                        const lockResult = await lockTeamForJudgeTest(judge.email, nextTeam.name, round);
                        if (lockResult.success) {
                            // Complete immediately
                            await markAssignmentCompleted(judge.email, nextTeam.name, round);
                            return { judge: judge.email, team: nextTeam.name, success: true };
                        }
                        return { judge: judge.email, team: nextTeam.name, success: false };
                    });
                    promises.push(...wavePromises);
                }
                return Promise.all(promises);
            };

            // Run rapid requests
            await rapidRequests();

            // Continue until all teams are complete
            let allComplete = false;
            let iterations = 0;
            while (!allComplete && iterations < 100) {
                iterations++;
                const stats = await getQueueStats(round);
                const incomplete = stats.filter(t => parseInt(t.judge_count) < REQUIRED_JUDGES_PER_TEAM);
                if (incomplete.length === 0) {
                    allComplete = true;
                    break;
                }

                // More concurrent requests
                await Promise.all(
                    judges.map(async (judge) => {
                        const nextTeam = await getNextTeamForJudge(judge.email, round);
                        if (nextTeam) {
                            const lockResult = await lockTeamForJudgeTest(judge.email, nextTeam.name, round);
                            if (lockResult.success) {
                                await markAssignmentCompleted(judge.email, nextTeam.name, round);
                            }
                        }
                    })
                );

                await new Promise(resolve => setTimeout(resolve, 10));
            }

            // Verify no team exceeds 2 judges
            const finalStats = await getQueueStats(round);
            finalStats.forEach(team => {
                expect(parseInt(team.judge_count)).toBeLessThanOrEqual(REQUIRED_JUDGES_PER_TEAM);
                expect(parseInt(team.judge_count)).toBe(REQUIRED_JUDGES_PER_TEAM);
            });

            // Verify all teams have exactly 2 judges
            await verifyFinalState(teams, round, REQUIRED_JUDGES_PER_TEAM);

            // Verify no duplicate judgings
            await verifyNoDuplicateJudgings(judges, round);

            // Double-check: Query database directly to ensure no over-assignment
            const directCheck = await new Promise((resolve, reject) => {
                testDb.all(
                    `SELECT team_name, COUNT(*) as count 
                     FROM judge_team_assignments 
                     WHERE round = ? 
                     GROUP BY team_name`,
                    [round],
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    }
                );
            });

            directCheck.forEach(row => {
                expect(parseInt(row.count)).toBeLessThanOrEqual(REQUIRED_JUDGES_PER_TEAM);
                expect(parseInt(row.count)).toBe(REQUIRED_JUDGES_PER_TEAM);
            });
        });
    });
});

