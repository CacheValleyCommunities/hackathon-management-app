const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');
const { requireParticipant, requireTeamOwner, requireTeamLeader } = require('../middleware/rbac');
const { checkAndReturnError } = require('../middleware/validation');

// Configure multer for screenshot uploads
const uploadsDir = path.join(__dirname, '../public/uploads/screenshots');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const guid = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (allowedExts.includes(ext)) {
      cb(null, `${guid}${ext}`);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

const uploadScreenshots = multer({
  storage: screenshotStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit (for banner/logo compatibility, screenshots validated client-side to 2MB)
    files: 10 // Max 10 files
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

// Configure multer for banner and logo uploads (5MB limit)
const bannerLogoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const guid = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (allowedExts.includes(ext)) {
      cb(null, `${guid}${ext}`);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

const uploadBannerLogo = multer({
  storage: bannerLogoStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

// GET participant dashboard
router.get('/', requireParticipant, async (req, res) => {
  try {
    const user = await db.getUserWithTeam(req.session.user.email);

    if (!user || !user.team_id) {
      return res.render('error', {
        message: 'No team associated with your account. Please contact an admin.'
      });
    }

    const team = await db.getTeamById(user.team_id);

    // Get cumulative scores for this team up to current round
    const currentRound = req.session.currentRound || 1;
    const allScores = await db.getJudgeScores(null, null, team.table_name);
    const teamScores = allScores.filter(s => s.team_name === team.name && s.round <= currentRound);

    // Calculate total score across all rounds up to current round
    let totalScore = 0;
    const uniqueJudges = new Set();
    const roundsCompleted = new Set();

    if (teamScores.length > 0) {
      totalScore = teamScores.reduce((sum, s) => sum + s.score, 0);
      teamScores.forEach(s => {
        uniqueJudges.add(s.judge_email);
        roundsCompleted.add(s.round);
      });
    }

    // Get results for this team's division
    const allResults = await db.getTableResults(currentRound, null);
    const teamDivision = team.division || 'Unassigned';
    const divisionResults = allResults[teamDivision] || [];
    const teamRank = divisionResults.findIndex(t => t.team_name === team.name) + 1;

    res.render('participant/dashboard', {
      title: 'My Team Dashboard',
      team,
      teamScores,
      totalScore,
      teamRank,
      currentRound,
      judgeCount: uniqueJudges.size,
      roundsCompleted: roundsCompleted.size,
      query: req.query
    });
  } catch (error) {
    console.error('Participant dashboard error:', error);
    res.render('error', {
      message: 'Failed to load dashboard',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET edit team page
router.get('/team/edit', requireParticipant, async (req, res) => {
  try {
    const userRole = req.session.user.role;
    let teamId = null;

    // Admins can edit any team via query parameter
    if (userRole === 'admin' && req.query.teamId) {
      teamId = parseInt(req.query.teamId);
    } else {
      // Regular participants edit their own team
      const user = await db.getUserWithTeam(req.session.user.email);
      if (!user || !user.team_id) {
        return res.render('error', {
          message: 'No team associated with your account.'
        });
      }
      teamId = user.team_id;

      // Check if user is team leader (admins bypass this check)
      const userEmail = req.session.user.email;
      const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);
      if (!userIsTeamLeader) {
        return res.status(403).render('error', {
          message: 'Access denied. Only the team leader or an admin can edit team information.'
        });
      }
    }

    const team = await db.getTeamById(teamId);
    if (!team) {
      return res.render('error', {
        message: 'Team not found.'
      });
    }

    const screenshots = await db.getTeamScreenshots(teamId);

    res.render('participant/edit-team', {
      title: 'Edit Team Information',
      team,
      screenshots,
      isAdmin: userRole === 'admin'
    });
  } catch (error) {
    console.error('Edit team error:', error);
    res.render('error', {
      message: 'Failed to load team information',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST update team
router.post('/team/update', requireParticipant, uploadScreenshots.fields([
  { name: 'screenshots', maxCount: 10 },
  { name: 'banner_image', maxCount: 1 },
  { name: 'logo_image', maxCount: 1 }
]), async (req, res) => {
  try {
    const userRole = req.session.user.role;
    let teamId = null;

    // Admins can update any team via body parameter
    if (userRole === 'admin' && req.body.teamId) {
      teamId = parseInt(req.body.teamId);
    } else {
      // Regular participants update their own team
      const user = await db.getUserWithTeam(req.session.user.email);
      if (!user || !user.team_id) {
        return res.render('error', {
          message: 'No team associated with your account.'
        });
      }
      teamId = user.team_id;

      // Check authorization (using helper function that doesn't expose team_leader_email)
      const userEmail = req.session.user.email;
      const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);

      if (!userIsTeamLeader) {
        return res.status(403).render('error', {
          message: 'Access denied. Only the team leader or an admin can edit team information.'
        });
      }
    }

    // Get current team for authorization check and to preserve existing data
    const currentTeam = await db.getTeamById(teamId);
    if (!currentTeam) {
      return res.render('error', {
        message: 'Team not found.'
      });
    }

    const { projectName, contactEmail, githubLink, websiteLink, readmeContent, teamMembers, screenshotOrders } = req.body;

    if (!projectName) {
      return res.render('error', {
        message: 'Project name is required'
      });
    }

    // Check for profanity
    const projectNameError = await checkAndReturnError(projectName, 'Project name');
    if (projectNameError) {
      return res.render('error', {
        message: projectNameError
      });
    }

    if (readmeContent) {
      const readmeError = await checkAndReturnError(readmeContent, 'README');
      if (readmeError) {
        return res.render('error', {
          message: readmeError
        });
      }
    }

    // Parse team members (expecting array from form or JSON string)
    let teamMembersArray = [];
    if (teamMembers) {
      try {
        if (Array.isArray(teamMembers)) {
          // Form sends as array
          teamMembersArray = teamMembers.filter(m => m && m.trim()).map(m => m.trim());
        } else if (typeof teamMembers === 'string') {
          // Try JSON first
          try {
            const parsed = JSON.parse(teamMembers);
            teamMembersArray = Array.isArray(parsed) ? parsed : [];
          } catch (e) {
            // If not JSON, try comma-separated or newline-separated
            teamMembersArray = teamMembers.split(/[,\n]/).map(m => m.trim()).filter(m => m);
          }
        }
      } catch (e) {
        // If parsing fails, use empty array
        teamMembersArray = [];
      }
    }

    // Handle uploaded screenshots
    if (req.files && req.files.screenshots && req.files.screenshots.length > 0) {
      // Get current screenshot count
      const currentScreenshots = await db.getTeamScreenshots(teamId);
      const remainingSlots = 10 - currentScreenshots.length;

      if (remainingSlots <= 0) {
        // Delete uploaded files
        req.files.screenshots.forEach(file => {
          fs.unlinkSync(file.path);
        });
        return res.render('error', {
          message: 'Maximum of 10 screenshots allowed. Please delete some existing screenshots first.'
        });
      }

      const filesToAdd = req.files.screenshots.slice(0, remainingSlots);

      for (let i = 0; i < filesToAdd.length; i++) {
        const file = filesToAdd[i];
        await db.addTeamScreenshot(
          teamId,
          file.filename,
          file.originalname,
          file.size,
          currentScreenshots.length + i
        );
      }

      // Delete excess files if any
      if (req.files.screenshots.length > remainingSlots) {
        req.files.screenshots.slice(remainingSlots).forEach(file => {
          fs.unlinkSync(file.path);
        });
      }
    }

    // Handle banner image
    let bannerImage = currentTeam.banner_image;
    if (req.files && req.files.banner_image && req.files.banner_image.length > 0) {
      // Delete old banner if exists
      if (currentTeam.banner_image) {
        const oldPath = path.join(uploadsDir, currentTeam.banner_image);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
      bannerImage = req.files.banner_image[0].filename;
    } else if (req.body.delete_banner_image === '1') {
      // User explicitly requested deletion
      if (currentTeam.banner_image) {
        const oldPath = path.join(uploadsDir, currentTeam.banner_image);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
      bannerImage = null;
    }

    // Handle logo image
    let logoImage = currentTeam.logo_image;
    if (req.files && req.files.logo_image && req.files.logo_image.length > 0) {
      // Delete old logo if exists
      if (currentTeam.logo_image) {
        const oldPath = path.join(uploadsDir, currentTeam.logo_image);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
      logoImage = req.files.logo_image[0].filename;
    } else if (req.body.delete_logo_image === '1') {
      // User explicitly requested deletion
      if (currentTeam.logo_image) {
        const oldPath = path.join(uploadsDir, currentTeam.logo_image);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }
      logoImage = null;
    }

    const updateData = {
      name: currentTeam.name,
      table_name: currentTeam.table_name,
      project_name: projectName.trim(),
      contact_email: contactEmail ? contactEmail.trim() : null,
      github_link: githubLink ? githubLink.trim() : null,
      website_link: websiteLink ? websiteLink.trim() : null,
      readme_content: readmeContent ? readmeContent.trim() : null,
      team_members: teamMembersArray,
      banner_image: bannerImage,
      logo_image: logoImage
    };

    await db.updateTeam(teamId, updateData);

    // Redirect based on user role
    if (userRole === 'admin') {
      res.redirect(`/admin/teams/${teamId}/edit?success=team_updated`);
    } else {
      res.redirect('/participant?success=team_updated');
    }
  } catch (error) {
    console.error('Update team error:', error);
    // Clean up uploaded files on error
    if (req.files) {
      if (req.files.screenshots) {
        req.files.screenshots.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
      if (req.files.banner_image) {
        req.files.banner_image.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
      if (req.files.logo_image) {
        req.files.logo_image.forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }
    }
    res.render('error', {
      message: 'Failed to update team',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST delete screenshot
router.post('/team/screenshot/:id/delete', requireParticipant, async (req, res) => {
  try {
    const userRole = req.session.user.role;
    const screenshotId = parseInt(req.params.id);
    
    // Get the screenshot to find which team it belongs to
    const screenshot = await db.getTeamScreenshotById(screenshotId);
    if (!screenshot) {
      return res.status(404).json({ error: 'Screenshot not found.' });
    }

    const teamId = screenshot.team_id;

    // Check authorization
    if (userRole !== 'admin') {
      const user = await db.getUserWithTeam(req.session.user.email);
      if (!user || !user.team_id || user.team_id !== teamId) {
        return res.status(403).json({ error: 'No team associated with your account.' });
      }

      const userEmail = req.session.user.email;
      const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);
      if (!userIsTeamLeader) {
        return res.status(403).json({ error: 'Access denied. Only the team leader or an admin can delete screenshots.' });
      }
    }

    const result = await db.deleteTeamScreenshot(screenshotId, teamId);

    // Delete the file
    const filePath = path.join(__dirname, '../public/uploads/screenshots', result.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete screenshot error:', error);
    res.status(500).json({ error: 'Failed to delete screenshot' });
  }
});

// POST update screenshot order
router.post('/team/screenshots/reorder', requireParticipant, async (req, res) => {
  try {
    const userRole = req.session.user.role;
    let teamId = null;

    // Admins can reorder screenshots for any team via body parameter
    if (userRole === 'admin' && req.body.teamId) {
      teamId = parseInt(req.body.teamId);
    } else {
      // Regular participants reorder their own team's screenshots
      const user = await db.getUserWithTeam(req.session.user.email);
      if (!user || !user.team_id) {
        return res.status(403).json({ error: 'No team associated with your account.' });
      }
      teamId = user.team_id;

      // Check authorization (using helper function that doesn't expose team_leader_email)
      const userEmail = req.session.user.email;
      const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);

      if (!userIsTeamLeader) {
        return res.status(403).json({ error: 'Access denied. Only the team leader or an admin can reorder screenshots.' });
      }
    }

    const { orders } = req.body;
    if (!Array.isArray(orders)) {
      return res.status(400).json({ error: 'Invalid orders format' });
    }

    await db.updateScreenshotOrder(teamId, orders);
    res.json({ success: true });
  } catch (error) {
    console.error('Update screenshot order error:', error);
    res.status(500).json({ error: 'Failed to update screenshot order' });
  }
});

// POST delete banner image
router.post('/team/banner/delete', requireParticipant, async (req, res) => {
  try {
    const userRole = req.session.user.role;
    let teamId = null;

    // Admins can delete banner from any team via body parameter
    if (userRole === 'admin' && req.body.teamId) {
      teamId = parseInt(req.body.teamId);
    } else {
      // Regular participants delete their own team's banner
      const user = await db.getUserWithTeam(req.session.user.email);
      if (!user || !user.team_id) {
        return res.status(403).json({ error: 'No team associated with your account.' });
      }
      teamId = user.team_id;

      // Check authorization (using helper function that doesn't expose team_leader_email)
      const userEmail = req.session.user.email;
      const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);

      if (!userIsTeamLeader) {
        return res.status(403).json({ error: 'Access denied. Only the team leader or an admin can delete the banner.' });
      }
    }

    const team = await db.getTeamById(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    if (team.banner_image) {
      const filePath = path.join(__dirname, '../public/uploads/screenshots', team.banner_image);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await db.updateTeam(teamId, { banner_image: null });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete banner error:', error);
    res.status(500).json({ error: 'Failed to delete banner' });
  }
});

// POST delete logo image
router.post('/team/logo/delete', requireParticipant, async (req, res) => {
  try {
    const userRole = req.session.user.role;
    let teamId = null;

    // Admins can delete logo from any team via body parameter
    if (userRole === 'admin' && req.body.teamId) {
      teamId = parseInt(req.body.teamId);
    } else {
      // Regular participants delete their own team's logo
      const user = await db.getUserWithTeam(req.session.user.email);
      if (!user || !user.team_id) {
        return res.status(403).json({ error: 'No team associated with your account.' });
      }
      teamId = user.team_id;

      // Check authorization (using helper function that doesn't expose team_leader_email)
      const userEmail = req.session.user.email;
      const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);

      if (!userIsTeamLeader) {
        return res.status(403).json({ error: 'Access denied. Only the team leader or an admin can delete the logo.' });
      }
    }

    const team = await db.getTeamById(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found.' });
    }

    if (team.logo_image) {
      const filePath = path.join(__dirname, '../public/uploads/screenshots', team.logo_image);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      await db.updateTeam(teamId, { logo_image: null });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete logo error:', error);
    res.status(500).json({ error: 'Failed to delete logo' });
  }
});

// GET live scores page
router.get('/scores', requireParticipant, async (req, res) => {
  try {
    const user = await db.getUserWithTeam(req.session.user.email);

    if (!user || !user.team_id) {
      return res.render('error', {
        message: 'No team associated with your account.'
      });
    }

    const team = await db.getTeamById(user.team_id);
    const round = parseInt(req.query.round) || req.session.currentRound || 1;

    // Get all scores for this team across all rounds
    const allScores = await db.getJudgeScores(null, null, team.table_name);
    const teamScores = allScores.filter(s => s.team_name === team.name);

    // Group scores by round
    const scoresByRound = {};
    teamScores.forEach(score => {
      if (!scoresByRound[score.round]) {
        scoresByRound[score.round] = [];
      }
      scoresByRound[score.round].push(score);
    });

    // Calculate averages per round
    const roundAverages = {};
    Object.keys(scoresByRound).forEach(roundNum => {
      const scores = scoresByRound[roundNum];
      const total = scores.reduce((sum, s) => sum + s.score, 0);
      roundAverages[roundNum] = total / scores.length;
    });

    // Get division results for current round
    const allResults = await db.getTableResults(round, null);
    const teamDivision = team.division || 'Unassigned';
    const divisionResults = allResults[teamDivision] || [];
    const teamRank = divisionResults.findIndex(t => t.team_name === team.name) + 1;

    res.render('participant/live-scores', {
      title: 'Live Scores',
      team,
      scoresByRound,
      roundAverages,
      currentRound: round,
      teamRank,
      divisionResults,
      teamDivision
    });
  } catch (error) {
    console.error('Live scores error:', error);
    res.render('error', {
      message: 'Failed to load scores',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

module.exports = router;

