const DEFAULT_MAX_SCORE = 100;
const MAX_SETTING = 1000;
const DEFAULT_JUDGING_SECONDS = 180;
const MIN_JUDGING_MINUTES = 1;
const MAX_JUDGING_MINUTES = 60;

const resolveJudgingSeconds = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return DEFAULT_JUDGING_SECONDS;
  const whole = Math.round(value);
  if (whole < MIN_JUDGING_MINUTES * 60 || whole > MAX_JUDGING_MINUTES * 60) return DEFAULT_JUDGING_SECONDS;
  return whole;
};

const parseJudgingMinutes = (raw) => {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) {
    return { ok: false, message: 'Enter how many minutes each team has with a judge.' };
  }
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: 'Use a whole number of minutes, from 1 to 60.' };
  }
  const minutes = Number(text);
  if (minutes < MIN_JUDGING_MINUTES || minutes > MAX_JUDGING_MINUTES) {
    return { ok: false, message: 'Judging time must be from 1 to 60 minutes.' };
  }
  return { ok: true, minutes, seconds: minutes * 60 };
};

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
  DEFAULT_JUDGING_SECONDS,
  formatScore,
  resolveMaxScore,
  resolveJudgingSeconds,
  parseScoreInput,
  parseMaxScoreSetting,
  parseJudgingMinutes
};
