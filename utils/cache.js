export class LRUCache {
  constructor(max = 100) {
    this.cache = new Map();
    this.max = max;
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key);
    // refresh the key
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value, ttl = 0) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, value);
    // Remove the oldest entry if over capacity
    if (this.cache.size > this.max) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  delete(key) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  cleanupExpired() {
    // No TTL handling implemented here – add if necessary.
  }

  getStats() {
    return { size: this.cache.size };
  }
}

export default LRUCache;