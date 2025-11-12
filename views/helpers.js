// Handlebars helpers
module.exports = {
  eq: (a, b) => {
    // Handle numeric comparison for IDs
    if (a != null && b != null) {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA === numB;
      }
    }
    return a === b;
  },
  contains: (array, value) => {
    if (!array) return false;
    // Try direct match first
    if (array.includes(value)) return true;
    // Try numeric comparison (handles string vs number mismatch)
    const numValue = Number(value);
    if (!isNaN(numValue)) {
      return array.some(item => Number(item) === numValue);
    }
    return false;
  },
  range: (start, end) => {
    const result = [];
    for (let i = start; i <= end; i++) {
      result.push(i);
    }
    return result;
  },
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  gt: (a, b) => a > b,
  size: (obj) => {
    if (!obj) return 0;
    if (Array.isArray(obj)) return obj.length;
    return Object.keys(obj).length;
  },
  encodeURIComponent: (str) => {
    if (str == null) return '';
    return encodeURIComponent(String(str));
  },
  toFixed: (num, decimals, options) => {
    if (num == null || isNaN(num)) return '0.00';
    // Handle Handlebars argument passing - decimals might be the options object if not provided
    let precision = 2;
    if (decimals != null && typeof decimals !== 'object') {
      precision = parseInt(decimals) || 2;
    }
    return Number(num).toFixed(precision);
  },
  add: (a, b) => {
    return (Number(a) || 0) + (Number(b) || 0);
  },
  subtract: (a, b) => {
    return (Number(a) || 0) - (Number(b) || 0);
  },
  concat: (...args) => {
    // Remove the options object (last argument from Handlebars)
    args.pop();
    return args.join('');
  },
  split: (str, delimiter) => {
    if (typeof str !== 'string') return [];
    return str.split(delimiter);
  },
  substring: (str, start, end, options) => {
    if (typeof str !== 'string') return '';
    // Handle Handlebars argument passing - if end is the options object, use start only
    if (end != null && typeof end === 'object' && end.fn) {
      return str.substring(Number(start) || 0);
    }
    if (end !== undefined && end !== null) {
      return str.substring(Number(start) || 0, Number(end));
    }
    return str.substring(Number(start) || 0);
  },
  markdown: (str) => {
    if (!str) return '';
    const { marked } = require('marked');
    // Configure marked for safe rendering
    marked.setOptions({
      breaks: true,
      gfm: true
    });
    return marked.parse(str);
  },
  formatDate: (date) => {
    if (!date) return '';
    try {
      const d = new Date(date);
      if (isNaN(d.getTime())) return date;
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return date;
    }
  }
};

