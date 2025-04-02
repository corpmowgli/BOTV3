/**
 * Enhanced LRU Cache Implementation
 * This implementation provides a Least Recently Used (LRU) cache with TTL (Time-To-Live) support,
 * automatic cleanup, and statistics tracking.
 */

export class LRUCache {
  /**
   * Creates a new LRU Cache instance
   * @param {number} max - Maximum number of items to store in the cache
   */
  constructor(max = 100) {
    this.cache = new Map();
    this.expirations = new Map();
    this.lastAccessed = new Map();
    this.max = max;
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.expirationCount = 0;
    this.createdAt = Date.now();
  }

  /**
   * Retrieves a value from the cache
   * @param {string} key - The key to retrieve
   * @returns {*} The value, or undefined if not found or expired
   */
  get(key) {
    // Check for expiration first
    if (this.expirations.has(key) && Date.now() > this.expirations.get(key)) {
      this.delete(key);
      this.missCount++;
      this.expirationCount++;
      return undefined;
    }

    if (!this.cache.has(key)) {
      this.missCount++;
      return undefined;
    }
    
    const value = this.cache.get(key);
    // Refresh the key (move to end of Map)
    this.cache.delete(key);
    this.cache.set(key, value);
    this.hitCount++;
    this.lastAccessed.set(key, Date.now());
    return value;
  }

  /**
   * Sets a value in the cache
   * @param {string} key - The key to set
   * @param {*} value - The value to store
   * @param {number} ttl - Time to live in milliseconds (0 for no expiration)
   * @returns {boolean} True if operation succeeded
   */
  set(key, value, ttl = 0) {
    // If key exists, remove it first
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.expirations.delete(key);
    }
    
    // Add the new value
    this.cache.set(key, value);
    this.lastAccessed.set(key, Date.now());
    
    // Set expiration if TTL is provided
    if (ttl > 0) {
      this.expirations.set(key, Date.now() + ttl);
    }
    
    // Remove the oldest entry if over capacity
    if (this.cache.size > this.max) {
      const firstKey = this.cache.keys().next().value;
      this.delete(firstKey);
      this.evictionCount++;
    }
    
    return true;
  }

  /**
   * Removes a key from the cache
   * @param {string} key - The key to delete
   * @returns {boolean} True if the key was found and deleted
   */
  delete(key) {
    const existed = this.cache.has(key);
    this.cache.delete(key);
    this.expirations.delete(key);
    this.lastAccessed.delete(key);
    return existed;
  }

  /**
   * Empties the cache completely
   */
  clear() {
    this.cache.clear();
    this.expirations.clear();
    this.lastAccessed.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    this.expirationCount = 0;
  }

  /**
   * Removes all expired entries from the cache
   * @returns {number} Number of entries cleaned up
   */
  cleanupExpired() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, expiry] of this.expirations.entries()) {
      if (now > expiry) {
        this.delete(key);
        cleanedCount++;
        this.expirationCount++;
      }
    }
    
    return cleanedCount;
  }

  /**
   * Returns cache statistics
   * @returns {Object} Object containing cache statistics
   */
  getStats() {
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? (this.hitCount / totalRequests) * 100 : 0;
    
    return { 
      size: this.cache.size,
      capacity: this.max, 
      hits: this.hitCount, 
      misses: this.missCount,
      hitRate,
      evictions: this.evictionCount,
      expirations: this.expirationCount,
      uptime: Date.now() - this.createdAt
    };
  }

  /**
   * Checks if a key exists in the cache and is not expired
   * @param {string} key - The key to check
   * @returns {boolean} True if the key exists and is not expired
   */
  has(key) {
    // Check for expiration first
    if (this.expirations.has(key) && Date.now() > this.expirations.get(key)) {
      this.delete(key);
      return false;
    }
    return this.cache.has(key);
  }

  /**
   * Gets the last accessed time for a key
   * @param {string} key - The key to check
   * @returns {number|null} The timestamp when the key was last accessed, or null if the key doesn't exist
   */
  getLastAccessed(key) {
    return this.lastAccessed.get(key) || null;
  }

  /**
   * Gets all keys in the cache
   * @returns {Array} Array of all keys in the cache
   */
  keys() {
    return Array.from(this.cache.keys());
  }

  /**
   * Gets the number of items in the cache
   * @returns {number} Number of items in the cache
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Updates the TTL for an existing key
   * @param {string} key - The key to update
   * @param {number} ttl - New TTL in milliseconds
   * @returns {boolean} True if the key existed and was updated
   */
  updateTTL(key, ttl) {
    if (!this.cache.has(key)) return false;
    
    if (ttl > 0) {
      this.expirations.set(key, Date.now() + ttl);
    } else {
      this.expirations.delete(key);
    }
    
    return true;
  }

  /**
   * Returns the remaining TTL for a key in milliseconds
   * @param {string} key - The key to check
   * @returns {number} Remaining TTL in milliseconds, 0 if no expiration, -1 if key doesn't exist
   */
  getRemainingTTL(key) {
    if (!this.cache.has(key)) return -1;
    
    if (!this.expirations.has(key)) return 0;
    
    const ttl = this.expirations.get(key) - Date.now();
    return ttl > 0 ? ttl : 0;
  }
}

/**
 * TimedCache - A simpler cache with automatic expiration but no LRU functionality
 */
export class TimedCache {
  constructor() {
    this.cache = new Map();
    this.expirations = new Map();
  }

  set(key, value, ttl = 60000) {
    this.cache.set(key, value);
    
    if (ttl > 0) {
      const expiry = Date.now() + ttl;
      this.expirations.set(key, expiry);
      
      // Schedule cleanup
      setTimeout(() => {
        if (this.expirations.get(key) <= Date.now()) {
          this.delete(key);
        }
      }, ttl);
    }
    
    return this;
  }

  get(key) {
    if (this.expirations.has(key) && this.expirations.get(key) <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    
    return this.cache.get(key);
  }

  has(key) {
    if (this.expirations.has(key) && this.expirations.get(key) <= Date.now()) {
      this.delete(key);
      return false;
    }
    
    return this.cache.has(key);
  }

  delete(key) {
    this.cache.delete(key);
    this.expirations.delete(key);
    return this;
  }

  clear() {
    this.cache.clear();
    this.expirations.clear();
    return this;
  }
}

export default LRUCache;