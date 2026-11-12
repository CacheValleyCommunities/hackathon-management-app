const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-schools-'));
const previousDbPath = process.env.JUDGING_DB_PATH;
process.env.JUDGING_DB_PATH = path.join(tempDir, 'judging.db');

const db = require('../db/database');

describe('event isolation and school accounts', () => {
  let firstEvent;
  let secondEvent;

  beforeAll(async () => {
    await db.init();
    firstEvent = (await db.listEvents())[0];
    secondEvent = await db.createEvent({ event_name: 'Second Hackathon', divisions: '[]' });
    await db.updateEventStatus(secondEvent.id, 'open');
    await db.syncTables(firstEvent.id, [{ name: 'A1' }]);
    await db.syncTables(secondEvent.id, [{ name: 'A1' }]);
  });

  afterAll(async () => {
    await db.close();
    if (previousDbPath === undefined) {
      delete process.env.JUDGING_DB_PATH;
    } else {
      process.env.JUDGING_DB_PATH = previousDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('the same team name can exist in two events and scores stay in one event', async () => {
    await db.createTeam({
      event_id: firstEvent.id,
      name: 'Shared Name',
      table_name: 'A1',
      project_name: 'First project',
      division: 'Open'
    });
    await db.createTeam({
      event_id: secondEvent.id,
      name: 'Shared Name',
      table_name: 'A1',
      project_name: 'Second project',
      division: 'Open'
    });

    await db.saveScore(firstEvent.id, 'judge@example.com', 'Shared Name', 'A1', 1, 9, '');

    const firstTeams = await db.getTeams(firstEvent.id);
    const secondTeams = await db.getTeams(secondEvent.id);
    expect(firstTeams.filter(team => team.name === 'Shared Name')).toHaveLength(1);
    expect(secondTeams.filter(team => team.name === 'Shared Name')).toHaveLength(1);
    expect(firstTeams.find(team => team.name === 'Shared Name').project_name).toBe('First project');
    expect(secondTeams.find(team => team.name === 'Shared Name').project_name).toBe('Second project');

    const firstResults = await db.getTableResults(firstEvent.id, 1);
    const secondResults = await db.getTableResults(secondEvent.id, 1);
    expect((firstResults.Open || []).map(team => team.team_name)).toContain('Shared Name');
    expect((secondResults.Open || []).some(team => team.total_score > 0)).toBe(false);

    const judge = await db.createUser('scoped-judge@example.com', 'Scoped Judge');
    await db.upsertMembership(judge.id, firstEvent.id, 'judge');
    const memberships = await db.getMembershipsForUser(judge.id);
    expect(memberships.map(membership => membership.event_id)).toEqual([firstEvent.id]);

    const scoredElsewhere = await db.getScore(secondEvent.id, 'judge@example.com', 'Shared Name', 1);
    expect(scoredElsewhere).toBeFalsy();
    const nextInFirst = await db.getNextTeamForJudge(firstEvent.id, judge.email, 1);
    expect(nextInFirst.name).toBe('Shared Name');
    expect((await db.getTeams(secondEvent.id)).find(team => team.name === 'Shared Name').project_name).toBe('Second project');
  });

  test('an individual can own one team per event', async () => {
    const person = await db.createUser('solo@example.com', 'Solo');
    await db.createTeam({
      event_id: firstEvent.id,
      name: 'Solo Team',
      table_name: 'A1',
      project_name: 'Solo project',
      division: 'Open',
      owner_user_id: person.id,
      registration_type: 'individual'
    });

    await expect(db.createTeam({
      event_id: firstEvent.id,
      name: 'Solo Team Two',
      table_name: 'A1',
      project_name: 'Another project',
      division: 'Open',
      owner_user_id: person.id,
      registration_type: 'individual'
    })).rejects.toMatchObject({ code: 'INDIVIDUAL_TEAM_EXISTS' });

    const owned = await db.getIndividualTeam(firstEvent.id, person.id);
    expect(owned.name).toBe('Solo Team');
  });

  test('a chaperone can create and edit two teams with no student information', async () => {
    const chaperone = await db.createUser('chaperone@school.test', 'Chaperone', 'user', null, {
      account_type: 'school',
      school_name: 'North High'
    });
    await db.upsertMembership(chaperone.id, firstEvent.id, 'chaperone');

    const first = await db.createTeam({
      event_id: firstEvent.id,
      name: 'School Robotics',
      table_name: 'A1',
      project_name: 'Robot arm',
      division: 'Open',
      owner_user_id: chaperone.id,
      registration_type: 'school',
      contact_email: chaperone.email,
      team_leader_email: chaperone.email,
      team_members: ['Student One', 'Student Two']
    });
    const second = await db.createTeam({
      event_id: firstEvent.id,
      name: 'School Climate',
      table_name: 'A1',
      project_name: 'Sensor map',
      division: 'Open',
      owner_user_id: chaperone.id,
      registration_type: 'school',
      contact_email: chaperone.email,
      team_leader_email: chaperone.email,
      team_members: ['Student Three']
    });

    const storedFirst = await db.getTeamById(first.id, true);
    const storedSecond = await db.getTeamById(second.id, true);
    expect(storedFirst.team_members == null || storedFirst.team_members.length === 0).toBe(true);
    expect(storedSecond.team_members == null || storedSecond.team_members.length === 0).toBe(true);
    expect(storedFirst.registration_type).toBe('school');
    expect(storedSecond.registration_type).toBe('school');

    await db.updateTeam(first.id, {
      project_name: 'Robot arm v2',
      team_members: ['Should not persist']
    });
    await db.updateTeam(second.id, { project_name: 'Sensor map v2' });

    const edited = await db.getTeamsForOwner(firstEvent.id, chaperone.id);
    const schoolTeams = edited.filter(team => team.registration_type === 'school');
    expect(schoolTeams.map(team => team.name).sort()).toEqual(['School Climate', 'School Robotics']);
    expect(schoolTeams.every(team => !team.team_members || team.team_members.length === 0)).toBe(true);
    expect(schoolTeams.find(team => team.name === 'School Robotics').project_name).toBe('Robot arm v2');
    expect(schoolTeams.find(team => team.name === 'School Climate').project_name).toBe('Sensor map v2');

    const publicView = await db.getTeamById(first.id, false);
    expect(!publicView.team_members || publicView.team_members.length === 0).toBe(true);
    expect(await db.countSchoolTeams(chaperone.id)).toBe(2);
  });
});
