import { LRUCache } from '../utils/cache.js';

export class DataManager {
  constructor(config, marketDataService) {
    this.config = config;
    this.marketData = marketDataService;
    this.priceDataCache = new LRUCache(200);
    this.historicalDataCache = new LRUCache(100);
    this.indicatorCache = new LRUCache(300);
    this.tokenInfoCache = new LRUCache(150);
    this.stats = {
      requestsCount: 0, cacheHits: 0, cacheMisses: 0, processingTimes: [],
      averageProcessingTime: 0, errors: [], lastUpdate: Date.now()
    };
    this.preloadQueue = [];
    this.isPreloading = false;
    this._cleanupInProgress = false;
    this._scheduleCacheCleanup();
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  async getBatchTokenPrices(tokenMints) {
    if (!tokenMints?.length) return {};
    const startTime = Date.now();
    this.stats.requestsCount++;
    const result = {};
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
    if (!tokensToFetch.length) {
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    }
    try {
      const prices = await this.marketData.getBatchTokenPrices(tokensToFetch);
      
      // Handle both object and Map returns
      if (prices instanceof Map) {
        prices.forEach((price, token) => {
          if (price !== undefined && price !== null) {
            result[token] = price;
            this.priceDataCache.set(`price_${token}`, price, 60000);
          }
        });
      } else if (typeof prices === 'object') {
        Object.entries(prices).forEach(([token, price]) => {
          if (price !== undefined && price !== null) {
            result[token] = price;
            this.priceDataCache.set(`price_${token}`, price, 60000);
          }
        });
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._recordError('getBatchTokenPrices', error);
      return result;
    }
  }

  async getTokenPrice(tokenMint) {
    if (!tokenMint) return null;
    const startTime = Date.now();
    this.stats.requestsCount++;
    const cachedPrice = this.priceDataCache.get(`price_${tokenMint}`);
    if (cachedPrice !== undefined) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedPrice;
    }
    this.stats.cacheMisses++;
    try {
      const price = await this.marketData.getTokenPrice(tokenMint);
      if (price != null) this.priceDataCache.set(`price_${tokenMint}`, price, 60000);
      this._recordProcessingTime(Date.now() - startTime);
      return price;
    } catch (error) {
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
    try {
      const endTime = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      // Use marketData.getHistoricalPrices but ensure proper data structure
      const data = await this.marketData.getHistoricalPrices(
        tokenMint, startDate.getTime(), endTime.getTime(), interval
      );
      
      // Ensure we return a consistent structure
      const result = {
        prices: data?.prices || [],
        volumes: data?.volumes || [],
        timestamps: data?.timestamps || []
      };
      
      if (result.prices.length > 0) {
        this.historicalDataCache.set(cacheKey, result, 1800000);
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
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
    try {
      const data = await this.marketData.aggregateTokenData(tokenMint);
      if (data) this.tokenInfoCache.set(`info_${tokenMint}`, data, 300000);
      this._recordProcessingTime(Date.now() - startTime);
      return data;
    } catch (error) {
      this._recordError('getTokenData', error);
      return null;
    }
  }

  async getTopTokens(limit = 20) {
    const startTime = Date.now();
    this.stats.requestsCount++;
    const cacheKey = `top_tokens_${limit}`;
    const cachedData = this.tokenInfoCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    this.stats.cacheMisses++;
    try {
      const minLiquidity = this.config.trading?.minLiquidity;
      const minVolume = this.config.trading?.minVolume24h;
      const data = await this.marketData.getTopTokens(limit, minLiquidity, minVolume);
      if (data?.length > 0) {
        this.tokenInfoCache.set(cacheKey, data, 300000);
      }
      this._recordProcessingTime(Date.now() - startTime);
      return data || [];
    } catch (error) {
      this._recordError('getTopTokens', error);
      return [];
    }
  }

  async getIndicators(tokenMint, interval = '1h', days = 7) {
    if (!tokenMint) return null;
    const startTime = Date.now();
    this.stats.requestsCount++;
    const cacheKey = `indicators_${tokenMint}_${interval}_${days}`;
    const cachedData = this.indicatorCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    this.stats.cacheMisses++;
    try {
      const historicalData = await this.getHistoricalData(tokenMint, interval, days);
      if (!historicalData?.prices?.length) {
        throw new Error('Données historiques insuffisantes pour calculer les indicateurs');
      }
      const result = {
        token: tokenMint,
        interval,
        days,
        data: historicalData,
        timestamp: Date.now()
      };
      this.indicatorCache.set(cacheKey, result, 900000);
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._recordError('getIndicators', error);
      return null;
    }
  }

  async getSolanaHealth() {
    const startTime = Date.now();
    this.stats.requestsCount++;
    const cacheKey = 'solana_health';
    const cachedData = this.tokenInfoCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    this.stats.cacheMisses++;
    try {
      const health = await this.marketData.getSolanaHealth();
      if (health) {
        this.tokenInfoCache.set(cacheKey, health, 300000);
      }
      this._recordProcessingTime(Date.now() - startTime);
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
    this.preloadQueue.push(...tokenMints.filter(mint => !this.preloadQueue.includes(mint)));
    if (!this.isPreloading) {
      this._startPreloading();
    }
  }

  async _startPreloading() {
    if (this.isPreloading || !this.preloadQueue.length) return;
    this.isPreloading = true;
    console.log(`Démarrage du préchargement pour ${this.preloadQueue.length} tokens`);
    const concurrentBatches = 3;
    const processNextBatch = async () => {
      if (!this.preloadQueue.length) {
        this.isPreloading = false;
        return;
      }
      const tokensToProcess = this.preloadQueue.splice(0, concurrentBatches);
      await Promise.all(tokensToProcess.map(async (token) => {
        try {
          if (!token) return; // Skip invalid tokens
          
          await this.getTokenPrice(token);
          setTimeout(() => {
            this.getHistoricalData(token)
              .catch(err => console.warn(`Erreur préchargement historique: ${token}`, err.message));
          }, 500);
          setTimeout(() => {
            this.getTokenData(token)
              .catch(err => console.warn(`Erreur préchargement info: ${token}`, err.message));
          }, 1000);
        } catch (err) {
          console.warn(`Erreur préchargement: ${token}`, err.message);
        }
      }));
      setTimeout(processNextBatch, 2000);
    };
    processNextBatch();
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
    console.error(`Erreur DataManager [${operation}]:`, error.message);
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
        console.error('Erreur nettoyage caches:', error);
      }
    }, 15 * 60 * 1000);
  }

  clearCaches() {
    this.priceDataCache.clear();
    this.historicalDataCache.clear();
    this.indicatorCache.clear();
    this.tokenInfoCache.clear();
    console.log('Tous les caches ont été vidés');
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
      isPreloading: this.isPreloading
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