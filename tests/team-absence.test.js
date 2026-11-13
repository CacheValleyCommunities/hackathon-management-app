const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-absence-'));
const previousDbPath = process.env.JUDGING_DB_PATH;
const previousJudgesPerTeam = process.env.JUDGES_PER_TEAM;

process.env.JUDGING_DB_PATH = path.join(tempDir, 'judging.db');
process.env.JUDGES_PER_TEAM = '2';

const db = require('../db/database');

const judgeEmail = (number) => `absent-judge${number}@example.com`;

let eventId;

const createTeam = (name) => db.createTeam({
  name,
  table_name: 'A1',
  project_name: `${name} project`,
  division: 'Absence',
  event_id: eventId,
  registration_type: 'individual'
});

const markAbsent = async (judgeNumber, teamName) => {
  const email = judgeEmail(judgeNumber);
  const lock = await db.lockTeamForJudge(eventId, email, teamName, 1);
  expect(lock.success).toBe(true);
  const result = await db.markTeamAbsent(eventId, email, teamName, 1);
  expect(result.ok).toBe(true);
  return result;
};

describe('team absences', () => {
  beforeAll(async () => {
    await db.init();
    eventId = (await db.listEvents())[0].id;
    await db.syncTables(eventId, [{ name: 'A1' }]);
  });

  afterAll(async () => {
    await db.close();
    if (previousDbPath === undefined) {
      delete process.env.JUDGING_DB_PATH;
    } else {
      process.env.JUDGING_DB_PATH = previousDbPath;
    }
    if (previousJudgesPerTeam === undefined) {
      delete process.env.JUDGES_PER_TEAM;
    } else {
      process.env.JUDGES_PER_TEAM = previousJudgesPerTeam;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('one absence frees that judge and still allows a second judge', async () => {
    await createTeam('Absent Once');

    await expect(db.markTeamAbsent(eventId, judgeEmail(1), 'Absent Once', 1)).resolves.toEqual({
      ok: false,
      reason: 'not_assigned'
    });

    await markAbsent(1, 'Absent Once');

    await expect(db.getCurrentAssignmentsForJudge(eventId, judgeEmail(1), 1)).resolves.toEqual([]);

    const stats = await db.getJudgeQueueStats(eventId, 1);
    const team = stats.find(row => row.team_name === 'Absent Once');
    expect(team.judge_count).toBe(1);
    expect(team.absence_count).toBe(1);
    expect(team.score_count).toBe(0);
    expect(db.isConfirmedAbsent(team.absence_count, team.score_count)).toBe(false);

    const secondLock = await db.lockTeamForJudge(eventId, judgeEmail(2), 'Absent Once', 1);
    expect(secondLock.success).toBe(true);
  });

  test('a second absence removes the team from the queue', async () => {
    await createTeam('Absent Twice');
    await markAbsent(1, 'Absent Twice');
    await markAbsent(2, 'Absent Twice');

    expect(await db.lockTeamForJudge(eventId, judgeEmail(3), 'Absent Twice', 1)).toEqual({
      success: false,
      reason: 'team_absent'
    });
    const nextTeam = await db.getNextTeamForJudge(eventId, judgeEmail(3), 1);
    expect(nextTeam && nextTeam.name).not.toBe('Absent Twice');

    const stats = await db.getJudgeQueueStats(eventId, 1);
    const team = stats.find(row => row.team_name === 'Absent Twice');
    expect(db.isConfirmedAbsent(team.absence_count, team.score_count)).toBe(true);

    const results = await db.getTableResults(eventId, 1);
    const ranked = results.Absence || [];
    expect(ranked.map(row => row.team_name)).not.toContain('Absent Twice');
  });

  test('one absence plus one score fills the cap and stays ranked', async () => {
    await createTeam('Found Later');
    await markAbsent(1, 'Found Later');

    const secondLock = await db.lockTeamForJudge(eventId, judgeEmail(2), 'Found Later', 1);
    expect(secondLock.success).toBe(true);
    await db.saveScore(eventId, judgeEmail(2), 'Found Later', 'A1', 1, 8, '');
    await db.markAssignmentCompleted(eventId, judgeEmail(2), 'Found Later', 1);

    expect(await db.lockTeamForJudge(eventId, judgeEmail(3), 'Found Later', 1)).toEqual({
      success: false,
      reason: 'team_full'
    });

    const results = await db.getTableResults(eventId, 1);
    expect((results.Absence || []).map(row => row.team_name)).toContain('Found Later');
  });

  test('the reporting judge is not assigned that team again', async () => {
    await createTeam('Missed Team');
    await createTeam('Other Team');
    await markAbsent(1, 'Missed Team');

    const nextTeam = await db.getNextTeamForJudge(eventId, judgeEmail(1), 1);
    expect(nextTeam).not.toBeNull();
    expect(nextTeam.name).not.toBe('Missed Team');
  });

  test('removing an absence reopens that judge slot', async () => {
    await createTeam('Cleared Absence');
    await markAbsent(1, 'Cleared Absence');
    await markAbsent(2, 'Cleared Absence');

    expect(await db.lockTeamForJudge(eventId, judgeEmail(3), 'Cleared Absence', 1)).toEqual({
      success: false,
      reason: 'team_absent'
    });

    const absences = await db.listAbsences(eventId, { teamName: 'Cleared Absence' });
    expect(absences).toHaveLength(2);
    const removed = await db.deleteAbsenceById(absences[0].id);
    expect(removed.judge_email).toBe(absences[0].judge_email);

    const replacement = await db.lockTeamForJudge(eventId, judgeEmail(3), 'Cleared Absence', 1);
    expect(replacement.success).toBe(true);
  });
});
