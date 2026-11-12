const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Middleware to require authentication
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  next();
};

// GET home page - landing page for non-authenticated, dashboard for authenticated
router.get('/', async (req, res) => {
  if (!req.session.user) {
    const events = await db.listVisibleEvents(null);
    return res.render('events/index', {
      title: 'Events',
      events,
      query: req.query,
      layout: 'main'
    });
  }

  if (!req.eventId) {
    return res.redirect('/events');
  }

  if (req.eventRole === 'participant') {
    return res.redirect('/participant');
  }
  if (req.eventRole === 'chaperone' || (req.session.user.account_type === 'school' && !req.eventRole)) {
    return res.redirect('/school');
  }

  const eventSettings = req.eventSettings || await db.getEventSettings(req.eventId);
  const currentRound = eventSettings.current_round || req.session.currentRound || 1;
  const tables = await db.getTableNames(req.eventId);
  const allTeams = await db.getTeams(req.eventId);

  // Filter out sensitive data (contact_email) for non-admin users
  const teams = allTeams.map(team => {
    const teamData = { ...team };
    // Only admins can see contact_email
    if (req.session.user.role !== 'admin') {
      delete teamData.contact_email;
    }
    return teamData;
  });

  // Create a map of table -> teams array for quick lookup (supports multiple teams per table)
  const tableMap = {};
  teams.forEach(team => {
    if (!tableMap[team.table_name]) {
      tableMap[team.table_name] = [];
    }
    tableMap[team.table_name].push(team);
  });

  // Generate grid structure dynamically from database tables
  // Parse table names to extract letters and numbers
  const lettersSet = new Set();
  const numbersSet = new Set();

  tables.forEach(tableName => {
    // Match pattern: letters followed by numbers (e.g., A1, AB12, P10)
    const match = tableName.match(/^([A-Z]+)(\d+)$/i);
    if (match) {
      lettersSet.add(match[1].toUpperCase());
      numbersSet.add(parseInt(match[2]));
    }
  });

  // Convert to sorted arrays
  // Letters in reverse alphabetical order (P to A) for display from left to right
  const letters = Array.from(lettersSet).sort().reverse();
  // Numbers in descending order (10 to 1) for display from top to bottom
  const numbers = Array.from(numbersSet).sort((a, b) => b - a);

  const gridRows = [];

  numbers.forEach(num => {
    const row = [];
    letters.forEach(letter => {
      const tableId = `${letter}${num}`;
      row.push({
        id: tableId,
        teams: tableMap[tableId] || []
      });
    });
    gridRows.push(row);
  });

  res.render('index', {
    title: 'Hackathon',
    currentRound,
    tables,
    teams,
    tableMap,
    gridRows,
    query: req.query
  });
});

// POST set round
router.post('/set-round', requireAuth, (req, res) => {
  const round = parseInt(req.body.round) || 1;
  req.session.currentRound = round;
  res.redirect('/scores/select-team?round=' + round);
});

module.exports = router;

