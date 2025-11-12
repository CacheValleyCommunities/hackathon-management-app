const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const emailService = require('../services/email');

// Initialize email service
emailService.init();

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';
const JWT_EXPIRES_IN = '7d'; // Token valid for 7 days

// GET login page
router.get('/login', async (req, res) => {
  try {
    // Check if user is already logged in via JWT
    const token = req.cookies?.token;
    if (token) {
      try {
        jwt.verify(token, JWT_SECRET);
        // Valid token, redirect to dashboard
        return res.redirect('/');
      } catch (err) {
        // Invalid token, clear it and show login
        res.clearCookie('token');
      }
    }
    
    const eventSettings = await db.getEventSettings();
    res.render('auth/login', { 
      title: `${eventSettings.event_name} Sign In`,
      eventName: eventSettings.event_name,
      error: null,
      success: null,
      layout: 'main'
    });
  } catch (error) {
    console.error('Login page error:', error);
    res.render('auth/login', { 
      title: 'Sign In',
      eventName: 'Hackathon',
      error: null,
      success: null,
      layout: 'main'
    });
  }
});

// POST request magic link
router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    const eventSettings = await db.getEventSettings();
    
    if (!email || !email.includes('@')) {
      return res.render('auth/login', {
        title: `${eventSettings.event_name} Sign In`,
        eventName: eventSettings.event_name,
        error: 'Please enter a valid email address',
        success: null
      });
    }

    // Create magic token
    const { token } = await db.createMagicToken(email.toLowerCase().trim());

    // Send magic link email
    try {
      await emailService.sendMagicLink(email.toLowerCase().trim(), token, eventSettings.event_name);
      res.render('auth/login', {
        title: `${eventSettings.event_name} Sign In`,
        eventName: eventSettings.event_name,
        error: null,
        success: 'Check your email for a login link!'
      });
    } catch (emailError) {
      console.error('Email error:', emailError);
      res.render('auth/login', {
        title: `${eventSettings.event_name} Sign In`,
        eventName: eventSettings.event_name,
        error: 'Failed to send email. Please check your email configuration.',
        success: null
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    const eventSettings = await db.getEventSettings();
    res.render('auth/login', {
      title: `${eventSettings.event_name} Sign In`,
      eventName: eventSettings.event_name,
      error: 'An error occurred. Please try again.',
      success: null
    });
  }
});

// GET verify magic link
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.redirect('/auth/login?error=invalid_token');
    }

    // Validate token
    const tokenData = await db.validateMagicToken(token);

    if (!tokenData) {
      const eventSettings = await db.getEventSettings();
      return res.render('auth/login', {
        title: `${eventSettings.event_name} Sign In`,
        eventName: eventSettings.event_name,
        error: 'Invalid or expired login link. Please request a new one.',
        success: null
      });
    }

    // Mark token as used
    await db.markTokenAsUsed(token);

    // Normalize email to lowercase for consistency
    const normalizedEmail = tokenData.email.toLowerCase().trim();

    // Get or create user (creates as judge by default if new)
    const user = await db.getOrCreateUser(normalizedEmail);
    const userWithTeam = await db.getUserWithTeam(user.email);
    const roleInfo = await db.getUserRole(user.email);

    // Check if user has accepted all required policies
    // Note: SQLite stores booleans as 0/1, so we check for truthy values (1 or true)
    // Also handle null/undefined for existing users who haven't accepted policies yet
    const hasAcceptedPolicies = (user.privacy_policy_accepted === 1 || user.privacy_policy_accepted === true) &&
                                 (user.terms_accepted === 1 || user.terms_accepted === true) &&
                                 (user.acceptable_use_accepted === 1 || user.acceptable_use_accepted === true);

    // If policies not accepted, redirect to policy acceptance page
    if (!hasAcceptedPolicies) {
      req.session.pendingAuth = {
        email: normalizedEmail,
        tokenData: tokenData
      };
      const eventSettings = await db.getEventSettings();
      return res.render('auth/accept-policies', {
        title: 'Accept Policies',
        eventSettings,
        layout: 'main'
      });
    }

    // Create JWT token
    const jwtPayload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: roleInfo.role || 'judge',
      team_id: roleInfo.team_id || null,
      team_name: userWithTeam?.team_name || null
    };

    const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    // Set JWT as HTTP-only cookie
    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax'
    });

    // Also set session for backward compatibility
    req.session.user = jwtPayload;
    req.session.currentRound = req.session.currentRound || 1;

    // Redirect based on role
    const role = jwtPayload.role;
    if (role === 'participant') {
      return res.redirect('/participant');
    }
    
    res.redirect('/');
  } catch (error) {
    console.error('Verify error:', error);
    const eventSettings = await db.getEventSettings();
    res.render('auth/login', {
      title: `${eventSettings.event_name} Sign In`,
      eventName: eventSettings.event_name,
      error: 'An error occurred during verification. Please try again.',
      success: null
    });
  }
});

// GET /me endpoint - Returns current user info
router.get('/me', (req, res) => {
  try {
    const token = req.cookies?.token;
    
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({
      user: {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        role: decoded.role,
        team_id: decoded.team_id,
        team_name: decoded.team_name
      }
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// GET policy acceptance page
router.get('/accept-policies', async (req, res) => {
  // Only allow if there's a pending auth in session
  if (!req.session.pendingAuth) {
    return res.redirect('/auth/login');
  }
  
  const eventSettings = await db.getEventSettings();
  res.render('auth/accept-policies', {
    title: 'Accept Policies',
    eventSettings,
    layout: 'main'
  });
});

// POST accept policies
router.post('/accept-policies', async (req, res) => {
  try {
    if (!req.session.pendingAuth) {
      return res.redirect('/auth/login');
    }

    const { 
      isUnder18, guardianEmail, privacyPolicyAccepted, termsAccepted, 
      acceptableUseAccepted, emailPreferences 
    } = req.body;

    // Validate policy acceptance
    if (!privacyPolicyAccepted || !termsAccepted || !acceptableUseAccepted) {
      const eventSettings = await db.getEventSettings();
      return res.render('auth/accept-policies', {
        title: 'Accept Policies',
        eventSettings,
        error: 'You must accept all required policies to continue.',
        layout: 'main'
      });
    }

    // Validate guardian email for users under 18
    const isUnder18Bool = isUnder18 === '1' || isUnder18 === true;
    if (isUnder18Bool && (!guardianEmail || !guardianEmail.trim() || !guardianEmail.includes('@'))) {
      const eventSettings = await db.getEventSettings();
      return res.render('auth/accept-policies', {
        title: 'Accept Policies',
        eventSettings,
        error: 'Guardian email is required for participants under 18 years of age.',
        layout: 'main'
      });
    }

    // Normalize email to lowercase for consistency
    const email = req.session.pendingAuth.email.toLowerCase().trim();
    const policyData = {
      privacy_policy_accepted: true,
      terms_accepted: true,
      acceptable_use_accepted: true,
      policies_accepted_at: new Date().toISOString(),
      is_under_18: isUnder18Bool,
      guardian_email: isUnder18Bool && guardianEmail ? guardianEmail.trim() : null,
      email_preferences: emailPreferences === '1' || emailPreferences === true
    };

    // Ensure user exists (get or create)
    let user = await db.getUserByEmail(email);
    if (!user) {
      // User doesn't exist, create them
      user = await db.getOrCreateUser(email);
    }

    // Update user with policy acceptance
    await db.updateUser(email, policyData);

    // Get updated user info (refresh from database)
    user = await db.getUserByEmail(email);
    if (!user) {
      throw new Error('Failed to retrieve user after policy acceptance');
    }

    const userWithTeam = await db.getUserWithTeam(user.email);
    const roleInfo = await db.getUserRole(user.email);

    // Create JWT token
    const jwtPayload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: roleInfo.role || 'judge',
      team_id: roleInfo.team_id || null,
      team_name: userWithTeam?.team_name || null
    };

    const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    // Set JWT as HTTP-only cookie
    res.cookie('token', jwtToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax'
    });

    // Also set session for backward compatibility
    req.session.user = jwtPayload;
    req.session.currentRound = req.session.currentRound || 1;
    delete req.session.pendingAuth;

    // Redirect based on role
    const role = jwtPayload.role;
    if (role === 'participant') {
      return res.redirect('/participant');
    }
    
    res.redirect('/');
  } catch (error) {
    console.error('Accept policies error:', error);
    
    // Try to recover by logging the user in if we have their email
    const email = req.session.pendingAuth?.email;
    if (email) {
      try {
        const user = await db.getUserByEmail(email.toLowerCase().trim());
        if (user) {
          const userWithTeam = await db.getUserWithTeam(user.email);
          const roleInfo = await db.getUserRole(user.email);
          
          const jwtPayload = {
            id: user.id,
            email: user.email,
            name: user.name,
            role: roleInfo.role || 'judge',
            team_id: roleInfo.team_id || null,
            team_name: userWithTeam?.team_name || null
          };

          const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

          res.cookie('token', jwtToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
          });

          req.session.user = jwtPayload;
          req.session.currentRound = req.session.currentRound || 1;
          delete req.session.pendingAuth;

          const role = jwtPayload.role;
          if (role === 'participant') {
            return res.redirect('/participant');
          }
          return res.redirect('/');
        }
      } catch (recoveryError) {
        console.error('Error during recovery login:', recoveryError);
      }
    }
    
    const eventSettings = await db.getEventSettings();
    res.render('auth/accept-policies', {
      title: 'Accept Policies',
      eventSettings,
      error: 'An error occurred. Please try again.',
      layout: 'main'
    });
  }
});

// GET logout
router.get('/logout', (req, res) => {
  // Clear JWT cookie
  res.clearCookie('token');
  
  // Destroy session
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/auth/login');
  });
});

module.exports = router;
