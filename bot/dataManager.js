import { LRUCache } from '../utils/cache.js';

export class DataManager {
  constructor(config, marketDataService) {
    this.config = config;
    this.marketData = marketDataService;
    
    // Optimized caching strategy with appropriate TTLs
    this.priceDataCache = new LRUCache(500);  // Increased size for more price caching
    this.historicalDataCache = new LRUCache(200); // Doubled for better performance
    this.indicatorCache = new LRUCache(300);
    this.tokenInfoCache = new LRUCache(200);
    
    // Statistics tracking
    this.stats = {
      requestsCount: 0, 
      cacheHits: 0, 
      cacheMisses: 0, 
      processingTimes: [],
      averageProcessingTime: 0, 
      errors: [], 
      lastUpdate: Date.now(),
      lastRequestTime: {},
      consecutiveFailures: {},
      backoffStatus: {}
    };
    
    // Preloading queue for eager data fetching
    this.preloadQueue = [];
    this.preloadBackgroundQueue = [];
    this.isPreloading = false;
    this._cleanupInProgress = false;
    
    // Setup periodic cache cleanup
    this._scheduleCacheCleanup();
    
    // Setup API health monitoring
    this._setupApiHealthMonitoring();
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    // Update cache settings if needed
    if (newConfig.performance?.cacheSettings) {
      if (newConfig.performance.cacheSettings.pricesTTL) 
        this.priceCacheTTL = newConfig.performance.cacheSettings.pricesTTL;
      if (newConfig.performance.cacheSettings.historicalTTL) 
        this.historicalCacheTTL = newConfig.performance.cacheSettings.historicalTTL;
      if (newConfig.performance.cacheSettings.tokenInfoTTL) 
        this.tokenInfoTTL = newConfig.performance.cacheSettings.tokenInfoTTL;
    }
  }

  _setupApiHealthMonitoring() {
    // Monitor API health and adjust request strategy accordingly
    this.apiHealthStatus = {
      isHealthy: true,
      lastCheck: Date.now(),
      successRate: 100,
      averageLatency: 0,
      degradedSince: null,
      backoffLevel: 0
    };
    
    // Check API health every 5 minutes
    setInterval(() => this._checkApiHealth(), 5 * 60 * 1000);
  }

  _checkApiHealth() {
    const totalRequests = this.stats.requestsCount;
    const failedRequests = this.stats.errors.length;
    const successRate = totalRequests > 0 ? ((totalRequests - failedRequests) / totalRequests) * 100 : 100;
    
    const now = Date.now();
    const previousStatus = this.apiHealthStatus.isHealthy;
    
    // Update health metrics
    this.apiHealthStatus.lastCheck = now;
    this.apiHealthStatus.successRate = successRate;
    this.apiHealthStatus.averageLatency = this.stats.averageProcessingTime;
    
    // Determine if API is healthy
    if (successRate < 80 || this.stats.averageProcessingTime > 2000) {
      this.apiHealthStatus.isHealthy = false;
      if (previousStatus) { // Just became unhealthy
        this.apiHealthStatus.degradedSince = now;
        this.apiHealthStatus.backoffLevel = 1;
        console.warn('API health degraded - enabling conservative request strategy');
      } else {
        // Already unhealthy, potentially increase backoff
        const degradedDuration = now - this.apiHealthStatus.degradedSince;
        if (degradedDuration > 15 * 60 * 1000) {
          this.apiHealthStatus.backoffLevel = Math.min(this.apiHealthStatus.backoffLevel + 1, 3);
          console.warn(`API continues to be unhealthy - increasing backoff to level ${this.apiHealthStatus.backoffLevel}`);
        }
      }
    } else if (!previousStatus && successRate > 95) {
      // Recovery
      this.apiHealthStatus.isHealthy = true;
      this.apiHealthStatus.degradedSince = null;
      this.apiHealthStatus.backoffLevel = 0;
      console.log('API health restored - resuming normal request strategy');
    }
  }

  async getBatchTokenPrices(tokenMints) {
    if (!tokenMints?.length) return {};
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Result object to store all prices
    const result = {};
    
    // Check cache first for all tokens
    const tokensToFetch = [];
    for (const mint of tokenMints) {
      if (!mint) continue; // Skip invalid tokens
      
      const cachedPrice = this.priceDataCache.get(`price_${mint}`);
      if (cachedPrice !== undefined) {
        result[mint] = cachedPrice;
        this.stats.cacheHits++;
      } else {
        tokensToFetch.push(mint);
        this.stats.cacheMisses++;
      }
    }
    
    // Return early if all prices were cached
    if (!tokensToFetch.length) {
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    }
    
    try {
      // Apply API health-aware request strategy
      if (!this.apiHealthStatus.isHealthy) {
        // Reduce batch size when API is unhealthy
        const maxBatchSize = [50, 30, 20, 10][this.apiHealthStatus.backoffLevel];
        
        // Process tokens in smaller batches
        for (let i = 0; i < tokensToFetch.length; i += maxBatchSize) {
          const batch = tokensToFetch.slice(i, i + maxBatchSize);
          await this._fetchPriceBatch(batch, result);
          
          // Add delay between batches if backoff level is high
          if (i + maxBatchSize < tokensToFetch.length && this.apiHealthStatus.backoffLevel > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000 * this.apiHealthStatus.backoffLevel));
          }
        }
      } else {
        // Normal operation - fetch all in one request if possible
        await this._fetchPriceBatch(tokensToFetch, result);
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._recordError('getBatchTokenPrices', error);
      return result;
    }
  }
  
  async _fetchPriceBatch(tokenBatch, resultObject) {
    try {
      const prices = await this.marketData.getBatchTokenPrices(tokenBatch);
      
      // Handle both object and Map returns
      if (prices instanceof Map) {
        prices.forEach((price, token) => {
          if (price !== undefined && price !== null) {
            resultObject[token] = price;
            this.priceDataCache.set(`price_${token}`, price, 60000);
          }
        });
      } else if (typeof prices === 'object') {
        Object.entries(prices).forEach(([token, price]) => {
          if (price !== undefined && price !== null) {
            resultObject[token] = price;
            this.priceDataCache.set(`price_${token}`, price, 60000);
          }
        });
      }
    } catch (error) {
      this._recordError('_fetchPriceBatch', error);
      throw error;
    }
  }

  async getTokenPrice(tokenMint) {
    if (!tokenMint) return null;
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Check cache first
    const cachedPrice = this.priceDataCache.get(`price_${tokenMint}`);
    if (cachedPrice !== undefined) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedPrice;
    }
    this.stats.cacheMisses++;
    
    // Apply per-token backoff strategy
    if (this._shouldBackoff(tokenMint)) {
      this._recordError('getTokenPrice', new Error(`Rate limiting applied for ${tokenMint}`));
      return null;
    }
    
    try {
      const price = await this.marketData.getTokenPrice(tokenMint);
      if (price != null) {
        this.priceDataCache.set(`price_${tokenMint}`, price, 60000);
        this._resetFailureCount(tokenMint);
      }
      this._recordProcessingTime(Date.now() - startTime);
      return price;
    } catch (error) {
      this._incrementFailureCount(tokenMint);
      this._recordError('getTokenPrice', error);
      return null;
    }
  }

  async getHistoricalData(tokenMint, interval = '1h', days = 7) {
    if (!tokenMint) return { prices: [], volumes: [], timestamps: [] };
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = `history_${tokenMint}_${interval}_${days}`;
    const cachedData = this.historicalDataCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    this.stats.cacheMisses++;
    
    // Apply per-token backoff strategy
    if (this._shouldBackoff(tokenMint)) {
      this._recordError('getHistoricalData', new Error(`Rate limiting applied for ${tokenMint}`));
      return { prices: [], volumes: [], timestamps: [] };
    }
    
    try {
      const endTime = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      // Call getHistoricalPrices on marketData with appropriate parameters
      const data = await this.marketData.getHistoricalPrices(
        tokenMint, startDate.getTime(), endTime.getTime(), interval
      );
      
      // Ensure we return a consistent structure
      const result = {
        prices: data?.prices || [],
        volumes: data?.volumes || [],
        timestamps: data?.timestamps || []
      };
      
      // Cache if we got valid results
      if (result.prices.length > 0) {
        // Longer TTL for historical data since it changes less frequently
        this.historicalDataCache.set(cacheKey, result, 1800000);
        this._resetFailureCount(tokenMint);
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._incrementFailureCount(tokenMint);
      this._recordError('getHistoricalData', error);
      return { prices: [], volumes: [], timestamps: [] };
    }
  }

  async getTokenData(tokenMint) {
    if (!tokenMint) return null;
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cachedData = this.tokenInfoCache.get(`info_${tokenMint}`);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    this.stats.cacheMisses++;
    
    // Apply per-token backoff strategy
    if (this._shouldBackoff(tokenMint)) {
      this._recordError('getTokenData', new Error(`Rate limiting applied for ${tokenMint}`));
      return null;
    }
    
    try {
      const data = await this.marketData.aggregateTokenData(tokenMint);
      if (data) {
        this.tokenInfoCache.set(`info_${tokenMint}`, data, 300000);
        this._resetFailureCount(tokenMint);
      }
      this._recordProcessingTime(Date.now() - startTime);
      return data;
    } catch (error) {
      this._incrementFailureCount(tokenMint);
      this._recordError('getTokenData', error);
      return null;
    }
  }

  async getTopTokens(limit = 20, minLiquidity = null, minVolume = null) {
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Use config values if not explicitly provided
    const actualMinLiquidity = minLiquidity || this.config.trading?.minLiquidity;
    const actualMinVolume = minVolume || this.config.trading?.minVolume24h;
    
    const cacheKey = `top_tokens_${limit}_${actualMinLiquidity}_${actualMinVolume}`;
    const cachedData = this.tokenInfoCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      
      // Schedule background refresh if cache is getting old (over 3 minutes)
      const cacheAge = Date.now() - this.tokenInfoCache.getLastAccessed(cacheKey);
      if (cacheAge > 180000) {
        this._scheduleBackgroundRefresh('topTokens', { limit, minLiquidity: actualMinLiquidity, minVolume: actualMinVolume });
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    this.stats.cacheMisses++;
    
    try {
      // Request more tokens than needed to account for filtering
      const fetchLimit = Math.min(limit * 2, 100);
      const data = await this.marketData.getTopTokens(fetchLimit, actualMinLiquidity, actualMinVolume);
      
      if (data?.length > 0) {
        // Filter and limit the results
        const filteredTokens = data.filter(token => 
          parseFloat(token.liquidity || 0) >= actualMinLiquidity && 
          parseFloat(token.volume24h || 0) >= actualMinVolume
        ).slice(0, limit);
        
        // Enhance token data with additional context
        const enhancedTokens = await this.enrichTokenData(filteredTokens);
        
        // Cache with reasonable TTL
        this.tokenInfoCache.set(cacheKey, enhancedTokens, 300000);
        this._recordProcessingTime(Date.now() - startTime);
        return enhancedTokens;
      }
      this._recordProcessingTime(Date.now() - startTime);
      return data || [];
    } catch (error) {
      this._recordError('getTopTokens', error);
      return [];
    }
  }

  async enrichTokenData(tokens) {
    try {
      // Fetch additional data for tokens in parallel
      const enhancedTokens = await Promise.all(tokens.map(async (token) => {
        try {
          // Try to get cached additional data
          const cachedInfo = this.tokenInfoCache.get(`enhanced_${token.token_mint || token.mint}`);
          if (cachedInfo) return { ...token, ...cachedInfo };
          
          // Prepare additional information
          let additionalInfo = {
            ecosystem: 'solana',
            tokenAge: this.estimateTokenAge(token.apy, token.volume24h)
          };
          
          // Try to get token supply information if available
          try {
            const supplyResponse = await this.marketData.getTokenSupply(token.token_mint || token.mint);
            if (supplyResponse && supplyResponse.value) {
              additionalInfo.supply = supplyResponse.value;
              additionalInfo.marketCap = supplyResponse.value * token.price;
            }
          } catch (err) {
            // Silently handle missing supply info
          }
          
          // Calculate volatility if possible
          if (token.priceHistory && token.priceHistory.length >= 24) {
            additionalInfo.volatility = this.calculateVolatility(token.priceHistory);
          }
          
          // Cache the additional info
          this.tokenInfoCache.set(`enhanced_${token.token_mint || token.mint}`, additionalInfo, 3600000);
          
          return { ...token, ...additionalInfo };
        } catch (error) {
          // If enhancement fails, return original token
          return token;
        }
      }));
      
      return enhancedTokens;
    } catch (error) {
      console.warn('Error enriching token data:', error.message);
      return tokens; // Return original tokens if enhancement fails
    }
  }

  calculateVolatility(priceHistory) {
    if (!priceHistory || priceHistory.length < 10) return 'medium';
    
    try {
      // Calculate price changes
      const changes = [];
      for (let i = 1; i < priceHistory.length; i++) {
        const change = Math.abs((priceHistory[i] - priceHistory[i-1]) / priceHistory[i-1] * 100);
        changes.push(change);
      }
      
      // Calculate average change
      const avgChange = changes.reduce((sum, change) => sum + change, 0) / changes.length;
      
      // Determine volatility category
      if (avgChange < 1.5) return 'low';
      if (avgChange > 5) return 'high';
      return 'medium';
    } catch (e) {
      return 'medium'; // Default if calculation fails
    }
  }

  estimateTokenAge(apy, volume24h) {
    if (!apy || !volume24h) return null;
    const apyFloat = parseFloat(apy);
    const volume = parseFloat(volume24h);
    
    // Heuristic for estimating token age based on APY and volume
    if (apyFloat > 1000 && volume < 100000) return 7; // Very new token
    else if (apyFloat > 500 && volume < 500000) return 14; // New token
    else if (apyFloat > 100 && volume < 1000000) return 30; // Moderately new token
    else return 90; // Established token
  }

  async aggregateTokenData(tokenMint) {
    const cacheKey = `aggregated_${tokenMint}`;
    const cachedData = this.tokenInfoCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      return cachedData;
    }
    this.stats.cacheMisses++;
    
    try {
      // Fetch price and token info in parallel
      const [price, tokenInfo] = await Promise.all([
        this.getTokenPrice(tokenMint).catch(() => null),
        this.getTokenInfo(tokenMint).catch(() => ({}))
      ]);
      
      const aggregated = {
        token: tokenMint,
        price: price || tokenInfo.price || 0,
        liquidity: tokenInfo.liquidity || 0,
        volume24h: tokenInfo.volume24h || 0,
        priceChange24h: tokenInfo.priceChange24h || 0,
        marketCap: tokenInfo.marketCap || 0,
        ecosystem: 'solana',
        timestamp: Date.now()
      };
      
      this.tokenInfoCache.set(cacheKey, aggregated, 60000);
      return aggregated;
    } catch (error) {
      this._recordError('aggregateTokenData', error);
      return {
        token: tokenMint,
        price: null,
        liquidity: 0,
        volume24h: 0,
        priceChange24h: 0,
        error: error.message
      };
    }
  }

  async getTokenInfo(tokenMint) {
    const cacheKey = `info_${tokenMint}`;
    const cachedInfo = this.tokenInfoCache.get(cacheKey);
    if (cachedInfo) {
      this.stats.cacheHits++;
      return cachedInfo;
    }
    this.stats.cacheMisses++;
    
    // Apply backoff if needed
    if (this._shouldBackoff(tokenMint)) {
      this._recordError('getTokenInfo', new Error(`Rate limiting applied for ${tokenMint}`));
      return null;
    }
    
    try {
      const response = await this.marketData.getTokenInfo(tokenMint);
      if (response.data) {
        this.tokenInfoCache.set(cacheKey, response.data, 300000);
        this._resetFailureCount(tokenMint);
        return response.data;
      }
      throw new Error(`No data available for ${tokenMint}`);
    } catch (error) {
      this._incrementFailureCount(tokenMint);
      this._recordError('getTokenInfo', error);
      throw error;
    }
  }

  async getSolanaHealth() {
    const cacheKey = 'solana_health';
    const cachedHealth = this.tokenInfoCache.get(cacheKey);
    if (cachedHealth) {
      this.stats.cacheHits++;
      return cachedHealth;
    }
    this.stats.cacheMisses++;
    
    try {
      const health = await this.marketData.getSolanaHealth();
      if (health) {
        this.tokenInfoCache.set(cacheKey, health, 300000);
      }
      return health;
    } catch (error) {
      this._recordError('getSolanaHealth', error);
      return {
        reliability: 'unknown',
        tps: 0,
        marketTrend: 'neutral',
        timestamp: Date.now(),
        error: error.message
      };
    }
  }

  async preloadData(tokenMints) {
    if (!tokenMints?.length) return;
    
    // Filter out duplicates and prioritize tokens
    this.preloadQueue = [
      ...new Set([
        ...tokenMints.filter(mint => !this.preloadQueue.includes(mint)),
        ...this.preloadQueue
      ])
    ].slice(0, 100); // Limit queue size
    
    if (!this.isPreloading) {
      this._startPreloading();
    }
  }

  async _startPreloading() {
    if (this.isPreloading || !this.preloadQueue.length) return;
    this.isPreloading = true;
    console.log(`Starting preload for ${this.preloadQueue.length} tokens`);
    
    // Adaptive concurrency based on API health
    const concurrentBatches = this.apiHealthStatus.isHealthy ? 3 : 1;
    
    const processNextBatch = async () => {
      if (!this.preloadQueue.length) {
        this.isPreloading = false;
        return;
      }
      
      const tokensToProcess = this.preloadQueue.splice(0, concurrentBatches);
      const promiseMap = tokensToProcess.map(async (token) => {
        try {
          if (!token) return; // Skip invalid tokens
          
          // First get current price (highest priority)
          await this.getTokenPrice(token);
          
          // Stagger historical data and token info requests
          setTimeout(() => {
            this.getHistoricalData(token)
              .catch(err => console.warn(`Error preloading history for ${token}: ${err.message}`));
          }, 500);
          
          setTimeout(() => {
            this.getTokenData(token)
              .catch(err => console.warn(`Error preloading info for ${token}: ${err.message}`));
          }, 1000);
          
        } catch (err) {
          console.warn(`Error preloading data for ${token}: ${err.message}`);
        }
      });
      
      await Promise.allSettled(promiseMap);
      
      // Adaptive delay between batches based on API health
      const delay = this.apiHealthStatus.isHealthy ? 2000 : 5000;
      setTimeout(processNextBatch, delay);
    };
    
    processNextBatch();
  }

  _scheduleBackgroundRefresh(type, params) {
    const cacheKey = `${type}_${JSON.stringify(params)}`;
    
    // Avoid duplicate refreshes
    if (this.preloadBackgroundQueue.some(item => item.key === cacheKey)) {
      return;
    }
    
    this.preloadBackgroundQueue.push({
      key: cacheKey,
      type,
      params,
      timestamp: Date.now()
    });
    
    // Start background refresh process if not already running
    if (!this._backgroundRefreshInProgress) {
      this._processBackgroundRefreshes();
    }
  }

  async _processBackgroundRefreshes() {
    if (this._backgroundRefreshInProgress || this.preloadBackgroundQueue.length === 0) {
      return;
    }
    
    this._backgroundRefreshInProgress = true;
    
    const item = this.preloadBackgroundQueue.shift();
    
    try {
      switch (item.type) {
        case 'topTokens':
          await this.getTopTokens(
            item.params.limit, 
            item.params.minLiquidity, 
            item.params.minVolume
          );
          break;
        case 'tokenPrice':
          await this.getTokenPrice(item.params.token);
          break;
        case 'historicalData':
          await this.getHistoricalData(
            item.params.token,
            item.params.interval,
            item.params.days
          );
          break;
        default:
          console.warn(`Unknown background refresh type: ${item.type}`);
      }
    } catch (error) {
      console.warn(`Background refresh failed for ${item.type}:`, error.message);
    }
    
    this._backgroundRefreshInProgress = false;
    
    // Continue with next item after a delay
    if (this.preloadBackgroundQueue.length > 0) {
      setTimeout(() => this._processBackgroundRefreshes(), 2000);
    }
  }

  _shouldBackoff(token) {
    const failures = this.stats.consecutiveFailures[token] || 0;
    if (failures === 0) return false;
    
    const backoffStatus = this.stats.backoffStatus[token];
    if (!backoffStatus) return false;
    
    // Check if we're still in backoff period
    if (Date.now() < backoffStatus.until) {
      return true;
    }
    
    // Backoff period has expired
    delete this.stats.backoffStatus[token];
    return false;
  }

  _incrementFailureCount(token) {
    if (!token) return;
    
    const currentFailures = this.stats.consecutiveFailures[token] || 0;
    this.stats.consecutiveFailures[token] = currentFailures + 1;
    
    // Apply exponential backoff when failures occur
    if (currentFailures + 1 >= 3) {
      const backoffTime = Math.min(60000 * Math.pow(2, currentFailures - 2), 3600000);
      this.stats.backoffStatus[token] = {
        until: Date.now() + backoffTime,
        level: currentFailures - 1
      };
      
      console.warn(`Applied backoff for ${token} - ${backoffTime}ms (level ${currentFailures - 1})`);
    }
  }

  _resetFailureCount(token) {
    if (!token) return;
    
    if (this.stats.consecutiveFailures[token]) {
      delete this.stats.consecutiveFailures[token];
    }
    
    if (this.stats.backoffStatus[token]) {
      delete this.stats.backoffStatus[token];
    }
  }

  _recordProcessingTime(time) {
    this.stats.processingTimes.push(time);
    if (this.stats.processingTimes.length > 100) {
      this.stats.processingTimes.shift();
    }
    this.stats.averageProcessingTime = this.stats.processingTimes.reduce((a, b) => a + b, 0) / 
                                      this.stats.processingTimes.length;
  }

  _recordError(operation, error) {
    if (this.stats.errors.length >= 50) {
      this.stats.errors.shift();
    }
    this.stats.errors.push({
      operation,
      message: error.message,
      timestamp: Date.now()
    });
    console.error(`DataManager error [${operation}]:`, error.message);
  }

  _scheduleCacheCleanup() {
    this._cleanupInterval = setInterval(() => {
      try {
        if (this._cleanupInProgress) return;
        this._cleanupInProgress = true;
        
        this.priceDataCache.cleanupExpired();
        this.historicalDataCache.cleanupExpired();
        this.indicatorCache.cleanupExpired();
        this.tokenInfoCache.cleanupExpired();
        
        this._cleanupInProgress = false;
      } catch (error) {
        this._cleanupInProgress = false;
        console.error('Error cleaning caches:', error);
      }
    }, 15 * 60 * 1000);
  }

  clearCaches() {
    this.priceDataCache.clear();
    this.historicalDataCache.clear();
    this.indicatorCache.clear();
    this.tokenInfoCache.clear();
    console.log('All caches cleared');
  }

  getStats() {
    return {
      ...this.stats,
      cacheSizes: {
        price: this.priceDataCache.getStats().size,
        historical: this.historicalDataCache.getStats().size,
        indicators: this.indicatorCache.getStats().size,
        tokenInfo: this.tokenInfoCache.getStats().size
      },
      cacheHitRate: this.getCacheHitRate(),
      preloadQueueSize: this.preloadQueue.length,
      isPreloading: this.isPreloading,
      apiHealth: this.apiHealthStatus,
      backoffTokens: Object.keys(this.stats.backoffStatus).length
    };
  }

  getCacheHitRate() {
    const totalRequests = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate = totalRequests > 0 ? (this.stats.cacheHits / totalRequests) * 100 : 0;
    return hitRate.toFixed(2) + '%';
  }
  
  cleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    
    this.clearCaches();
  }
}