const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-cap-'));
const previousDbPath = process.env.JUDGING_DB_PATH;
const previousJudgesPerTeam = process.env.JUDGES_PER_TEAM;

process.env.JUDGING_DB_PATH = path.join(tempDir, 'judging.db');
process.env.JUDGES_PER_TEAM = '2';

const db = require('../db/database');

const judgeEmail = (number) => `judge${number}@example.com`;

let eventId;

const createTeam = (name, division) => db.createTeam({
  name,
  table_name: 'A1',
  project_name: `${name} project`,
  division,
  event_id: eventId,
  registration_type: 'individual'
});

const divisionNames = (results, division) => (results[division] || []).map(team => team.team_name);

describe('judge cap and tie breaks', () => {
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

  test('a third judge cannot lock or submit once two judges have scored', async () => {
    await createTeam('Cap Team', 'Cap');

    const firstLock = await db.lockTeamForJudge(eventId, judgeEmail(1), 'Cap Team', 1);
    expect(firstLock.success).toBe(true);
    await db.saveScore(eventId, judgeEmail(1), 'Cap Team', 'A1', 1, 8, '');
    await db.markAssignmentCompleted(eventId, judgeEmail(1), 'Cap Team', 1);

    const secondLock = await db.lockTeamForJudge(eventId, judgeEmail(2), 'Cap Team', 1);
    expect(secondLock.success).toBe(true);
    await db.saveScore(eventId, judgeEmail(2), 'Cap Team', 'A1', 1, 9, '');
    await db.markAssignmentCompleted(eventId, judgeEmail(2), 'Cap Team', 1);

    const thirdLock = await db.lockTeamForJudge(eventId, judgeEmail(3), 'Cap Team', 1);
    expect(thirdLock).toEqual({ success: false, reason: 'team_full' });

    await expect(db.canJudgeSubmitNewScore(eventId, judgeEmail(3), 'Cap Team', 1)).resolves.toEqual({
      ok: false,
      reason: 'team_full'
    });

    await db.saveScore(eventId, judgeEmail(1), 'Cap Team', 'A1', 1, 7.5, 'updated');
    const updated = await db.getScore(eventId, judgeEmail(1), 'Cap Team', 1);
    expect(updated.score).toBe(7.5);
    await expect(db.canJudgeSubmitNewScore(eventId, judgeEmail(1), 'Cap Team', 1)).resolves.toEqual({
      ok: true,
      reason: 'edit'
    });
  });

  test('scores without an assignment still fill the judge cap', async () => {
    await createTeam('Manual Team', 'Cap');
    await db.saveScore(eventId, judgeEmail(1), 'Manual Team', 'A1', 1, 6, '');
    await db.saveScore(eventId, judgeEmail(2), 'Manual Team', 'A1', 1, 6, '');

    const stats = await db.getJudgeQueueStats(eventId, 1);
    const team = stats.find(row => row.team_name === 'Manual Team');
    expect(team.judge_count).toBe(2);

    const thirdLock = await db.lockTeamForJudge(eventId, judgeEmail(3), 'Manual Team', 1);
    expect(thirdLock).toEqual({ success: false, reason: 'team_full' });
    await expect(db.canJudgeSubmitNewScore(eventId, judgeEmail(1), 'Manual Team', 1)).resolves.toEqual({
      ok: true,
      reason: 'edit'
    });
  });

  test('a new score requires a queue assignment when the team still has room', async () => {
    await createTeam('Open Team', 'Cap');

    await expect(db.canJudgeSubmitNewScore(eventId, judgeEmail(1), 'Open Team', 1)).resolves.toEqual({
      ok: false,
      reason: 'not_assigned'
    });

    const lock = await db.lockTeamForJudge(eventId, judgeEmail(1), 'Open Team', 1);
    expect(lock.success).toBe(true);
    await expect(db.canJudgeSubmitNewScore(eventId, judgeEmail(1), 'Open Team', 1)).resolves.toEqual({
      ok: true,
      reason: 'assigned'
    });
  });

  test('deleting a score frees the judge slot', async () => {
    await createTeam('Delete Team', 'Cap');
    await db.lockTeamForJudge(eventId, judgeEmail(1), 'Delete Team', 1);
    await db.saveScore(eventId, judgeEmail(1), 'Delete Team', 'A1', 1, 5, '');
    await db.markAssignmentCompleted(eventId, judgeEmail(1), 'Delete Team', 1);
    await db.lockTeamForJudge(eventId, judgeEmail(2), 'Delete Team', 1);
    await db.saveScore(eventId, judgeEmail(2), 'Delete Team', 'A1', 1, 5, '');
    await db.markAssignmentCompleted(eventId, judgeEmail(2), 'Delete Team', 1);

    expect(await db.lockTeamForJudge(eventId, judgeEmail(3), 'Delete Team', 1)).toEqual({
      success: false,
      reason: 'team_full'
    });

    const secondScore = await db.getScore(eventId, judgeEmail(2), 'Delete Team', 1);
    const deleted = await db.deleteScoreById(secondScore.id);
    expect(deleted.judge_email).toBe(judgeEmail(2));

    const replacement = await db.lockTeamForJudge(eventId, judgeEmail(3), 'Delete Team', 1);
    expect(replacement.success).toBe(true);
  });

  test('tied teams follow the admin order, then team name', async () => {
    await createTeam('Apple', 'TieDivision');
    await createTeam('Zebra', 'TieDivision');
    await db.saveScore(eventId, judgeEmail(1), 'Apple', 'A1', 1, 10, '');
    await db.saveScore(eventId, judgeEmail(1), 'Zebra', 'A1', 1, 10, '');

    const before = await db.getTableResults(eventId, 1);
    const tied = before.TieDivision;
    expect(divisionNames(before, 'TieDivision')).toEqual(['Apple', 'Zebra']);
    expect(tied.every(team => team.scoreTied && !team.tieResolved)).toBe(true);

    await db.saveTieBreakOrder(eventId, 'TieDivision', 1, ['Zebra', 'Apple']);

    const after = await db.getTableResults(eventId, 1);
    expect(divisionNames(after, 'TieDivision')).toEqual(['Zebra', 'Apple']);
    expect(after.TieDivision.map(team => team.rank)).toEqual([1, 2]);
    expect(after.TieDivision.every(team => team.tieResolved)).toBe(true);
    expect(after.TieDivision[0].total_score).toBe(after.TieDivision[1].total_score);

    await db.saveScore(eventId, judgeEmail(1), 'Apple', 'A1', 1, 15, '');
    const separated = await db.getTableResults(eventId, 1);
    expect(divisionNames(separated, 'TieDivision')).toEqual(['Apple', 'Zebra']);
    expect(separated.TieDivision.every(team => team.scoreTied)).toBe(false);
  });
});
