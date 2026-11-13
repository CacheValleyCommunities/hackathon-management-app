const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-scores-'));
const previousDbPath = process.env.JUDGING_DB_PATH;
process.env.JUDGING_DB_PATH = path.join(tempDir, 'judging.db');

const db = require('../db/database');

const criteriaFor = (scoreId) => new Promise((resolve, reject) => {
  db.getDb().all(
    'SELECT criterion, value FROM score_criteria WHERE score_id = ? ORDER BY criterion',
    [scoreId],
    (err, rows) => (err ? reject(err) : resolve(rows || []))
  );
});

describe('rubric scores', () => {
  let eventId;

  beforeAll(async () => {
    await db.init();
    eventId = (await db.listEvents())[0].id;
    await db.syncTables(eventId, [{ name: 'A1' }]);
    await db.createTeam({
      name: 'Rubric Team',
      table_name: 'A1',
      project_name: 'Rubric project',
      division: 'Novice',
      event_id: eventId,
      registration_type: 'individual'
    });
  });

  afterAll(async () => {
    await db.close();
    if (previousDbPath === undefined) {
      delete process.env.JUDGING_DB_PATH;
    } else {
      process.env.JUDGING_DB_PATH = previousDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('saves the sum and replaces the four criterion rows', async () => {
    const first = await db.saveScore(
      eventId,
      'judge@example.com',
      'Rubric Team',
      'A1',
      1,
      0,
      'notes',
      { technical: 5, aesthetics: 5, uniqueness: 5, viability: 5 }
    );
    const saved = await db.getScore(eventId, 'judge@example.com', 'Rubric Team', 1);
    expect(saved.score).toBe(20);
    expect(saved.criteria).toEqual({ technical: 5, aesthetics: 5, uniqueness: 5, viability: 5 });
    expect(saved.rubricBreakdown.map((item) => item.value)).toEqual([5, 5, 5, 5]);

    await db.saveScore(
      eventId,
      'judge@example.com',
      'Rubric Team',
      'A1',
      1,
      0,
      'revised',
      { technical: 1, aesthetics: 2, uniqueness: 3, viability: 4 }
    );
    const updated = await db.getScore(eventId, 'judge@example.com', 'Rubric Team', 1);
    expect(updated.id).toBe(first.id);
    expect(updated.score).toBe(10);
    expect(updated.notes).toBe('revised');
    const rows = await criteriaFor(updated.id);
    expect(rows).toEqual([
      { criterion: 'aesthetics', value: 2 },
      { criterion: 'technical', value: 1 },
      { criterion: 'uniqueness', value: 3 },
      { criterion: 'viability', value: 4 }
    ]);
  });

  test('admin update stores a new composite and delete removes the criterion rows', async () => {
    const existing = await db.getScore(eventId, 'judge@example.com', 'Rubric Team', 1);
    await db.updateScoreById(existing.id, 0, 'admin notes', {
      technical: 2,
      aesthetics: 2,
      uniqueness: 2,
      viability: 2
    });
    const updated = await db.getScoreById(existing.id);
    expect(updated.score).toBe(8);
    expect(updated.notes).toBe('admin notes');
    expect(await criteriaFor(existing.id)).toHaveLength(4);

    const deleted = await db.deleteScoreById(existing.id);
    expect(deleted.id).toBe(existing.id);
    expect(await db.getScoreById(existing.id)).toBeNull();
    expect(await criteriaFor(existing.id)).toEqual([]);
  });

  test('a score saved without criteria keeps its number', async () => {
    await db.saveScore(eventId, 'legacy@example.com', 'Rubric Team', 'A1', 1, 17.5, '');
    const saved = await db.getScore(eventId, 'legacy@example.com', 'Rubric Team', 1);
    expect(saved.score).toBe(17.5);
    expect(saved.criteria).toBeNull();
    expect(saved.rubricBreakdown).toEqual([]);
  });
});
