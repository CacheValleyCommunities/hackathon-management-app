const db = require('../db/database');

// Middleware to require specific role(s)
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/auth/login');
    }
    
    const userRole = req.session.user.role || 'judge';
    
    // Admins can access everything
    if (userRole === 'admin') {
      return next();
    }
    
    // Check if user's role is in allowed roles
    if (!allowedRoles.includes(userRole)) {
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
const requireParticipant = requireRole('participant', 'admin');

// Middleware to check if user owns the team
const requireTeamOwner = async (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  
  const userRole = req.session.user.role;
  const userEmail = req.session.user.email;
  const userTeamId = req.session.user.team_id;
  
  // Admins can access everything
  if (userRole === 'admin') {
    return next();
  }
  
  // Participants can only access their own team
  if (userRole === 'participant') {
    const teamId = parseInt(req.params.id || req.params.teamId);
    if (userTeamId !== teamId) {
      return res.status(403).render('error', {
        message: 'Access denied. You can only access your own team information.'
      });
    }
  }
  
  next();
};

// Middleware to check if user is team leader or admin
const requireTeamLeader = async (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  
  const userRole = req.session.user.role;
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
    
    // Check if user is the team leader (using helper function that doesn't expose team_leader_email)
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
  requireTeamOwner,
  requireTeamLeader
};

