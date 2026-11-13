const db = require('../db/database');

const COOKIE_NAME = 'eventId';

const parsePositiveInt = (value) => {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 24 * 60 * 60 * 1000,
  path: '/'
});

const rememberEvent = (req, res, eventId) => {
  const id = parsePositiveInt(eventId);
  if (!id) return;
  req.session.eventId = id;
  delete req.session.currentRound;
  res.cookie(COOKIE_NAME, String(id), cookieOptions());
};

const clearSelectedEvent = (res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
};

const resolveRequestEventId = async (req) => {
  const sessionId = parsePositiveInt(req.session?.eventId);
  if (sessionId) return sessionId;

  const cookieId = parsePositiveInt(req.cookies?.eventId);
  if (!cookieId || !req.session?.user) return null;

  const event = await db.getEventById(cookieId);
  if (!event) return null;

  let allowed = req.session.user.role === 'admin' || event.status === 'open';
  if (!allowed && req.session.user.id) {
    const membership = await db.getMembership(req.session.user.id, cookieId);
    allowed = !!membership;
  }
  if (!allowed) return null;

  if (req.session) req.session.eventId = cookieId;
  return cookieId;
};

module.exports = {
  rememberEvent,
  clearSelectedEvent,
  resolveRequestEventId
};
