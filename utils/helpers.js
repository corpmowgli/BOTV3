export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const formatCurrency = (amount, currency = 'USD') => new Intl.NumberFormat('en-US', {style:'currency',currency}).format(amount);

export const formatPercentage = (value, decimals = 2) => `${value.toFixed(decimals)}%`;

export const truncateMiddle = (str, startChars = 6, endChars = 4) => str.length <= startChars + endChars ? str : `${str.substring(0, startChars)}...${str.substring(str.length - endChars)}`;

export const debounce = (func, wait) => {
  let timeout;
  return function(...args) {
    const later = () => {clearTimeout(timeout);func(...args);};
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

export const throttle = (func, limit) => {
  let inThrottle;
  return function(...args) {
    if(!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};

export const deepClone = obj => JSON.parse(JSON.stringify(obj));

export const getTimeDifference = (start, end) => {
  const diff = Math.abs(end - start);
  const days = Math.floor(diff / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  const seconds = Math.floor((diff % (60 * 1000)) / 1000);
  return {days, hours, minutes, seconds};
};

export const isInRange = (value, min, max) => value >= min && value <= max;

export const retry = async (fn, maxRetries = 3, baseDelay = 1000, onRetryCallback = null) => {
  let retries = 0;
  const execute = async () => {
    try {
      return await fn();
    } catch (error) {
      if(retries >= maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, retries);
      retries++;
      
      if (typeof onRetryCallback === 'function') {
        onRetryCallback(retries, delay, error);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return execute();
    }
  };
  return execute();
};

export function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function formatTimestamp(timestamp, includeTime = true) {
  const date = new Date(timestamp);
  if (includeTime) return date.toISOString();
  return date.toISOString().split('T')[0];
}

export function calculateMaxDrawdown(balanceHistory) {
  let peak = balanceHistory[0];
  let maxDrawdown = 0;
  for (const value of balanceHistory) {
    if (value > peak) peak = value;
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown * 100;
}

export function daysBetween(date1, date2) {
  const diff = Math.abs(date2 - date1);
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}