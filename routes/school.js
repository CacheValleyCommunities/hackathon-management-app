const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireSelectedEvent } = require('../middleware/rbac');

const requireSchool = async (req, res, next) => {
  if (!req.session.user) return res.redirect('/auth/login');
  if (!req.eventId) return res.redirect('/events');
  if (req.session.user.role === 'admin') return next();
  if (req.session.user.account_type === 'school' || req.eventRole === 'chaperone') return next();
  return res.status(403).render('error', {
    message: 'Access denied. A school account is required.'
  });
};

router.use(requireSelectedEvent);
router.use(requireSchool);

router.get('/', async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.session.user.email);
    const teams = user ? await db.getTeamsForOwner(req.eventId, user.id) : [];
    const schoolTeams = teams.filter(team => team.registration_type === 'school' || req.session.user.role === 'admin');
    res.render('school/dashboard', {
      title: 'School Teams',
      teams: req.session.user.role === 'admin' ? teams : schoolTeams,
      schoolName: user?.school_name || '',
      registrationOpen: req.eventSettings && req.eventSettings.status === 'open',
      query: req.query
    });
  } catch (error) {
    console.error('School dashboard error:', error);
    res.status(500).render('error', { message: 'Failed to load school teams.' });
  }
});

module.exports = router;
