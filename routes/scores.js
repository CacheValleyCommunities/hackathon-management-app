const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireJudge, requireSelectedEvent } = require('../middleware/rbac');
const { checkAndReturnError } = require('../middleware/validation');

const scoreEligibilityMessage = (reason) => {
  if (reason === 'team_full') {
    return 'This team already has the required number of judges for this round.';
  }
  return 'This team is not assigned to you. Use the judge queue to get a team.';
};

// Middleware to require authentication
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  if (!req.eventId) {
    return res.redirect('/events');
  }
  next();
};

router.use(requireSelectedEvent);

// GET judge queue page - shows stats and next table button
router.get('/judge-queue', requireJudge, async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings(req.eventId);
    const round = eventSettings.current_round || req.session.currentRound || 1;
    const judgeEmail = req.session.user.email;

    // Get queue statistics
    const queueStats = await db.getJudgeQueueStats(req.eventId, round);
    
    // Get teams this judge has judged
    const judgedTeams = await db.getJudgedTeamsByJudge(req.eventId, judgeEmail);
    const judgedTeamNames = new Set(judgedTeams.map(t => t.team_name));
    
    // Get current incomplete assignments (locked but not completed)
    const currentAssignments = await db.getCurrentAssignmentsForJudge(req.eventId, judgeEmail, round);
    const currentAssignmentTeamNames = new Set(currentAssignments.map(a => a.team_name));
    
    const requiredJudgesPerTeam = db.getRequiredJudgesPerTeam();
    
    // Get judging locked status
    const judgingLocked = eventSettings.judging_locked || false;
    
    // Determine which teams can be self-assigned by this judge
    const queueStatsWithSelfAssign = await Promise.all(queueStats.map(async (team) => {
      // Check if team is locked by another judge
      const isLocked = await db.isTeamLocked(req.eventId, team.team_name, round);
      
      // Determine if this judge can self-assign this team
      const canSelfAssign = !judgingLocked &&
        !judgedTeamNames.has(team.team_name) &&  // Never judged
        !currentAssignmentTeamNames.has(team.team_name) &&  // Not currently assigned
        team.judge_count < requiredJudgesPerTeam &&  // Needs more judges
        !isLocked;  // Not locked by another judge
      
      return {
        ...team,
        canSelfAssign
      };
    }));
    
    // Calculate summary stats
    const totalTeams = queueStats.length;
    const teamsNeedingJudges = queueStats.filter(t => t.judge_count < requiredJudgesPerTeam).length;
    const myTeamCount = judgedTeams.length;

    res.render('scores/judge-queue', {
      title: 'Judge Queue',
      round,
      queueStats: queueStatsWithSelfAssign,
      judgedTeams,
      currentAssignments,
      totalTeams,
      teamsNeedingJudges,
      myTeamCount,
      requiredJudgesPerTeam,
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
    const eventSettings = await db.getEventSettings(req.eventId);
    
    // Check if judging is locked
    if (eventSettings.judging_locked) {
      return res.redirect('/scores/judge-queue?error=judging_locked');
    }
    
    const round = eventSettings.current_round || req.session.currentRound || 1;
    const judgeEmail = req.session.user.email;

    // Check if judge already has an incomplete assignment
    const currentAssignments = await db.getCurrentAssignmentsForJudge(req.eventId, judgeEmail, round);
    if (currentAssignments && currentAssignments.length > 0) {
      // Redirect to the first incomplete assignment
      const firstAssignment = currentAssignments[0];
      return res.redirect(`/scores/enter/${encodeURIComponent(firstAssignment.team_name)}?round=${round}&auto=1`);
    }

    // Try to get and lock a team (with retries for race conditions)
    let nextTeam = null;
    let lockResult = null;
    const maxRetries = 5;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Get next available team for this judge
      nextTeam = await db.getNextTeamForJudge(req.eventId, judgeEmail, round);

      if (!nextTeam) {
        const requiredJudgesPerTeam = db.getRequiredJudgesPerTeam();
        
        // Check if all teams have required judges or if judge has judged all available teams
        const queueStats = await db.getJudgeQueueStats(req.eventId, round);
        const allTeamsComplete = queueStats.every(t => t.judge_count >= requiredJudgesPerTeam);
        
        if (allTeamsComplete) {
          return res.redirect('/scores/judge-queue?message=all_complete');
        } else {
          return res.redirect('/scores/judge-queue?message=no_more_for_you');
        }
      }

      // Double-check: Verify this judge hasn't already judged this team
      const judgedTeams = await db.getJudgedTeamsByJudge(req.eventId, judgeEmail);
      const hasJudgedThisTeam = judgedTeams.some(t => t.team_name === nextTeam.name);
      
      if (hasJudgedThisTeam) {
        console.error(`Error: Judge ${judgeEmail} was assigned to team ${nextTeam.name} they already judged!`);
        // Try again with a different team
        continue;
      }

      // Try to atomically lock the team
      lockResult = await db.lockTeamForJudge(req.eventId, judgeEmail, nextTeam.name, round);
      
      if (lockResult.success) {
        // Successfully locked the team
        break;
      } else if (lockResult.reason === 'already_locked') {
        // Team was locked by another judge, try again
        if (attempt < maxRetries - 1) {
          continue;
        } else {
          return res.redirect('/scores/judge-queue?error=assignment_failed');
        }
      } else {
        // Other error, try again
        if (attempt < maxRetries - 1) {
          continue;
        } else {
          return res.redirect('/scores/judge-queue?error=assignment_failed');
        }
      }
    }

    if (!lockResult || !lockResult.success) {
      return res.redirect('/scores/judge-queue?error=assignment_failed');
    }

    // Redirect to score this team
    res.redirect(`/scores/enter/${encodeURIComponent(nextTeam.name)}?round=${round}&auto=1`);
  } catch (error) {
    console.error('Error getting next team:', error);
    res.redirect('/scores/judge-queue?error=assignment_failed');
  }
});

// GET assign specific team - allows judge to self-assign a specific team
router.get('/assign-team/:teamName', requireJudge, async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings(req.eventId);
    
    // Check if judging is locked
    if (eventSettings.judging_locked) {
      return res.redirect('/scores/judge-queue?error=judging_locked');
    }
    
    const round = eventSettings.current_round || req.session.currentRound || 1;
    const judgeEmail = req.session.user.email;
    const teamName = decodeURIComponent(req.params.teamName);
    
    const requiredJudgesPerTeam = db.getRequiredJudgesPerTeam();
    
    // Check if judge already has an incomplete assignment
    const currentAssignments = await db.getCurrentAssignmentsForJudge(req.eventId, judgeEmail, round);
    if (currentAssignments && currentAssignments.length > 0) {
      // Check if this is the same team they're already assigned to
      const isAlreadyAssigned = currentAssignments.some(a => a.team_name === teamName);
      if (isAlreadyAssigned) {
        // Redirect to score entry for this team
        return res.redirect(`/scores/enter/${encodeURIComponent(teamName)}?round=${round}&auto=1`);
      } else {
        // Judge has other incomplete assignments, redirect to queue with message
        return res.redirect('/scores/judge-queue?error=incomplete_assignment');
      }
    }
    
    // Verify this judge hasn't already judged this team (ever)
    const judgedTeams = await db.getJudgedTeamsByJudge(req.eventId, judgeEmail);
    const hasJudgedThisTeam = judgedTeams.some(t => t.team_name === teamName);
    
    if (hasJudgedThisTeam) {
      return res.redirect('/scores/judge-queue?error=already_judged');
    }
    
    // Check if team exists and get its info
    const queueStats = await db.getJudgeQueueStats(req.eventId, round);
    const teamInfo = queueStats.find(t => t.team_name === teamName);
    
    if (!teamInfo) {
      return res.redirect('/scores/judge-queue?error=team_not_found');
    }
    
    // Check if team already has enough judges
    if (teamInfo.judge_count >= requiredJudgesPerTeam) {
      return res.redirect('/scores/judge-queue?error=team_complete');
    }
    
    // Check if team is locked by another judge
    const isLocked = await db.isTeamLocked(req.eventId, teamName, round);
    if (isLocked) {
      return res.redirect('/scores/judge-queue?error=team_locked');
    }
    
    // Try to atomically lock the team
    const lockResult = await db.lockTeamForJudge(req.eventId, judgeEmail, teamName, round);
    
    if (!lockResult.success) {
      if (lockResult.reason === 'already_locked') {
        return res.redirect('/scores/judge-queue?error=team_locked');
      }
      if (lockResult.reason === 'team_full') {
        return res.redirect('/scores/judge-queue?error=team_complete');
      }
      return res.redirect('/scores/judge-queue?error=assignment_failed');
    }
    
    // Successfully locked the team, redirect to score entry
    res.redirect(`/scores/enter/${encodeURIComponent(teamName)}?round=${round}&auto=1`);
  } catch (error) {
    console.error('Error assigning team:', error);
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
    const allTeams = await db.getTeams(req.eventId);
    
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
    const eventSettings = await db.getEventSettings(req.eventId);
    const divisions = eventSettings.divisions || [];

    // Filter teams by division if specified
    const teams = selectedDivision 
      ? filteredTeams.filter(team => team.division === selectedDivision)
      : filteredTeams;

    // Get existing scores for this judge in this round
    const existingScores = await db.getJudgeScores(req.eventId, req.session.user.email, round);
    const scoredTeams = new Set(existingScores.map(s => s.team_name));
    const currentAssignments = await db.getCurrentAssignmentsForJudge(req.eventId, req.session.user.email, round);
    const assignedTeams = currentAssignments.map(assignment => assignment.team_name);

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
    const isRoundLocked = await db.isRoundLocked(req.eventId, round);

    res.render('scores/select-team', {
      title: 'Select Team',
      teams,
      teamsByDivision,
      divisions,
      round,
      selectedDivision,
      scoredTeams: Array.from(scoredTeams),
      assignedTeams,
      existingScores,
      isRoundLocked,
      requiredJudgesPerTeam: db.getRequiredJudgesPerTeam(),
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
    const eventSettings = await db.getEventSettings(req.eventId);
    if (eventSettings.judging_locked) {
      return res.render('error', {
        message: 'Judging has been locked. No new scores can be entered.',
        error: {}
      });
    }

    const teamName = decodeURIComponent(req.params.teamName);
    const round = parseInt(req.query.round) || req.session.currentRound || 1;

    // Check if round is locked
    const isLocked = await db.isRoundLocked(req.eventId, round);
    if (isLocked) {
      return res.render('error', {
        message: `Round ${round} has been locked. Scores can no longer be entered or edited for this round.`
      });
    }

    // Get team table
    const tableName = await db.getTeamTable(req.eventId, teamName);
    if (!tableName) {
      return res.render('error', {
        message: 'Team not found.'
      });
    }

    const eligibility = await db.canJudgeSubmitNewScore(req.eventId, req.session.user.email, teamName, round);
    if (!eligibility.ok) {
      return res.render('error', {
        message: scoreEligibilityMessage(eligibility.reason)
      });
    }

    const existingScore = await db.getScore(req.eventId, req.session.user.email, teamName, round);

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
    const eventSettings = await db.getEventSettings(req.eventId);
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
    const isLocked = await db.isRoundLocked(req.eventId, roundNum);
    if (isLocked) {
      return res.render('error', {
        message: `Round ${roundNum} has been locked. Scores can no longer be entered or edited for this round.`
      });
    }

    const eligibility = await db.canJudgeSubmitNewScore(req.eventId, judgeEmail, teamName, roundNum);
    if (!eligibility.ok) {
      return res.render('error', {
        message: scoreEligibilityMessage(eligibility.reason)
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
    await db.saveScore(req.eventId, judgeEmail, teamName, tableName, roundNum, scoreNum, notes || '');

    // Mark team assignment as completed
    await db.markAssignmentCompleted(req.eventId, judgeEmail, teamName, roundNum);

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
    const scores = await db.getJudgeScores(req.eventId, req.session.user.email);

    // Get event settings for locked rounds
    const eventSettings = await db.getEventSettings(req.eventId);
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
      lockedRounds,
      query: req.query
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
    
    const allResults = await db.getTableResults(req.eventId, round, null);
    
    // Filter results by division if specified
    let results = allResults;
    if (selectedDivision) {
      results = { [selectedDivision]: allResults[selectedDivision] || [] };
    }
    
    // Get event settings for divisions
    const eventSettings = await db.getEventSettings(req.eventId);
    const divisions = eventSettings.divisions || [];
    
    // Get top team per category for sidebar
    const categoryLeaders = await db.getTopTeamPerCategory(req.eventId, round) || [];

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
    
    const allResults = await db.getTableResults(req.eventId, round, null);
    
    // Filter results by division if specified
    let results = allResults;
    if (selectedDivision) {
      results = { [selectedDivision]: allResults[selectedDivision] || [] };
    }
    
    // Get top team per category for sidebar
    const categoryLeaders = await db.getTopTeamPerCategory(req.eventId, round) || [];

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

// GET table map (for modal display)
router.get('/table-map', requireJudge, async (req, res) => {
  try {
    const tables = await db.getTableNames(req.eventId);
    const allTeams = await db.getTeams(req.eventId);

    // Filter out sensitive data (contact_email) for non-admin users
    const teams = allTeams.map(team => {
      const teamData = { ...team };
      // Only admins can see contact_email
      if (req.session.user.role !== 'admin') {
        delete teamData.contact_email;
      }
      return teamData;
    });

    // Create a map of table -> teams array for quick lookup (supports multiple teams per table)
    const tableMap = {};
    teams.forEach(team => {
      if (!tableMap[team.table_name]) {
        tableMap[team.table_name] = [];
      }
      tableMap[team.table_name].push(team);
    });

    // Generate grid structure dynamically from database tables
    // Parse table names to extract letters and numbers
    const lettersSet = new Set();
    const numbersSet = new Set();

    tables.forEach(tableName => {
      // Match pattern: letters followed by numbers (e.g., A1, AB12, P10)
      const match = tableName.match(/^([A-Z]+)(\d+)$/i);
      if (match) {
        lettersSet.add(match[1].toUpperCase());
        numbersSet.add(parseInt(match[2]));
      }
    });

    // Convert to sorted arrays
    // Letters in reverse alphabetical order (P to A) for display from left to right
    const letters = Array.from(lettersSet).sort().reverse();
    // Numbers in descending order (10 to 1) for display from top to bottom
    const numbers = Array.from(numbersSet).sort((a, b) => b - a);

    const gridRows = [];

    numbers.forEach(num => {
      const row = [];
      letters.forEach(letter => {
        const tableId = `${letter}${num}`;
        row.push({
          id: tableId,
          teams: tableMap[tableId] || []
        });
      });
      gridRows.push(row);
    });

    // Render just the table map section
    res.render('partials/table-map', {
      gridRows,
      layout: false
    });
  } catch (error) {
    console.error('Error loading table map:', error);
    res.status(500).send('<div class="text-center text-red-500 p-4">Error loading table map. Please try again.</div>');
  }
});

module.exports = router;

