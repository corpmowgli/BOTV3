import EventEmitter from 'events';
import { delay } from '../utils/helpers.js';

export class CycleManager extends EventEmitter {
  constructor(config, dataManager, strategy, riskManager, positionManager, portfolioManager, logger) {
    super();
    this.config = config;
    this.dataManager = dataManager;
    this.strategy = strategy;
    this.riskManager = riskManager;
    this.positionManager = positionManager;
    this.portfolioManager = portfolioManager;
    this.logger = logger;
    this.isRunning = false;
    this.isStopping = false;
    this._cycleInProgress = false;
    this.cycleInterval = null;
    this.metrics = {
      cycleCount: 0, successfulCycles: 0, failedCycles: 0, lastCycleTime: null,
      avgCycleDuration: 0, totalCycleDuration: 0, tokensProcessed: 0, signalsGenerated: 0
    };
    this.circuitBreaker = {
      tripped: false, consecutiveErrors: 0, lastError: null, cooldownUntil: null,
      maxConsecutiveErrors: config.errorHandling?.maxConsecutiveErrors || 3
    };
    this.priceCache = new Map();
    this.priceCacheTime = 0;
    this.priceCacheTTL = 10000;
    this.concurrencyLimit = config.performance?.tokenConcurrency || 5;
  }

  async start() {
    if (this.isRunning) {
      this.emit('warning', 'Cycle manager is already running');
      return false;
    }
    try {
      this.isRunning = true;
      this.isStopping = false;
      this.emit('info', 'Cycle manager started');
      await this.runTradingCycle();
      const interval = this.config.trading.cycleInterval || 60000;
      this.cycleInterval = setInterval(() => this.runTradingCycle(), interval);
      return true;
    } catch (error) {
      this.isRunning = false;
      this.emit('error', error);
      return false;
    }
  }

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

  async runTradingCycle() {
    if (this.isStopping || this.checkCircuitBreaker() || this._cycleInProgress) return false;
    
    this._cycleInProgress = true;
    const cycleStartTime = Date.now();
    this.metrics.cycleCount++;
    this.metrics.lastCycleTime = cycleStartTime;
    
    try {
      this.emit('debug', `Starting trading cycle #${this.metrics.cycleCount}`);
      const tokens = await this.getQualifiedTokens();
      if (!tokens?.length) {
        this.emit('info', 'No qualified tokens found in this cycle');
        return this.completeCycle(cycleStartTime, true);
      }
      await this.preloadMarketData(tokens);
      await this.processTokensBatch(tokens);
      await this.checkPositions();
      this.metrics.successfulCycles++;
      this.resetCircuitBreaker();
      return this.completeCycle(cycleStartTime, true);
    } catch (error) {
      this.metrics.failedCycles++;
      this.incrementCircuitBreaker(error);
      this.emit('error', new Error(`Cycle error: ${error.message}`));
      return this.completeCycle(cycleStartTime, false);
    } finally {
      this._cycleInProgress = false;
    }
  }

  async preloadMarketData(tokens) {
    try {
      const tokenMints = tokens.map(token => token.token_mint);
      if (tokenMints.length > 0) await this.dataManager.getBatchTokenPrices(tokenMints);
    } catch (error) {
      this.emit('warning', `Error preloading market data: ${error.message}`);
    }
  }

  async processTokensBatch(tokens) {
    const batchSize = this.concurrencyLimit;
    const openPositions = this.positionManager.getOpenPositions();
    const openPositionTokens = new Set(openPositions.map(p => p.token));
    const tokensToProcess = tokens.filter(token => !openPositionTokens.has(token.token_mint));
    for (let i = 0; i < tokensToProcess.length; i += batchSize) {
      if (this.isStopping) break;
      const batch = tokensToProcess.slice(i, i + batchSize);
      await Promise.all(batch.map(token => this.processToken(token)));
      this.metrics.tokensProcessed += batch.length;
      if (i + batchSize < tokensToProcess.length && !this.isStopping) {
        await delay(200);
      }
    }
  }

  async getQualifiedTokens() {
    try {
      const marketData = await this.dataManager.getTopTokens(
        this.config.trading.maxTokensToAnalyze || 50
      );
      return marketData.filter(token => 
        token.liquidity >= this.config.trading.minLiquidity &&
        token.volume24h >= this.config.trading.minVolume24h
      );
    } catch (error) {
      this.emit('error', new Error(`Error getting qualified tokens: ${error.message}`));
      return [];
    }
  }

  async processToken(token) {
    try {
      // Ensure we're using consistent token identifiers
      const tokenMint = token.token_mint || token.mint || token.symbol || token;
      
      // Check if position is already open for this token
      if (this.positionManager.getOpenPositions().some(p => p.token === tokenMint)) return;
      
      const [prices, volumes] = await Promise.all([
        this.getHistoricalPrices(tokenMint),
        this.getHistoricalVolumes(tokenMint)
      ]);
      
      if (!prices || prices.length < 20) return;
      
      const signal = await this.strategy.analyze(tokenMint, prices, volumes, token);
      if (signal.type !== 'NONE') this.metrics.signalsGenerated++;
      
      if (signal.type !== 'NONE' && signal.confidence >= this.config.trading.minConfidenceThreshold) {
        if (this.riskManager.canTrade(this.portfolioManager)) {
          try {
            const currentPrice = prices[prices.length - 1];
            const positionSize = this.riskManager.calculatePositionSize(currentPrice, this.portfolioManager);
            
            if (!positionSize || positionSize <= 0) {
              this.emit('warning', `Invalid position size calculated for ${tokenMint}`);
              return;
            }
            
            const position = await this.positionManager.openPosition(
              tokenMint, positionSize, currentPrice, signal.type, 
              { signal, confidence: signal.confidence }
            );
            
            if (position) this.emit('info', `Opened position for ${tokenMint} at ${currentPrice}`);
          } catch (error) {
            this.emit('error', new Error(`Error opening position for ${tokenMint}: ${error.message}`));
          }
        }
      }
    } catch (error) {
      this.emit('error', new Error(`Error processing token ${token.token_mint || token}: ${error.message}`));
    }
  }

  async checkPositions() {
    try {
      const positions = this.positionManager.getOpenPositions();
      if (!positions.length) return;
      
      const currentPrices = await this.getCachedCurrentPrices();
      if (!currentPrices?.size) return;
      
      // Convert currentPrices Map to something the positionManager can use
      const priceMapForManager = {};
      currentPrices.forEach((price, token) => {
        priceMapForManager[token] = price;
      });
      
      // Update positions first to update trailing stops and other values
      const updates = await this.positionManager.updatePositions(currentPrices);
      
      // Then check if any positions need to be closed
      const closedPositions = [];
      for (const position of positions) {
        const price = currentPrices.get(position.token);
        if (!price) continue;
        
        // Check if position should be closed based on conditions
        const { shouldClose, reason } = this.riskManager.shouldClosePosition(position, price);
        
        if (shouldClose) {
          try {
            const closedPosition = await this.positionManager.closePosition(position.id, price, reason);
            if (closedPosition) {
              this.portfolioManager.updatePortfolio(closedPosition);
              const tradeLog = this.logger.logTrade(closedPosition);
              this.emit('trade', tradeLog);
              closedPositions.push(closedPosition);
            }
          } catch (error) {
            this.emit('error', new Error(`Error closing position ${position.id}: ${error.message}`));
          }
        }
      }
      
      if (closedPositions.length > 0) {
        this.emit('info', `Closed ${closedPositions.length} positions`);
      }
      
      return closedPositions;
    } catch (error) {
      this.emit('error', new Error(`Error checking positions: ${error.message}`));
      return [];
    }
  }

  async getCachedCurrentPrices() {
    try {
      const now = Date.now();
      const positions = this.positionManager.getOpenPositions();
      if (!positions.length) return new Map();
      const tokens = positions.map(p => p.token);
      if (this.priceCache.size > 0 && 
          (now - this.priceCacheTime) < this.priceCacheTTL &&
          tokens.every(token => this.priceCache.has(token))) {
        return this.priceCache;
      }
      const priceMap = await this.getCurrentPrices();
      this.priceCache = priceMap;
      this.priceCacheTime = now;
      return priceMap;
    } catch (error) {
      this.emit('error', new Error(`Error getting cached prices: ${error.message}`));
      return new Map();
    }
  }

  async getCurrentPrices() {
    try {
      const positions = this.positionManager.getOpenPositions();
      if (!positions.length) return new Map();
      const tokens = positions.map(p => p.token);
      const batchPrices = await this.dataManager.getBatchTokenPrices(tokens);
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

  async getHistoricalPrices(tokenMint) {
    try {
      const endTime = Date.now();
      const startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      // Use getHistoricalData for consistency
      const priceData = await this.dataManager.getHistoricalData(
        tokenMint, '1h', 7
      );
      // Ensure we're returning the correct data structure
      return priceData?.prices || [];
    } catch (error) {
      this.emit('error', new Error(`Error getting historical prices: ${error.message}`));
      return [];
    }
  }

  async getHistoricalVolumes(tokenMint) {
    try {
      const endTime = Date.now();
      const startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      // Use getHistoricalData which is the proper method
      const data = await this.dataManager.getHistoricalData(
        tokenMint, '1h', 7
      );
      return data?.volumes || [];
    } catch (error) {
      this.emit('error', new Error(`Error getting historical volumes: ${error.message}`));
      return [];
    }
  }

  checkCircuitBreaker() {
    if (!this.circuitBreaker.tripped) return false;
    if (this.circuitBreaker.cooldownUntil && Date.now() > this.circuitBreaker.cooldownUntil) {
      this.resetCircuitBreaker();
      this.emit('info', 'Circuit breaker reset after cooldown period');
      return false;
    }
    return true;
  }

  incrementCircuitBreaker(error) {
    this.circuitBreaker.consecutiveErrors++;
    this.circuitBreaker.lastError = error;
    if (this.circuitBreaker.consecutiveErrors >= this.circuitBreaker.maxConsecutiveErrors) {
      this.circuitBreaker.tripped = true;
      const cooldownMs = this.config.errorHandling?.circuitBreakerTimeout || 300000;
      this.circuitBreaker.cooldownUntil = Date.now() + cooldownMs;
      this.emit('warning', `Circuit breaker tripped after ${this.circuitBreaker.consecutiveErrors} consecutive errors. Cooling down for ${cooldownMs/1000}s`);
    }
  }

  resetCircuitBreaker() {
    this.circuitBreaker.tripped = false;
    this.circuitBreaker.consecutiveErrors = 0;
    this.circuitBreaker.lastError = null;
    this.circuitBreaker.cooldownUntil = null;
  }

  completeCycle(startTime, success) {
    const cycleDuration = Date.now() - startTime;
    this.metrics.totalCycleDuration += cycleDuration;
    this.metrics.avgCycleDuration = this.metrics.totalCycleDuration / this.metrics.cycleCount;
    this.emit('debug', `Completed trading cycle in ${cycleDuration}ms`);
    
    // Emit cycle completion event with metrics
    this.emit('cycle_completed', {
      duration: cycleDuration,
      success,
      cycleCount: this.metrics.cycleCount
    });
    
    return success;
  }

  getMetrics() {
    return { ...this.metrics };
  }

  updateConfig(newConfig) {
    if (newConfig) {
      this.config = { ...this.config, ...newConfig };
      this.concurrencyLimit = this.config.performance?.tokenConcurrency || 5;
    }
  }

  cleanup() {
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
    if (this.priceCache) {
      this.priceCache.clear();
    }
  }
}

export default CycleManager;