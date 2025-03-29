// DataManager.js - Version optimisée
import { LRUCache } from '../utils/cache.js';

export class DataManager {
  constructor(config, marketDataService) {
    this.config = config;
    this.marketData = marketDataService;
    
    // Caches optimisés
    this.priceDataCache = new LRUCache(200);
    this.historicalDataCache = new LRUCache(100);
    this.indicatorCache = new LRUCache(300);
    this.tokenInfoCache = new LRUCache(150);
    
    // Stats
    this.stats = {
      requestsCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      processingTimes: [],
      averageProcessingTime: 0,
      errors: [],
      lastUpdate: Date.now()
    };
    
    // File de préchargement
    this.preloadQueue = [];
    this.isPreloading = false;
    
    this._scheduleCacheCleanup();
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Récupère les prix de plusieurs tokens
   */
  async getBatchTokenPrices(tokenMints) {
    if (!tokenMints?.length) return {};
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Vérifier cache
    const result = {};
    const tokensToFetch = [];
    
    for (const mint of tokenMints) {
      const cachedPrice = this.priceDataCache.get(`price_${mint}`);
      if (cachedPrice !== undefined) {
        result[mint] = cachedPrice;
        this.stats.cacheHits++;
      } else {
        tokensToFetch.push(mint);
        this.stats.cacheMisses++;
      }
    }
    
    // Si tout est en cache
    if (!tokensToFetch.length) {
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    }
    
    try {
      // Obtenir les prix manquants
      const prices = await this.marketData.getBatchTokenPrices(tokensToFetch);
      
      // Mettre à jour cache et résultats
      Object.entries(prices).forEach(([token, price]) => {
        if (price !== undefined && price !== null) {
          this.priceDataCache.set(`price_${token}`, price, 60000); // 1 minute TTL
          result[token] = price;
        }
      });
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._recordError('getBatchTokenPrices', error);
      return result;
    }
  }

  /**
   * Récupère le prix d'un token
   */
  async getTokenPrice(tokenMint) {
    if (!tokenMint) return null;
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Vérifier cache
    const cachedPrice = this.priceDataCache.get(`price_${tokenMint}`);
    if (cachedPrice !== undefined) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedPrice;
    }
    
    this.stats.cacheMisses++;
    
    try {
      const price = await this.marketData.getTokenPrice(tokenMint);
      
      if (price != null) {
        this.priceDataCache.set(`price_${tokenMint}`, price, 60000);
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return price;
    } catch (error) {
      this._recordError('getTokenPrice', error);
      return null;
    }
  }

  /**
   * Récupère des données historiques
   */
  async getHistoricalData(tokenMint, interval = '1h', days = 7) {
    if (!tokenMint) return { prices: [], volumes: [], timestamps: [] };
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = `history_${tokenMint}_${interval}_${days}`;
    
    // Vérifier cache
    const cachedData = this.historicalDataCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    try {
      // Calculer dates
      const endTime = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      const data = await this.marketData.getHistoricalPrices(
        tokenMint,
        startDate.getTime(),
        endTime.getTime(),
        interval
      );
      
      // Mise en cache
      if (data?.prices?.length > 0) {
        this.historicalDataCache.set(cacheKey, data, 1800000); // 30 minutes
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return data;
    } catch (error) {
      this._recordError('getHistoricalData', error);
      return { prices: [], volumes: [], timestamps: [] };
    }
  }

  /**
   * Récupère des données d'un token
   */
  async getTokenData(tokenMint) {
    if (!tokenMint) return null;
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Vérifier cache
    const cachedData = this.tokenInfoCache.get(`info_${tokenMint}`);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    try {
      const data = await this.marketData.aggregateTokenData(tokenMint);
      
      if (data) {
        this.tokenInfoCache.set(`info_${tokenMint}`, data, 300000); // 5 minutes
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return data;
    } catch (error) {
      this._recordError('getTokenData', error);
      return null;
    }
  }

  /**
   * Récupère les meilleurs tokens
   */
  async getTopTokens(limit = 20) {
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = `top_tokens_${limit}`;
    
    // Vérifier cache
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
        this.tokenInfoCache.set(cacheKey, data, 300000); // 5 minutes
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return data;
    } catch (error) {
      this._recordError('getTopTokens', error);
      return [];
    }
  }

  /**
   * Récupère des indicateurs techniques
   */
  async getIndicators(tokenMint, interval = '1h', days = 7) {
    if (!tokenMint) return null;
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = `indicators_${tokenMint}_${interval}_${days}`;
    
    // Vérifier cache
    const cachedData = this.indicatorCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    try {
      // Récupérer données historiques
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
      
      this.indicatorCache.set(cacheKey, result, 900000); // 15 minutes
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._recordError('getIndicators', error);
      return null;
    }
  }

  /**
   * Récupère l'état du réseau Solana
   */
  async getSolanaHealth() {
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = 'solana_health';
    
    // Vérifier cache
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
        this.tokenInfoCache.set(cacheKey, health, 300000); // 5 minutes
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

  /**
   * Précharge des données
   */
  async preloadData(tokenMints) {
    if (!tokenMints?.length) return;
    
    // Ajouter à la file
    this.preloadQueue.push(...tokenMints.filter(mint => !this.preloadQueue.includes(mint)));
    
    // Démarrer préchargement
    if (!this.isPreloading) {
      this._startPreloading();
    }
  }

  /**
   * Démarre le préchargement
   */
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
      
      // Prendre les prochains tokens
      const tokensToProcess = this.preloadQueue.splice(0, concurrentBatches);
      
      // Précharger en parallèle
      await Promise.all(tokensToProcess.map(async (token) => {
        try {
          // Précharger prix et données avec délais progressifs
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
      
      // Attendre entre les lots
      setTimeout(processNextBatch, 2000);
    };
    
    processNextBatch();
  }

  // Méthodes utilitaires
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
    setInterval(() => {
      try {
        this.priceDataCache.cleanupExpired();
        this.historicalDataCache.cleanupExpired();
        this.indicatorCache.cleanupExpired();
        this.tokenInfoCache.cleanupExpired();
      } catch (error) {
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
    const totalRequests = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate = totalRequests > 0 ? (this.stats.cacheHits / totalRequests) * 100 : 0;
    
    return {
      ...this.stats,
      cacheSizes: {
        price: this.priceDataCache.getStats().size,
        historical: this.historicalDataCache.getStats().size,
        indicators: this.indicatorCache.getStats().size,
        tokenInfo: this.tokenInfoCache.getStats().size
      },
      cacheHitRate: hitRate.toFixed(2) + '%',
      preloadQueueSize: this.preloadQueue.length,
      isPreloading: this.isPreloading
    };
  }
}