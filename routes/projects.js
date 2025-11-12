const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET public projects page - shows all teams and their projects
router.get('/', async (req, res) => {
  try {
    const selectedDivision = req.query.division || null;
    const teams = await db.getAllTeamsForProjects();
    const eventSettings = await db.getEventSettings();
    
    // Parse divisions from eventSettings
    let divisions = [];
    if (eventSettings.divisions) {
      try {
        divisions = typeof eventSettings.divisions === 'string'
          ? JSON.parse(eventSettings.divisions)
          : eventSettings.divisions;
      } catch (e) {
        divisions = [];
      }
    }
    
    // Filter teams by division if specified
    let filteredTeams = teams;
    if (selectedDivision) {
      filteredTeams = teams.filter(team => team.division === selectedDivision);
    }
    
    // Get screenshots for each team and check authorization for contact_email
    const teamsWithScreenshots = await Promise.all(filteredTeams.map(async (team) => {
      const screenshots = await db.getTeamScreenshots(team.id);
      
      // Check if user is authorized to see contact_email (team owner or admin)
      let canViewContactEmail = false;
      if (req.session && req.session.user) {
        const user = req.session.user;
        if (user.role === 'admin') {
          canViewContactEmail = true;
        } else if (user.role === 'participant' && user.team_id === team.id) {
          // Check if user is team leader
          const isLeader = await db.isTeamLeader(team.id, user.email);
          if (isLeader) {
            canViewContactEmail = true;
          }
        }
      }
      
      const teamData = { ...team };
      // contact_email is already excluded from getAllTeamsForProjects, but ensure it's not present
      if (!canViewContactEmail) {
        delete teamData.contact_email;
      }
      
      return {
        ...teamData,
        screenshots,
        canViewContactEmail
      };
    }));
    
    res.render('projects/index', {
      title: 'Projects',
      teams: teamsWithScreenshots,
      eventSettings,
      divisions,
      selectedDivision,
      query: req.query
    });
  } catch (error) {
    console.error('Projects page error:', error);
    res.render('error', {
      message: 'Failed to load projects',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET individual project page
router.get('/:teamId', async (req, res) => {
  try {
    const teamId = parseInt(req.params.teamId);
    // Don't include sensitive fields for public access
    const team = await db.getTeamById(teamId, false);
    const eventSettings = await db.getEventSettings();
    
    if (!team) {
      return res.render('error', {
        message: 'Project not found'
      });
    }
    
    // Check if user is authorized to see contact_email (team owner or admin)
    let canViewContactEmail = false;
    if (req.session && req.session.user) {
      const user = req.session.user;
      if (user.role === 'admin') {
        canViewContactEmail = true;
      } else if (user.role === 'participant' && user.team_id === teamId) {
        // Check if user is team leader
        const isLeader = await db.isTeamLeader(teamId, user.email);
        if (isLeader) {
          canViewContactEmail = true;
        }
      }
    }
    
    // Only include contact_email if user is authorized
    const teamData = { ...team };
    if (!canViewContactEmail) {
      delete teamData.contact_email;
    }
    
    const screenshots = await db.getTeamScreenshots(teamId);
    
    res.render('projects/detail', {
      title: `${team.project_name} - ${team.name}`,
      team: teamData,
      screenshots,
      eventSettings,
      canViewContactEmail
    });
  } catch (error) {
    console.error('Project detail error:', error);
    res.render('error', {
      message: 'Failed to load project',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

module.exports = router;

