// utils/helpers.js
/**
 * Collection of helper functions for the trading bot
 */

/**
 * Introduces a delay in the execution flow
 * @param {number} ms - Number of milliseconds to delay
 * @returns {Promise} A promise that resolves after the specified delay
 */
export const delay = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Formats a number as currency
 * @param {number} amount - The amount to format
 * @param {string} currency - The currency code (default: 'USD')
 * @returns {string} Formatted currency string
 */
export const formatCurrency = (amount, currency = 'USD') => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(amount);
};

/**
 * Formats a percentage value
 * @param {number} value - The percentage value to format
 * @param {number} decimals - Number of decimal places (default: 2)
 * @returns {string} Formatted percentage string
 */
export const formatPercentage = (value, decimals = 2) => {
  return `${value.toFixed(decimals)}%`;
};

/**
 * Truncates a string in the middle and adds ellipsis
 * @param {string} str - The string to truncate
 * @param {number} startChars - Number of characters to keep at the start
 * @param {number} endChars - Number of characters to keep at the end
 * @returns {string} Truncated string
 */
export const truncateMiddle = (str, startChars = 6, endChars = 4) => {
  if (str.length <= startChars + endChars) {
    return str;
  }
  return `${str.substring(0, startChars)}...${str.substring(str.length - endChars)}`;
};

/**
 * Debounces a function call
 * @param {Function} func - The function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

/**
 * Throttles a function call
 * @param {Function} func - The function to throttle
 * @param {number} limit - Limit in milliseconds
 * @returns {Function} Throttled function
 */
export const throttle = (func, limit) => {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};

/**
 * Creates a deep clone of an object
 * @param {Object} obj - The object to clone
 * @returns {Object} Cloned object
 */
export const deepClone = (obj) => {
  return JSON.parse(JSON.stringify(obj));
};

/**
 * Calculates the time difference between two timestamps
 * @param {number} start - Start timestamp
 * @param {number} end - End timestamp
 * @returns {Object} Object containing days, hours, minutes, seconds
 */
export const getTimeDifference = (start, end) => {
  const diff = Math.abs(end - start);
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((diff % (60 * 1000)) / 1000);
  
  return { days, hours, minutes, seconds };
};

/**
 * Checks if a value is within a specified range
 * @param {number} value - The value to check
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {boolean} True if within range
 */
export const isInRange = (value, min, max) => {
  return value >= min && value <= max;
};

/**
 * Retries a function execution with exponential backoff
 * @param {Function} fn - Function to execute
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {Promise} Result of the function execution
 */
export const retry = async (fn, maxRetries = 3, baseDelay = 1000) => {
  let retries = 0;
  
  const execute = async () => {
    try {
      return await fn();
    } catch (error) {
      if (retries >= maxRetries) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, retries);
      retries++;
      await new Promise(resolve => setTimeout(resolve, delay));
      return execute();
    }
  };
  
  return execute();
};
