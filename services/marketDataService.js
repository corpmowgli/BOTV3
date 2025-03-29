// services/marketDataService.js - Service de données de marché optimisé pour Solana
import axios from 'axios';
import { LRUCache } from '../utils/cache.js';
import { delay, retry } from '../utils/helpers.js';

export class MarketDataService {
  constructor(config) {
    this.config = config;
    this.apiConfig = config.api;
    
    // Caches optimisés avec TTL
    this.priceCache = new LRUCache(1000); // Cache plus grand pour les prix
    this.liquidityCache = new LRUCache(500);
    this.tokenInfoCache = new LRUCache(500);
    this.historicalCache = new LRUCache(200);
    
    // Statistiques
    this.stats = {
      requests: { total: 0, successful: 0, failed: 0 },
      requestsByEndpoint: {},
      cacheHits: 0,
      cacheMisses: 0,
      averageResponseTime: 0,
      errors: [],
      lastRequestTime: {},
      queueSizes: { high: 0, medium: 0, low: 0 }
    };
    
    // Files d'attente pour gérer les rate limits
    this.queues = {
      high: [], // Requêtes prioritaires (prix actuels)
      medium: [], // Requêtes de priorité moyenne (infos tokens)
      low: [] // Requêtes de faible priorité (données historiques)
    };
    
    // Initialiser les instances d'API avec retry et circuit breaker
    this.api = this.initializeApiInstances();
    
    // Démarrer le traitement des files d'attente
    this.processQueues();
  }

  initializeApiInstances() {
    // Fonction pour créer une instance axios avec configuration complète
    const createApiInstance = (baseURL, config = {}) => {
      const instance = axios.create({
        baseURL,
        timeout: config.timeout || 10000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(config.headers || {})
        }
      });
      
      // Intercepteur pour les logs et statistiques
      instance.interceptors.request.use(
        config => {
          config.metadata = { startTime: Date.now() };
          return config;
        },
        error => Promise.reject(error)
      );
      
      instance.interceptors.response.use(
        response => {
          const duration = Date.now() - response.config.metadata.startTime;
          this.updateStats(response.config.url, true, duration);
          return response;
        },
        async error => {
          if (error.response) {
            this.updateStats(error.config.url, false, 0, error);
            
            // Gestion des rate limits
            if (error.response.status === 429) {
              const retryAfter = error.response.headers['retry-after'] 
                ? parseInt(error.response.headers['retry-after']) * 1000 
                : this.apiConfig.fallbacks.retryDelay || 60000;
              
              console.warn(`Rate limit atteint pour ${error.config.baseURL}, attente de ${retryAfter}ms`);
              await delay(retryAfter);
              return axios(error.config);
            }
          }
          
          return Promise.reject(error);
        }
      );
      
      return instance;
    };
    
    // Créer les instances pour chaque API 
    return {
      raydium: createApiInstance(this.apiConfig.raydium.baseUrl, {
        timeout: this.apiConfig.fallbacks.timeouts.default
      }),
      
      jupiter: createApiInstance(this.apiConfig.jupiter.baseURL, {
        timeout: this.apiConfig.fallbacks.timeouts.priceData
      }),
      
      coingecko: createApiInstance(this.apiConfig.coingecko.baseUrl, {
        timeout: this.apiConfig.fallbacks.timeouts.default,
        headers: {
          'x-cg-pro-api-key': process.env.COINGECKO_API_KEY // Optionnel
        }
      }),
      
      solana: createApiInstance(this.apiConfig.solana.rpcUrl, {
        timeout: this.apiConfig.fallbacks.timeouts.default
      })
    };
  }

  updateStats(endpoint, success, duration, error = null) {
    this.stats.requests.total++;
    
    if (success) {
      this.stats.requests.successful++;
      
      // Mettre à jour la durée moyenne de réponse
      const totalResponses = this.stats.requests.successful;
      this.stats.averageResponseTime = 
        ((this.stats.averageResponseTime * (totalResponses - 1)) + duration) / totalResponses;
    } else {
      this.stats.requests.failed++;
      
      if (error && this.stats.errors.length < 100) {
        this.stats.errors.push({
          timestamp: Date.now(),
          endpoint,
          message: error.message,
          status: error.response?.status
        });
      }
    }
    
    // Statistiques par endpoint
    if (!this.stats.requestsByEndpoint[endpoint]) {
      this.stats.requestsByEndpoint[endpoint] = { total: 0, successful: 0, failed: 0 };
    }
    
    this.stats.requestsByEndpoint[endpoint].total++;
    if (success) {
      this.stats.requestsByEndpoint[endpoint].successful++;
    } else {
      this.stats.requestsByEndpoint[endpoint].failed++;
    }
    
    this.stats.lastRequestTime[endpoint] = Date.now();
  }

  async processQueues() {
    const processQueue = async (queueName, delay) => {
      if (this.queues[queueName].length === 0) return;
      
      const { request, resolve, reject } = this.queues[queueName].shift();
      this.stats.queueSizes[queueName] = this.queues[queueName].length;
      
      try {
        const result = await request();
        resolve(result);
      } catch (error) {
        reject(error);
      }
      
      if (this.queues[queueName].length > 0) {
        setTimeout(() => processQueue(queueName, delay), delay);
      }
    };
    
    // Traitement continu des files
    setInterval(() => {
      if (this.queues.high.length > 0) {
        processQueue('high', 100); // Traitement plus rapide pour les requêtes prioritaires
      }
      
      if (this.queues.medium.length > 0) {
        processQueue('medium', 300);
      }
      
      if (this.queues.low.length > 0) {
        processQueue('low', 500);
      }
      
      // Mettre à jour les tailles des files
      this.stats.queueSizes = {
        high: this.queues.high.length,
        medium: this.queues.medium.length,
        low: this.queues.low.length
      };
    }, 100);
  }

  enqueueRequest(queueName, request) {
    return new Promise((resolve, reject) => {
      this.queues[queueName].push({ request, resolve, reject });
      this.stats.queueSizes[queueName] = this.queues[queueName].length;
    });
  }

  async getTokenPrice(tokenMint) {
    const cacheKey = `price_${tokenMint}`;
    
    // Vérifier le cache
    const cachedPrice = this.priceCache.get(cacheKey);
    if (cachedPrice) {
      this.stats.cacheHits++;
      return cachedPrice;
    }
    
    this.stats.cacheMisses++;
    
    // Mettre en file d'attente avec priorité élevée
    return this.enqueueRequest('high', async () => {
      try {
        // Essayer d'abord Jupiter (source primaire pour Solana)
        const response = await retry(
          () => this.api.jupiter.get('/price', { params: { ids: tokenMint } }),
          this.apiConfig.fallbacks.maxRetries,
          this.apiConfig.fallbacks.retryDelay
        );
        
        if (response.data && response.data.data && response.data.data[tokenMint]) {
          const price = response.data.data[tokenMint].price;
          
          // Mise en cache avec TTL de 30 secondes
          this.priceCache.set(cacheKey, price, 30000);
          
          return price;
        }
        
        throw new Error(`Prix non disponible pour ${tokenMint}`);
      } catch (error) {
        // Fallback vers Raydium
        try {
          const response = await this.api.raydium.get(`/price?token=${tokenMint}`);
          if (response.data && response.data.price) {
            const price = response.data.price;
            this.priceCache.set(cacheKey, price, 30000);
            return price;
          }
        } catch (fallbackError) {
          console.error(`Erreur de fallback Raydium pour ${tokenMint}:`, fallbackError.message);
        }
        
        throw error;
      }
    });
  }

  async getBatchTokenPrices(tokenMints) {
    if (!tokenMints || tokenMints.length === 0) return {};
    
    const result = {};
    const tokensToFetch = [];
    
    // Récupérer d'abord les prix en cache
    for (const mint of tokenMints) {
      const cachedPrice = this.priceCache.get(`price_${mint}`);
      if (cachedPrice) {
        result[mint] = cachedPrice;
        this.stats.cacheHits++;
      } else {
        tokensToFetch.push(mint);
        this.stats.cacheMisses++;
      }
    }
    
    if (tokensToFetch.length === 0) return result;
    
    // Traiter par lots de 100 (limite de Jupiter)
    const batchSize = 100;
    const batches = [];
    
    for (let i = 0; i < tokensToFetch.length; i += batchSize) {
      batches.push(tokensToFetch.slice(i, i + batchSize));
    }
    
    await Promise.all(batches.map(async (batch) => {
      try {
        const response = await retry(
          () => this.api.jupiter.get('/price', { params: { ids: batch.join(',') } }),
          this.apiConfig.fallbacks.maxRetries,
          this.apiConfig.fallbacks.retryDelay
        );
        
        if (response.data && response.data.data) {
          Object.entries(response.data.data).forEach(([token, data]) => {
            if (data && data.price) {
              result[token] = data.price;
              
              // Mise en cache individuelle
              this.priceCache.set(`price_${token}`, data.price, 30000);
            }
          });
        }
      } catch (error) {
        console.error(`Erreur lors de la récupération par lot:`, error.message);
        
        // Fallback: récupérer individuellement
        for (const token of batch) {
          try {
            const price = await this.getTokenPrice(token);
            if (price) {
              result[token] = price;
            }
          } catch (individualError) {
            console.warn(`Impossible de récupérer le prix pour ${token}`);
          }
        }
      }
    }));
    
    return result;
  }

  async getHistoricalPrices(tokenMint, startTime, endTime, timeframe = '1h') {
    const cacheKey = `history_${tokenMint}_${timeframe}_${startTime}_${endTime}`;
    
    // Vérifier le cache
    const cachedData = this.historicalCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    // Mettre en file d'attente avec priorité basse
    return this.enqueueRequest('low', async () => {
      try {
        const response = await retry(
          () => this.api.raydium.get('/charts', { 
            params: { tokenMint, timeframe, startTime, endTime } 
          }),
          this.apiConfig.fallbacks.maxRetries,
          this.apiConfig.fallbacks.retryDelay
        );
        
        if (response.data) {
          const data = this.processHistoricalData(response.data);
          
          // Mise en cache plus longue pour les données historiques (5 minutes)
          this.historicalCache.set(cacheKey, data, 300000);
          
          return data;
        }
        
        throw new Error(`Données historiques non disponibles pour ${tokenMint}`);
      } catch (error) {
        console.error(`Erreur lors de la récupération des données historiques:`, error.message);
        throw error;
      }
    });
  }

  processHistoricalData(data) {
    if (!data || !Array.isArray(data)) return { prices: [], volumes: [], timestamps: [] };
    
    // Extraire les séries temporelles
    const prices = [];
    const volumes = [];
    const timestamps = [];
    
    data.forEach(item => {
      if (item.time && item.close && item.volume !== undefined) {
        timestamps.push(item.time);
        prices.push(parseFloat(item.close));
        volumes.push(parseFloat(item.volume));
      }
    });
    
    return { prices, volumes, timestamps };
  }

  async getTopTokens(limit = 20, minLiquidity = null, minVolume = null) {
    const actualMinLiquidity = minLiquidity || this.config.trading.minLiquidity || 100000;
    const actualMinVolume = minVolume || this.config.trading.minVolume24h || 50000;
    
    const cacheKey = `top_tokens_${limit}_${actualMinLiquidity}_${actualMinVolume}`;
    
    // Vérifier le cache
    const cachedData = this.tokenInfoCache.get(cacheKey);
    if (cachedData) {
      this.stats.cacheHits++;
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    // Mettre en file d'attente avec priorité moyenne
    return this.enqueueRequest('medium', async () => {
      try {
        const response = await retry(
          () => this.api.raydium.get('/tokens', { 
            params: { limit: limit * 2, sortBy: 'volume24h', order: 'desc' } 
          }),
          this.apiConfig.fallbacks.maxRetries,
          this.apiConfig.fallbacks.retryDelay
        );
        
        if (response.data && Array.isArray(response.data)) {
          // Filtrer selon les critères
          const filteredTokens = response.data.filter(token => 
            parseFloat(token.liquidity || 0) >= actualMinLiquidity && 
            parseFloat(token.volume24h || 0) >= actualMinVolume
          ).slice(0, limit);
          
          // Ajouter des métadonnées supplémentaires Solana
          const enhancedTokens = await this.enrichTokenData(filteredTokens);
          
          // Mise en cache pour 5 minutes
          this.tokenInfoCache.set(cacheKey, enhancedTokens, 300000);
          
          return enhancedTokens;
        }
        
        throw new Error('Impossible de récupérer les top tokens');
      } catch (error) {
        console.error(`Erreur lors de la récupération des top tokens:`, error.message);
        throw error;
      }
    });
  }

  async enrichTokenData(tokens) {
    // Fonction pour améliorer les données de token avec des infos supplémentaires
    try {
      const mintAddresses = tokens.map(token => token.mint);
      
      // Récupérer les infos supplémentaires du réseau Solana
      // Note: cette implémentation est simplifiée, à adapter selon les besoins
      const enhancedData = await Promise.all(tokens.map(async (token) => {
        try {
          // Récupérer d'autres informations si disponibles
          let additionalInfo = {};
          try {
            // Exemple: récupération d'infos depuis un endpoint spécifique Solana
            const response = await this.api.solana.post('', {
              jsonrpc: '2.0',
              id: 1,
              method: 'getTokenSupply',
              params: [token.mint]
            });
            
            if (response.data && response.data.result && response.data.result.value) {
              additionalInfo.supply = response.data.result.value.uiAmount;
            }
          } catch (infoError) {
            // Ignorer les erreurs d'informations supplémentaires
          }
          
          return {
            ...token,
            ecosystem: 'solana',
            tokenAge: this.estimateTokenAge(token.apy, token.volume24h),
            ...additionalInfo
          };
        } catch (error) {
          return token;
        }
      }));
      
      return enhancedData;
    } catch (error) {
      console.warn('Erreur lors de l\'enrichissement des données de tokens:', error.message);
      return tokens;
    }
  }

  estimateTokenAge(apy, volume24h) {
    // Heuristique simple pour estimer l'âge d'un token
    // Note: Ce n'est qu'une approximation, idéalement utiliser des données réelles
    if (!apy || !volume24h) return null;
    
    const apyFloat = parseFloat(apy);
    const volume = parseFloat(volume24h);
    
    if (apyFloat > 1000 && volume < 100000) {
      return 7; // Très récent (< 1 semaine)
    } else if (apyFloat > 500 && volume < 500000) {
      return 14; // Récent (1-2 semaines)
    } else if (apyFloat > 100 && volume < 1000000) {
      return 30; // < 1 mois
    } else {
      return 90; // Etabli (> 3 mois)
    }
  }

  async aggregateTokenData(tokenMint) {
    const cacheKey = `aggregated_${tokenMint}`;
    const cachedData = this.tokenInfoCache.get(cacheKey);
    
    if (cachedData) {
      this.stats.cacheHits++;
      return cachedData;
    }
    
    this.stats.cacheMisses++;
    
    return this.enqueueRequest('medium', async () => {
      try {
        // Récupérer les données de différentes sources en parallèle
        const [price, tokenInfo] = await Promise.all([
          this.getTokenPrice(tokenMint).catch(() => null),
          this.getTokenInfo(tokenMint).catch(() => ({}))
        ]);
        
        // Combiner les données
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
        
        this.tokenInfoCache.set(cacheKey, aggregated, 60000); // 1 minute
        return aggregated;
      } catch (error) {
        console.error(`Erreur lors de l'agrégation des données de token pour ${tokenMint}:`, error.message);
        return {
          token: tokenMint,
          price: null,
          liquidity: 0,
          volume24h: 0,
          priceChange24h: 0,
          error: error.message
        };
      }
    });
  }

  async getTokenInfo(tokenMint) {
    const cacheKey = `info_${tokenMint}`;
    const cachedInfo = this.tokenInfoCache.get(cacheKey);
    
    if (cachedInfo) {
      this.stats.cacheHits++;
      return cachedInfo;
    }
    
    this.stats.cacheMisses++;
    
    return this.enqueueRequest('medium', async () => {
      try {
        const response = await retry(
          () => this.api.raydium.get(`/tokens/${tokenMint}`),
          this.apiConfig.fallbacks.maxRetries,
          this.apiConfig.fallbacks.retryDelay
        );
        
        if (response.data) {
          this.tokenInfoCache.set(cacheKey, response.data, 300000); // 5 minutes
          return response.data;
        }
        
        throw new Error(`Informations non disponibles pour ${tokenMint}`);
      } catch (error) {
        console.error(`Erreur lors de la récupération des infos de token:`, error.message);
        throw error;
      }
    });
  }

  async getSolanaHealth() {
    const cacheKey = 'solana_health';
    const cachedHealth = this.tokenInfoCache.get(cacheKey);
    
    if (cachedHealth) {
      this.stats.cacheHits++;
      return cachedHealth;
    }
    
    this.stats.cacheMisses++;
    
    return this.enqueueRequest('low', async () => {
      try {
        // Vérifier plusieurs métriques pour déterminer la santé de Solana
        const [networkStats, globalMarkets] = await Promise.all([
          this.api.solana.post('', {
            jsonrpc: '2.0',
            id: 1,
            method: 'getRecentPerformanceSamples',
            params: [1]
          }).catch(() => null),
          
          this.api.coingecko.get('/global').catch(() => null)
        ]);
        
        let tps = 0;
        let reliability = 'unknown';
        let marketTrend = 'neutral';
        
        // Analyser les TPS (transactions par seconde)
        if (networkStats && networkStats.data && networkStats.data.result) {
          const samples = networkStats.data.result;
          if (samples.length > 0) {
            tps = samples[0].numTransactions / samples[0].samplePeriodSecs;
            reliability = tps > 1500 ? 'high' : tps > 1000 ? 'medium' : 'low';
          }
        }
        
        // Analyser la tendance du marché global
        if (globalMarkets && globalMarkets.data && globalMarkets.data.data) {
          const btcDominance = globalMarkets.data.data.market_cap_percentage.btc;
          const marketCapChange = globalMarkets.data.data.market_cap_change_percentage_24h_usd;
          
          if (marketCapChange > 3) {
            marketTrend = 'bullish';
          } else if (marketCapChange < -3) {
            marketTrend = 'bearish';
          }
        }
        
        const healthStatus = {
          reliability,
          tps,
          marketTrend,
          timestamp: Date.now()
        };
        
        this.tokenInfoCache.set(cacheKey, healthStatus, 900000); // 15 minutes
        return healthStatus;
      } catch (error) {
        console.error(`Erreur lors de la récupération de la santé de Solana:`, error.message);
        return {
          reliability: 'unknown',
          tps: 0,
          marketTrend: 'neutral',
          timestamp: Date.now(),
          error: error.message
        };
      }
    });
  }

  getStats() {
    return {
      ...this.stats,
      cacheStats: {
        price: {
          size: this.priceCache.getStats().size,
          hitRate: this.priceCache.getStats().hitRate
        },
        tokenInfo: {
          size: this.tokenInfoCache.getStats().size,
          hitRate: this.tokenInfoCache.getStats().hitRate
        },
        historical: {
          size: this.historicalCache.getStats().size,
          hitRate: this.historicalCache.getStats().hitRate
        }
      }
    };
  }

  clearCaches() {
    this.priceCache.clear();
    this.tokenInfoCache.clear();
    this.liquidityCache.clear();
    this.historicalCache.clear();
    console.log('Tous les caches du service de données de marché ont été vidés');
  }
}