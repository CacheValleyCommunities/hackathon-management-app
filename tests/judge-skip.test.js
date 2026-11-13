const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const exphbs = require('express-handlebars');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-skip-'));
const previousDbPath = process.env.JUDGING_DB_PATH;
const previousJudgesPerTeam = process.env.JUDGES_PER_TEAM;

process.env.JUDGING_DB_PATH = path.join(tempDir, 'judging.db');
process.env.JUDGES_PER_TEAM = '2';

const db = require('../db/database');
const scoreRoutes = require('../routes/scores');
const helpers = require('../views/helpers');

const createApp = () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(session({
    secret: 'judge-skip-test',
    resave: false,
    saveUninitialized: false
  }));
  app.engine('hbs', exphbs.engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, '../views/layouts'),
    partialsDir: path.join(__dirname, '../views/partials'),
    helpers
  }));
  app.set('view engine', 'hbs');
  app.set('views', path.join(__dirname, '../views'));
  app.use(async (req, res, next) => {
    req.eventId = req.session?.eventId || null;
    req.eventRole = null;
    if (req.session?.user && req.eventId) {
      const membership = await db.getMembership(req.session.user.id, req.eventId);
      req.eventRole = membership ? membership.role : null;
    }
    const eventSettings = req.eventId ? await db.getEventById(req.eventId) : null;
    req.eventSettings = eventSettings;
    res.locals.eventSettings = eventSettings || {
      event_name: 'Hackathon',
      divisions: [],
      status: 'open'
    };
    res.locals.currentYear = 2026;
    res.locals.baseUrl = 'http://127.0.0.1';
    res.locals.currentRound = (eventSettings && eventSettings.current_round) || 1;
    res.locals.projectsUrl = '/projects';
    res.locals.registerUrl = '/register';
    res.locals.homeUrl = '/scores/judge-queue';
    if (req.session?.user) {
      res.locals.user = {
        ...req.session.user,
        eventRole: req.eventRole,
        role: req.eventRole || req.session.user.role
      };
    }
    next();
  });
  app.post('/test/session', (req, res) => {
    req.session.user = {
      id: parseInt(req.body.id, 10),
      email: req.body.email,
      name: req.body.name,
      role: req.body.role || 'user',
      account_type: 'individual',
      school_name: null
    };
    if (req.body.eventId) req.session.eventId = parseInt(req.body.eventId, 10);
    req.session.save((err) => {
      if (err) return res.status(500).end(err.message);
      res.end('ok');
    });
  });
  app.use('/scores', scoreRoutes);
  return app;
};

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

const mergeCookies = (jar, setCookie) => {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  list.forEach((entry) => {
    const pair = entry.split(';')[0];
    jar.set(pair.split('=')[0], pair);
  });
  return [...jar.values()].join('; ');
};

const request = (server, { method, path: requestPath, cookie, body }) => new Promise((resolve, reject) => {
  const payload = body ? new URLSearchParams(body).toString() : null;
  const req = http.request({
    hostname: '127.0.0.1',
    port: server.address().port,
    path: requestPath,
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(payload)
      } : {})
    }
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks).toString()
    }));
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const counterValue = (html, label) => {
  const match = html.match(new RegExp(`${label}</p>\\s*<p[^>]*>\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
};

const judgeEmail = (number) => `skip-judge${number}@example.com`;

let eventId;

const createTeam = (name, id = eventId) => db.createTeam({
  name,
  table_name: 'A1',
  project_name: `${name} project`,
  division: 'Skip',
  event_id: id,
  registration_type: 'individual'
});

const teamStats = async (name, id = eventId, round = 1) => {
  const stats = await db.getJudgeQueueStats(id, round);
  return stats.find(row => row.team_name === name);
};

describe('judge skips', () => {
  let server;

  beforeAll(async () => {
    await db.init();
    eventId = (await db.listEvents())[0].id;
    await db.syncTables(eventId, [{ name: 'A1' }]);
    server = await listen(createApp());
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
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

  test('skip without a lock fails, and a scored team cannot be skipped', async () => {
    await createTeam('Skip Guard');

    await expect(db.skipTeamForJudge(eventId, judgeEmail(1), 'Skip Guard', 1)).resolves.toEqual({
      ok: false,
      reason: 'not_assigned'
    });

    const lock = await db.lockTeamForJudge(eventId, judgeEmail(1), 'Skip Guard', 1);
    expect(lock.success).toBe(true);
    await db.saveScore(eventId, judgeEmail(1), 'Skip Guard', 'A1', 1, 8, '');

    await expect(db.skipTeamForJudge(eventId, judgeEmail(1), 'Skip Guard', 1)).resolves.toEqual({
      ok: false,
      reason: 'already_scored'
    });
    const assignments = await db.getCurrentAssignmentsForJudge(eventId, judgeEmail(1), 1);
    expect(assignments.map(row => row.team_name)).toContain('Skip Guard');
  });

  test('a skip releases the lock without using a judge slot or recording an absence', async () => {
    await createTeam('Skipped Team');
    const before = await teamStats('Skipped Team');
    expect(before.judge_count).toBe(0);

    const lock = await db.lockTeamForJudge(eventId, judgeEmail(4), 'Skipped Team', 1);
    expect(lock.success).toBe(true);
    const result = await db.skipTeamForJudge(eventId, judgeEmail(4), 'Skipped Team', 1);
    expect(result.ok).toBe(true);

    await expect(db.getCurrentAssignmentsForJudge(eventId, judgeEmail(4), 1)).resolves.toEqual([]);
    const after = await teamStats('Skipped Team');
    expect(after.judge_count).toBe(0);
    expect(after.absence_count).toBe(0);
    expect(after.score_count).toBe(0);

    const secondLock = await db.lockTeamForJudge(eventId, judgeEmail(2), 'Skipped Team', 1);
    expect(secondLock.success).toBe(true);
    expect((await db.skipTeamForJudge(eventId, judgeEmail(2), 'Skipped Team', 1)).ok).toBe(true);

    const skipped = await db.getSkippedTeamsByJudge(eventId, judgeEmail(4), 1);
    expect(skipped.map(row => row.team_name)).toContain('Skipped Team');
    expect(await db.lockTeamForJudge(eventId, judgeEmail(4), 'Skipped Team', 1)).toEqual({
      success: false,
      reason: 'skipped'
    });
    const freed = await teamStats('Skipped Team');
    expect(freed.judge_count).toBe(0);
    expect(freed.absence_count).toBe(0);
  });

  test('the skipping judge is excluded this round and can judge the team next round', async () => {
    const event = await db.createEvent({ event_name: 'Skip Round Event', status: 'active' });
    await db.syncTables(event.id, [{ name: 'A1' }]);
    await createTeam('Only Skipped Team', event.id);

    const email = judgeEmail(3);
    const lock = await db.lockTeamForJudge(event.id, email, 'Only Skipped Team', 1);
    expect(lock.success).toBe(true);
    expect((await db.skipTeamForJudge(event.id, email, 'Only Skipped Team', 1)).ok).toBe(true);

    expect(await db.getNextTeamForJudge(event.id, email, 1)).toBeNull();
    expect(await db.lockTeamForJudge(event.id, email, 'Only Skipped Team', 1)).toEqual({
      success: false,
      reason: 'skipped'
    });

    const nextRound = await db.getNextTeamForJudge(event.id, email, 2);
    expect(nextRound).not.toBeNull();
    expect(nextRound.name).toBe('Only Skipped Team');
    expect((await db.lockTeamForJudge(event.id, email, 'Only Skipped Team', 2)).success).toBe(true);
  });

  test('the queue counter counts scores and a skip does not remove the team', async () => {
    const event = await db.createEvent({ event_name: 'Skip Counter Event', status: 'open' });
    await db.syncTables(event.id, [{ name: 'A1' }]);
    await createTeam('Scored Team', event.id);
    await createTeam('Locked Team', event.id);
    await createTeam('Open Team', event.id);

    const judge = await db.createUser('counter-judge@example.com', 'Counter Judge', 'user');
    await db.upsertMembership(judge.id, event.id, 'judge');
    expect((await db.lockTeamForJudge(event.id, judge.email, 'Scored Team', 1)).success).toBe(true);
    await db.saveScore(event.id, judge.email, 'Scored Team', 'A1', 1, 9, '');
    await db.markAssignmentCompleted(event.id, judge.email, 'Scored Team', 1);
    await db.saveScore(event.id, judge.email, 'Scored Team', 'A1', 2, 7, '');
    expect((await db.lockTeamForJudge(event.id, judge.email, 'Locked Team', 1)).success).toBe(true);

    const jar = new Map();
    const login = await request(server, {
      method: 'POST',
      path: '/test/session',
      body: {
        id: String(judge.id),
        email: judge.email,
        name: judge.name,
        role: 'user',
        eventId: String(event.id)
      }
    });
    let cookie = mergeCookies(jar, login.headers['set-cookie']);

    const before = await request(server, {
      method: 'GET',
      path: '/scores/judge-queue',
      cookie
    });
    expect(before.status).toBe(200);
    expect(counterValue(before.body, "You've judged")).toBe(1);
    expect(counterValue(before.body, 'Still need judges')).toBe(3);
    expect(before.body).toContain('Skip this team');
    expect(before.body).toContain('You will not judge this team again this round.');
    expect(before.body).toContain(`/scores/assign-team/${encodeURIComponent('Open Team')}`);
    expect(before.body).not.toContain(`/scores/assign-team/${encodeURIComponent('Locked Team')}`);
    expect(before.body).not.toContain(`/scores/assign-team/${encodeURIComponent('Scored Team')}`);

    const skipped = await request(server, {
      method: 'POST',
      path: '/scores/skip',
      cookie,
      body: { teamName: 'Locked Team', round: '1' }
    });
    expect(skipped.status).toBe(302);
    expect(skipped.headers.location).toBe('/scores/judge-queue?message=team_skipped');

    const after = await request(server, {
      method: 'GET',
      path: skipped.headers.location,
      cookie
    });
    expect(after.status).toBe(200);
    expect(after.body).toContain('Team skipped. You will not judge that team again this round.');
    expect(counterValue(after.body, "You've judged")).toBe(1);
    expect(counterValue(after.body, 'Still need judges')).toBe(3);
    expect(after.body).not.toContain('Skip this team');
    expect(after.body).not.toContain(`/scores/assign-team/${encodeURIComponent('Locked Team')}`);
    expect(after.body).toContain(`/scores/assign-team/${encodeURIComponent('Open Team')}`);

    const nextTeam = await request(server, {
      method: 'GET',
      path: '/scores/next-team',
      cookie
    });
    expect(nextTeam.status).toBe(302);
    expect(nextTeam.headers.location).toBe(`/scores/enter/${encodeURIComponent('Open Team')}?round=1&auto=1`);

    const scorePage = await request(server, {
      method: 'GET',
      path: nextTeam.headers.location,
      cookie
    });
    expect(scorePage.status).toBe(200);
    expect(scorePage.body).toContain('Skip this team');
    expect(scorePage.body).toContain('You will not judge this team again this round.');
    expect(scorePage.body).toContain("Can't find this team");
    expect(scorePage.body).not.toContain('Locked Team');
  });
});
