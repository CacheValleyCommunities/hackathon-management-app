const { requireRole, requireAdmin, requireJudge, requireParticipant, requireTeamOwner } = require('../middleware/rbac');

describe('RBAC Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      session: {},
      params: {}
    };
    res = {
      redirect: jest.fn(),
      status: jest.fn().mockReturnThis(),
      render: jest.fn()
    };
    next = jest.fn();
  });

  describe('requireRole', () => {
    test('should redirect to login if user is not authenticated', async () => {
      req.session.user = null;
      
      const middleware = requireRole('judge');
      await middleware(req, res, next);
      
      expect(res.redirect).toHaveBeenCalledWith('/auth/login');
      expect(next).not.toHaveBeenCalled();
    });

    test('should allow access if user has required role', async () => {
      req.session.user = { role: 'judge' };
      
      const middleware = requireRole('judge');
      await middleware(req, res, next);
      
      expect(res.redirect).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    test('should allow access if user has one of multiple allowed roles', async () => {
      req.session.user = { role: 'admin' };
      
      const middleware = requireRole('judge', 'admin');
      await middleware(req, res, next);
      
      expect(res.redirect).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    test('should deny access if user does not have required role', async () => {
      req.session.user = { role: 'participant' };
      
      const middleware = requireRole('judge');
      await middleware(req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.render).toHaveBeenCalledWith('error', expect.objectContaining({
        message: expect.stringContaining('judge')
      }));
      expect(next).not.toHaveBeenCalled();
    });

    test('should allow admin to access any role', async () => {
      req.session.user = { role: 'admin' };
      
      const middleware = requireRole('judge', 'participant');
      await middleware(req, res, next);
      
      expect(res.redirect).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    test('should default to judge role if role is not set', async () => {
      req.session.user = {}; // No role set
      
      const middleware = requireRole('judge');
      await middleware(req, res, next);
      
      expect(res.redirect).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireAdmin', () => {
    test('should allow admin access', async () => {
      req.session.user = { role: 'admin' };
      
      await requireAdmin(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should deny non-admin access', async () => {
      req.session.user = { role: 'judge' };
      
      await requireAdmin(req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireJudge', () => {
    test('should allow judge access', async () => {
      req.session.user = { role: 'judge' };
      
      await requireJudge(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should allow admin access', async () => {
      req.session.user = { role: 'admin' };
      
      await requireJudge(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should deny participant access', async () => {
      req.session.user = { role: 'participant' };
      
      await requireJudge(req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireParticipant', () => {
    test('should allow participant access', async () => {
      req.session.user = { role: 'participant' };
      
      await requireParticipant(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should allow admin access', async () => {
      req.session.user = { role: 'admin' };
      
      await requireParticipant(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should deny judge access', async () => {
      req.session.user = { role: 'judge' };
      
      await requireParticipant(req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireTeamOwner', () => {
    test('should redirect to login if user is not authenticated', async () => {
      req.session.user = null;
      
      await requireTeamOwner(req, res, next);
      
      expect(res.redirect).toHaveBeenCalledWith('/auth/login');
      expect(next).not.toHaveBeenCalled();
    });

    test('should allow admin to access any team', async () => {
      req.session.user = { role: 'admin' };
      req.params.id = 123;
      
      await requireTeamOwner(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should allow participant to access their own team', async () => {
      req.session.user = { role: 'participant', team_id: 123 };
      req.params.id = 123;
      
      await requireTeamOwner(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should deny participant access to other teams', async () => {
      req.session.user = { role: 'participant', team_id: 123 };
      req.params.id = 456;
      
      await requireTeamOwner(req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.render).toHaveBeenCalledWith('error', expect.objectContaining({
        message: expect.stringContaining('own team')
      }));
      expect(next).not.toHaveBeenCalled();
    });

    test('should work with teamId parameter', async () => {
      req.session.user = { role: 'participant', team_id: 123 };
      req.params.teamId = 123;
      
      await requireTeamOwner(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });

    test('should allow judge access to team resources (judges are not restricted)', async () => {
      req.session.user = { role: 'judge' };
      req.params.id = 123;
      
      await requireTeamOwner(req, res, next);
      
      // Judges are allowed through (only participants are restricted to their own teams)
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

