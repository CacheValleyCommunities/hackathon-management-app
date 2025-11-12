# Scripts

This directory contains utility scripts for the code camp judging application.

## Available Scripts

### `create-sample-data.js`

Generates sample data for testing and development purposes. This script creates:
- Sample teams with various divisions
- Sample judges
- Sample tables (A1-F7)
- Sample judge assignments
- Sample scores across multiple rounds

#### Usage

```bash
node scripts/create-sample-data.js
```

#### What It Creates

**Teams:**
- 15 teams across different divisions (Beginner, Intermediate, Advanced)
- Teams assigned to tables A1-F7
- Each team has project names, contact emails, and GitHub links

**Judges:**
- 5 sample judges with email addresses
- Judges are created as regular users with 'judge' role

**Tables:**
- Tables A1 through F7 (42 tables total)
- Tables are created if they don't exist

**Scores:**
- Scores for Round 1 and Round 2
- Each team gets scores from 2 judges per round
- Scores range from 70-95 points
- Some teams have notes attached

**Judge Assignments:**
- Judge-team assignments for Round 1 and Round 2
- Ensures each team has 2 judges per round
- Assignments are marked as completed

#### Features

- **Safe Execution**: Clears existing sample data before creating new data
- **Error Handling**: Gracefully handles missing dependencies
- **Database Validation**: Checks database connection before proceeding
- **Detailed Logging**: Provides console output showing what's being created

#### Sample Data Structure

```
Teams: 15 teams
  - Division: Beginner (5 teams)
  - Division: Intermediate (5 teams)
  - Division: Advanced (5 teams)

Judges: 5 judges
  - judge1@example.com
  - judge2@example.com
  - judge3@example.com
  - judge4@example.com
  - judge5@example.com

Tables: 42 tables (A1-F7)

Scores: 
  - Round 1: 30 scores (15 teams × 2 judges)
  - Round 2: 30 scores (15 teams × 2 judges)
```

#### Prerequisites

- Database must be initialized
- Database connection must be available
- Required database tables must exist

#### Notes

- This script is designed for development and testing only
- It will delete existing sample data before creating new data
- It will not delete non-sample data (real teams, judges, etc.)
- Run this script in a development environment only

#### Customization

You can modify the script to:
- Change the number of teams created
- Adjust the divisions
- Modify score ranges
- Add more rounds
- Change table assignments

Edit the constants at the top of the file:
```javascript
const NUM_TEAMS = 15;
const NUM_JUDGES = 5;
const TEAM_PREFIX = ['Alpha', 'Beta', 'Gamma', ...];
const DIVISIONS = ['Beginner', 'Intermediate', 'Advanced'];
```

## Adding New Scripts

When creating new utility scripts:

1. Place them in the `scripts/` directory
2. Use clear, descriptive names
3. Include error handling
4. Add usage documentation in comments
5. Update this README with script information

### Script Template

```javascript
require('dotenv').config();
const db = require('../db/database');

async function main() {
  try {
    // Initialize database
    await db.init();
    
    // Your script logic here
    
    console.log('Script completed successfully');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
```

## Best Practices

1. **Error Handling**: Always wrap script logic in try-catch blocks
2. **Database Cleanup**: Close database connections when done
3. **Logging**: Provide clear console output
4. **Idempotency**: Scripts should be safe to run multiple times
5. **Documentation**: Include clear comments and usage instructions
6. **Environment Checks**: Verify environment before running

## Security Considerations

- Scripts should not contain sensitive data
- Use environment variables for configuration
- Validate inputs before database operations
- Be cautious with data deletion operations
- Test scripts in development before production use

