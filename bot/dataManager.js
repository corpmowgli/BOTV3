// bot/dataManager.js - Gestionnaire de données optimisé
import { LRUCache } from '../utils/cache.js';

export class DataManager {
  constructor(config, marketDataService) {
    this.config = config;
    this.marketData = marketDataService;
    
    // Caches optimisés pour différents types de données
    this.priceDataCache = new LRUCache(200);
    this.historicalDataCache = new LRUCache(100);
    this.indicatorCache = new LRUCache(300);
    this.tokenInfoCache = new LRUCache(150);
    
    // Stats pour suivi des performances
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
    
    // Planifier le nettoyage périodique des caches
    this._scheduleCacheCleanup();
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  async getBatchTokenPrices(tokenMints) {
    if (!tokenMints || tokenMints.length === 0) return {};
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Vérifier d'abord dans le cache
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
    
    // Si tous les prix sont en cache, retourner immédiatement
    if (tokensToFetch.length === 0) {
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    }
    
    try {
      // Obtenir les prix pour les tokens manquants
      const prices = await this.marketData.getBatchTokenPrices(tokensToFetch);
      
      // Mettre à jour le cache et les résultats
      for (const [token, price] of Object.entries(prices)) {
        if (price !== undefined && price !== null) {
          this.priceDataCache.set(`price_${token}`, price, 60000); // 1 minute TTL
          result[token] = price;
        }
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return result;
    } catch (error) {
      this._recordError('getBatchTokenPrices', error);
      
      // En cas d'erreur, retourner ce qu'on a déjà pu récupérer
      return result;
    }
  }

  async getTokenPrice(tokenMint) {
    if (!tokenMint) return null;
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Vérifier le cache
    const cachedPrice = this.priceDataCache.get(`price_${tokenMint}`);
    if (cachedPrice !== undefined) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedPrice;
    }
    
    this.stats.cacheMisses++;
    
    try {
      const price = await this.marketData.getTokenPrice(tokenMint);
      
      if (price !== null && price !== undefined) {
        this.priceDataCache.set(`price_${tokenMint}`, price, 60000); // 1 minute TTL
      }
      
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
    
    // Vérifier le cache
    const cachedData = this.historicalDataCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    try {
      // Calculer les dates pour la requête
      const endTime = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      const data = await this.marketData.getHistoricalPrices(
        tokenMint,
        startDate.getTime(),
        endTime.getTime(),
        interval
      );
      
      // Mettre en cache avec TTL plus long pour les données historiques
      if (data && data.prices && data.prices.length > 0) {
        this.historicalDataCache.set(cacheKey, data, 1800000); // 30 minutes
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return data;
    } catch (error) {
      this._recordError('getHistoricalData', error);
      return { prices: [], volumes: [], timestamps: [] };
    }
  }

  async getTokenData(tokenMint) {
    if (!tokenMint) return null;
    
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    // Vérifier le cache
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

  async getTopTokens(limit = 20) {
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = `top_tokens_${limit}`;
    
    // Vérifier le cache
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
      
      if (data && data.length > 0) {
        this.tokenInfoCache.set(cacheKey, data, 300000); // 5 minutes
      }
      
      this._recordProcessingTime(Date.now() - startTime);
      return data;
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
    
    // Vérifier le cache
    const cachedData = this.indicatorCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      this._recordProcessingTime(Date.now() - startTime);
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    try {
      // Récupérer d'abord les données historiques
      const historicalData = await this.getHistoricalData(tokenMint, interval, days);
      
      if (!historicalData || !historicalData.prices || historicalData.prices.length === 0) {
        throw new Error('Données historiques insuffisantes pour calculer les indicateurs');
      }
      
      // Le calcul des indicateurs est délégué à la stratégie
      // Nous stockons juste les données brutes dans le cache
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

  async getSolanaHealth() {
    const startTime = Date.now();
    this.stats.requestsCount++;
    
    const cacheKey = 'solana_health';
    
    // Vérifier le cache
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
      
      // Retourner un état par défaut en cas d'erreur
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
    if (!tokenMints || tokenMints.length === 0) return;
    
    // Ajouter à la file de préchargement
    this.preloadQueue.push(...tokenMints.filter(mint => 
      !this.preloadQueue.includes(mint)
    ));
    
    // Démarrer le préchargement si ce n'est pas déjà en cours
    if (!this.isPreloading) {
      this._startPreloading();
    }
  }

  async _startPreloading() {
    if (this.isPreloading || this.preloadQueue.length === 0) return;
    
    this.isPreloading = true;
    console.log(`Démarrage du préchargement pour ${this.preloadQueue.length} tokens`);
    
    const concurrentBatches = 3;
    
    const processNextBatch = async () => {
      if (this.preloadQueue.length === 0) {
        this.isPreloading = false;
        return;
      }
      
      // Prendre les prochains tokens à précharger
      const tokensToProcess = this.preloadQueue.splice(0, concurrentBatches);
      
      // Précharger en parallèle
      await Promise.all(tokensToProcess.map(async (token) => {
        try {
          // Précharger les prix
          await this.getTokenPrice(token);
          
          // Précharger les données historiques avec une priorité plus basse
          setTimeout(() => {
            this.getHistoricalData(token)
              .catch(err => console.warn(`Erreur de préchargement des données historiques pour ${token}:`, err.message));
          }, 500);
          
          // Précharger les infos du token avec une priorité encore plus basse
          setTimeout(() => {
            this.getTokenData(token)
              .catch(err => console.warn(`Erreur de préchargement des infos pour ${token}:`, err.message));
          }, 1000);
        } catch (err) {
          console.warn(`Erreur lors du préchargement pour ${token}:`, err.message);
        }
      }));
      
      // Attendre un peu entre les lots pour éviter de surcharger l'API
      setTimeout(processNextBatch, 2000);
    };
    
    processNextBatch();
  }

  _recordProcessingTime(time) {
    this.stats.processingTimes.push(time);
    
    // Limiter le nombre de temps conservés
    if (this.stats.processingTimes.length > 100) {
      this.stats.processingTimes.shift();
    }
    
    // Mettre à jour le temps moyen de traitement
    this.stats.averageProcessingTime = this.stats.processingTimes.reduce((a, b) => a + b, 0) / this.stats.processingTimes.length;
  }

  _recordError(operation, error) {
    // Stocker l'erreur pour les statistiques
    if (this.stats.errors.length >= 50) {
      this.stats.errors.shift(); // Éviter une croissance illimitée
    }
    
    this.stats.errors.push({
      operation,
      message: error.message,
      timestamp: Date.now()
    });
    
    console.error(`Erreur DataManager [${operation}]:`, error.message);
  }

  _scheduleCacheCleanup() {
    // Nettoyer les caches toutes les 15 minutes
    setInterval(() => {
      try {
        // Supprimer les entrées expirées des caches
        this.priceDataCache.cleanupExpired();
        this.historicalDataCache.cleanupExpired();
        this.indicatorCache.cleanupExpired();
        this.tokenInfoCache.cleanupExpired();
        
        console.log('Nettoyage des caches terminé');
      } catch (error) {
        console.error('Erreur lors du nettoyage des caches:', error);
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