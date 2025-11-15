const express = require('express');
const router = express.Router();

// Middleware to require authentication
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  next();
};

// GET home page - landing page for non-authenticated, dashboard for authenticated
router.get('/', async (req, res) => {
  // If not authenticated, show landing page
  if (!req.session.user) {
    const db = require('../db/database');
    const eventSettings = await db.getEventSettings();
    // Parse divisions for display
    let divisionsList = [];
    if (eventSettings.divisions) {
      try {
        divisionsList = typeof eventSettings.divisions === 'string'
          ? JSON.parse(eventSettings.divisions)
          : eventSettings.divisions;
      } catch (e) {
        divisionsList = [];
      }
    }

    // Prepare meta tags for landing page
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const metaImage = eventSettings.logo_filename ? `${appUrl}/uploads/${eventSettings.logo_filename}` : null;
    const eventName = eventSettings.event_name || 'Hackathon';

    const meta = {
      type: 'website',
      title: eventName,
      description: eventSettings.landing_page_content
        ? eventSettings.landing_page_content.replace(/<[^>]*>/g, '').substring(0, 200) + '...'
        : `Join ${eventName} - A hackathon event featuring amazing projects and innovative solutions.`,
      url: appUrl,
      image: metaImage,
      siteName: eventName,
      twitterCard: 'summary_large_image'
    };

    return res.render('landing', {
      title: eventName,
      eventSettings,
      divisionsList,
      layout: 'main',
      meta
    });
  }

  // If authenticated, show dashboard (existing logic)
  const role = req.session.user.role || 'judge';

  // Redirect participants to their dashboard
  if (role === 'participant') {
    return res.redirect('/participant');
  }

  // Judges and admins see the main dashboard
  const db = require('../db/database');
  const eventSettings = await db.getEventSettings();
  const currentRound = eventSettings.current_round || req.session.currentRound || 1;
  const tables = await db.getTableNames();
  const allTeams = await db.getTeams();

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
    user: req.session.user,
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

