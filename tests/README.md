# Test Suite

This directory contains comprehensive unit tests for the code camp judging application.

## Test Files

### `judge-queue.test.js`
Tests the judge queue system to ensure it works correctly according to the requirements.

**Requirements Tested:**
1. Each team gets exactly `JUDGES_PER_TEAM` judges per round (configurable via `.env`)
2. Judges never judge the same team twice (across all rounds)
3. Queue routes judges until all teams have been judged the required number of times
4. Completion messages are shown when:
   - All teams have been judged (all judges see completion message)
   - A judge has judged all remaining available teams (individual judge sees "done for now" message)

**Coverage:**
- Basic Queue Functionality: Round-robin assignment, ensuring all teams get required judges
- Judge Uniqueness: Preventing duplicate assignments across rounds
- Queue Completion: Proper handling of completion states
- Load Balancing: Prioritizing teams with fewer judges
- Edge Cases: Single judge, more judges than needed, empty teams
- Round Isolation: Multiple rounds work independently

### `database.test.js`
Tests core database operations for user, team, score, and event settings management.

**Coverage:**
- User Management: Create, retrieve, update users with role and team associations
- Team Management: Create, retrieve teams with optional fields
- Score Management: Save, update, and retrieve scores across rounds
- Magic Token Management: Create, validate, and expire authentication tokens
- Event Settings: Get and update event configuration

### `scores.test.js`
Tests score calculation and aggregation functions.

**Coverage:**
- Cumulative Scoring: Scores accumulate across rounds correctly
- Round Filtering: Only scores up to specified round are included
- Judge Scores Retrieval: Filter scores by judge, round, and table
- Division-based Results: Results grouped and ranked by division
- Judge Count and Rounds: Accurate counting of unique judges and completed rounds

### `validation.test.js`
Tests input validation middleware for profanity filtering.

**Coverage:**
- Empty/null input handling
- Profanity detection and error messages
- Field name in error messages
- Error handling

### `profanity-filter.test.js`
Tests the profanity filter service.

**Coverage:**
- Clean text validation
- Case insensitivity
- Special characters and unicode handling
- Multiple field validation
- Edge cases (empty strings, null values, long text)

### `rbac.test.js`
Tests role-based access control middleware.

**Coverage:**
- Authentication checks
- Role-based access (admin, judge, participant)
- Admin override permissions
- Team ownership validation
- Multiple role requirements

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/judge-queue.test.js
npm test -- tests/database.test.js
npm test -- tests/scores.test.js
npm test -- tests/validation.test.js
npm test -- tests/profanity-filter.test.js
npm test -- tests/rbac.test.js

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Environment Variables

The tests use the `JUDGES_PER_TEAM` environment variable (defaults to 2 if not set). You can override this:

```bash
JUDGES_PER_TEAM=3 npm test
```

## Test Databases

Tests use separate test databases that are created and cleaned up automatically:
- `test-judge-queue.db` - Judge queue tests
- `test-database.db` - Database function tests
- `test-scores.db` - Score management tests

All test databases are deleted after tests complete.

## Test Statistics

- **Total Test Suites**: 6
- **Total Tests**: 86+ tests covering all core functionality
- **Coverage**: Database operations, business logic, middleware, and services

## Writing New Tests

When adding new functionality, please add corresponding tests:

1. Create test file in `tests/` directory
2. Follow existing test patterns
3. Use isolated test databases
4. Clean up after tests
5. Ensure tests are deterministic and independent

### Example Test Structure

```javascript
describe('Feature Name', () => {
  let testDb;

  beforeAll(async () => {
    // Setup test database
  });

  afterAll(async () => {
    // Cleanup test database
  });

  beforeEach(async () => {
    // Clear data before each test
  });

  describe('Sub-feature', () => {
    test('should do something', async () => {
      // Test implementation
    });
  });
});
```

## Best Practices

1. **Isolation**: Each test should be independent and not rely on other tests
2. **Cleanup**: Always clean up test data and databases
3. **Descriptive Names**: Use clear, descriptive test names
4. **Arrange-Act-Assert**: Structure tests with clear sections
5. **Edge Cases**: Test both happy paths and edge cases
6. **Mocking**: Mock external dependencies (APIs, services)

## Continuous Integration

Tests should pass in CI/CD pipelines. Ensure:
- All tests pass locally before committing
- No hardcoded paths or environment-specific code
- Tests are fast and don't require external services (unless mocked)

