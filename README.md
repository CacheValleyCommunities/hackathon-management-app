# Code Camp Judging System

A comprehensive web application for managing hackathon judging, scoring, and team management. Built with Node.js, Express, SQLite, and Handlebars.

## Features

### For Judges
- **Judge Queue System**: Intelligent team assignment ensuring each team gets the required number of judges
- **Score Entry**: Easy-to-use interface for entering scores with notes
- **My Scores**: View and edit all scores you've entered
- **Live Leaderboard**: Real-time score updates with division-based rankings

### For Participants
- **Team Dashboard**: View your team's scores, rank, and statistics
- **Team Registration**: Register your team with project details
- **Live Scores**: Track your team's performance across rounds
- **Team Information**: Update project details and contact information

### For Administrators
- **Admin Dashboard**: Comprehensive overview of teams, judges, and event status
- **User Management**: Add judges individually or import via CSV
- **Team Management**: View, edit, and manage all registered teams
- **Event Settings**: Configure event name, dates, divisions, logo, and rounds
- **Table Management**: Manage table assignments and generate chessboard layout
- **Round Management**: Lock rounds and increment to next round

## Technology Stack

- **Backend**: Node.js, Express.js
- **Database**: SQLite3
- **Templating**: Handlebars.js
- **Authentication**: JWT (JSON Web Tokens) with magic link login
- **Email**: Mailgun integration
- **Styling**: Tailwind CSS
- **Testing**: Jest

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Mailgun account (for email functionality)
- SQLite3

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd code-camp-judging-app
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Session & JWT
SESSION_SECRET=your-session-secret-here
JWT_SECRET=your-jwt-secret-here

# Mailgun Configuration (for email functionality)
MAILGUN_API_KEY=your-mailgun-api-key
MAILGUN_DOMAIN=your-mailgun-domain
MAILGUN_FROM_EMAIL=noreply@yourdomain.com

# Judge Queue Configuration
JUDGES_PER_TEAM=2
```

4. Initialize the database:
```bash
npm start
```

The database will be automatically created on first run.

5. Access the application:
```
http://localhost:3000
```

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 3000 | No |
| `NODE_ENV` | Environment (development/production) | development | No |
| `SESSION_SECRET` | Secret for session encryption | - | Yes |
| `JWT_SECRET` | Secret for JWT token signing | - | Yes |
| `MAILGUN_API_KEY` | Mailgun API key for emails | - | Yes |
| `MAILGUN_DOMAIN` | Mailgun domain | - | Yes |
| `MAILGUN_FROM_EMAIL` | From email address | - | Yes |
| `JUDGES_PER_TEAM` | Number of judges required per team per round | 2 | No |

## Usage

### Initial Setup

1. **Create Admin Account**: The system automatically creates a default admin account on first run. Check the console for login credentials.

2. **Configure Event Settings**:
   - Navigate to Admin Dashboard → Event Settings
   - Set event name, dates, divisions, and upload logo
   - Configure initial round settings

3. **Add Judges**:
   - Individual: Admin Dashboard → Add User
   - Bulk Import: Admin Dashboard → Import Judges (CSV)

4. **Set Up Tables**:
   - Admin Dashboard → Manage Tables
   - Use "Quick Setup" to generate chessboard layout (A1-P10)
   - Or add tables manually

5. **Team Registration**:
   - Teams can register at `/register`
   - Or admins can add teams manually

### Judge Queue System

The judge queue system ensures fair distribution of judges:

- Each team gets exactly `JUDGES_PER_TEAM` judges per round
- Judges never judge the same team twice (across all rounds)
- System automatically routes judges to teams needing judges
- Load balancing prioritizes teams with fewer judges

**Usage**:
1. Judges click "Judge Queue" from the dashboard
2. Click "Get Next Team" to be assigned a team
3. Enter score and submit
4. System automatically assigns next team
5. When all teams are judged, judges see completion message

### Scoring System

- **Cumulative Scoring**: Scores accumulate across rounds
  - Round 1: Only Round 1 scores
  - Round 2: Round 1 + Round 2 scores
  - Round 3: Round 1 + Round 2 + Round 3 scores
  - And so on...

- **Division-based Rankings**: Teams are ranked within their division
- **Round Locking**: Admins can lock rounds to prevent score edits

### Roles

- **Admin**: Full access to all features
- **Judge**: Can enter scores, view leaderboard, use judge queue
- **Participant**: Can view their team's scores and update team info

## Project Structure

```
code-camp-judging-app/
├── db/
│   └── database.js          # Database operations
├── middleware/
│   ├── rbac.js              # Role-based access control
│   └── validation.js        # Input validation
├── routes/
│   ├── admin.js             # Admin routes
│   ├── auth.js              # Authentication routes
│   ├── index.js             # Main dashboard
│   ├── participant.js       # Participant routes
│   ├── register.js          # Team registration
│   └── scores.js            # Score management
├── scripts/
│   └── create-sample-data.js # Sample data generator
├── services/
│   ├── email.js             # Email service (Mailgun)
│   └── profanity-filter.js  # Profanity filtering
├── tests/
│   ├── database.test.js     # Database tests
│   ├── judge-queue.test.js  # Judge queue tests
│   ├── profanity-filter.test.js
│   ├── rbac.test.js         # RBAC tests
│   ├── scores.test.js       # Score tests
│   └── validation.test.js   # Validation tests
├── views/
│   ├── admin/               # Admin views
│   ├── auth/                # Authentication views
│   ├── layouts/             # Layout templates
│   ├── participant/         # Participant views
│   ├── scores/              # Score views
│   └── partials/            # Reusable partials
├── public/
│   └── uploads/             # Uploaded files (logos)
├── server.js                # Main server file
└── package.json
```

## Scripts

```bash
# Start the server
npm start

# Start in development mode (with auto-reload)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Testing

The project includes comprehensive unit tests. See [tests/README.md](tests/README.md) for detailed information.

Run all tests:
```bash
npm test
```

Run specific test suite:
```bash
npm test -- tests/judge-queue.test.js
```

## Security Features

- **JWT Authentication**: Secure token-based authentication
- **SQL Injection Protection**: All queries use parameterized statements
- **Profanity Filter**: Input validation using external wordlist
- **Role-Based Access Control**: Middleware ensures proper authorization
- **Session Security**: Secure session cookies in production

## Email Functionality

The system sends emails for:
- Magic link login
- Team registration confirmation
- Judge account creation (individual and bulk)

Configure Mailgun in your `.env` file to enable email functionality.

## Database

The application uses SQLite3 for data storage. The database file (`judging.db`) is created automatically in the `db/` directory.

### Key Tables

- `users`: User accounts (judges, admins, participants)
- `teams`: Registered teams
- `scores`: Judge scores
- `judge_team_assignments`: Judge queue assignments
- `event_settings`: Event configuration
- `magic_tokens`: Authentication tokens
- `tables`: Table assignments

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## License

ISC

## Support

For issues, questions, or contributions, please open an issue on the repository.

