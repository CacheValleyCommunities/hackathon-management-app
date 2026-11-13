const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { renderProjectIndex, renderProjectDetail } = require('./projects');

const destinationForEvent = async (req, event) => {
  if (req.session.user.role === 'admin') return '/admin';
  const membership = await db.getMembership(req.session.user.id, event.id);
  if (membership && membership.role === 'judge') return '/';
  if ((membership && membership.role === 'chaperone') || req.session.user.account_type === 'school') return '/school';
  if (membership && membership.role === 'participant') return '/participant';
  if (event.status === 'open') return '/register';
  return '/events';
};

const saveSession = (req) => new Promise((resolve, reject) => {
  req.session.save((err) => (err ? reject(err) : resolve()));
});

router.get('/', async (req, res) => {
  try {
    const events = await db.listVisibleEvents(req.session.user || null);
    res.render('events/index', {
      title: 'Events',
      events,
      query: req.query
    });
  } catch (error) {
    console.error('Event list error:', error);
    res.status(500).render('error', { message: 'Failed to load events' });
  }
});

router.post('/select', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');

  try {
    const event = await db.getEventById(parseInt(req.body.eventId, 10));
    if (!event) return res.redirect('/events?error=missing');

    const isAdmin = req.session.user.role === 'admin';
    let membership = await db.getMembership(req.session.user.id, event.id);
    const visible = isAdmin || event.status === 'open' || !!membership;
    if (!visible) {
      return res.status(403).render('error', { message: 'That event is not available.' });
    }

    if (!isAdmin && req.session.user.account_type === 'school' && !membership && event.status === 'open') {
      await db.upsertMembership(req.session.user.id, event.id, 'chaperone');
      membership = await db.getMembership(req.session.user.id, event.id);
    }

    req.session.eventId = event.id;
    delete req.session.currentRound;
    await saveSession(req);
    const target = await destinationForEvent(req, event);
    return res.redirect(target);
  } catch (error) {
    console.error('Event select error:', error);
    return res.status(500).render('error', { message: 'Failed to open that event.' });
  }
});

router.get('/:slug/projects/:teamId', async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event || (event.status === 'draft' && req.session.user?.role !== 'admin')) {
    return res.status(404).render('error', { message: 'Event not found.' });
  }
  return renderProjectDetail(req, res, event);
});

router.get('/:slug/projects', async (req, res) => {
  const event = await db.getEventBySlug(req.params.slug);
  if (!event || (event.status === 'draft' && req.session.user?.role !== 'admin')) {
    return res.status(404).render('error', { message: 'Event not found.' });
  }
  return renderProjectIndex(req, res, event);
});

router.get('/:slug', async (req, res) => {
  try {
    const event = await db.getEventBySlug(req.params.slug);
    if (!event || ((event.status === 'draft' || event.status === 'archived') && (!req.session.user || req.session.user.role !== 'admin'))) {
      return res.status(404).render('error', { message: 'Event not found.' });
    }
    res.render('landing', {
      title: event.event_name,
      eventSettings: event,
      divisionsList: event.divisions || [],
      showEventActions: true,
      layout: 'main'
    });
  } catch (error) {
    console.error('Public event error:', error);
    res.status(500).render('error', { message: 'Failed to load event' });
  }
});

module.exports = router;
