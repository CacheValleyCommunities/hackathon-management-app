const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { checkAndReturnError } = require('../middleware/validation');

// GET registration form page
router.get('/', async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const tables = await db.getTableNames();
    res.render('register', {
      title: 'Team Registration',
      error: null,
      success: null,
      divisions: eventSettings.divisions || [],
      tables
    });
  } catch (error) {
    res.render('register', {
      title: 'Team Registration',
      error: null,
      success: null,
      divisions: [],
      tables: []
    });
  }
});

// POST submit registration
router.post('/', async (req, res) => {
  let eventSettings;
  let allTables;

  try {
    const {
      teamName, tableName, projectName, contactEmail, githubLink, websiteLink, division, teamMembers,
      isUnder18, guardianEmail, privacyPolicyAccepted, termsAccepted, acceptableUseAccepted, emailPreferences
    } = req.body;

    // Load data once
    eventSettings = await db.getEventSettings();
    allTables = await db.getTableNames();

    // Validation
    if (!teamName || !tableName || !projectName) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'Please fill in all required fields (Team Name, Table Name, Project Name)',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables
      });
    }

    // Validate policy acceptance
    if (!privacyPolicyAccepted || !termsAccepted || !acceptableUseAccepted) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'You must accept all required policies (Privacy Policy, Terms of Use, and Acceptable Use Policy) to register.',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables
      });
    }

    // Validate age and email requirements
    const isUnder18Bool = isUnder18 === '1' || isUnder18 === true;

    // Determine the contact email to use
    // For users under 18: guardian email is required, contact email is optional (use guardian if not provided)
    // For users 18+: contact email is required
    let finalContactEmail = contactEmail ? contactEmail.trim() : null;

    if (isUnder18Bool) {
      if (!guardianEmail || !guardianEmail.trim() || !guardianEmail.includes('@')) {
        return res.render('register', {
          title: 'Team Registration',
          error: 'Guardian email is required for participants under 18 years of age.',
          success: null,
          divisions: eventSettings.divisions || [],
          tables: allTables
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
          tables: allTables
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
        tables: allTables
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
      await db.syncTables([{ name: normalizedTableName }]);
    }

    // Check if team name already exists
    const existingTeams = await db.getTeams();
    const teamExists = existingTeams.some(t => t.name.toLowerCase() === teamName.toLowerCase());

    if (teamExists) {
      return res.render('register', {
        title: 'Team Registration',
        error: 'A team with this name already exists. Please choose a different name.',
        success: null,
        divisions: eventSettings.divisions || [],
        tables: allTables
      });
    }

    // Parse team members
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

    // Determine team leader email
    // For under 18: use guardian email as team leader email (since we don't collect participant email)
    // For 18+: use logged-in user's email if available, otherwise contact email
    let teamLeaderEmail = null;
    if (isUnder18Bool && guardianEmail) {
      teamLeaderEmail = guardianEmail.trim();
    } else if (req.session.user && req.session.user.email) {
      teamLeaderEmail = req.session.user.email;
    } else if (finalContactEmail) {
      teamLeaderEmail = finalContactEmail;
    }

    // Determine contact email for team
    // For under 18: use guardian email as contact email (since participant email not collected)
    // For 18+: use contact email if provided
    let teamContactEmail = null;
    if (isUnder18Bool && guardianEmail) {
      teamContactEmail = guardianEmail.trim();
    } else if (finalContactEmail) {
      teamContactEmail = finalContactEmail;
    }

    // Create team
    const team = await db.createTeam({
      name: teamName.trim(),
      table_name: normalizedTableName,
      project_name: projectName.trim(),
      contact_email: teamContactEmail,
      github_link: githubLink ? githubLink.trim() : null,
      website_link: websiteLink ? websiteLink.trim() : null,
      division: division || null,
      team_members: teamMembersArray.length > 0 ? teamMembersArray : null,
      team_leader_email: teamLeaderEmail
    });

    // Create/update user account if applicable
    // For under 18: create account using guardian email (since participant email not collected)
    // For 18+: create account using contact email or logged-in user email
    const policyData = {
      privacy_policy_accepted: true,
      terms_accepted: true,
      acceptable_use_accepted: true,
      policies_accepted_at: new Date().toISOString(),
      is_under_18: isUnder18Bool,
      guardian_email: isUnder18Bool && guardianEmail ? guardianEmail.trim() : null,
      email_preferences: emailPreferences === '1' || emailPreferences === true
    };

    if (isUnder18Bool && guardianEmail) {
      // For under 18, use guardian email for account creation
      const guardianEmailLower = guardianEmail.toLowerCase().trim();
      const existingUser = await db.getUserByEmail(guardianEmailLower);

      if (existingUser) {
        await db.updateUser(guardianEmailLower, {
          role: 'participant',
          team_id: team.id,
          ...policyData
        });
      } else {
        await db.createUser(guardianEmailLower, null, 'participant', team.id, policyData);
      }
    } else if (req.session.user && !req.session.user.team_id && finalContactEmail) {
      // If logged in and contact email provided, link to team
      const userEmail = finalContactEmail.toLowerCase();
      const existingUser = await db.getUserByEmail(userEmail);

      if (existingUser) {
        await db.updateUser(userEmail, {
          role: 'participant',
          team_id: team.id,
          ...policyData
        });
      } else {
        await db.createUser(userEmail, null, 'participant', team.id, policyData);
      }
    } else if (finalContactEmail) {
      // If not logged in but contact email provided, create/update user
      const userEmail = finalContactEmail.toLowerCase();
      const existingUser = await db.getUserByEmail(userEmail);

      if (existingUser) {
        await db.updateUser(userEmail, policyData);
      } else {
        await db.createUser(userEmail, null, 'participant', team.id, policyData);
      }
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
      isUnder18: isUnder18Bool,
      guardianEmail: isUnder18Bool ? guardianEmail : null
    });
  } catch (error) {
    console.error('Registration error:', error);
    // Ensure we have the data for error rendering
    if (!eventSettings) eventSettings = await db.getEventSettings();
    if (!allTables) allTables = await db.getTableNames();

    res.render('register', {
      title: 'Team Registration',
      error: 'An error occurred during registration. Please try again.',
      success: null,
      divisions: eventSettings.divisions || [],
      tables: allTables
    });
  }
});

module.exports = router;

