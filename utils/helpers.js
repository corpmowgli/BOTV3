export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Added missing functions
export const generateUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

export const formatTimestamp = (timestamp, includeTime = true) => {
  const date = new Date(timestamp);
  if (!includeTime) {
    return date.toISOString().split('T')[0];
  }
  return date.toLocaleString();
};

export const calculateMaxDrawdown = (balanceHistory) => {
  let maxDrawdown = 0;
  let peak = balanceHistory[0] || 0;
  
  for (const balance of balanceHistory) {
    if (balance > peak) {
      peak = balance;
    } else if (peak > 0) {
      const drawdown = (peak - balance) / peak * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
  }
  
  return maxDrawdown;
};

export const daysBetween = (date1, date2) => {
  const oneDay = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
  const firstDate = new Date(date1);
  const secondDate = new Date(date2);
  const diffDays = Math.round(Math.abs((firstDate - secondDate) / oneDay));
  return diffDays;
};