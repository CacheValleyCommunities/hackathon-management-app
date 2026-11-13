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

  test('renaming an event keeps its public slug', async () => {
    const before = await db.getEventById(secondEvent.id);
    await db.renameEvent(secondEvent.id, 'Renamed Hackathon');
    const renamed = await db.getEventById(secondEvent.id);
    expect(renamed.event_name).toBe('Renamed Hackathon');
    expect(renamed.slug).toBe(before.slug);

    await db.updateEventSettings(secondEvent.id, {
      event_name: 'Renamed Again',
      start_date: renamed.start_date,
      end_date: renamed.end_date,
      divisions: renamed.divisions,
      logo_filename: renamed.logo_filename,
      hero_banner_image: renamed.hero_banner_image,
      hero_banner_link: renamed.hero_banner_link,
      landing_page_content: '# About\n\nA renamed event.',
      event_dates_text: renamed.event_dates_text
    });
    const afterSettings = await db.getEventById(secondEvent.id);
    expect(afterSettings.event_name).toBe('Renamed Again');
    expect(afterSettings.slug).toBe(before.slug);
    expect(afterSettings.landing_page_content).toBe('# About\n\nA renamed event.');

    await expect(db.renameEvent(secondEvent.id, '   ')).rejects.toThrow('Name is required');
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

  test('a parent invite can be created and consumed once', async () => {
    const minor = await db.createUser('minor-invite@example.test', 'Minor');
    const invite = await db.createRegistrationInvite({
      eventId: firstEvent.id,
      guardianEmail: 'Parent@Example.test',
      invitedByUserId: minor.id
    });

    const stored = await db.getRegistrationInvite(invite.token);
    expect(stored.guardian_email).toBe('parent@example.test');
    expect(stored.event_id).toBe(firstEvent.id);
    expect(stored.invited_by_user_id).toBe(minor.id);
    expect(stored.used_at).toBeNull();
    expect(new Date(stored.expires_at).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);

    const firstUse = await db.markRegistrationInviteUsed(invite.token);
    expect(firstUse.updated).toBe(true);
    const used = await db.getRegistrationInvite(invite.token);
    expect(used.used_at).toBeTruthy();

    const secondUse = await db.markRegistrationInviteUsed(invite.token);
    expect(secondUse.updated).toBe(false);
    expect((await db.deleteRegistrationInvite(invite.token)).deleted).toBe(false);
    expect(await db.getRegistrationInvite(invite.token)).toBeTruthy();
  });

  test('team member contacts round-trip as name and email', async () => {
    const created = await db.createTeam({
      event_id: secondEvent.id,
      name: 'Contact Round Trip',
      table_name: 'A1',
      project_name: 'Contacts',
      registration_type: 'individual',
      team_members: [
        { name: 'Ada Lovelace', email: 'ada@example.test' },
        'Grace Hopper'
      ]
    });

    const stored = (await db.getTeams(secondEvent.id, null, true)).find(team => team.id === created.id);
    expect(stored.team_members).toEqual([
      { name: 'Ada Lovelace', email: 'ada@example.test' },
      'Grace Hopper'
    ]);

    const school = await db.createTeam({
      event_id: secondEvent.id,
      name: 'School Contact Drop',
      table_name: 'A1',
      project_name: 'No students',
      registration_type: 'school',
      team_members: [{ name: 'Should Not Persist', email: 'student@example.test' }]
    });
    const storedSchool = await db.getTeamById(school.id, true);
    expect(!storedSchool.team_members || storedSchool.team_members.length === 0).toBe(true);
  });

  test('judging time defaults to 3 minutes and survives unrelated setting saves', async () => {
    const created = await db.getEventById(firstEvent.id);
    expect(created.judging_seconds).toBe(180);
    expect(created.judging_minutes).toBe(3);

    await db.updateEventSettings(firstEvent.id, {
      event_name: created.event_name,
      start_date: created.start_date,
      end_date: created.end_date,
      divisions: created.divisions,
      judging_seconds: 300
    });
    const updated = await db.getEventById(firstEvent.id);
    expect(updated.judging_seconds).toBe(300);
    expect(updated.judging_minutes).toBe(5);

    await db.updateEventSettings(firstEvent.id, {
      event_name: created.event_name,
      start_date: created.start_date,
      end_date: created.end_date,
      divisions: created.divisions,
      landing_page_content: created.landing_page_content
    });
    const preserved = await db.getEventById(firstEvent.id);
    expect(preserved.judging_seconds).toBe(300);
    expect(preserved.judging_minutes).toBe(5);
  });
});
