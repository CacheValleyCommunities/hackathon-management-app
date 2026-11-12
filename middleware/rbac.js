const db = require('../db/database');

const actingRole = (req) => {
  const sessionUser = req.session.user || {};
  if (sessionUser.role === 'admin') return 'admin';
  if (req.eventRole) return req.eventRole;
  if (sessionUser.role && sessionUser.role !== 'user') return sessionUser.role;
  return null;
};

// Middleware to require specific role(s)
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/auth/login');
    }

    const userRole = actingRole(req);

    if (userRole === 'admin') {
      return next();
    }

    if (!userRole || !allowedRoles.includes(userRole)) {
      return res.status(403).render('error', {
        message: `Access denied. Required role: ${allowedRoles.join(' or ')}`
      });
    }

    next();
  };
};

// Middleware to require admin
const requireAdmin = requireRole('admin');

// Middleware to require judge (or admin)
const requireJudge = requireRole('judge', 'admin');

// Middleware to require participant (or admin)
const requireParticipant = requireRole('participant', 'chaperone', 'admin');

const requireSelectedEvent = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  if (!req.eventId) {
    return res.redirect('/events');
  }
  next();
};

// Middleware to check if user owns the team
const requireTeamOwner = async (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  
  const userRole = actingRole(req);
  const userEmail = req.session.user.email;
  const userTeamId = req.session.user.team_id;

  if (userRole === 'admin') {
    return next();
  }

  const teamId = parseInt(req.params.id || req.params.teamId, 10);
  if ((userRole === 'participant' || userRole === 'chaperone') && userTeamId && userTeamId === teamId) {
    return next();
  }

  if (userRole === 'participant' && userTeamId && userTeamId !== teamId) {
    return res.status(403).render('error', {
      message: 'Access denied. You can only access your own team information.'
    });
  }

  if (userRole === 'participant' || userRole === 'chaperone') {
    try {
      const team = await db.getTeamById(teamId);
      if (!team || (req.eventId && team.event_id !== req.eventId)) {
        return res.status(403).render('error', {
          message: 'Access denied. You can only access your own team information.'
        });
      }
      const ownsTeam = await db.isTeamLeader(teamId, userEmail);
      if (!ownsTeam) {
        return res.status(403).render('error', {
          message: 'Access denied. You can only access your own team information.'
        });
      }
      return next();
    } catch (error) {
      console.error('Error checking team ownership:', error);
      return res.status(500).render('error', { message: 'Error verifying team ownership.' });
    }
  }
  
  next();
};

// Middleware to check if user is team leader or admin
const requireTeamLeader = async (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  
  const userRole = actingRole(req);
  const userEmail = req.session.user.email;
  
  // Admins can access everything
  if (userRole === 'admin') {
    return next();
  }
  
  // Get team ID from params or body
  let teamId = null;
  if (req.params.id) {
    teamId = parseInt(req.params.id);
  } else if (req.params.teamId) {
    teamId = parseInt(req.params.teamId);
  } else if (req.body.teamId) {
    teamId = parseInt(req.body.teamId);
  }
  
  // If no team ID, try to get from user's team_id
  if (!teamId && req.session.user.team_id) {
    teamId = req.session.user.team_id;
  }
  
  if (!teamId) {
    return res.status(403).render('error', {
      message: 'Access denied. Team not found.'
    });
  }
  
  // Get team to check ownership
  try {
    const team = await db.getTeamById(teamId);
    if (!team) {
      return res.status(404).render('error', {
        message: 'Team not found.'
      });
    }
    
    if (req.eventId && team.event_id && team.event_id !== req.eventId) {
      return res.status(403).render('error', {
        message: 'Access denied. That team belongs to a different event.'
      });
    }

    // Check if user is the team leader or owning chaperone
    const userIsTeamLeader = await db.isTeamLeader(teamId, userEmail);
    
    if (!userIsTeamLeader && userRole !== 'admin') {
      return res.status(403).render('error', {
        message: 'Access denied. Only the team leader or an admin can edit team information.'
      });
    }
    
    next();
  } catch (error) {
    console.error('Error checking team ownership:', error);
    return res.status(500).render('error', {
      message: 'Error verifying team ownership.'
    });
  }
};

module.exports = {
  requireRole,
  requireAdmin,
  requireJudge,
  requireParticipant,
  requireSelectedEvent,
  requireTeamOwner,
  requireTeamLeader
};

