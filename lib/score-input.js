const DEFAULT_MAX_SCORE = 100;
const MAX_SETTING = 1000;

const formatScore = (value) => {
  const rounded = Math.round(Number(value) * 10) / 10;
  if (!Number.isFinite(rounded)) return '';
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
};

const resolveMaxScore = (maxScore) => {
  const max = Number(maxScore);
  if (!Number.isFinite(max) || max <= 0) return DEFAULT_MAX_SCORE;
  return Math.round(max * 10) / 10;
};

const parseScoreInput = (raw, maxScore) => {
  const limit = resolveMaxScore(maxScore);
  const text = String(raw == null ? '' : raw).trim().replace(/,/g, '.').replace(/\.$/, '');
  if (!text) {
    return { ok: false, message: 'Enter a score.' };
  }
  if (!/^\d+(\.\d)?$/.test(text)) {
    return { ok: false, message: 'Use a number, like 8 or 8.5.' };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, message: 'Use a number, like 8 or 8.5.' };
  }
  if (value > limit) {
    return { ok: false, message: `The highest score is ${formatScore(limit)}.` };
  }
  return { ok: true, value, max: limit };
};

const parseMaxScoreSetting = (raw) => {
  const text = String(raw == null ? '' : raw).trim().replace(/,/g, '.');
  if (!text) {
    return { ok: false, message: 'Enter the highest score a judge can give.' };
  }
  if (!/^\d+(\.\d)?$/.test(text)) {
    return { ok: false, message: 'Use a number for the highest score, like 10 or 100.' };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: 'The highest score must be more than 0.' };
  }
  if (value > MAX_SETTING) {
    return { ok: false, message: `The highest score can be at most ${MAX_SETTING}.` };
  }
  return { ok: true, value };
};

module.exports = {
  DEFAULT_MAX_SCORE,
  formatScore,
  resolveMaxScore,
  parseScoreInput,
  parseMaxScoreSetting
};
