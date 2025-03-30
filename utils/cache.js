export class LRUCache {
  constructor(capacity = 100) {
    this.capacity = capacity;
    this.cache = new Map();
    this.expiryTimes = new Map();
    this.stats = {hits:0,misses:0,sets:0,deletes:0,clears:0,expirations:0};
  }

  get(key) {
    if(!this.cache.has(key)) {this.stats.misses++;return undefined;}
    const expiryTime = this.expiryTimes.get(key);
    if(expiryTime && Date.now() > expiryTime) {
      this.delete(key);
      this.stats.misses++;
      this.stats.expirations++;
      return undefined;
    }
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    this.stats.hits++;
    return value;
  }

  set(key, value, ttl = 0) {
    if(this.cache.has(key)) {
      this.cache.delete(key);
      this.expiryTimes.delete(key);
    } else if(this.cache.size >= this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.expiryTimes.delete(oldestKey);
    }
    this.cache.set(key, value);
    if(ttl > 0) this.expiryTimes.set(key, Date.now() + ttl);
    this.stats.sets++;
    return this;
  }

  delete(key) {
    if(this.cache.has(key)) {
      this.cache.delete(key);
      this.expiryTimes.delete(key);
      this.stats.deletes++;
      return true;
    }
    return false;
  }

  has(key) {
    if(!this.cache.has(key)) return false;
    const expiryTime = this.expiryTimes.get(key);
    if(expiryTime && Date.now() > expiryTime) {
      this.delete(key);
      this.stats.expirations++;
      return false;
    }
    return true;
  }

  clear() {
    this.cache.clear();
    this.expiryTimes.clear();
    this.stats.clears++;
  }

  cleanupExpired() {
    const now = Date.now();
    let count = 0;
    for(const [key, expiryTime] of this.expiryTimes.entries()) {
      if(expiryTime && now > expiryTime) {
        this.delete(key);
        count++;
      }
    }
    this.stats.expirations += count;
    return count;
  }

  size() {
    return this.cache.size;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      capacity: this.capacity,
      hitRate: this.stats.hits+this.stats.misses>0?
        (this.stats.hits/(this.stats.hits+this.stats.misses))*100:0
    };
  }
}

export default LRUCache;