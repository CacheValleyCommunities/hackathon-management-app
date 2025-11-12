#!/usr/bin/env node

/**
 * Sample Data Generator for Hackathon Judging System
 * 
 * This script creates dummy data for testing:
 * - Tables A1-F7 (42 tables)
 * - 3 divisions: Beginner, Intermediate, Advanced
 * - 5 teams per division (15 teams total)
 * - 10 judges
 */

const db = require('../db/database');

// Sample data constants
const DIVISIONS = ['Beginner', 'Intermediate', 'Advanced'];
const TEAM_PREFIX = [
    'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon',
    'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa',
    'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron'
];
const PROJECT_THEMES = [
    'AI Assistant', 'Blockchain Platform', 'Climate Tracker', 'DevOps Tool', 'EdTech Platform',
    'FinTech App', 'Gaming Engine', 'Health Monitor', 'IoT Controller', 'Job Matcher',
    'Knowledge Base', 'Learning Portal', 'Music Streamer', 'News Aggregator', 'Online Marketplace'
];

// Generate tables A1-F7
function generateTables() {
    const tables = [];
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (const letter of letters) {
        for (let num = 1; num <= 7; num++) {
            tables.push({ name: `${letter}${num}` });
        }
    }
    return tables;
}

// Generate teams
function generateTeams() {
    const teams = [];
    const tables = generateTables();
    let tableIndex = 0;

    DIVISIONS.forEach((division, divIndex) => {
        for (let i = 0; i < 5; i++) {
            const teamNum = divIndex * 5 + i + 1;
            const table = tables[tableIndex % tables.length];
            tableIndex++;

            teams.push({
                name: `Team ${TEAM_PREFIX[teamNum - 1]}`,
                table_name: table.name,
                project_name: `${PROJECT_THEMES[teamNum - 1]} ${division === 'Beginner' ? 'Starter' : division === 'Intermediate' ? 'Pro' : 'Elite'}`,
                contact_email: `team${teamNum}@example.com`,
                github_link: `https://github.com/team${teamNum}/project`,
                division: division
            });
        }
    });

    return teams;
}

// Generate judges
function generateJudges() {
    const judges = [];
    const names = [
        'Alice Johnson', 'Bob Smith', 'Carol Martinez', 'David Chen', 'Emma Wilson',
        'Frank Brown', 'Grace Lee', 'Henry Davis', 'Iris Rodriguez', 'Jack Thompson'
    ];

    names.forEach((name, index) => {
        const firstName = name.split(' ')[0].toLowerCase();
        judges.push({
            email: `${firstName}@judges.com`,
            name: name,
            role: 'judge'
        });
    });

    return judges;
}

async function clearExistingData() {
    console.log('🗑️  Clearing existing sample data...');
    const dbInstance = db.getDb();

    // Delete in correct order due to foreign keys
    await new Promise((resolve, reject) => {
        dbInstance.run('DELETE FROM judge_team_assignments', (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    await new Promise((resolve, reject) => {
        dbInstance.run('DELETE FROM scores', (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    await new Promise((resolve, reject) => {
        dbInstance.run('DELETE FROM teams', (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    // Delete sample tables (A1-F7)
    await new Promise((resolve, reject) => {
        const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
        const placeholders = letters.map(() => 'name LIKE ?').join(' OR ');
        const patterns = letters.map(l => `${l}%`);
        dbInstance.run(`DELETE FROM tables WHERE ${placeholders}`, patterns, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    await new Promise((resolve, reject) => {
        dbInstance.run("DELETE FROM users WHERE email LIKE '%@judges.com' OR email LIKE 'team%@example.com'", (err) => {
            if (err) reject(err);
            else resolve();
        });
    });

    console.log('✓ Existing sample data cleared\n');
}

async function createSampleData() {
    console.log('🚀 Starting sample data creation...');
    console.log('⚠️  Note: This will clear any existing sample data (Teams A-F, judges@*.com)\n');

    try {
        // Initialize database
        await db.init();
        console.log('✓ Database initialized');

        // Clear existing sample data
        await clearExistingData();

        // Update event settings with divisions
        console.log('📋 Setting up event...');
        const eventSettings = await db.getEventSettings();
        await db.updateEventSettings({
            ...eventSettings,
            event_name: 'Sample Hackathon 2025',
            divisions: JSON.stringify(DIVISIONS),
            current_round: 1,
            locked_rounds: JSON.stringify([])
        });
        console.log('✓ Event settings updated');
        console.log(`  - Event: Sample Hackathon 2025`);
        console.log(`  - Divisions: ${DIVISIONS.join(', ')}`);
        console.log(`  - Current Round: 1`);

        // Create tables
        console.log('\n🗺️  Creating tables...');
        const tables = generateTables();
        await db.syncTables(tables);
        console.log(`✓ Created ${tables.length} tables (A1-F7)`);

        // Create teams
        console.log('\n👥 Creating teams...');
        const teams = generateTeams();
        for (const team of teams) {
            await db.createTeam(team);
        }
        console.log(`✓ Created ${teams.length} teams across ${DIVISIONS.length} divisions`);
        DIVISIONS.forEach(div => {
            const count = teams.filter(t => t.division === div).length;
            console.log(`  - ${div}: ${count} teams`);
        });

        // Create judges
        console.log('\n⚖️  Creating judges...');
        const judges = generateJudges();
        for (const judge of judges) {
            await db.getOrCreateUser(judge.email, judge.name, judge.role);
        }
        console.log(`✓ Created ${judges.length} judges`);
        judges.forEach((judge, i) => {
            console.log(`  ${i + 1}. ${judge.name} (${judge.email})`);
        });

        console.log('\n✨ Sample data creation complete!\n');
        console.log('📊 Summary:');
        console.log(`  - Tables: ${tables.length}`);
        console.log(`  - Teams: ${teams.length}`);
        console.log(`  - Judges: ${judges.length}`);
        console.log(`  - Divisions: ${DIVISIONS.length}`);
        console.log('\n💡 You can now log in with any judge email:');
        judges.slice(0, 3).forEach(judge => {
            console.log(`  - ${judge.email}`);
        });
        console.log('\n🔗 Use the magic link system to authenticate.\n');

    } catch (error) {
        console.error('\n❌ Error creating sample data:', error);
        process.exit(1);
    } finally {
        db.close();
        process.exit(0);
    }
}

// Run the script
createSampleData();

