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
    
    // Prepare meta tags for Open Graph and Twitter
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const projectsUrl = `${appUrl}/projects${selectedDivision ? `?division=${encodeURIComponent(selectedDivision)}` : ''}`;
    
    let metaImage = null;
    if (eventSettings.logo_filename) {
      metaImage = `${appUrl}/uploads/${eventSettings.logo_filename}`;
    }
    
    const description = selectedDivision 
      ? `Explore projects from the ${selectedDivision} division at ${eventSettings.event_name || 'this hackathon'}`
      : `Explore all amazing projects from ${eventSettings.event_name || 'this hackathon'}`;
    
    const meta = {
      type: 'website',
      title: `Projects${selectedDivision ? ` - ${selectedDivision}` : ''} - ${eventSettings.event_name || 'Hackathon'}`,
      description: description,
      url: projectsUrl,
      image: metaImage,
      siteName: eventSettings.event_name || 'Hackathon',
      twitterCard: 'summary_large_image'
    };
    
    res.render('projects/index', {
      title: 'Projects',
      teams: teamsWithScreenshots,
      eventSettings,
      divisions,
      selectedDivision,
      query: req.query,
      meta
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

    // Check if project is published (admins can always view)
    const isAdmin = req.session && req.session.user && req.session.user.role === 'admin';
    const isTeamOwner = req.session && req.session.user && req.session.user.team_id === teamId;
    
    if (!team.is_published && !isAdmin && !isTeamOwner) {
      return res.render('error', {
        message: 'This project is not publicly available'
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
    
    // Prepare meta tags for Open Graph and Twitter
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const projectUrl = `${appUrl}/projects/${teamId}`;
    
    // Get first screenshot or banner image for meta image
    let metaImage = null;
    if (team.banner_image) {
      metaImage = `${appUrl}/uploads/screenshots/${team.banner_image}`;
    } else if (screenshots && screenshots.length > 0) {
      metaImage = `${appUrl}/uploads/screenshots/${screenshots[0].filename}`;
    } else if (eventSettings.logo_filename) {
      metaImage = `${appUrl}/uploads/${eventSettings.logo_filename}`;
    }
    
    // Create description from readme or project info
    let description = `${team.project_name} by ${team.name}`;
    if (team.readme_content) {
      // Strip markdown and get first 200 characters
      const plainText = team.readme_content.replace(/[#*`_~\[\]()]/g, '').replace(/\n/g, ' ').trim();
      description = plainText.substring(0, 200) + (plainText.length > 200 ? '...' : '');
    } else {
      description = `${team.project_name} by ${team.name}${team.division ? ` - ${team.division} Division` : ''}`;
    }
    
    const meta = {
      type: 'website',
      title: `${team.project_name} - ${team.name}`,
      description: description,
      url: projectUrl,
      image: metaImage,
      siteName: eventSettings.event_name || 'Hackathon',
      twitterCard: 'summary_large_image'
    };
    
    res.render('projects/detail', {
      title: `${team.project_name} - ${team.name}`,
      team: teamData,
      screenshots,
      eventSettings,
      canViewContactEmail,
      meta
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

