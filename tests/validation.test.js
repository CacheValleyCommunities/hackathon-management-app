const { checkAndReturnError } = require('../middleware/validation');
const profanityFilter = require('../services/profanity-filter');

// Mock the profanity filter
jest.mock('../services/profanity-filter');

describe('Validation Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkAndReturnError', () => {
    test('should return null for empty text', async () => {
      const result = await checkAndReturnError('', 'Test Field');
      expect(result).toBeNull();
    });

    test('should return null for null text', async () => {
      const result = await checkAndReturnError(null, 'Test Field');
      expect(result).toBeNull();
    });

    test('should return null for undefined text', async () => {
      const result = await checkAndReturnError(undefined, 'Test Field');
      expect(result).toBeNull();
    });

    test('should return null when no profanity is detected', async () => {
      profanityFilter.checkProfanity.mockResolvedValue({
        hasProfanity: false
      });

      const result = await checkAndReturnError('This is a clean text', 'Test Field');
      expect(result).toBeNull();
      expect(profanityFilter.checkProfanity).toHaveBeenCalledWith('This is a clean text');
    });

    test('should return error message when profanity is detected', async () => {
      profanityFilter.checkProfanity.mockResolvedValue({
        hasProfanity: true
      });

      const result = await checkAndReturnError('bad word here', 'Team Name');
      expect(result).toBe('Team Name contains inappropriate language. Please use professional language.');
      expect(profanityFilter.checkProfanity).toHaveBeenCalledWith('bad word here');
    });

    test('should use correct field name in error message', async () => {
      profanityFilter.checkProfanity.mockResolvedValue({
        hasProfanity: true
      });

      const result = await checkAndReturnError('bad text', 'Project Description');
      expect(result).toContain('Project Description');
    });

    test('should handle profanity filter errors gracefully', async () => {
      profanityFilter.checkProfanity.mockRejectedValue(new Error('Filter error'));

      // The function will throw if the filter errors - this is expected behavior
      await expect(checkAndReturnError('test', 'Field')).rejects.toThrow('Filter error');
    });
  });
});

