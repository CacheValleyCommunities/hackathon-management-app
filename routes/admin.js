const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const csv = require('csv-parser');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/rbac');
const { checkAndReturnError } = require('../middleware/validation');
const emailService = require('../services/email');

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate GUID for filename to prevent path-based attacks
    const guid = crypto.randomUUID();
    const ext = path.extname(file.originalname).toLowerCase();
    // Only allow image extensions
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'];
    if (allowedExts.includes(ext)) {
      cb(null, `${guid}${ext}`);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Check MIME type
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images are allowed.'));
    }
  }
});

// GET admin dashboard
router.get('/', requireAdmin, async (req, res) => {
  try {
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin
    const users = await db.getAllUsers();
    const tables = await db.getTableNames();
    const eventSettings = await db.getEventSettings();

    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      teams,
      users,
      tables,
      eventSettings,
      query: req.query
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.render('error', {
      message: 'Failed to load admin dashboard',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST increment round
router.post('/increment-round', requireAdmin, async (req, res) => {
  try {
    await db.incrementRound();
    res.redirect('/?success=round_incremented');
  } catch (error) {
    console.error('Increment round error:', error);
    res.redirect('/?error=increment_failed');
  }
});

// GET add team page (must be before /teams/:id/edit to avoid route conflict)
router.get('/teams/add', requireAdmin, async (req, res) => {
  try {
    const tables = await db.getTableNames();
    const categories = await db.getCategories();
    const eventSettings = await db.getEventSettings();

    res.render('admin/add-team', {
      title: 'Add Team',
      tables,
      categories,
      divisions: eventSettings.divisions || [],
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Add team page error:', error);
    res.render('error', {
      message: 'Failed to load add team page',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST add team
router.post('/teams/add', requireAdmin, async (req, res) => {
  try {
    const { teamName, tableName, projectName, contactEmail, githubLink, websiteLink, division, categoryId, isPublished } = req.body;

    const tables = await db.getTableNames();
    const categories = await db.getCategories();
    const eventSettings = await db.getEventSettings();

    // Validation
    if (!teamName || !tableName || !projectName) {
      return res.render('admin/add-team', {
        title: 'Add Team',
        tables,
        categories,
        divisions: eventSettings.divisions || [],
        error: 'Please fill in all required fields (Team Name, Table Name, Project Name)',
        success: null
      });
    }

    // Validate category is selected
    if (!categoryId || categoryId === '') {
      return res.render('admin/add-team', {
        title: 'Add Team',
        tables,
        categories,
        divisions: eventSettings.divisions || [],
        error: 'Please select a category for the team',
        success: null
      });
    }

    // Validate division is selected (if divisions exist)
    if (eventSettings.divisions && eventSettings.divisions.length > 0 && (!division || division === '')) {
      return res.render('admin/add-team', {
        title: 'Add Team',
        tables,
        categories,
        divisions: eventSettings.divisions || [],
        error: 'Please select a division for the team',
        success: null
      });
    }

    // Check for profanity in team name and project name
    const teamNameError = await checkAndReturnError(teamName, 'Team name');
    const projectNameError = await checkAndReturnError(projectName, 'Project name');

    if (teamNameError || projectNameError) {
      return res.render('admin/add-team', {
        title: 'Add Team',
        tables,
        categories,
        divisions: eventSettings.divisions || [],
        error: teamNameError || projectNameError,
        success: null
      });
    }

    // Normalize table name
    let normalizedTableName = tableName.trim();
    if (/^\d+$/.test(normalizedTableName)) {
      normalizedTableName = `Table ${normalizedTableName}`;
    }

    // Check if table exists, create if it doesn't
    if (!tables.includes(normalizedTableName)) {
      await db.syncTables([{ name: normalizedTableName }]);
    }

    // Check if team name already exists
    const existingTeams = await db.getTeams();
    const teamExists = existingTeams.some(t => t.name.toLowerCase() === teamName.toLowerCase());

    if (teamExists) {
      return res.render('admin/add-team', {
        title: 'Add Team',
        tables,
        categories,
        divisions: eventSettings.divisions || [],
        error: 'A team with this name already exists. Please choose a different name.',
        success: null
      });
    }

    // Parse category ID
    const categoryIdInt = categoryId && categoryId !== '' ? parseInt(categoryId) : null;
    // Parse publish status
    const isPublishedBool = isPublished === '1' || isPublished === true;

    // Create team without user data
    const team = await db.createTeam({
      name: teamName.trim(),
      table_name: normalizedTableName,
      project_name: projectName.trim(),
      contact_email: contactEmail ? contactEmail.trim() : null,
      github_link: githubLink ? githubLink.trim() : null,
      website_link: websiteLink ? websiteLink.trim() : null,
      division: division || null,
      category_id: categoryIdInt,
      is_published: isPublishedBool,
      team_leader_email: null // No user data required
    });

    res.render('admin/add-team', {
      title: 'Add Team',
      tables,
      categories,
      divisions: eventSettings.divisions || [],
      error: null,
      success: `Team "${teamName}" successfully created! The team can now be judged without requiring user accounts.`
    });
  } catch (error) {
    console.error('Add team error:', error);
    const tables = await db.getTableNames();
    const categories = await db.getCategories();
    const eventSettings = await db.getEventSettings();
    res.render('admin/add-team', {
      title: 'Add Team',
      tables,
      categories,
      divisions: eventSettings.divisions || [],
      error: 'An error occurred while creating the team. Please try again.',
      success: null
    });
  }
});

// GET edit team page
router.get('/teams/:id/edit', requireAdmin, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const team = await db.getTeamById(teamId, true); // Include sensitive fields for admin

    if (!team) {
      return res.render('error', {
        message: 'Team not found'
      });
    }

    // Get all teams to check for duplicate names
    const allTeams = await db.getTeams(null, true); // Include sensitive fields for admin
    const tables = await db.getTableNames();
    const categories = await db.getCategories();
    const eventSettings = await db.getEventSettings();

    res.render('admin/edit-team', {
      title: `Edit Team - ${team.name}`,
      team,
      tables,
      categories,
      allTeams,
      divisions: eventSettings.divisions || []
    });
  } catch (error) {
    console.error('Edit team error:', error);
    res.render('error', {
      message: 'Failed to load team',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST update team
router.post('/teams/:id/update', requireAdmin, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    const { teamName, tableName, projectName, contactEmail, githubLink, division, categoryId, isPublished } = req.body;

    if (!teamName || !tableName || !projectName) {
      return res.render('error', {
        message: 'Please fill in all required fields'
      });
    }

    // Validate category is selected
    if (!categoryId || categoryId === '') {
      const existingTeam = await db.getTeamById(teamId, true);
      if (!existingTeam) {
        return res.render('error', {
          message: 'Team not found'
        });
      }
      const eventSettings = await db.getEventSettings();
      const categories = await db.getCategories();
      return res.render('admin/edit-team', {
        title: `Edit Team - ${existingTeam.name}`,
        team: existingTeam,
        tables: await db.getTableNames(),
        categories,
        divisions: eventSettings.divisions || [],
        error: 'Please select a category for the team'
      });
    }

    // Check if team name already exists (excluding current team)
    const existingTeam = await db.getTeamById(teamId, true); // Include sensitive fields for admin
    if (!existingTeam) {
      return res.render('error', {
        message: 'Team not found'
      });
    }

    const allTeams = await db.getTeams(null, true); // Include sensitive fields for admin
    const nameExists = allTeams.some(t =>
      t.id !== teamId && t.name.toLowerCase() === teamName.toLowerCase()
    );

    // Check for profanity in team name and project name
    const teamNameError = await checkAndReturnError(teamName, 'Team name');
    const projectNameError = await checkAndReturnError(projectName, 'Project name');

    if (teamNameError || projectNameError) {
      const eventSettings = await db.getEventSettings();
      const categories = await db.getCategories();
      return res.render('admin/edit-team', {
        title: `Edit Team - ${existingTeam.name}`,
        team: existingTeam,
        tables: await db.getTableNames(),
        categories,
        divisions: eventSettings.divisions || [],
        error: teamNameError || projectNameError
      });
    }

    if (nameExists) {
      const eventSettings = await db.getEventSettings();
      const categories = await db.getCategories();
      return res.render('admin/edit-team', {
        title: `Edit Team - ${existingTeam.name}`,
        team: existingTeam,
        tables: await db.getTableNames(),
        categories,
        divisions: eventSettings.divisions || [],
        error: 'A team with this name already exists'
      });
    }

    // Parse category ID
    const categoryIdInt = categoryId && categoryId !== '' ? parseInt(categoryId) : null;
    // Parse publish status
    const isPublishedBool = isPublished === '1' || isPublished === true;

    await db.updateTeam(teamId, {
      name: teamName.trim(),
      table_name: tableName,
      project_name: projectName.trim(),
      contact_email: contactEmail ? contactEmail.trim() : null,
      github_link: githubLink ? githubLink.trim() : null,
      division: division || null,
      category_id: categoryIdInt,
      is_published: isPublishedBool
    });

    res.redirect('/admin?success=team_updated');
  } catch (error) {
    console.error('Update team error:', error);
    res.render('error', {
      message: 'Failed to update team',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST delete team
router.post('/teams/:id/delete', requireAdmin, async (req, res) => {
  try {
    const teamId = parseInt(req.params.id);
    await db.deleteTeam(teamId);
    res.redirect('/admin?success=team_deleted');
  } catch (error) {
    console.error('Delete team error:', error);
    res.render('error', {
      message: 'Failed to delete team',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET add judge page
router.get('/judges/add', requireAdmin, async (req, res) => {
  const teams = await db.getTeams(null, true); // Include sensitive fields for admin
  res.render('admin/add-judge', {
    title: 'Add User',
    error: null,
    success: null,
    teams
  });
});

// POST add judge
router.post('/judges/add', requireAdmin, async (req, res) => {
  try {
    const { email, name, role, teamId } = req.body;
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin

    if (!email || !email.includes('@')) {
      return res.render('admin/add-judge', {
        title: 'Add User',
        error: 'Please enter a valid email address',
        success: null,
        teams
      });
    }

    // Check for profanity in name field
    if (name) {
      const nameError = await checkAndReturnError(name, 'Name');
      if (nameError) {
        return res.render('admin/add-judge', {
          title: 'Add User',
          error: nameError,
          success: null,
          teams
        });
      }
    }

    const selectedRole = role || 'judge';
    const linkedTeamId = teamId && teamId !== '' ? parseInt(teamId) : null;

    // Check if user already exists
    const existingUser = await db.getUserByEmail(email.toLowerCase().trim());

    if (existingUser) {
      // Update existing user
      await db.updateUser(email.toLowerCase().trim(), {
        name: name || existingUser.name,
        role: selectedRole,
        team_id: linkedTeamId
      });
      return res.render('admin/add-judge', {
        title: 'Add User',
        error: null,
        success: `User ${email} already exists. Updated role to ${selectedRole}${linkedTeamId ? ' and linked to team' : ''}.`,
        teams
      });
    }

    // Create new user
    await db.createUser(
      email.toLowerCase().trim(),
      name || null,
      selectedRole,
      linkedTeamId
    );

    // Send confirmation email
    try {
      const emailService = require('../services/email');
      const eventSettings = await db.getEventSettings();
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      await emailService.sendJudgeConfirmation(
        email.toLowerCase().trim(),
        name || email.split('@')[0],
        selectedRole,
        eventSettings.event_name || 'Hackathon',
        appUrl
      );
    } catch (emailError) {
      console.error('Error sending judge confirmation email:', emailError);
      // Don't fail user creation if email fails
    }

    res.render('admin/add-judge', {
      title: 'Add User',
      error: null,
      success: `User ${email} (${selectedRole}) added successfully!${linkedTeamId ? ' Linked to team.' : ''} A confirmation email has been sent.`,
      teams
    });
  } catch (error) {
    console.error('Add user error:', error);
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin
    res.render('admin/add-judge', {
      title: 'Add User',
      error: 'An error occurred. Please try again.',
      success: null,
      teams
    });
  }
});

// POST update judge role
router.post('/judges/:email/update', requireAdmin, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { role } = req.body;

    await db.updateUser(email, {
      role: role || 'judge'
    });

    res.redirect('/admin?success=judge_updated');
  } catch (error) {
    console.error('Update judge error:', error);
    res.render('error', {
      message: 'Failed to update judge',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET event settings page
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getEventSettings();
    res.render('admin/settings', {
      title: 'Event Settings',
      settings,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Event settings error:', error);
    res.render('error', {
      message: 'Failed to load event settings',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST update event settings
router.post('/settings', requireAdmin, upload.single('logo'), async (req, res) => {
  try {
    const { eventName, startDate, endDate, divisions } = req.body;

    // Parse divisions (expecting comma-separated string, JSON string, or array)
    let divisionsArray = [];
    if (divisions) {
      if (Array.isArray(divisions)) {
        // Already an array
        divisionsArray = divisions;
      } else if (typeof divisions === 'string') {
        // Try to parse as JSON first
        if (divisions.trim().startsWith('[')) {
          try {
            divisionsArray = JSON.parse(divisions);
          } catch (e) {
            console.error('Error parsing divisions as JSON:', e);
          }
        } else {
          // Handle comma-separated string
          divisionsArray = divisions.split(',').map(d => d.trim()).filter(d => d);
        }
      }
    }

    // Get current settings to preserve logo and landing page settings if not uploading a new one
    const currentSettings = await db.getEventSettings();

    const settings = {
      event_name: eventName || 'Hackathon',
      start_date: startDate || null,
      end_date: endDate || null,
      divisions: divisionsArray,
      logo_filename: currentSettings.logo_filename || null, // Preserve existing logo
      hero_banner_image: currentSettings.hero_banner_image || null, // Preserve landing page settings
      hero_banner_link: currentSettings.hero_banner_link || null,
      landing_page_content: currentSettings.landing_page_content || null,
      event_dates_text: currentSettings.event_dates_text || null
    };

    // Handle logo upload
    if (req.file) {
      // Delete old logo if exists
      if (currentSettings.logo_filename) {
        const oldLogoPath = path.join(uploadsDir, currentSettings.logo_filename);
        if (fs.existsSync(oldLogoPath)) {
          fs.unlinkSync(oldLogoPath);
        }
      }
      settings.logo_filename = req.file.filename;
    }

    await db.updateEventSettings(settings);

    res.render('admin/settings', {
      title: 'Event Settings',
      settings: await db.getEventSettings(),
      error: null,
      success: 'Event settings updated successfully!'
    });
  } catch (error) {
    console.error('Update event settings error:', error);
    const settings = await db.getEventSettings();
    res.render('admin/settings', {
      title: 'Event Settings',
      settings,
      error: error.message || 'Failed to update event settings',
      success: null
    });
  }
});

// GET landing page settings
router.get('/landing', requireAdmin, async (req, res) => {
  try {
    const settings = await db.getEventSettings();
    res.render('admin/landing', {
      title: 'Landing Page Settings',
      settings,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Landing page settings error:', error);
    res.render('error', {
      message: 'Failed to load landing page settings',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST update landing page settings
router.post('/landing', requireAdmin, upload.single('heroBanner'), async (req, res) => {
  try {
    const { heroBannerLink, landingPageContent, eventDatesText } = req.body;

    // Get current settings to preserve existing values
    const currentSettings = await db.getEventSettings();

    const settings = {
      event_name: currentSettings.event_name || 'Hackathon',
      start_date: currentSettings.start_date || null,
      end_date: currentSettings.end_date || null,
      divisions: currentSettings.divisions || '[]',
      logo_filename: currentSettings.logo_filename || null,
      hero_banner_image: currentSettings.hero_banner_image || null,
      hero_banner_link: heroBannerLink || null,
      landing_page_content: landingPageContent || null,
      event_dates_text: eventDatesText || null
    };

    // Handle hero banner image upload
    if (req.file) {
      // Delete old hero banner if exists
      if (currentSettings.hero_banner_image) {
        const oldBannerPath = path.join(uploadsDir, currentSettings.hero_banner_image);
        if (fs.existsSync(oldBannerPath)) {
          fs.unlinkSync(oldBannerPath);
        }
      }
      settings.hero_banner_image = req.file.filename;
    }

    await db.updateEventSettings(settings);

    res.render('admin/landing', {
      title: 'Landing Page Settings',
      settings: await db.getEventSettings(),
      error: null,
      success: 'Landing page settings updated successfully!'
    });
  } catch (error) {
    console.error('Update landing page settings error:', error);
    const settings = await db.getEventSettings();
    res.render('admin/landing', {
      title: 'Landing Page Settings',
      settings,
      error: error.message || 'Failed to update landing page settings',
      success: null
    });
  }
});

// GET category management page
router.get('/categories', requireAdmin, async (req, res) => {
  try {
    const categories = await db.getCategories();
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin

    // Create a map of category usage with counts
    const categoryUsage = {};
    teams.forEach(team => {
      if (team.category_id) {
        const categoryId = team.category_id;
        if (!categoryUsage[categoryId]) {
          categoryUsage[categoryId] = { teams: [], count: 0 };
        }
        categoryUsage[categoryId].teams.push(team);
        categoryUsage[categoryId].count++;
      }
    });

    res.render('admin/categories', {
      title: 'Manage Categories',
      categories,
      categoryUsage,
      query: req.query
    });
  } catch (error) {
    console.error('Category management error:', error);
    res.render('error', {
      message: 'Failed to load categories',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST add new category
router.post('/categories/add', requireAdmin, async (req, res) => {
  try {
    const { categoryName } = req.body;

    if (!categoryName || !categoryName.trim()) {
      return res.redirect('/admin/categories?error=empty');
    }

    const normalizedCategoryName = categoryName.trim();

    // Check if category already exists
    const existingCategories = await db.getCategoryNames();
    if (existingCategories.includes(normalizedCategoryName)) {
      return res.redirect('/admin/categories?error=exists');
    }

    // Add the category
    await db.syncCategories([{ name: normalizedCategoryName }]);

    res.redirect('/admin/categories?success=added');
  } catch (error) {
    console.error('Add category error:', error);
    res.redirect('/admin/categories?error=failed');
  }
});

// POST delete category
router.post('/categories/:id/delete', requireAdmin, async (req, res) => {
  try {
    const categoryId = parseInt(req.params.id);

    // Check if category has teams assigned
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin
    const hasTeams = teams.some(team => team.category_id === categoryId);

    if (hasTeams) {
      return res.redirect('/admin/categories?error=has_teams');
    }

    // Delete the category
    const dbInstance = db.getDb();
    await new Promise((resolve, reject) => {
      dbInstance.run('DELETE FROM categories WHERE id = ?', [categoryId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.redirect('/admin/categories?success=deleted');
  } catch (error) {
    console.error('Delete category error:', error);
    res.redirect('/admin/categories?error=failed');
  }
});

// GET table management page
router.get('/tables', requireAdmin, async (req, res) => {
  try {
    const tables = await db.getTables();
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin

    // Create a map of table usage
    const tableUsage = {};
    teams.forEach(team => {
      if (!tableUsage[team.table_name]) {
        tableUsage[team.table_name] = [];
      }
      tableUsage[team.table_name].push(team);
    });

    res.render('admin/tables', {
      title: 'Manage Tables',
      tables,
      tableUsage,
      query: req.query
    });
  } catch (error) {
    console.error('Table management error:', error);
    res.render('error', {
      message: 'Failed to load tables',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST add new table
router.post('/tables/add', requireAdmin, async (req, res) => {
  try {
    const { tableName } = req.body;

    if (!tableName || !tableName.trim()) {
      return res.redirect('/admin/tables?error=empty');
    }

    const normalizedTableName = tableName.trim();

    // Check if table already exists
    const existingTables = await db.getTableNames();
    if (existingTables.includes(normalizedTableName)) {
      return res.redirect('/admin/tables?error=exists');
    }

    // Add the table
    await db.syncTables([{ name: normalizedTableName }]);

    res.redirect('/admin/tables?success=added');
  } catch (error) {
    console.error('Add table error:', error);
    res.redirect('/admin/tables?error=failed');
  }
});

// POST delete table
router.post('/tables/:name/delete', requireAdmin, async (req, res) => {
  try {
    const tableName = decodeURIComponent(req.params.name);

    // Check if table has teams assigned
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin
    const hasTeams = teams.some(team => team.table_name === tableName);

    if (hasTeams) {
      return res.redirect('/admin/tables?error=has_teams');
    }

    // Delete the table
    const dbInstance = db.getDb();
    await new Promise((resolve, reject) => {
      dbInstance.run('DELETE FROM tables WHERE name = ?', [tableName], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.redirect('/admin/tables?success=deleted');
  } catch (error) {
    console.error('Delete table error:', error);
    res.redirect('/admin/tables?error=failed');
  }
});

// POST bulk delete tables
router.post('/tables/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const tableNames = req.body['tables[]'] || req.body.tables || [];

    // Ensure it's an array
    const tablesToDelete = Array.isArray(tableNames) ? tableNames : [tableNames];

    if (tablesToDelete.length === 0) {
      return res.redirect('/admin/tables?error=no_selection');
    }

    // Check if any tables have teams assigned
    const teams = await db.getTeams(null, true); // Include sensitive fields for admin
    const tablesWithTeams = tablesToDelete.filter(tableName =>
      teams.some(team => team.table_name === tableName)
    );

    if (tablesWithTeams.length > 0) {
      return res.redirect('/admin/tables?error=has_teams');
    }

    // Delete all selected tables
    const dbInstance = db.getDb();
    const placeholders = tablesToDelete.map(() => '?').join(',');

    await new Promise((resolve, reject) => {
      dbInstance.run(
        `DELETE FROM tables WHERE name IN (${placeholders})`,
        tablesToDelete,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    res.redirect(`/admin/tables?success=bulk_deleted&count=${tablesToDelete.length}`);
  } catch (error) {
    console.error('Bulk delete tables error:', error);
    res.redirect('/admin/tables?error=failed');
  }
});

// POST initialize chessboard tables (A1-P10)
router.post('/tables/initialize-chessboard', requireAdmin, async (req, res) => {
  try {
    await db.initializeChessBoardTables();
    res.redirect('/admin/tables?success=chessboard_initialized');
  } catch (error) {
    console.error('Initialize chessboard tables error:', error);
    res.redirect('/admin/tables?error=failed');
  }
});

// Configure multer for CSV uploads
const csvStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const guid = crypto.randomUUID();
    cb(null, `csv-${guid}.csv`);
  }
});

const csvUpload = multer({
  storage: csvStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed.'));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// GET CSV import page
router.get('/judges/import', requireAdmin, (req, res) => {
  res.render('admin/import-judges', {
    title: 'Import Judges from CSV',
    query: req.query
  });
});

// POST upload CSV and show mapping interface
router.post('/judges/import/upload', requireAdmin, csvUpload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.render('admin/import-judges', {
        title: 'Import Judges from CSV',
        error: 'Please select a CSV file to upload.',
        query: req.query
      });
    }

    // Parse CSV file
    const results = [];
    const headers = [];
    let isFirstRow = true;

    return new Promise((resolve, reject) => {
      fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('headers', (headerList) => {
          headers.push(...headerList);
        })
        .on('data', (data) => {
          if (isFirstRow && headers.length === 0) {
            // If headers weren't detected, use first row as headers
            headers.push(...Object.keys(data));
            isFirstRow = false;
          }
          results.push(data);
        })
        .on('end', () => {
          // Clean up temp file
          fs.unlinkSync(req.file.path);

          // Limit preview to first 10 rows
          const preview = results.slice(0, 10);

          res.render('admin/import-judges-map', {
            title: 'Map CSV Fields',
            headers,
            preview,
            totalRows: results.length,
            csvData: JSON.stringify(results), // Store full data for import
            query: req.query
          });
          resolve();
        })
        .on('error', (error) => {
          // Clean up temp file on error
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
          reject(error);
        });
    });
  } catch (error) {
    console.error('CSV upload error:', error);
    res.render('admin/import-judges', {
      title: 'Import Judges from CSV',
      error: error.message || 'Failed to process CSV file.',
      query: req.query
    });
  }
});

// POST process mapped CSV and import judges
router.post('/judges/import/process', requireAdmin, async (req, res) => {
  try {
    const { csvData, emailField, nameField, roleField } = req.body;

    if (!csvData || !emailField || !nameField) {
      return res.render('admin/import-judges', {
        title: 'Import Judges from CSV',
        error: 'Please map all required fields (Email and Name).',
        query: req.query
      });
    }

    const rows = JSON.parse(csvData);

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const row of rows) {
      const email = row[emailField]?.trim();
      const name = row[nameField]?.trim();
      const role = roleField && row[roleField] ? row[roleField].trim() : 'judge';
      const teamId = row[req.body.teamField]?.trim() || null;

      if (!email || !name) {
        skipped++;
        errors.push(`Row ${imported + skipped}: Missing email or name`);
        continue;
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        skipped++;
        errors.push(`Row ${imported + skipped}: Invalid email format: ${email}`);
        continue;
      }

      // Check for profanity in name field
      if (name) {
        const nameError = await checkAndReturnError(name, 'Name');
        if (nameError) {
          skipped++;
          errors.push(`Row ${imported + skipped}: ${nameError}`);
          continue;
        }
      }

      try {
        // Check if user already exists
        const existingUser = await db.getUserByEmail(email);
        const isNewUser = !existingUser;

        // Get or create user (will create if doesn't exist)
        await db.getOrCreateUser(email, name, role);

        // If team field is mapped, try to assign team
        if (teamId) {
          // You might want to add team assignment logic here
          // For now, we'll just create the user
        }

        // Send confirmation email only to newly created users
        if (isNewUser) {
          try {
            const emailService = require('../services/email');
            const eventSettings = await db.getEventSettings();
            const appUrl = process.env.APP_URL || 'http://localhost:3000';
            await emailService.sendJudgeConfirmation(
              email,
              name || email.split('@')[0],
              role,
              eventSettings.event_name || 'Hackathon',
              appUrl
            );
          } catch (emailError) {
            console.error(`Error sending confirmation email to ${email}:`, emailError);
            // Don't fail import if email fails
          }
        }

        imported++;
      } catch (error) {
        skipped++;
        errors.push(`Row ${imported + skipped}: ${error.message}`);
      }
    }

    res.render('admin/import-judges-result', {
      title: 'Import Results',
      imported,
      skipped,
      total: rows.length,
      errors: errors.slice(0, 20), // Show first 20 errors
      query: req.query
    });
  } catch (error) {
    console.error('CSV import process error:', error);
    res.render('admin/import-judges', {
      title: 'Import Judges from CSV',
      error: error.message || 'Failed to import judges.',
      query: req.query
    });
  }
});

// GET volunteers management page
router.get('/volunteers', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status || null;
    const search = req.query.search || null;
    const volunteers = await db.getVolunteers(status, search);
    const eventSettings = await db.getEventSettings();

    // Count by status (without search filter for accurate counts)
    const allVolunteers = await db.getVolunteers();
    const pendingCount = allVolunteers.filter(v => v.status === 'pending').length;
    const approvedCount = allVolunteers.filter(v => v.status === 'approved').length;
    const deniedCount = allVolunteers.filter(v => v.status === 'denied').length;

    res.render('admin/volunteers', {
      title: 'Manage Volunteers',
      volunteers,
      status,
      search,
      pendingCount,
      approvedCount,
      deniedCount,
      eventSettings,
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    console.error('Error loading volunteers:', error);
    res.render('admin/volunteers', {
      title: 'Manage Volunteers',
      volunteers: [],
      status: null,
      search: null,
      pendingCount: 0,
      approvedCount: 0,
      deniedCount: 0,
      eventSettings: { event_name: 'Hackathon' },
      error: 'An error occurred loading volunteers.',
      success: null
    });
  }
});

// POST approve/deny volunteer
router.post('/volunteers/:id/status', requireAdmin, async (req, res) => {
  try {
    const volunteerId = parseInt(req.params.id);
    const { status } = req.body;
    const reviewedBy = req.session.user.email;

    if (!['approved', 'denied'].includes(status)) {
      return res.redirect('/admin/volunteers?error=invalid_status');
    }

    const volunteer = await db.getVolunteerById(volunteerId);
    if (!volunteer) {
      return res.redirect('/admin/volunteers?error=volunteer_not_found');
    }

    let userId = null;

    // If approving, create a user account with judge role
    if (status === 'approved') {
      try {
        // Check if user already exists
        const existingUser = await db.getUserByEmail(volunteer.email);

        if (existingUser) {
          // User already exists, link to existing user
          userId = existingUser.id;
          // Update role to judge if not already admin
          if (existingUser.role !== 'admin') {
            await db.updateUser(volunteer.email, { role: 'judge' });
          }
        } else {
          // Create new user account
          const newUser = await db.createUser(
            volunteer.email,
            volunteer.name,
            'judge',
            null,
            {
              privacy_policy_accepted: 1,
              terms_accepted: 1,
              acceptable_use_accepted: 1,
              policies_accepted_at: new Date().toISOString()
            }
          );
          userId = newUser.id;

          // Send judge confirmation email
          try {
            const eventSettings = await db.getEventSettings();
            await emailService.sendJudgeConfirmation(
              volunteer.email,
              volunteer.name,
              'judge',
              eventSettings.event_name || 'Hackathon'
            );
          } catch (emailError) {
            console.error('Error sending judge confirmation email:', emailError);
          }
        }
      } catch (userError) {
        console.error('Error creating user account for volunteer:', userError);
        // Continue with approval even if user creation fails
      }
    }

    // Update volunteer status and link to user
    await db.updateVolunteerStatus(volunteerId, status, reviewedBy, userId);

    // Send email notification
    try {
      const eventSettings = await db.getEventSettings();
      await emailService.sendVolunteerStatusUpdate(
        volunteer.email,
        volunteer.name,
        status,
        eventSettings.event_name || 'Hackathon'
      );
    } catch (emailError) {
      console.error('Error sending volunteer status update email:', emailError);
      // Continue even if email fails
    }

    res.redirect(`/admin/volunteers?success=${status === 'approved' ? 'volunteer_approved' : 'volunteer_denied'}`);
  } catch (error) {
    console.error('Error updating volunteer status:', error);
    res.redirect('/admin/volunteers?error=update_failed');
  }
});

// POST update volunteer admin notes
router.post('/volunteers/:id/notes', requireAdmin, async (req, res) => {
  try {
    const volunteerId = parseInt(req.params.id);
    const { admin_notes } = req.body;

    await db.updateVolunteerNotes(volunteerId, admin_notes);

    res.redirect('/admin/volunteers?success=notes_updated');
  } catch (error) {
    console.error('Error updating volunteer notes:', error);
    res.redirect('/admin/volunteers?error=notes_update_failed');
  }
});

// GET lock judging / select winners page
router.get('/judging/finalize', requireAdmin, async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const divisions = eventSettings.divisions || [];

    // Get teams with scores for each division
    const divisionTeams = {};
    for (const division of divisions) {
      divisionTeams[division] = await db.getTeamsByDivisionWithScores(division);
    }

    // Auto-populate winners based on top 3 scores if winners haven't been set
    let winners = eventSettings.winners || {};
    const hasWinners = Object.keys(winners).length > 0;

    if (!hasWinners) {
      // Auto-select top 3 teams by score for each division
      winners = {};
      for (const division of divisions) {
        const teams = divisionTeams[division] || [];
        // Filter teams that have been judged (at least 1 judge)
        const judgedTeams = teams.filter(t => t.judge_count > 0);
        if (judgedTeams.length > 0) {
          // Take top 3 teams (already sorted by avg_score DESC)
          winners[division] = judgedTeams.slice(0, 3).map(t => t.id);
        }
      }

      // Save auto-selected winners if any were found
      if (Object.keys(winners).length > 0) {
        try {
          await db.setWinners(winners);
        } catch (err) {
          console.error('Error auto-saving winners:', err);
          // Continue even if save fails - winners will still be shown in the form
        }
      }
    }

    res.render('admin/finalize-judging', {
      title: 'Finalize Judging',
      eventSettings,
      divisions,
      divisionTeams,
      winners,
      error: null,
      success: req.query.success || null
    });
  } catch (error) {
    console.error('Error loading finalize judging page:', error);
    res.render('error', {
      message: 'Failed to load finalize judging page',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST lock/unlock judging
router.post('/judging/lock', requireAdmin, async (req, res) => {
  try {
    const { locked } = req.body;
    const isLocked = locked === '1' || locked === 'true' || locked === true;

    await db.setJudgingLocked(isLocked);

    res.redirect(`/admin/judging/finalize?success=${isLocked ? 'judging_locked' : 'judging_unlocked'}`);
  } catch (error) {
    console.error('Error locking/unlocking judging:', error);
    res.redirect('/admin/judging/finalize?error=lock_failed');
  }
});

// POST set winners
router.post('/judging/winners', requireAdmin, async (req, res) => {
  try {
    const { winners } = req.body;

    // Parse winners - expect format: { division: [teamId1, teamId2, teamId3] }
    const winnersObj = {};
    if (typeof winners === 'string') {
      try {
        winnersObj = JSON.parse(winners);
      } catch (e) {
        // If not JSON, parse from form data format
        const eventSettings = await db.getEventSettings();
        const divisions = eventSettings.divisions || [];
        for (const division of divisions) {
          const first = req.body[`winner_${division}_1`];
          const second = req.body[`winner_${division}_2`];
          const third = req.body[`winner_${division}_3`];
          if (first || second || third) {
            winnersObj[division] = [first, second, third].filter(id => id);
          }
        }
      }
    } else {
      winnersObj = winners || {};
    }

    await db.setWinners(winnersObj);

    res.redirect('/admin/judging/finalize?success=winners_updated');
  } catch (error) {
    console.error('Error setting winners:', error);
    res.redirect('/admin/judging/finalize?error=winners_failed');
  }
});

// GET newsletter page
router.get('/newsletter', requireAdmin, async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();

    // Get user counts by role for display
    const allUsers = await db.getAllUsers();
    const userCounts = {
      participants: allUsers.filter(u => u.role === 'participant').length,
      judges: allUsers.filter(u => u.role === 'judge').length,
      admins: allUsers.filter(u => u.role === 'admin').length
    };

    // Get approved volunteers count
    const approvedVolunteers = await db.getVolunteers('approved');
    userCounts.volunteers = approvedVolunteers.length;

    res.render('admin/newsletter', {
      title: 'Send Newsletter',
      eventSettings,
      userCounts,
      error: null,
      success: null,
      query: req.query
    });
  } catch (error) {
    console.error('Newsletter page error:', error);
    res.render('error', {
      message: 'Failed to load newsletter page',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST send newsletter
router.post('/newsletter/send', requireAdmin, async (req, res) => {
  try {
    const { subject, content, recipients, confirmSend, sendToken } = req.body;
    const eventSettings = await db.getEventSettings();

    // Require explicit confirmation to prevent accidental sends
    if (confirmSend !== 'true') {
      const allUsers = await db.getAllUsers();
      const userCounts = {
        participants: allUsers.filter(u => u.role === 'participant').length,
        judges: allUsers.filter(u => u.role === 'judge').length,
        admins: allUsers.filter(u => u.role === 'admin').length
      };
      const approvedVolunteers = await db.getVolunteers('approved');
      userCounts.volunteers = approvedVolunteers.length;

      return res.render('admin/newsletter', {
        title: 'Send Newsletter',
        eventSettings,
        userCounts,
        error: 'Please confirm that you want to send the newsletter',
        success: null,
        subject,
        content,
        recipients: Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []),
        query: req.query
      });
    }

    if (!subject || !content) {
      const allUsers = await db.getAllUsers();
      const userCounts = {
        participants: allUsers.filter(u => u.role === 'participant').length,
        judges: allUsers.filter(u => u.role === 'judge').length,
        admins: allUsers.filter(u => u.role === 'admin').length
      };
      const approvedVolunteers = await db.getVolunteers('approved');
      userCounts.volunteers = approvedVolunteers.length;

      return res.render('admin/newsletter', {
        title: 'Send Newsletter',
        eventSettings,
        userCounts,
        error: 'Subject and content are required',
        success: null,
        subject: subject || null,
        content: content || null,
        recipients: recipientsArray,
        query: req.query
      });
    }

    // Normalize recipients to always be an array
    // When only one checkbox is selected, Express sends a string instead of an array
    const recipientsArray = Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []);

    if (!recipientsArray || recipientsArray.length === 0) {
      const allUsers = await db.getAllUsers();
      const userCounts = {
        participants: allUsers.filter(u => u.role === 'participant').length,
        judges: allUsers.filter(u => u.role === 'judge').length,
        admins: allUsers.filter(u => u.role === 'admin').length
      };
      const approvedVolunteers = await db.getVolunteers('approved');
      userCounts.volunteers = approvedVolunteers.length;

      return res.render('admin/newsletter', {
        title: 'Send Newsletter',
        eventSettings,
        userCounts,
        error: 'Please select at least one recipient group',
        success: null,
        subject: subject || null,
        content: content || null,
        recipients: recipientsArray,
        query: req.query
      });
    }

    // Collect all recipient emails based on selected groups
    const recipientEmails = [];
    const allUsers = await db.getAllUsers();

    if (recipientsArray.includes('participants')) {
      const participants = allUsers.filter(u => u.role === 'participant' && u.email);
      participants.forEach(u => recipientEmails.push({ email: u.email, name: u.name || u.email }));
    }

    if (recipientsArray.includes('judges')) {
      const judges = allUsers.filter(u => u.role === 'judge' && u.email);
      judges.forEach(u => recipientEmails.push({ email: u.email, name: u.name || u.email }));
    }

    if (recipientsArray.includes('admins')) {
      const admins = allUsers.filter(u => u.role === 'admin' && u.email);
      admins.forEach(u => recipientEmails.push({ email: u.email, name: u.name || u.email }));
    }

    if (recipientsArray.includes('volunteers')) {
      const approvedVolunteers = await db.getVolunteers('approved');
      approvedVolunteers.forEach(v => {
        // Use user_email if linked, otherwise use volunteer email
        const email = v.user_email || v.email;
        if (email) {
          recipientEmails.push({ email: email, name: v.name || email });
        }
      });
    }

    // Remove duplicates (in case a user has multiple roles)
    const uniqueRecipients = [];
    const seenEmails = new Set();
    recipientEmails.forEach(r => {
      if (!seenEmails.has(r.email.toLowerCase())) {
        seenEmails.add(r.email.toLowerCase());
        uniqueRecipients.push(r);
      }
    });

    if (uniqueRecipients.length === 0) {
      const userCounts = {
        participants: allUsers.filter(u => u.role === 'participant').length,
        judges: allUsers.filter(u => u.role === 'judge').length,
        admins: allUsers.filter(u => u.role === 'admin').length
      };
      const approvedVolunteers = await db.getVolunteers('approved');
      userCounts.volunteers = approvedVolunteers.length;

      return res.render('admin/newsletter', {
        title: 'Send Newsletter',
        eventSettings,
        userCounts,
        error: 'No recipients found for the selected groups',
        success: null,
        subject: subject || null,
        content: content || null,
        recipients: recipientsArray,
        query: req.query
      });
    }

    // Check if this newsletter was already sent (prevent duplicates)
    // Create a hash from subject, content, and recipients to uniquely identify this newsletter
    const sendHash = db.createNewsletterSendHash(subject, content, recipientsArray);
    const existingSend = await db.checkNewsletterAlreadySent(sendHash);

    if (existingSend) {
      const userCounts = {
        participants: allUsers.filter(u => u.role === 'participant').length,
        judges: allUsers.filter(u => u.role === 'judge').length,
        admins: allUsers.filter(u => u.role === 'admin').length
      };
      const approvedVolunteers = await db.getVolunteers('approved');
      userCounts.volunteers = approvedVolunteers.length;

      const sentDate = new Date(existingSend.sent_at).toLocaleString();
      return res.render('admin/newsletter', {
        title: 'Send Newsletter',
        eventSettings,
        userCounts,
        error: `This newsletter was already sent on ${sentDate} by ${existingSend.sent_by}. To send a different newsletter, please modify the subject or content.`,
        success: null,
        subject: subject || null,
        content: content || null,
        recipients: recipientsArray,
        query: req.query
      });
    }

    // Send newsletter
    const result = await emailService.sendNewsletter(
      uniqueRecipients,
      subject,
      content,
      eventSettings.event_name || 'Hackathon'
    );

    // Log the newsletter send in the database
    try {
      await db.logNewsletterSend(
        sendHash,
        subject,
        content,
        recipientsArray,
        uniqueRecipients.length,
        result.sent,
        result.failed,
        req.session.user.email || 'unknown'
      );
    } catch (logError) {
      console.error('Error logging newsletter send:', logError);
      // Don't fail the request if logging fails, but log the error
    }

    // Render success page with results
    res.render('admin/newsletter', {
      title: 'Send Newsletter',
      eventSettings,
      userCounts: {
        participants: allUsers.filter(u => u.role === 'participant').length,
        judges: allUsers.filter(u => u.role === 'judge').length,
        admins: allUsers.filter(u => u.role === 'admin').length,
        volunteers: (await db.getVolunteers('approved')).length
      },
      error: result.failed > 0 ? `Newsletter sent to ${result.sent} recipients, but ${result.failed} failed.` : null,
      success: result.failed === 0 ? `Newsletter successfully sent to ${result.sent} recipients!` : null,
      sendResult: result,
      query: req.query
    });
  } catch (error) {
    console.error('Send newsletter error:', error);
    const eventSettings = await db.getEventSettings();
    const allUsers = await db.getAllUsers();
    const userCounts = {
      participants: allUsers.filter(u => u.role === 'participant').length,
      judges: allUsers.filter(u => u.role === 'judge').length,
      admins: allUsers.filter(u => u.role === 'admin').length
    };
    const approvedVolunteers = await db.getVolunteers('approved');
    userCounts.volunteers = approvedVolunteers.length;

    res.render('admin/newsletter', {
      title: 'Send Newsletter',
      eventSettings,
      userCounts,
      error: 'Failed to send newsletter: ' + (error.message || 'Unknown error'),
      success: null,
      query: req.query
    });
  }
});

module.exports = router;

