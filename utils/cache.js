export class LRUCache {
  constructor(max = 100) {
    this.cache = new Map();
    this.expirations = new Map();
    this.max = max;
    this.hitCount = 0;
    this.missCount = 0;
  }

  get(key) {
    // Check for expiration first
    if (this.expirations.has(key) && Date.now() > this.expirations.get(key)) {
      this.delete(key);
      this.missCount++;
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
    return value;
  }

  set(key, value, ttl = 0) {
    // If key exists, remove it first
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.expirations.delete(key);
    }
    
    // Add the new value
    this.cache.set(key, value);
    
    // Set expiration if TTL is provided
    if (ttl > 0) {
      this.expirations.set(key, Date.now() + ttl);
    }
    
    // Remove the oldest entry if over capacity
    if (this.cache.size > this.max) {
      const firstKey = this.cache.keys().next().value;
      this.delete(firstKey);
    }
  }

  delete(key) {
    this.cache.delete(key);
    this.expirations.delete(key);
  }

  clear() {
    this.cache.clear();
    this.expirations.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [key, expiry] of this.expirations.entries()) {
      if (now > expiry) {
        this.delete(key);
      }
    }
  }

  getStats() {
    const totalRequests = this.hitCount + this.missCount;
    const hitRate = totalRequests > 0 ? (this.hitCount / totalRequests) * 100 : 0;
    
    return { 
      size: this.cache.size, 
      hits: this.hitCount, 
      misses: this.missCount,
      hitRate
    };
  }
}

export default LRUCache;