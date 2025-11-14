const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireJudge } = require('../middleware/rbac');
const { checkAndReturnError } = require('../middleware/validation');

// Middleware to require authentication
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  next();
};

// GET judge queue page - shows stats and next table button
router.get('/judge-queue', requireJudge, async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const round = eventSettings.current_round || req.session.currentRound || 1;
    const judgeEmail = req.session.user.email;

    // Get queue statistics
    const queueStats = await db.getJudgeQueueStats(round);
    
    // Get teams this judge has judged
    const judgedTeams = await db.getJudgedTeamsByJudge(judgeEmail);
    
    // Get required judges per team from env (default to 2)
    const requiredJudgesPerTeam = parseInt(process.env.JUDGES_PER_TEAM || '2', 10);
    
    // Calculate summary stats
    const totalTeams = queueStats.length;
    const teamsNeedingJudges = queueStats.filter(t => t.judge_count < requiredJudgesPerTeam).length;
    const myTeamCount = judgedTeams.length;
    
    // Get judging locked status
    const judgingLocked = eventSettings.judging_locked || false;

    res.render('scores/judge-queue', {
      title: 'Judge Queue',
      round,
      queueStats,
      judgedTeams,
      totalTeams,
      teamsNeedingJudges,
      myTeamCount,
      eventSettings,
      judgingLocked,
      query: req.query
    });
  } catch (error) {
    console.error('Error loading judge queue:', error);
    res.render('error', {
      message: 'Failed to load judge queue',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET next team - assigns and redirects to scoring
router.get('/next-team', requireJudge, async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    
    // Check if judging is locked
    if (eventSettings.judging_locked) {
      return res.redirect('/scores/judge-queue?error=judging_locked');
    }
    
    const round = eventSettings.current_round || req.session.currentRound || 1;
    const judgeEmail = req.session.user.email;

    // Get next available team for this judge
    const nextTeam = await db.getNextTeamForJudge(judgeEmail, round);

    if (!nextTeam) {
      // Get required judges per team from env (default to 2)
      const requiredJudgesPerTeam = parseInt(process.env.JUDGES_PER_TEAM || '2', 10);
      
      // Check if all teams have required judges or if judge has judged all available teams
      const queueStats = await db.getJudgeQueueStats(round);
      const allTeamsComplete = queueStats.every(t => t.judge_count >= requiredJudgesPerTeam);
      
      if (allTeamsComplete) {
        return res.redirect('/scores/judge-queue?message=all_complete');
      } else {
        return res.redirect('/scores/judge-queue?message=no_more_for_you');
      }
    }

    // Double-check: Verify this judge hasn't already judged this team
    const judgedTeams = await db.getJudgedTeamsByJudge(judgeEmail);
    const hasJudgedThisTeam = judgedTeams.some(t => t.team_name === nextTeam.name);
    
    if (hasJudgedThisTeam) {
      console.error(`Error: Judge ${judgeEmail} was assigned to team ${nextTeam.name} they already judged!`);
      // Get a different team
      return res.redirect('/scores/judge-queue?error=duplicate_assignment');
    }

    // Assign judge to this team (INSERT OR IGNORE prevents duplicates)
    await db.assignJudgeToTeam(judgeEmail, nextTeam.name, round);

    // Redirect to score this team
    res.redirect(`/scores/enter/${encodeURIComponent(nextTeam.name)}?round=${round}&auto=1`);
  } catch (error) {
    console.error('Error getting next team:', error);
    res.redirect('/scores/judge-queue?error=assignment_failed');
  }
});

// GET select team page (judges and admins only)
router.get('/select-team', requireJudge, async (req, res) => {
  try {
    const round = parseInt(req.query.round) || req.session.currentRound || 1;
    const selectedDivision = req.query.division || null;
    req.session.currentRound = round;

    // Get all teams from database
    const allTeams = await db.getTeams();
    
    // Filter out sensitive data (contact_email) for non-admin users
    const filteredTeams = allTeams.map(team => {
      const teamData = { ...team };
      // Only admins can see contact_email
      if (req.session.user.role !== 'admin') {
        delete teamData.contact_email;
      }
      return teamData;
    });
    
    // Get event settings for divisions
    const eventSettings = await db.getEventSettings();
    const divisions = eventSettings.divisions || [];

    // Filter teams by division if specified
    const teams = selectedDivision 
      ? filteredTeams.filter(team => team.division === selectedDivision)
      : filteredTeams;

    // Get existing scores for this judge in this round
    const existingScores = await db.getJudgeScores(req.session.user.email, round);
    const scoredTeams = new Set(existingScores.map(s => s.team_name));

    // Group teams by division
    const teamsByDivision = {};
    teams.forEach(team => {
      const division = team.division || 'Unassigned';
      if (!teamsByDivision[division]) {
        teamsByDivision[division] = [];
      }
      teamsByDivision[division].push(team);
    });

    // Check if current round is locked
    const isRoundLocked = await db.isRoundLocked(round);

    res.render('scores/select-team', {
      title: 'Select Team',
      teams,
      teamsByDivision,
      divisions,
      round,
      selectedDivision,
      scoredTeams: Array.from(scoredTeams),
      existingScores,
      isRoundLocked,
      query: req.query
    });
  } catch (error) {
    console.error('Error loading teams:', error);
    res.render('error', {
      message: 'Failed to load teams.',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET score entry page (judges and admins only)
router.get('/enter/:teamName', requireJudge, async (req, res) => {
  try {
    // Check if judging is locked
    const eventSettings = await db.getEventSettings();
    if (eventSettings.judging_locked) {
      return res.render('error', {
        message: 'Judging has been locked. No new scores can be entered.',
        error: {}
      });
    }

    const teamName = decodeURIComponent(req.params.teamName);
    const round = parseInt(req.query.round) || req.session.currentRound || 1;

    // Check if round is locked
    const isLocked = await db.isRoundLocked(round);
    if (isLocked) {
      return res.render('error', {
        message: `Round ${round} has been locked. Scores can no longer be entered or edited for this round.`
      });
    }

    // Get team table
    const tableName = await db.getTeamTable(teamName);
    if (!tableName) {
      return res.render('error', {
        message: 'Team not found.'
      });
    }

    // Check if score already exists
    const existingScore = await db.getScore(req.session.user.email, teamName, round);

    res.render('scores/enter', {
      title: `Score Entry - ${teamName}`,
      teamName,
      tableName,
      round,
      existingScore,
      isEdit: !!existingScore,
      query: req.query
    });
  } catch (error) {
    console.error('Error loading score entry:', error);
    res.render('error', {
      message: 'An error occurred',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// POST submit score (judges and admins only)
router.post('/submit', requireJudge, async (req, res) => {
  try {
    // Check if judging is locked
    const eventSettings = await db.getEventSettings();
    if (eventSettings.judging_locked) {
      return res.render('error', {
        message: 'Judging has been locked. No new scores can be entered.',
        error: {}
      });
    }

    const { teamName, tableName, round, score, notes } = req.body;
    const judgeEmail = req.session.user.email;
    const roundNum = parseInt(round) || 1;
    const scoreNum = parseFloat(score);

    if (!teamName || !tableName || isNaN(scoreNum)) {
      return res.render('error', {
        message: 'Invalid score data. Please try again.'
      });
    }

    // Check if round is locked
    const isLocked = await db.isRoundLocked(roundNum);
    if (isLocked) {
      return res.render('error', {
        message: `Round ${roundNum} has been locked. Scores can no longer be entered or edited for this round.`
      });
    }

    // Check for profanity in notes
    if (notes) {
      const notesError = await checkAndReturnError(notes, 'Notes');
      if (notesError) {
        // Redirect back to score entry page with error
        return res.redirect(`/scores/enter/${encodeURIComponent(teamName)}?round=${roundNum}&error=${encodeURIComponent(notesError)}`);
      }
    }

    // Save to local database
    await db.saveScore(judgeEmail, teamName, tableName, roundNum, scoreNum, notes || '');

    // Mark team assignment as completed
    await db.markAssignmentCompleted(judgeEmail, teamName, roundNum);

    // Check if this was from the auto-queue system
    // Handle both string '1' and number 1, and check both body and query
    const autoValue = req.body.auto || req.query.auto;
    const wasAutoAssigned = autoValue === '1' || autoValue === 1 || autoValue === true || autoValue === 'true';
    
    // Debug logging (remove in production if needed)
    if (process.env.NODE_ENV === 'development') {
      console.log('Score submission - auto check:', {
        bodyAuto: req.body.auto,
        queryAuto: req.query.auto,
        autoValue,
        wasAutoAssigned
      });
    }
    
    if (wasAutoAssigned) {
      // Redirect to next team automatically
      res.redirect(`/scores/next-team`);
    } else {
      // Redirect back to select-team page with success message
      res.redirect(`/scores/select-team?round=${roundNum}&success=1`);
    }
  } catch (error) {
    console.error('Error submitting score:', error);
    res.render('error', {
      message: 'Failed to save score. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET my scores page (judges and admins only)
router.get('/my-scores', requireJudge, async (req, res) => {
  try {
    const scores = await db.getJudgeScores(req.session.user.email);

    // Get event settings for locked rounds
    const eventSettings = await db.getEventSettings();
    const lockedRounds = JSON.parse(eventSettings.locked_rounds || '[]');

    // Group scores by round only
    const scoresByRound = {};
    scores.forEach(score => {
      if (!scoresByRound[score.round]) {
        scoresByRound[score.round] = [];
      }
      scoresByRound[score.round].push(score);
    });

    res.render('scores/my-scores', {
      title: 'My Scores',
      scores,
      scoresByRound,
      lockedRounds
    });
  } catch (error) {
    console.error('Error loading scores:', error);
    res.render('error', {
      message: 'Failed to load scores',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET results/leaderboard page (all authenticated users)
router.get('/results', requireAuth, async (req, res) => {
  try {
    const round = parseInt(req.query.round) || req.session.currentRound || 1;
    const selectedDivision = req.query.division || null;
    
    const allResults = await db.getTableResults(round, null);
    
    // Filter results by division if specified
    let results = allResults;
    if (selectedDivision) {
      results = { [selectedDivision]: allResults[selectedDivision] || [] };
    }
    
    // Get event settings for divisions
    const eventSettings = await db.getEventSettings();
    const divisions = eventSettings.divisions || [];
    
    // Get top team per category for sidebar
    const categoryLeaders = await db.getTopTeamPerCategory(round) || [];

    res.render('scores/results', {
      title: 'Live Leaderboard',
      results,
      divisions,
      round,
      selectedDivision,
      categoryLeaders,
      layout: 'minimal'
    });
  } catch (error) {
    console.error('Error loading results:', error);
    res.render('error', {
      message: 'Failed to load results',
      error: process.env.NODE_ENV === 'development' ? error : {}
    });
  }
});

// GET results JSON for AJAX updates (all authenticated users)
router.get('/results/json', requireAuth, async (req, res) => {
  try {
    const round = parseInt(req.query.round) || req.session.currentRound || 1;
    const selectedDivision = req.query.division || null;
    
    const allResults = await db.getTableResults(round, null);
    
    // Filter results by division if specified
    let results = allResults;
    if (selectedDivision) {
      results = { [selectedDivision]: allResults[selectedDivision] || [] };
    }
    
    // Get top team per category for sidebar
    const categoryLeaders = await db.getTopTeamPerCategory(round) || [];

    // Render just the results partial
    res.render('partials/results-content', {
      results,
      categoryLeaders,
      round,
      layout: false
    });
  } catch (error) {
    console.error('Error loading results JSON:', error);
    res.status(500).send('Error loading results');
  }
});

module.exports = router;

