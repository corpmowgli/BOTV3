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
      cycleCount: 0, 
      successfulCycles: 0, 
      failedCycles: 0, 
      lastCycleTime: null,
      avgCycleDuration: 0, 
      totalCycleDuration: 0, 
      tokensProcessed: 0, 
      signalsGenerated: 0
    };
    this.circuitBreaker = {
      tripped: false, 
      consecutiveErrors: 0, 
      lastError: null, 
      cooldownUntil: null,
      maxConsecutiveErrors: config.errorHandling?.maxConsecutiveErrors || 3
    };
    this.priceCache = new Map();
    this.priceCacheTime = 0;
    this.priceCacheTTL = 10000;
    this.concurrencyLimit = config.performance?.tokenConcurrency || 5;
    this.tokenProcessingQueue = [];
    this.positionCheckInterval = null;
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
      
      // Separate interval for checking positions more frequently
      const positionCheckFrequency = Math.min(30000, interval / 2);
      this.positionCheckInterval = setInterval(() => this.checkPositions(), positionCheckFrequency);
      
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
      if (this.positionCheckInterval) {
        clearInterval(this.positionCheckInterval);
        this.positionCheckInterval = null;
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
      if (tokenMints.length > 0) {
        // Use Promise.all to load batch prices and market data in parallel
        await Promise.all([
          this.dataManager.getBatchTokenPrices(tokenMints),
          this.preloadMarketDataForTopTokens(tokenMints.slice(0, 10))
        ]);
      }
    } catch (error) {
      this.emit('warning', `Error preloading market data: ${error.message}`);
    }
  }
  
  async preloadMarketDataForTopTokens(tokenMints) {
    // Preload historical data for top tokens
    const promises = tokenMints.map(token => 
      this.dataManager.getHistoricalData(token, '1h', 7)
        .catch(err => this.emit('debug', `Error preloading history for ${token}: ${err.message}`))
    );
    await Promise.allSettled(promises);
  }

  async processTokensBatch(tokens) {
    const batchSize = this.concurrencyLimit;
    const openPositions = this.positionManager.getOpenPositions();
    const openPositionTokens = new Set(openPositions.map(p => p.token));
    
    // Filter out tokens that already have open positions
    this.tokenProcessingQueue = tokens.filter(token => !openPositionTokens.has(token.token_mint));
    
    const processBatch = async () => {
      if (this.isStopping || this.tokenProcessingQueue.length === 0) return;
      
      const batch = this.tokenProcessingQueue.splice(0, batchSize);
      const batchPromises = batch.map(token => this.processToken(token));
      
      // Use Promise.allSettled to handle errors without interrupting the batch
      const results = await Promise.allSettled(batchPromises);
      
      // Count processed tokens and log any errors
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          this.metrics.tokensProcessed++;
        } else {
          this.emit('warning', `Error processing ${batch[index].token_mint}: ${result.reason.message}`);
        }
      });
      
      // Process next batch if there are more tokens and not stopping
      if (this.tokenProcessingQueue.length > 0 && !this.isStopping) {
        await delay(200);
        await processBatch();
      }
    };
    
    await processBatch();
  }

  async getQualifiedTokens() {
    try {
      const marketData = await this.dataManager.getTopTokens(
        this.config.trading.maxTokensToAnalyze || 50
      );
      
      // Filter for qualified tokens based on configured criteria
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
      
      // Load historical data in parallel
      const [priceData, volumeData] = await Promise.all([
        this.getHistoricalPrices(tokenMint),
        this.getHistoricalVolumes(tokenMint)
      ]);
      
      if (!priceData || priceData.length < 20) return;
      
      // Analyze token for trading signals
      const signal = await this.strategy.analyze(tokenMint, priceData, volumeData, token);
      if (signal.type !== 'NONE') this.metrics.signalsGenerated++;
      
      // Check if signal meets confidence threshold
      if (signal.type !== 'NONE' && signal.confidence >= this.config.trading.minConfidenceThreshold) {
        if (this.riskManager.canTrade(this.portfolioManager)) {
          try {
            const currentPrice = priceData[priceData.length - 1];
            const positionSize = this.riskManager.calculatePositionSize(currentPrice, this.portfolioManager);
            
            if (!positionSize || positionSize <= 0) {
              this.emit('warning', `Invalid position size calculated for ${tokenMint}`);
              return;
            }
            
            // Calculate optimal entry parameters
            const riskParams = this.riskManager.calculatePositionRisk(
              tokenMint, 
              currentPrice, 
              positionSize, 
              signal.confidence, 
              { volatility: token.volatility || 'medium' }
            );
            
            // Open position with enhanced parameters
            const position = await this.positionManager.openPosition(
              tokenMint, 
              positionSize, 
              currentPrice, 
              signal.type, 
              { 
                signal, 
                confidence: signal.confidence,
                stopLoss: riskParams.stopLoss,
                takeProfit: riskParams.takeProfit,
                trailingStop: riskParams.trailingStop
              }
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
      
      // Check if cache is valid
      if (this.priceCache.size > 0 && 
          (now - this.priceCacheTime) < this.priceCacheTTL &&
          tokens.every(token => this.priceCache.has(token))) {
        return this.priceCache;
      }
      
      // If cache is invalid or incomplete, get fresh prices
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
          if (price !== undefined && price !== null) {
            priceMap.set(token, price);
          }
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
      
      // If running, consider restarting intervals with new timings
      if (this.isRunning && this.cycleInterval && newConfig.trading?.cycleInterval) {
        clearInterval(this.cycleInterval);
        this.cycleInterval = setInterval(
          () => this.runTradingCycle(), 
          this.config.trading.cycleInterval
        );
        
        // Update position check interval if needed
        if (this.positionCheckInterval) {
          clearInterval(this.positionCheckInterval);
          const positionCheckFrequency = Math.min(30000, this.config.trading.cycleInterval / 2);
          this.positionCheckInterval = setInterval(
            () => this.checkPositions(),
            positionCheckFrequency
          );
        }
      }
    }
  }

  cleanup() {
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = null;
    }
    if (this.priceCache) {
      this.priceCache.clear();
    }
  }
}

export default CycleManager;