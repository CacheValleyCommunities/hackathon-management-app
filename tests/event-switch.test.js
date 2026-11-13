const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const exphbs = require('express-handlebars');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-switch-'));
const previousDbPath = process.env.JUDGING_DB_PATH;
process.env.JUDGING_DB_PATH = path.join(tempDir, 'judging.db');

const db = require('../db/database');
const eventsRoutes = require('../routes/events');
const adminRoutes = require('../routes/admin');
const helpers = require('../views/helpers');
const { resolveRequestEventId } = require('../middleware/selected-event');

const createApp = () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(session({
    secret: 'event-switch-test',
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
    req.eventId = await resolveRequestEventId(req);
    res.locals.currentYear = new Date().getFullYear();
    res.locals.baseUrl = 'http://127.0.0.1';
    res.locals.currentRound = req.session?.currentRound || 1;
    if (req.session?.user) {
      res.locals.user = req.session.user;
    }
    next();
  });
  app.post('/test/session', (req, res) => {
    req.session.user = {
      id: parseInt(req.body.id, 10),
      email: req.body.email,
      name: req.body.name,
      role: req.body.role,
      account_type: 'individual',
      school_name: null
    };
    if (req.body.eventId) req.session.eventId = parseInt(req.body.eventId, 10);
    req.session.save((err) => {
      if (err) return res.status(500).end(err.message);
      res.end('ok');
    });
  });
  app.use('/events', eventsRoutes);
  app.use('/admin', adminRoutes);
  app.use((err, req, res, next) => {
    res.status(500).send(err.message);
  });
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

describe('admin event switching', () => {
  let server;
  let admin;
  let person;
  let firstEvent;
  let secondEvent;

  beforeAll(async () => {
    await db.init();
    firstEvent = (await db.listEvents())[0];
    await db.updateEventSettings(firstEvent.id, {
      event_name: 'First Switch Event',
      divisions: [],
      start_date: null,
      end_date: null
    });
    firstEvent = await db.getEventById(firstEvent.id);
    secondEvent = await db.createEvent({ event_name: 'Second Switch Event', status: 'draft' });
    await db.syncTables(secondEvent.id, [{ name: 'A1' }]);
    await db.createTeam({
      event_id: secondEvent.id,
      name: 'Heavy Team',
      table_name: 'A1',
      project_name: 'Heavy project',
      contact_email: 'lead@example.com',
      readme_content: 'A very long readme that the dashboard should not load',
      banner_image: 'banner.png',
      logo_image: 'logo.png'
    });
    admin = await db.createUser('admin-switch@example.com', 'Admin', 'admin');
    person = await db.createUser('person-switch@example.com', 'Person', 'user');
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('the dashboard team query omits readme, banner, and logo fields', async () => {
    const summaries = await db.getTeamSummaries(secondEvent.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      name: 'Heavy Team',
      table_name: 'A1',
      project_name: 'Heavy project',
      contact_email: 'lead@example.com'
    });
    expect(summaries[0].readme_content).toBeUndefined();
    expect(summaries[0].banner_image).toBeUndefined();
    expect(summaries[0].logo_image).toBeUndefined();
    expect(summaries[0].screenshots).toBeUndefined();
  });

  test('a global admin with no membership can switch into a draft event', async () => {
    expect(await db.getMembership(admin.id, secondEvent.id)).toBeNull();
    const jar = new Map();
    const login = await request(server, {
      method: 'POST',
      path: '/test/session',
      body: {
        id: String(admin.id),
        email: admin.email,
        name: admin.name,
        role: 'admin',
        eventId: String(firstEvent.id)
      }
    });
    let cookie = mergeCookies(jar, login.headers['set-cookie']);

    const selected = await request(server, {
      method: 'POST',
      path: '/events/select',
      cookie,
      body: { eventId: String(secondEvent.id) }
    });
    cookie = mergeCookies(jar, selected.headers['set-cookie']);
    expect(selected.status).toBe(302);
    expect(selected.headers.location).toBe('/admin');

    const dashboard = await request(server, { method: 'GET', path: '/admin', cookie });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toContain('Admin Dashboard</h1>');
    expect(dashboard.body).toContain('Second Switch Event');
    expect(dashboard.body).not.toContain('A very long readme');

    const back = await request(server, {
      method: 'POST',
      path: '/events/select',
      cookie,
      body: { eventId: String(firstEvent.id) }
    });
    cookie = mergeCookies(jar, back.headers['set-cookie']);
    const eventsPage = await request(server, { method: 'GET', path: '/admin/events', cookie });
    expect(eventsPage.status).toBe(200);
    expect(eventsPage.body).toContain(`/events/${firstEvent.slug} · open · current`);
    expect(eventsPage.body).not.toContain(`/events/${secondEvent.slug} · draft · current`);
  });

  test('the event cookie keeps a draft event selected when the session is new', async () => {
    const jar = new Map();
    const login = await request(server, {
      method: 'POST',
      path: '/test/session',
      body: {
        id: String(admin.id),
        email: admin.email,
        name: admin.name,
        role: 'admin',
        eventId: String(firstEvent.id)
      }
    });
    let cookie = mergeCookies(jar, login.headers['set-cookie']);
    const selected = await request(server, {
      method: 'POST',
      path: '/events/select',
      cookie,
      body: { eventId: String(secondEvent.id) }
    });
    cookie = mergeCookies(jar, selected.headers['set-cookie']);
    const eventCookie = jar.get('eventId');
    expect(eventCookie).toBe(`eventId=${secondEvent.id}`);

    const fresh = new Map();
    const again = await request(server, {
      method: 'POST',
      path: '/test/session',
      body: {
        id: String(admin.id),
        email: admin.email,
        name: admin.name,
        role: 'admin'
      }
    });
    const freshCookie = [mergeCookies(fresh, again.headers['set-cookie']), eventCookie].filter(Boolean).join('; ');
    const dashboard = await request(server, { method: 'GET', path: '/admin', cookie: freshCookie });
    expect(dashboard.status).toBe(200);
    expect(dashboard.body).toContain('Admin Dashboard</h1>');
    expect(dashboard.body).toContain('Second Switch Event');
  });

  test('a non-admin cannot open a draft event', async () => {
    const jar = new Map();
    const login = await request(server, {
      method: 'POST',
      path: '/test/session',
      body: {
        id: String(person.id),
        email: person.email,
        name: person.name,
        role: 'user'
      }
    });
    const cookie = mergeCookies(jar, login.headers['set-cookie']);
    const selected = await request(server, {
      method: 'POST',
      path: '/events/select',
      cookie,
      body: { eventId: String(secondEvent.id) }
    });
    expect(selected.status).toBe(403);
    expect(selected.body).toContain('That event is not available.');
  });
});
