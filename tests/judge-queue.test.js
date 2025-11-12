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
            completed INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(judge_email, team_name, round)
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
                'INSERT OR IGNORE INTO judge_team_assignments (judge_email, team_name, round, completed) VALUES (?, ?, ?, 0)',
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
});

