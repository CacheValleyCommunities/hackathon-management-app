const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../db/database');
const emailService = require('../services/email');
const { checkAndReturnError } = require('../middleware/validation');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';
const JWT_EXPIRES_IN = '7d';

const sessionPayload = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role === 'admin' ? 'admin' : 'user',
  account_type: user.account_type || 'individual',
  school_name: user.school_name || null
});

const asList = (value) => {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
};

const isEmail = (value) => typeof value === 'string' && value.includes('@') && !value.includes(' ');

const inviteIsOpen = (invite) => {
  if (!invite || invite.used_at) return false;
  return new Date(invite.expires_at).getTime() > Date.now();
};

const usesSchoolWizard = (req, draft) => {
  return req.session.user.account_type === 'school' && !(draft && draft.inviteToken);
};

const emptyDraft = (req) => ({
  step: 'event',
  eventId: req.session.eventId || null,
  belongsToSchool: null,
  isUnder18: false,
  guardianEmail: null,
  inviteToken: null,
  members: []
});

const saveDraft = (req, draft) => {
  req.session.registrationDraft = {
    step: draft.step,
    eventId: draft.eventId || null,
    belongsToSchool: draft.belongsToSchool === true ? true : (draft.belongsToSchool === false ? false : null),
    isUnder18: !!draft.isUnder18,
    guardianEmail: draft.guardianEmail || null,
    inviteToken: draft.inviteToken || null,
    members: Array.isArray(draft.members) ? draft.members : []
  };
  return req.session.registrationDraft;
};

const draftFor = (req) => {
  if (!req.session.registrationDraft) {
    return saveDraft(req, emptyDraft(req));
  }
  return saveDraft(req, req.session.registrationDraft);
};

const progressFor = (draft, schoolWizard) => {
  if (draft.step === 'done') return null;
  if (schoolWizard) {
    const order = ['event', 'project'];
    const labels = { event: 'Event', project: 'Project' };
    const index = Math.max(0, order.indexOf(draft.step));
    return { current: index + 1, total: order.length, label: labels[draft.step] || 'Event' };
  }
  if (draft.inviteToken) {
    const order = ['members', 'project'];
    const labels = { members: 'Team', project: 'Project' };
    const index = Math.max(0, order.indexOf(draft.step));
    return { current: index + 1, total: order.length, label: labels[draft.step] || 'Team' };
  }
  if (draft.step === 'parent' || draft.step === 'parent-sent') {
    return { current: 4, total: 4, label: 'Parent' };
  }
  const order = ['event', 'school', 'age', 'members', 'project'];
  const labels = {
    event: 'Event',
    school: 'School',
    chaperone: 'School',
    age: 'Age',
    members: 'Team',
    project: 'Project'
  };
  const index = Math.max(0, order.indexOf(draft.step === 'chaperone' ? 'school' : draft.step));
  return { current: index + 1, total: order.length, label: labels[draft.step] || 'Event' };
};

const previousStep = (draft, schoolWizard) => {
  if (schoolWizard) {
    return draft.step === 'project' ? 'event' : null;
  }
  if (draft.inviteToken) {
    return draft.step === 'project' ? 'members' : null;
  }
  const previous = {
    school: 'event',
    chaperone: 'school',
    age: 'school',
    parent: 'age',
    'parent-sent': 'parent',
    members: 'age',
    project: 'members'
  };
  return previous[draft.step] || null;
};

const saveAndRedirect = (req, res, target = '/register') => {
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).render('error', { message: 'Could not save your progress. Please try again.' });
    }
    return res.redirect(target);
  });
};

const signInUser = (req, res, user) => {
  const payload = sessionPayload(user);
  const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.cookie('token', jwtToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  });
  req.session.user = payload;
};

const renderWizard = async (req, res, options = {}) => {
  const draft = draftFor(req);
  const schoolWizard = usesSchoolWizard(req, draft);
  if (schoolWizard && !['event', 'project'].includes(draft.step)) {
    draft.step = draft.eventId ? 'project' : 'event';
    saveDraft(req, draft);
  }

  let tables = [];
  let categories = [];
  let divisions = [];
  let eventName = null;
  if (draft.eventId) {
    const event = await db.getEventById(draft.eventId);
    if (event) {
      eventName = event.event_name;
      divisions = event.divisions || [];
      tables = await db.getTableNames(draft.eventId) || [];
      categories = await db.getCategories(draft.eventId) || [];
    }
  }

  const openEvents = (await db.listVisibleEvents(req.session.user)).filter(event => event.status === 'open');
  const submittedMembers = options.members;
  const members = submittedMembers || (draft.members.length
    ? draft.members
    : [{ name: req.session.user.name || '', email: req.session.user.email || '' }]);

  res.render('register', {
    title: 'Team Registration',
    step: draft.step,
    error: options.error || null,
    isSchool: schoolWizard,
    progress: progressFor(draft, schoolWizard),
    canGoBack: !!previousStep(draft, schoolWizard),
    events: openEvents,
    selectedEventId: draft.eventId,
    eventName,
    divisions,
    tables,
    categories,
    members,
    guardianEmail: draft.guardianEmail,
    form: options.form || {}
  });
};

const requireDraftEvent = async (req, res, draft) => {
  const event = draft.eventId ? await db.getEventById(draft.eventId) : null;
  if (!event || event.status !== 'open') {
    draft.step = 'event';
    saveDraft(req, draft);
    await renderWizard(req, res, { error: 'Choose an open event before continuing.' });
    return null;
  }
  return event;
};

const parseMembers = (body) => {
  const names = asList(body.memberName);
  const emails = asList(body.memberEmail);
  const count = Math.max(names.length, emails.length);
  const members = [];
  for (let index = 0; index < count; index += 1) {
    const name = String(names[index] || '').trim();
    const email = String(emails[index] || '').trim();
    if (!name && !email) continue;
    members.push({ name, email });
  }
  return members;
};

const membersError = (members) => {
  if (!members.length) return 'Add at least one team member.';
  for (const member of members) {
    if (!member.name) return 'Each team member needs a name.';
    if (!isEmail(member.email)) return 'Each team member needs an email address.';
  }
  return null;
};

router.get('/continue', async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const invite = token ? await db.getRegistrationInvite(token) : null;
    if (!inviteIsOpen(invite)) {
      return res.status(400).render('error', {
        message: 'This signup link is not valid, or it has already been used.'
      });
    }

    const event = await db.getEventById(invite.event_id);
    if (!event || event.status !== 'open') {
      return res.status(403).render('error', { message: 'Registration is closed for this event.' });
    }

    const user = await db.getOrCreateUser(invite.guardian_email);
    const existing = await db.getIndividualTeam(event.id, user.id);
    if (existing) {
      return res.status(400).render('error', {
        message: 'This account already has a team for this event.'
      });
    }

    signInUser(req, res, user);
    req.session.eventId = event.id;
    delete req.session.currentRound;
    saveDraft(req, {
      step: 'members',
      eventId: event.id,
      belongsToSchool: false,
      isUnder18: true,
      guardianEmail: invite.guardian_email,
      inviteToken: invite.token,
      members: [{ name: user.name || '', email: user.email }]
    });
    return saveAndRedirect(req, res);
  } catch (error) {
    console.error('Registration continue error:', error);
    return res.status(500).render('error', { message: 'Could not open that signup link.' });
  }
});

router.use((req, res, next) => {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
});

router.get('/', async (req, res) => {
  try {
    draftFor(req);
    await renderWizard(req, res);
  } catch (error) {
    console.error('Error loading registration page:', error);
    res.status(500).render('error', { message: 'Could not load registration.' });
  }
});

router.get('/complete', (req, res) => {
  const result = req.session.registrationResult;
  if (!result) return res.redirect('/register');
  delete req.session.registrationResult;
  res.render('register', {
    title: 'Team Registration',
    step: 'done',
    error: null,
    isSchool: !!result.isSchool,
    progress: null,
    canGoBack: false,
    success: result.message,
    dashboardUrl: result.isSchool ? '/school' : '/participant'
  });
});

router.post('/back', async (req, res) => {
  const draft = draftFor(req);
  const schoolWizard = usesSchoolWizard(req, draft);
  const target = previousStep(draft, schoolWizard);
  if (target) {
    draft.step = target;
    saveDraft(req, draft);
  }
  return saveAndRedirect(req, res);
});

router.post('/event', async (req, res) => {
  try {
    const draft = draftFor(req);
    if (draft.inviteToken) return saveAndRedirect(req, res);
    const event = await db.getEventById(parseInt(req.body.eventId, 10));
    if (!event || event.status !== 'open') {
      return renderWizard(req, res, { error: 'Choose an open event.' });
    }

    const user = await db.getUserByEmail(req.session.user.email);
    if (!usesSchoolWizard(req, draft)) {
      const existing = user ? await db.getIndividualTeam(event.id, user.id) : null;
      if (existing) {
        req.session.eventId = event.id;
        delete req.session.currentRound;
        return saveAndRedirect(req, res, '/participant');
      }
    } else if (user) {
      const membership = await db.getMembership(user.id, event.id);
      if (!membership) await db.upsertMembership(user.id, event.id, 'chaperone');
    }

    req.session.eventId = event.id;
    delete req.session.currentRound;
    draft.eventId = event.id;
    draft.step = usesSchoolWizard(req, draft) ? 'project' : 'school';
    saveDraft(req, draft);
    return saveAndRedirect(req, res);
  } catch (error) {
    console.error('Registration event step error:', error);
    return renderWizard(req, res, { error: 'Could not select that event. Please try again.' });
  }
});

router.post('/school', async (req, res) => {
  const draft = draftFor(req);
  if (draft.inviteToken || usesSchoolWizard(req, draft)) return saveAndRedirect(req, res);
  if (!await requireDraftEvent(req, res, draft)) return;

  const answer = req.body.belongsToSchool;
  if (answer !== 'yes' && answer !== 'no') {
    draft.step = 'school';
    saveDraft(req, draft);
    return renderWizard(req, res, { error: 'Tell us whether you are part of a school.' });
  }

  draft.belongsToSchool = answer === 'yes';
  draft.step = answer === 'yes' ? 'chaperone' : 'age';
  saveDraft(req, draft);
  return saveAndRedirect(req, res);
});

router.post('/age', async (req, res) => {
  const draft = draftFor(req);
  if (draft.inviteToken || usesSchoolWizard(req, draft) || draft.belongsToSchool !== false) {
    return saveAndRedirect(req, res);
  }
  if (!await requireDraftEvent(req, res, draft)) return;

  const answer = req.body.isUnder18;
  if (answer !== 'yes' && answer !== 'no') {
    draft.step = 'age';
    saveDraft(req, draft);
    return renderWizard(req, res, { error: 'Tell us whether you are under 18.' });
  }

  draft.isUnder18 = answer === 'yes';
  draft.inviteToken = null;
  if (answer === 'yes') {
    draft.step = 'parent';
  } else {
    draft.guardianEmail = null;
    draft.step = 'members';
    if (!draft.members.length) {
      draft.members = [{ name: req.session.user.name || '', email: req.session.user.email || '' }];
    }
  }
  saveDraft(req, draft);
  return saveAndRedirect(req, res);
});

router.post('/parent', async (req, res) => {
  const draft = draftFor(req);
  if (usesSchoolWizard(req, draft) || draft.belongsToSchool !== false || !draft.isUnder18 || draft.inviteToken) {
    return saveAndRedirect(req, res);
  }
  const event = await requireDraftEvent(req, res, draft);
  if (!event) return;

  const guardianEmail = typeof req.body.guardianEmail === 'string' ? req.body.guardianEmail.trim() : '';
  if (!isEmail(guardianEmail)) {
    draft.step = 'parent';
    saveDraft(req, draft);
    return renderWizard(req, res, { error: 'Enter a parent email address so they can finish signup.' });
  }

  let invite = null;
  try {
    const user = await db.getUserByEmail(req.session.user.email);
    invite = await db.createRegistrationInvite({
      eventId: event.id,
      guardianEmail,
      invitedByUserId: user ? user.id : null
    });
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    await emailService.sendParentRegistrationInvite(
      invite.guardian_email,
      event.event_name || 'Hackathon',
      `${appUrl}/register/continue?token=${encodeURIComponent(invite.token)}`
    );
    draft.guardianEmail = invite.guardian_email;
    draft.step = 'parent-sent';
    saveDraft(req, draft);
    return saveAndRedirect(req, res);
  } catch (error) {
    console.error('Parent invite error:', error);
    if (invite) {
      try {
        await db.deleteRegistrationInvite(invite.token);
      } catch (deleteError) {
        console.error('Could not remove unsent parent invite:', deleteError);
      }
    }
    draft.step = 'parent';
    draft.guardianEmail = guardianEmail;
    saveDraft(req, draft);
    return renderWizard(req, res, {
      error: 'We could not send the email. Check the address and try again.'
    });
  }
});

router.post('/members', async (req, res) => {
  const draft = draftFor(req);
  const schoolWizard = usesSchoolWizard(req, draft);
  if (schoolWizard || draft.belongsToSchool === true) return saveAndRedirect(req, res);
  if (draft.isUnder18 && !draft.inviteToken) return saveAndRedirect(req, res);
  if (!await requireDraftEvent(req, res, draft)) return;

  const members = parseMembers(req.body);
  const error = membersError(members);
  if (error) {
    draft.step = 'members';
    saveDraft(req, draft);
    return renderWizard(req, res, { error, members });
  }

  draft.members = members;
  draft.step = 'project';
  saveDraft(req, draft);
  return saveAndRedirect(req, res);
});

router.post('/project', async (req, res) => {
  const draft = draftFor(req);
  const schoolWizard = usesSchoolWizard(req, draft);
  const event = await requireDraftEvent(req, res, draft);
  if (!event) return;

  if (!schoolWizard && draft.belongsToSchool === true) {
    draft.step = 'chaperone';
    saveDraft(req, draft);
    return saveAndRedirect(req, res);
  }
  if (!schoolWizard && draft.isUnder18 && !draft.inviteToken) {
    draft.step = 'parent';
    saveDraft(req, draft);
    return saveAndRedirect(req, res);
  }
  if (!schoolWizard) {
    const error = membersError(draft.members);
    if (error) {
      draft.step = 'members';
      saveDraft(req, draft);
      return saveAndRedirect(req, res);
    }
  }

  const {
    teamName, tableName, projectName, githubLink, websiteLink, division, categoryId,
    privacyPolicyAccepted, termsAccepted, acceptableUseAccepted, emailPreferences
  } = req.body;
  const form = {
    teamName,
    tableName,
    projectName,
    githubLink,
    websiteLink,
    division,
    categoryId,
    privacyPolicyAccepted,
    termsAccepted,
    acceptableUseAccepted,
    emailPreferences
  };

  const fail = async (message) => {
    draft.step = 'project';
    saveDraft(req, draft);
    return renderWizard(req, res, { error: message, form });
  };

  try {
    if (schoolWizard && (req.body.memberName || req.body.memberEmail || req.body.teamMembers || req.body.isUnder18 || req.body.guardianEmail)) {
      return fail('School accounts register teams with chaperone contact details only. Do not submit student names, ages, or guardian emails.');
    }
    if (!teamName || !tableName || !projectName) {
      return fail('Please fill in all required fields (Team Name, Table Name, Project Name).');
    }
    if (!categoryId) return fail('Please select a category for your team.');
    if (event.divisions && event.divisions.length > 0 && !division) {
      return fail('Please select a division for your team.');
    }
    if (!privacyPolicyAccepted || !termsAccepted || !acceptableUseAccepted) {
      return fail('You must accept all required policies (Privacy Policy, Terms of Use, and Acceptable Use Policy) to register.');
    }

    const teamNameError = await checkAndReturnError(teamName, 'Team name');
    const projectNameError = await checkAndReturnError(projectName, 'Project name');
    if (teamNameError || projectNameError) return fail(teamNameError || projectNameError);

    let normalizedTableName = tableName.trim();
    if (/^\d+$/.test(normalizedTableName)) normalizedTableName = `Table ${normalizedTableName}`;
    const allTables = await db.getTableNames(event.id);
    if (!allTables.includes(normalizedTableName)) {
      await db.syncTables(event.id, [{ name: normalizedTableName }]);
    }

    const existingTeams = await db.getTeams(event.id);
    if (existingTeams.some(team => team.name.toLowerCase() === teamName.trim().toLowerCase())) {
      return fail('A team with this name already exists. Please choose a different name.');
    }

    const actingUser = await db.getUserByEmail(req.session.user.email);
    if (!actingUser) return fail('Sign in again before registering a team.');
    if (!schoolWizard) {
      const existingIndividual = await db.getIndividualTeam(event.id, actingUser.id);
      if (existingIndividual) return fail('You already have a team for this event.');
    }

    let invite = null;
    if (draft.inviteToken) {
      invite = await db.getRegistrationInvite(draft.inviteToken);
      if (!inviteIsOpen(invite) || invite.guardian_email !== actingUser.email.toLowerCase()) {
        return fail('This parent signup link is no longer valid.');
      }
    }

    const contactEmail = actingUser.email;
    const team = await db.createTeam({
      event_id: event.id,
      name: teamName.trim(),
      table_name: normalizedTableName,
      project_name: projectName.trim(),
      contact_email: contactEmail,
      github_link: githubLink ? githubLink.trim() : null,
      website_link: websiteLink ? websiteLink.trim() : null,
      division: division || null,
      category_id: parseInt(categoryId, 10),
      is_published: false,
      team_members: schoolWizard ? null : draft.members,
      team_leader_email: contactEmail,
      owner_user_id: actingUser.id,
      registration_type: schoolWizard ? 'school' : 'individual'
    });

    const policyData = {
      privacy_policy_accepted: true,
      terms_accepted: true,
      acceptable_use_accepted: true,
      policies_accepted_at: new Date().toISOString(),
      is_under_18: !schoolWizard && !!draft.isUnder18,
      guardian_email: !schoolWizard && draft.isUnder18 ? contactEmail : null,
      email_preferences: emailPreferences === '1' || emailPreferences === true,
      team_id: team.id,
      role: actingUser.role === 'admin' ? 'admin' : 'user'
    };
    await db.updateUser(contactEmail, policyData);
    await db.upsertMembership(actingUser.id, event.id, schoolWizard ? 'chaperone' : 'participant');

    if (invite) await db.markRegistrationInviteUsed(invite.token);

    let emailSent = false;
    try {
      const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      await emailService.sendTeamRegistrationConfirmation(
        contactEmail,
        team.name,
        normalizedTableName,
        event.event_name || 'Hackathon',
        appUrl
      );
      emailSent = true;
    } catch (emailError) {
      console.error('Error sending team registration confirmation email:', emailError);
    }

    let successMessage = `Team "${team.name}" successfully registered at ${normalizedTableName}!`;
    if (emailSent) {
      successMessage += ` A confirmation email has been sent to ${contactEmail}.`;
    }
    if (draft.inviteToken) {
      successMessage += ' You finished signup for the participant under 18.';
    }

    delete req.session.registrationDraft;
    req.session.registrationResult = { message: successMessage, isSchool: schoolWizard };
    return saveAndRedirect(req, res, '/register/complete');
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'INDIVIDUAL_TEAM_EXISTS') {
      return fail('You already have a team for this event.');
    }
    return fail('An error occurred during registration. Please try again.');
  }
});

module.exports = router;
