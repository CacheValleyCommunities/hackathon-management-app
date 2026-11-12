const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { checkAndReturnError } = require('../middleware/validation');

router.use((req, res, next) => {
  if (!req.session.user) return res.redirect('/auth/login');
  if (!req.eventId) return res.redirect('/events');
  if (!req.eventSettings || req.eventSettings.status !== 'open') {
    return res.status(403).render('error', { message: 'Registration is closed for this event.' });
  }
  res.locals.isSchool = req.session.user.account_type === 'school';
  next();
});

// GET registration form page
router.get('/', async (req, res) => {
  try {
    const eventSettings = req.eventSettings || await db.getEventSettings(req.eventId);
    const tables = await db.getTableNames(req.eventId);
    const categories = await db.getCategories(req.eventId) || [];
    if (req.session.user.account_type !== 'school') {
      const user = await db.getUserByEmail(req.session.user.email);
      const existing = user ? await db.getIndividualTeam(req.eventId, user.id) : null;
      if (existing) return res.redirect('/participant');
    }
    res.render('register', {
      title: 'Team Registration',
      error: null,
      success: null,
      divisions: eventSettings.divisions || [],
      tables: tables || [],
      categories: categories || []
    });
  } catch (error) {
    console.error('Error loading registration page:', error);
    res.render('register', {
      title: 'Team Registration',
      error: null,
      success: null,
      divisions: [],
      tables: [],
      categories: []
    });
  }
});

// POST submit registration
router.post('/', async (req, res) => {
  let eventSettings;
  let allTables;

  try {
    const {
      teamName, tableName, projectName, contactEmail, githubLink, websiteLink, division, categoryId, teamMembers,
      isUnder18, guardianEmail, privacyPolicyAccepted, termsAccepted, acceptableUseAccepted, emailPreferences
    } = req.body;

    // Load data once
    eventSettings = req.eventSettings || await db.getEventSettings(req.eventId);
    allTables = await db.getTableNames(req.eventId);
    const categories = await db.getCategories(req.eventId) || [];
    const isSchool = req.session.user.account_type === 'school';

    // Validation
    if (!teamName || !tableName || !projectName) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'Please fill in all required fields (Team Name, Table Name, Project Name)',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    // Validate category is selected
    if (!categoryId || categoryId === '') {
      return res.render('register', {
        title: 'Team Registration',
        error: 'Please select a category for your team',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    // Validate division is selected (if divisions exist)
    if (eventSettings.divisions && eventSettings.divisions.length > 0 && (!division || division === '')) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'Please select a division for your team',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    // Validate policy acceptance
    if (!privacyPolicyAccepted || !termsAccepted || !acceptableUseAccepted) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'You must accept all required policies (Privacy Policy, Terms of Use, and Acceptable Use Policy) to register.',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    if (isSchool && (teamMembers || isUnder18 || guardianEmail)) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'School accounts register teams with chaperone contact details only. Do not submit student names, ages, or guardian emails.',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    const isUnder18Bool = !isSchool && (isUnder18 === '1' || isUnder18 === true);
    let finalContactEmail = isSchool ? req.session.user.email : (contactEmail ? contactEmail.trim() : null);

    if (isSchool) {
      // Contact is the signed-in chaperone.
    } else if (isUnder18Bool) {
      if (!guardianEmail || !guardianEmail.trim() || !guardianEmail.includes('@')) {
        return res.render('register', {
          title: 'Team Registration',
          error: 'Guardian email is required for participants under 18 years of age.',
          success: null,
          divisions: eventSettings.divisions || [],
          tables: allTables,
          categories
        });
      }
      // Use guardian email as contact email if contact email not provided
      if (!finalContactEmail) {
        finalContactEmail = guardianEmail.trim();
      }
    } else {
      // For users 18+: contact email is required
      if (!finalContactEmail || !finalContactEmail.includes('@')) {
        return res.render('register', {
          title: 'Team Registration',
          error: 'Contact email is required for participants 18 years of age or older.',
          success: null,
          divisions: eventSettings.divisions || [],
          tables: allTables,
          categories
        });
      }
    }

    // Check for profanity in team name and project name
    const teamNameError = await checkAndReturnError(teamName, 'Team name');
    const projectNameError = await checkAndReturnError(projectName, 'Project name');

    if (teamNameError || projectNameError) {
      return res.render('register', {
        title: 'Team Registration',
        error: teamNameError || projectNameError,
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    // Normalize table name - accept both numeric (Table 1) and chessboard style (a1, b12)
    let normalizedTableName = tableName.trim();
    // If it's a number, prefix with "Table "
    if (/^\d+$/.test(normalizedTableName)) {
      normalizedTableName = `Table ${normalizedTableName}`;
    }
    // Otherwise, use as-is (chessboard style like a1, b12)

    if (!allTables.includes(normalizedTableName)) {
      // Create table if it doesn't exist
      await db.syncTables(req.eventId, [{ name: normalizedTableName }]);
    }

    // Check if team name already exists
    const existingTeams = await db.getTeams(req.eventId);
    const teamExists = existingTeams.some(t => t.name.toLowerCase() === teamName.toLowerCase());

    if (teamExists) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'A team with this name already exists. Please choose a different name.',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables,
        categories
      });
    }

    const actingUser = await db.getUserByEmail(req.session.user.email);
    if (!isSchool) {
      const existingIndividual = await db.getIndividualTeam(req.eventId, actingUser.id);
      if (existingIndividual) {
        return res.render('register', {
          title: 'Team Registration',
          error: 'You already have a team for this event.',
          success: null,
          divisions: eventSettings.divisions || [],
          tables: allTables,
          categories
        });
      }
    }

    let teamMembersArray = [];
    if (teamMembers) {
      try {
        if (typeof teamMembers === 'string') {
          // Try JSON first
          try {
            teamMembersArray = JSON.parse(teamMembers);
          } catch (e) {
            // If not JSON, try comma-separated or newline-separated
            teamMembersArray = teamMembers.split(/[,\n]/).map(m => m.trim()).filter(m => m);
          }
        } else if (Array.isArray(teamMembers)) {
          teamMembersArray = teamMembers;
        }
      } catch (e) {
        // If parsing fails, use empty array
        teamMembersArray = [];
      }
    }

    let teamLeaderEmail = req.session.user.email;
    let teamContactEmail = isSchool ? req.session.user.email : null;
    if (!isSchool && isUnder18Bool && guardianEmail) {
      teamLeaderEmail = guardianEmail.trim();
      teamContactEmail = guardianEmail.trim();
    } else if (!isSchool && finalContactEmail) {
      teamContactEmail = finalContactEmail;
    }

    // Parse category ID
    const categoryIdInt = categoryId && categoryId !== '' ? parseInt(categoryId) : null;

    const team = await db.createTeam({
      event_id: req.eventId,
      name: teamName.trim(),
      table_name: normalizedTableName,
      project_name: projectName.trim(),
      contact_email: teamContactEmail,
      github_link: githubLink ? githubLink.trim() : null,
      website_link: websiteLink ? websiteLink.trim() : null,
      division: division || null,
      category_id: categoryIdInt,
      is_published: false,
      team_members: isSchool ? null : (teamMembersArray.length > 0 ? teamMembersArray : null),
      team_leader_email: teamLeaderEmail,
      owner_user_id: actingUser.id,
      registration_type: isSchool ? 'school' : 'individual'
    });

    const policyData = {
      privacy_policy_accepted: true,
      terms_accepted: true,
      acceptable_use_accepted: true,
      policies_accepted_at: new Date().toISOString(),
      is_under_18: isUnder18Bool,
      guardian_email: !isSchool && isUnder18Bool && guardianEmail ? guardianEmail.trim() : null,
      email_preferences: emailPreferences === '1' || emailPreferences === true
    };

    const accountEmail = (!isSchool && isUnder18Bool && guardianEmail)
      ? guardianEmail.toLowerCase().trim()
      : req.session.user.email;
    let accountUser = await db.getUserByEmail(accountEmail);
    if (accountUser) {
      await db.updateUser(accountEmail, {
        ...policyData,
        team_id: team.id,
        role: accountUser.role === 'admin' ? 'admin' : 'user'
      });
    } else {
      accountUser = await db.createUser(accountEmail, null, 'user', team.id, policyData);
    }
    await db.upsertMembership(accountUser.id, req.eventId, isSchool ? 'chaperone' : 'participant');
    if (accountEmail !== req.session.user.email) {
      await db.updateTeam(team.id, { owner_user_id: accountUser.id });
    }

    // Send confirmation email
    // For under 18: send guardian notification email (guardian must complete setup)
    // For 18+: send regular team registration confirmation
    let emailSent = false;
    let emailRecipient = null;

    if (isUnder18Bool && guardianEmail) {
      // Send guardian notification email
      try {
        const emailService = require('../services/email');
        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        await emailService.sendGuardianNotification(
          guardianEmail.trim(),
          teamName.trim(),
          normalizedTableName,
          eventSettings.event_name || 'Hackathon',
          appUrl
        );
        emailSent = true;
        emailRecipient = guardianEmail.trim();
      } catch (emailError) {
        console.error('Error sending guardian notification email:', emailError);
        // Don't fail registration if email fails
      }
    } else if (finalContactEmail) {
      // Send regular team registration confirmation
      try {
        const emailService = require('../services/email');
        const appUrl = process.env.APP_URL || 'http://localhost:3000';
        await emailService.sendTeamRegistrationConfirmation(
          finalContactEmail,
          teamName.trim(),
          normalizedTableName,
          eventSettings.event_name || 'Hackathon',
          appUrl
        );
        emailSent = true;
        emailRecipient = finalContactEmail;
      } catch (emailError) {
        console.error('Error sending team registration confirmation email:', emailError);
        // Don't fail registration if email fails
      }
    }

    // Build success message
    let successMessage = `Team "${teamName}" successfully registered at ${normalizedTableName}!`;
    if (isUnder18Bool && guardianEmail) {
      successMessage += ` A notification has been sent to the guardian email (${emailRecipient}). The guardian must log in to complete the team setup and verify all information.`;
    } else if (emailSent) {
      successMessage += ` A confirmation email has been sent to ${emailRecipient}.`;
    }

    res.render('register', {
      title: 'Team Registration',
      error: null,
      success: successMessage,
      divisions: eventSettings.divisions || [],
      tables: allTables,
      categories,
      isUnder18: isUnder18Bool,
      guardianEmail: isUnder18Bool ? guardianEmail : null
    });
  } catch (error) {
    console.error('Registration error:', error);
    // Ensure we have the data for error rendering
    if (!eventSettings) eventSettings = req.eventSettings || await db.getEventSettings(req.eventId);
    if (!allTables) allTables = await db.getTableNames(req.eventId);
    let categories = [];
    try {
      categories = await db.getCategories(req.eventId);
    } catch (catError) {
      console.error('Error loading categories:', catError);
    }

    res.render('register', {
      title: 'Team Registration',
      error: 'An error occurred during registration. Please try again.',
      success: null,
      divisions: eventSettings.divisions || [],
      tables: allTables,
      categories
    });
  }
});

module.exports = router;

