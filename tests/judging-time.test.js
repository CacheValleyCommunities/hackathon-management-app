const { parseJudgingMinutes, resolveJudgingSeconds, DEFAULT_JUDGING_SECONDS } = require('../lib/score-input');

describe('judging time setting', () => {
  test('defaults to 3 minutes', () => {
    expect(DEFAULT_JUDGING_SECONDS).toBe(180);
    expect(resolveJudgingSeconds(null)).toBe(180);
    expect(resolveJudgingSeconds(undefined)).toBe(180);
    expect(resolveJudgingSeconds('nope')).toBe(180);
  });

  test('accepts whole minutes from 1 to 60', () => {
    expect(parseJudgingMinutes('3')).toEqual({ ok: true, minutes: 3, seconds: 180 });
    expect(parseJudgingMinutes(' 1 ').seconds).toBe(60);
    expect(parseJudgingMinutes('60').seconds).toBe(3600);
    expect(resolveJudgingSeconds(300)).toBe(300);
  });

  test('rejects empty, fractional, and out of range values', () => {
    expect(parseJudgingMinutes('').ok).toBe(false);
    expect(parseJudgingMinutes('3.5').ok).toBe(false);
    expect(parseJudgingMinutes('0').ok).toBe(false);
    expect(parseJudgingMinutes('61').ok).toBe(false);
    expect(resolveJudgingSeconds(30)).toBe(180);
    expect(resolveJudgingSeconds(4000)).toBe(180);
  });
});
