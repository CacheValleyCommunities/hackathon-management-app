const profanityFilter = require('../services/profanity-filter');

/**
 * Middleware to validate input fields for profanity
 * @param {Array} fieldsToCheck - Array of field names to check
 */
const validateProfanity = (fieldsToCheck) => {
  return async (req, res, next) => {
    try {
      const fields = {};
      
      // Extract fields from body
      for (const fieldName of fieldsToCheck) {
        if (req.body[fieldName]) {
          fields[fieldName] = req.body[fieldName];
        }
      }
      
      // Validate fields
      const validation = await profanityFilter.validateFields(fields);
      
      if (!validation.isValid) {
        // Return error response
        const errorMessages = Object.values(validation.errors).join('; ');
        
        // Check if this is an API request or regular form submission
        if (req.xhr || req.headers.accept?.includes('application/json')) {
          return res.status(400).json({
            error: 'Validation failed',
            details: validation.errors
          });
        }
        
        // For regular form submissions, render error page or redirect with error
        // We'll need to handle this per-route since different routes render different views
        req.validationErrors = validation.errors;
        return next(new Error(errorMessages));
      }
      
      next();
    } catch (error) {
      console.error('Profanity validation error:', error);
      // Don't block on validation errors, but log them
      next();
    }
  };
};

/**
 * Helper function to check profanity and return error message
 */
const checkAndReturnError = async (text, fieldName) => {
  if (!text) return null;
  
  const result = await profanityFilter.checkProfanity(text);
  if (result.hasProfanity) {
    return `${fieldName} contains inappropriate language. Please use professional language.`;
  }
  return null;
};

module.exports = {
  validateProfanity,
  checkAndReturnError
};

