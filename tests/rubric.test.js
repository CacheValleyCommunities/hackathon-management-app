const { compositeScore, parseRubricInput, RUBRIC_MAX } = require('../lib/rubric');

const perfect = {
  technical: '5',
  aesthetics: '5',
  uniqueness: '5',
  viability: '5'
};

describe('rubric composite', () => {
  test('four ratings of 5 sum to 20', () => {
    const parsed = parseRubricInput(perfect);
    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBe(20);
    expect(parsed.total).toBe(RUBRIC_MAX);
    expect(compositeScore(parsed.values)).toBe(20);
  });

  test('ratings add without weights', () => {
    const parsed = parseRubricInput({
      technical: '1',
      aesthetics: '2',
      uniqueness: '3',
      viability: '4'
    });
    expect(parsed).toMatchObject({
      ok: true,
      total: 10,
      values: { technical: 1, aesthetics: 2, uniqueness: 3, viability: 4 }
    });
  });

  test('viability is required', () => {
    const parsed = parseRubricInput({
      technical: '5',
      aesthetics: '5',
      uniqueness: '5'
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/Viability/);
  });

  test('rejects a missing criterion and an out-of-range rating', () => {
    expect(parseRubricInput({}).ok).toBe(false);
    expect(parseRubricInput({ ...perfect, technical: '0' }).ok).toBe(false);
    expect(parseRubricInput({ ...perfect, aesthetics: '6' }).ok).toBe(false);
    expect(parseRubricInput({ ...perfect, uniqueness: '3.5' }).ok).toBe(false);
    expect(parseRubricInput({ ...perfect, viability: 'high' }).ok).toBe(false);
  });
});
