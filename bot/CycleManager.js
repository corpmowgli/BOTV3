// CycleManager.js - Version optimisée
import EventEmitter from 'events';
import { delay } from '../utils/helpers.js';

/**
 * Gère les cycles de trading du bot
 */
export class CycleManager extends EventEmitter {
  constructor(config, marketData, strategy, riskManager, positionManager, portfolioManager, logger) {
    super();
    this.config = config;
    this.marketData = marketData;
    this.strategy = strategy;
    this.riskManager = riskManager;
    this.positionManager = positionManager;
    this.portfolioManager = portfolioManager;
    this.logger = logger;

    // État
    this.isRunning = false;
    this.isStopping = false;
    this.cycleInterval = null;
    
    // Métriques
    this.metrics = {
      cycleCount: 0,
      successfulCycles: 0,
      failedCycles: 0,
      lastCycleTime: null,
      avgCycleDuration: 0,
      totalCycleDuration: 0,
      tokensProcessed: 0,
      signalsGenerated: 0
    };

    // Circuit breaker
    this.circuitBreaker = {
      tripped: false,
      consecutiveErrors: 0,
      lastError: null,
      cooldownUntil: null,
      maxConsecutiveErrors: config.errorHandling?.maxConsecutiveErrors || 3
    };
    
    // Cache
    this.priceCache = new Map();
    this.priceCacheTime = 0;
    this.priceCacheTTL = 10000; // 10 secondes
    
    // Concurrence
    this.concurrencyLimit = config.performance?.tokenConcurrency || 5;
  }

  /**
   * Démarre le gestionnaire de cycles
   */
  async start() {
    if (this.isRunning) {
      this.emit('warning', 'Cycle manager is already running');
      return false;
    }

    try {
      this.isRunning = true;
      this.isStopping = false;
      this.emit('info', 'Cycle manager started');

      // Premier cycle immédiat
      await this.runTradingCycle();

      // Configurer l'intervalle pour les cycles suivants
      const interval = this.config.trading.cycleInterval || 60000;
      this.cycleInterval = setInterval(() => this.runTradingCycle(), interval);

      return true;
    } catch (error) {
      this.isRunning = false;
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Arrête le gestionnaire de cycles
   */
  async stop() {
    if (!this.isRunning) {
      this.emit('warning', 'Cycle manager is not running');
      return false;
    }

    try {
      this.isStopping = true;
      this.emit('info', 'Stopping cycle manager...');

      if (this.cycleInterval) {
        clearInterval(this.cycleInterval);
        this.cycleInterval = null;
      }

      this.isRunning = false;
      this.isStopping = false;
      this.emit('info', 'Cycle manager stopped');
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Exécute un cycle de trading
   */
  async runTradingCycle() {
    // Vérifications préliminaires
    if (this.isStopping || this.checkCircuitBreaker()) return false;

    const cycleStartTime = Date.now();
    this.metrics.cycleCount++;
    this.metrics.lastCycleTime = cycleStartTime;
    
    try {
      this.emit('debug', `Starting trading cycle #${this.metrics.cycleCount}`);

      // Étape 1: Obtention des tokens qualifiés
      const tokens = await this.getQualifiedTokens();
      if (!tokens?.length) {
        this.emit('info', 'No qualified tokens found in this cycle');
        return this.completeCycle(cycleStartTime, true);
      }

      // Étape 2: Préchargement des données
      await this.preloadMarketData(tokens);

      // Étape 3: Analyse des tokens
      await this.processTokensBatch(tokens);

      // Étape 4: Vérification des positions
      await this.checkPositions();

      // Cycle réussi
      this.metrics.successfulCycles++;
      this.resetCircuitBreaker();
      
      return this.completeCycle(cycleStartTime, true);
    } catch (error) {
      this.metrics.failedCycles++;
      this.incrementCircuitBreaker(error);
      this.emit('error', new Error(`Cycle error: ${error.message}`));
      
      return this.completeCycle(cycleStartTime, false);
    }
  }

  /**
   * Précharge les données de marché
   */
  async preloadMarketData(tokens) {
    try {
      const tokenMints = tokens.map(token => token.token_mint);
      if (tokenMints.length > 0) {
        await this.marketData.getBatchTokenPrices(tokenMints);
      }
    } catch (error) {
      this.emit('warning', `Error preloading market data: ${error.message}`);
      // Continue l'exécution malgré l'erreur
    }
  }

  /**
   * Traite un lot de tokens avec limite de concurrence
   */
  async processTokensBatch(tokens) {
    const batchSize = this.concurrencyLimit;
    
    // Filtrer les tokens sans position ouverte
    const openPositions = this.positionManager.getOpenPositions();
    const openPositionTokens = new Set(openPositions.map(p => p.token));
    const tokensToProcess = tokens.filter(token => !openPositionTokens.has(token.token_mint));
    
    // Traitement par lots
    for (let i = 0; i < tokensToProcess.length; i += batchSize) {
      if (this.isStopping) break;
      
      const batch = tokensToProcess.slice(i, i + batchSize);
      
      // Traitement parallèle
      await Promise.all(batch.map(token => this.processToken(token)));
      
      this.metrics.tokensProcessed += batch.length;
      
      // Pause entre les lots
      if (i + batchSize < tokensToProcess.length && !this.isStopping) {
        await delay(200);
      }
    }
  }

  /**
   * Récupère les tokens qualifiés pour analyse
   */
  async getQualifiedTokens() {
    try {
      const marketData = await this.marketData.getTopTokens(
        this.config.trading.maxTokensToAnalyze || 50
      );

      // Filtrage
      return marketData.filter(token => 
        token.liquidity >= this.config.trading.minLiquidity &&
        token.volume24h >= this.config.trading.minVolume24h
      );
    } catch (error) {
      this.emit('error', new Error(`Error getting qualified tokens: ${error.message}`));
      return [];
    }
  }

  /**
   * Traite un token pour analyse
   */
  async processToken(token) {
    try {
      // Vérifier si position déjà ouverte
      if (this.positionManager.getOpenPositions().some(p => p.token === token.token_mint)) {
        return;
      }

      // Obtenir données historiques
      const [prices, volumes] = await Promise.all([
        this.getHistoricalPrices(token.token_mint),
        this.getHistoricalVolumes(token.token_mint)
      ]);
      
      if (!prices || prices.length < 20) return;

      // Analyser avec la stratégie
      const signal = await this.strategy.analyze(token.token_mint, prices, volumes, token);
      
      if (signal.type !== 'NONE') {
        this.metrics.signalsGenerated++;
      }

      // Valider et exécuter le signal
      if (signal.type !== 'NONE' && signal.confidence >= this.config.trading.minConfidenceThreshold) {
        if (this.riskManager.canTrade(this.portfolioManager)) {
          const currentPrice = prices[prices.length - 1];
          const positionSize = this.riskManager.calculatePositionSize(currentPrice, this.portfolioManager);
          
          const position = await this.positionManager.openPosition(
            token.token_mint,
            currentPrice,
            positionSize,
            signal
          );

          if (position) {
            this.emit('info', `Opened position for ${token.token_mint} at ${currentPrice}`);
          }
        }
      }
    } catch (error) {
      this.emit('error', new Error(`Error processing token ${token.token_mint}: ${error.message}`));
    }
  }

  /**
   * Vérifie les positions ouvertes
   */
  async checkPositions() {
    try {
      const positions = this.positionManager.getOpenPositions();
      if (!positions.length) return;
      
      const currentPrices = await this.getCachedCurrentPrices();
      if (!currentPrices?.size) return;

      const closedPositions = await this.positionManager.checkPositions(currentPrices);
      
      for (const position of closedPositions) {
        this.portfolioManager.updatePortfolio(position);
        const tradeLog = this.logger.logTrade(position);
        this.emit('trade', tradeLog);
      }

      if (closedPositions.length > 0) {
        this.emit('info', `Closed ${closedPositions.length} positions`);
      }
    } catch (error) {
      this.emit('error', new Error(`Error checking positions: ${error.message}`));
    }
  }

  /**
   * Récupère les prix actuels depuis le cache
   */
  async getCachedCurrentPrices() {
    try {
      const now = Date.now();
      const positions = this.positionManager.getOpenPositions();
      if (!positions.length) return new Map();

      const tokens = positions.map(p => p.token);
      
      // Vérifier cache
      if (this.priceCache.size > 0 && 
          (now - this.priceCacheTime) < this.priceCacheTTL &&
          tokens.every(token => this.priceCache.has(token))) {
        return this.priceCache;
      }
      
      // Sinon, récupérer les données
      const priceMap = await this.getCurrentPrices();
      
      // Mettre à jour cache
      this.priceCache = priceMap;
      this.priceCacheTime = now;
      
      return priceMap;
    } catch (error) {
      this.emit('error', new Error(`Error getting cached prices: ${error.message}`));
      return new Map();
    }
  }

  /**
   * Récupère les prix actuels
   */
  async getCurrentPrices() {
    try {
      const positions = this.positionManager.getOpenPositions();
      if (!positions.length) return new Map();

      const tokens = positions.map(p => p.token);
      const batchPrices = await this.marketData.getBatchTokenPrices(tokens);
      
      // Convertir en Map
      const priceMap = new Map();
      if (batchPrices && typeof batchPrices === 'object') {
        Object.entries(batchPrices).forEach(([token, price]) => {
          priceMap.set(token, price);
        });
      }
      
      return priceMap;
    } catch (error) {
      this.emit('error', new Error(`Error getting current prices: ${error.message}`));
      return new Map();
    }
  }

  /**
   * Récupère l'historique des prix
   */
  async getHistoricalPrices(tokenMint) {
    try {
      const endTime = Date.now();
      const startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      
      const priceData = await this.marketData.getHistoricalPrices(
        tokenMint, startTime, endTime, '1h'
      );

      return priceData.map(d => d.price);
    } catch (error) {
      this.emit('error', new Error(`Error getting historical prices: ${error.message}`));
      return [];
    }
  }

  /**
   * Récupère l'historique des volumes
   */
  async getHistoricalVolumes(tokenMint) {
    try {
      const endTime = Date.now();
      const startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      
      const volumeData = await this.marketData.getHistoricalVolumes(
        tokenMint, startTime, endTime, '1h'
      );

      return volumeData.map(d => d.volume);
    } catch (error) {
      this.emit('error', new Error(`Error getting historical volumes: ${error.message}`));
      return [];
    }
  }

  /**
   * Vérifie si le circuit breaker est déclenché
   */
  checkCircuitBreaker() {
    if (!this.circuitBreaker.tripped) return false;

    // Vérifier si le temps de cooldown est écoulé
    if (this.circuitBreaker.cooldownUntil && Date.now() > this.circuitBreaker.cooldownUntil) {
      this.resetCircuitBreaker();
      this.emit('info', 'Circuit breaker reset after cooldown period');
      return false;
    }

    return true;
  }

  /**
   * Incrémente le compteur d'erreurs du circuit breaker
   */
  incrementCircuitBreaker(error) {
    this.circuitBreaker.consecutiveErrors++;
    this.circuitBreaker.lastError = error;

    // Si seuil atteint, déclencher circuit breaker
    if (this.circuitBreaker.consecutiveErrors >= this.circuitBreaker.maxConsecutiveErrors) {
      this.circuitBreaker.tripped = true;
      
      // Définir cooldown
      const cooldownMs = this.config.errorHandling?.circuitBreakerTimeout || 300000;
      this.circuitBreaker.cooldownUntil = Date.now() + cooldownMs;
      
      this.emit('warning', `Circuit breaker tripped after ${this.circuitBreaker.consecutiveErrors} consecutive errors. Cooling down for ${cooldownMs/1000}s`);
    }
  }

  /**
   * Réinitialise le circuit breaker
   */
  resetCircuitBreaker() {
    this.circuitBreaker.tripped = false;
    this.circuitBreaker.consecutiveErrors = 0;
    this.circuitBreaker.lastError = null;
    this.circuitBreaker.cooldownUntil = null;
  }

  /**
   * Termine et enregistre les métriques d'un cycle
   */
  completeCycle(startTime, success) {
    const cycleDuration = Date.now() - startTime;
    
    // Mettre à jour métriques
    this.metrics.totalCycleDuration += cycleDuration;
    this.metrics.avgCycleDuration = this.metrics.totalCycleDuration / this.metrics.cycleCount;
    
    this.emit('debug', `Completed trading cycle in ${cycleDuration}ms`);
    return success;
  }

  /**
   * Retourne les métriques
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Nettoie les ressources
   */
  cleanup() {
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
    
    this.priceCache.clear();
  }
}

export default CycleManager;