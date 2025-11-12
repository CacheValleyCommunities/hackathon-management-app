const https = require('https');
const fs = require('fs');
const path = require('path');

// GitHub raw URLs for profanity word lists
const WORD_LIST_URLS = {
  en: 'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en',
  // Add more languages if needed
};

// Cache for word lists
let bannedWordsCache = null;
let lastFetchTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Local fallback word list (basic common profanity)
const FALLBACK_WORDS = [
  // Add a few basic ones as fallback
  'damn', 'hell'
];

/**
 * Fetch banned words from GitHub
 */
const fetchBannedWords = async () => {
  return new Promise((resolve, reject) => {
    const url = WORD_LIST_URLS.en;
    
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        console.warn('Failed to fetch banned words from GitHub, using fallback');
        resolve(FALLBACK_WORDS);
        return;
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        // Split by newlines and filter out empty lines and comments
        const words = data
          .split('\n')
          .map(line => line.trim().toLowerCase())
          .filter(line => line && !line.startsWith('#') && line.length > 0);
        
        // Combine with fallback words
        const allWords = [...new Set([...words, ...FALLBACK_WORDS])];
        resolve(allWords);
      });
    }).on('error', (error) => {
      console.error('Error fetching banned words:', error);
      console.warn('Using fallback word list');
      resolve(FALLBACK_WORDS);
    });
  });
};

/**
 * Get banned words (with caching)
 */
const getBannedWords = async () => {
  const now = Date.now();
  
  // Return cached words if still valid
  if (bannedWordsCache && lastFetchTime && (now - lastFetchTime) < CACHE_DURATION) {
    return bannedWordsCache;
  }

  try {
    bannedWordsCache = await fetchBannedWords();
    lastFetchTime = now;
    console.log(`Loaded ${bannedWordsCache.length} banned words`);
    return bannedWordsCache;
  } catch (error) {
    console.error('Error loading banned words:', error);
    return FALLBACK_WORDS;
  }
};

/**
 * Check if text contains profanity
 * @param {string} text - Text to check
 * @returns {Promise<{hasProfanity: boolean, words: string[]}>}
 */
const checkProfanity = async (text) => {
  if (!text || typeof text !== 'string') {
    return { hasProfanity: false, words: [] };
  }

  try {
    const bannedWords = await getBannedWords();
    const lowerText = text.toLowerCase().trim();
    
    if (lowerText.length === 0) {
      return { hasProfanity: false, words: [] };
    }
    
    // Normalize text: remove special characters for word boundary matching
    const normalizedText = lowerText.replace(/[^\w\s]/g, ' ');
    const words = normalizedText.split(/\s+/).filter(w => w.length > 0);
    
    const foundWords = new Set();
    
    // Check each word against banned list (exact match)
    for (const word of words) {
      if (bannedWords.includes(word)) {
        foundWords.add(word);
      }
    }
    
    // Also check for banned words as substrings (for partial matches, but only words >= 3 chars)
    for (const bannedWord of bannedWords) {
      if (bannedWord.length >= 3 && lowerText.includes(bannedWord)) {
        // Make sure it's not part of a larger word (basic word boundary check)
        const regex = new RegExp(`\\b${bannedWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(lowerText)) {
          foundWords.add(bannedWord);
        }
      }
    }

    return {
      hasProfanity: foundWords.size > 0,
      words: Array.from(foundWords)
    };
  } catch (error) {
    console.error('Error checking profanity:', error);
    // Fail open - don't block on filter errors
    return { hasProfanity: false, words: [] };
  }
};

/**
 * Validate multiple text fields
 * @param {Object} fields - Object with field names as keys and text values
 * @returns {Promise<{isValid: boolean, errors: Object}>}
 */
const validateFields = async (fields) => {
  const errors = {};
  
  for (const [fieldName, value] of Object.entries(fields)) {
    if (value && typeof value === 'string') {
      const result = await checkProfanity(value);
      if (result.hasProfanity) {
        errors[fieldName] = `Contains inappropriate language: ${result.words.join(', ')}`;
      }
    }
  }
  
  return {
    isValid: Object.keys(errors).length === 0,
    errors
  };
};

module.exports = {
  checkProfanity,
  validateFields,
  getBannedWords
};

