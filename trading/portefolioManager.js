// trading/portfolioManager.js

/**
 * Portfolio Manager
 * Manages all aspects of the trading portfolio including:
 * - Capital allocation
 * - Position tracking
 * - Performance metrics
 * - Risk management
 */
export class PortfolioManager {
  /**
   * Create a new portfolio manager
   * @param {number} initialCapital - Initial capital in USD
   * @param {Object} [options={}] - Additional configuration options
   */
  constructor(initialCapital, options = {}) {
    // Portfolio state
    this.initialCapital = initialCapital;
    this.currentCapital = initialCapital;
    this.availableCapital = initialCapital;
    this.peakCapital = initialCapital;
    this.lowestCapital = initialCapital;
    
    // Track positions and history
    this.openPositions = new Map();
    this.closedPositions = [];
    this.history = [{
      timestamp: Date.now(),
      capital: initialCapital,
      type: 'INITIALIZATION',
      change: 0,
      changePercent: 0
    }];
    
    // Daily statistics
    this.dailyStats = {
      date: new Date().toISOString().split('T')[0],
      profit: 0,
      trades: 0,
      volume: 0,
      fees: 0
    };
    
    // Configuration options with defaults
    this.config = {
      feePercentage: options.feePercentage || 0.1,
      trackFees: options.trackFees !== undefined ? options.trackFees : true,
      maxPositions: options.maxPositions || 10,
      maxPercentPerPosition: options.maxPercentPerPosition || 20,
      maxLeverage: options.maxLeverage || 1, // Default: no leverage
      stopLoss: options.stopLoss || 5, // Default: 5% stop loss
      takeProfit: options.takeProfit || 15, // Default: 15% take profit
      reserveCapital: options.reserveCapital || 10, // Default: 10% reserve
      autoPeriodReset: options.autoPeriodReset || false,
      ...options
    };
    
    // Track all asset balances
    this.assetBalances = new Map();
    this.assetBalances.set('USD', initialCapital);
    
    // Event listeners
    this.positionListeners = [];
    this.statsListeners = [];
    
    // Initialize performance metrics cache
    this.performanceCache = null;
    this.performanceCacheTime = 0;
  }

  /**
   * Open a new position
   * @param {string} token - Token/asset identifier
   * @param {number} entryPrice - Entry price
   * @param {number} amount - Amount to buy (in token units)
   * @param {Object} [metadata={}] - Additional position metadata
   * @returns {Object|null} The position object or null if failed
   */
  openPosition(token, entryPrice, amount, metadata = {}) {
    // Check if too many positions are already open
    if (this.openPositions.size >= this.config.maxPositions) {
      console.warn(`Cannot open position: maximum positions (${this.config.maxPositions}) reached`);
      return null;
    }
    
    // Calculate position value and check if enough capital is available
    const positionValue = entryPrice * amount;
    const fees = this.config.trackFees ? (positionValue * this.config.feePercentage / 100) : 0;
    const totalCost = positionValue + fees;
    
    if (totalCost > this.availableCapital) {
      console.warn(`Cannot open position: insufficient capital (need ${totalCost}, have ${this.availableCapital})`);
      return null;
    }
    
    // Check position size against max allowed percentage
    const maxPositionSize = this.currentCapital * (this.config.maxPercentPerPosition / 100);
    if (positionValue > maxPositionSize) {
      console.warn(`Position size ${positionValue} exceeds maximum allowed (${maxPositionSize})`);
      return null;
    }
    
    // Generate a unique ID for the position
    const positionId = this.generatePositionId(token);
    
    // Create position object
    const position = {
      id: positionId,
      token,
      entryPrice,
      amount,
      value: positionValue,
      fees,
      timestamp: Date.now(),
      stopLoss: metadata.stopLoss || (entryPrice * (1 - this.config.stopLoss / 100)),
      takeProfit: metadata.takeProfit || (entryPrice * (1 + this.config.takeProfit / 100)),
      metadata: { ...metadata },
      status: 'OPEN'
    };
    
    // Update available capital
    this.availableCapital -= totalCost;
    
    // Update asset balances
    this.updateAssetBalance(token, amount, 'add');
    this.updateAssetBalance('USD', -totalCost, 'add');
    
    // Store position
    this.openPositions.set(positionId, position);
    
    // Update daily stats
    this.dailyStats.trades += 1;
    this.dailyStats.volume += positionValue;
    this.dailyStats.fees += fees;
    
    // Add to history
    this.history.push({
      timestamp: position.timestamp,
      capital: this.currentCapital,
      type: 'OPEN_POSITION',
      tokenAmount: amount,
      token,
      positionId,
      positionValue,
      fees
    });
    
    // Notify listeners
    this.notifyPositionListeners('open', position);
    
    return position;
  }

  /**
   * Close an existing position
   * @param {string} positionId - ID of the position to close
   * @param {number} exitPrice - Exit price
   * @param {Object} [metadata={}] - Additional metadata for closure
   * @returns {Object|null} Closed position details or null if failed
   */
  closePosition(positionId, exitPrice, metadata = {}) {
    if (!this.openPositions.has(positionId)) {
      console.warn(`Cannot close position: position with ID ${positionId} not found`);
      return null;
    }
    
    // Get position
    const position = this.openPositions.get(positionId);
    const { token, amount, entryPrice, fees: entryFees } = position;
    
    // Calculate exit value and fees
    const exitValue = exitPrice * amount;
    const exitFees = this.config.trackFees ? (exitValue * this.config.feePercentage / 100) : 0;
    
    // Calculate profit/loss
    const profit = exitValue - (position.value + entryFees + exitFees);
    const profitPercentage = (profit / position.value) * 100;
    
    // Update position with closure details
    const closedPosition = {
      ...position,
      exitPrice,
      exitValue,
      exitFees,
      profit,
      profitPercentage,
      closeTimestamp: Date.now(),
      holdingPeriod: Date.now() - position.timestamp,
      status: 'CLOSED',
      closeMeta: { ...metadata }
    };
    
    // Remove from open positions
    this.openPositions.delete(positionId);
    
    // Add to closed positions
    this.closedPositions.push(closedPosition);
    
    // Update current and available capital
    this.currentCapital += profit;
    this.availableCapital += exitValue - exitFees;
    
    // Update asset balances
    this.updateAssetBalance(token, -amount, 'add');
    this.updateAssetBalance('USD', exitValue - exitFees, 'add');
    
    // Update peak capital if we've reached a new high
    if (this.currentCapital > this.peakCapital) {
      this.peakCapital = this.currentCapital;
    }
    
    // Update lowest capital if we've reached a new low
    if (this.currentCapital < this.lowestCapital) {
      this.lowestCapital = this.currentCapital;
    }
    
    // Update daily stats
    this.updateDailyStats(profit, exitValue, exitFees);
    
    // Add to history
    this.history.push({
      timestamp: closedPosition.closeTimestamp,
      capital: this.currentCapital,
      type: 'CLOSE_POSITION',
      token,
      positionId,
      profit,
      profitPercentage,
      holdingPeriod: closedPosition.holdingPeriod
    });
    
    // Notify listeners
    this.notifyPositionListeners('close', closedPosition);
    
    // Reset performance cache
    this.performanceCache = null;
    
    return closedPosition;
  }

  /**
   * Update the pricing of all open positions
   * @param {Object} currentPrices - Map or object of current prices keyed by token
   * @returns {Object} Portfolio valuation details
   */
  updatePositionValues(currentPrices) {
    let portfolioValue = this.availableCapital;
    let unrealizedProfit = 0;
    
    for (const [positionId, position] of this.openPositions.entries()) {
      const currentPrice = currentPrices[position.token] || currentPrices.get?.(position.token);
      
      if (currentPrice) {
        // Calculate current value and unrealized P&L
        const currentValue = currentPrice * position.amount;
        const positionProfit = currentValue - position.value - position.fees;
        const profitPercentage = (positionProfit / position.value) * 100;
        
        // Update position
        position.currentPrice = currentPrice;
        position.currentValue = currentValue;
        position.unrealizedProfit = positionProfit;
        position.unrealizedProfitPercentage = profitPercentage;
        
        // Add to portfolio valuation
        portfolioValue += currentValue;
        unrealizedProfit += positionProfit;
      }
    }
    
    // Check for stop loss or take profit triggers
    this.checkPositionTriggers(currentPrices);
    
    return {
      portfolioValue,
      openPositionsValue: portfolioValue - this.availableCapital,
      availableCapital: this.availableCapital,
      unrealizedProfit,
      unrealizedProfitPercentage: this.currentCapital ? (unrealizedProfit / this.currentCapital) * 100 : 0
    };
  }

  /**
   * Check all positions for stop loss or take profit triggers
   * @private
   * @param {Object} currentPrices - Map or object of current prices keyed by token
   * @returns {Array} Positions that were automatically closed
   */
  checkPositionTriggers(currentPrices) {
    const closedPositions = [];
    
    for (const [positionId, position] of this.openPositions.entries()) {
      const currentPrice = currentPrices[position.token] || currentPrices.get?.(position.token);
      
      if (!currentPrice) continue;
      
      // Check stop loss
      if (position.stopLoss && currentPrice <= position.stopLoss) {
        const closed = this.closePosition(positionId, currentPrice, {
          triggerType: 'STOP_LOSS',
          automatic: true
        });
        
        if (closed) {
          closedPositions.push(closed);
        }
      }
      
      // Check take profit
      else if (position.takeProfit && currentPrice >= position.takeProfit) {
        const closed = this.closePosition(positionId, currentPrice, {
          triggerType: 'TAKE_PROFIT',
          automatic: true
        });
        
        if (closed) {
          closedPositions.push(closed);
        }
      }
    }
    
    return closedPositions;
  }

  /**
   * Update a position's stop loss or take profit levels
   * @param {string} positionId - ID of the position to update
   * @param {Object} updates - Updates to apply
   * @param {number} [updates.stopLoss] - New stop loss level
   * @param {number} [updates.takeProfit] - New take profit level
   * @returns {boolean} Success or failure
   */
  updatePositionParameters(positionId, updates) {
    if (!this.openPositions.has(positionId)) {
      console.warn(`Cannot update position: position with ID ${positionId} not found`);
      return false;
    }
    
    const position = this.openPositions.get(positionId);
    
    // Update stop loss if provided
    if (updates.stopLoss !== undefined) {
      position.stopLoss = updates.stopLoss;
    }
    
    // Update take profit if provided
    if (updates.takeProfit !== undefined) {
      position.takeProfit = updates.takeProfit;
    }
    
    // Update metadata if provided
    if (updates.metadata) {
      position.metadata = { ...position.metadata, ...updates.metadata };
    }
    
    // Add to history
    this.history.push({
      timestamp: Date.now(),
      type: 'UPDATE_POSITION',
      positionId,
      updates
    });
    
    return true;
  }

  /**
   * Calculate maximum position size based on risk parameters
   * @param {string} token - Token to calculate for
   * @param {number} price - Current price of the token
   * @param {Object} [options={}] - Additional options 
   * @returns {Object} Maximum position details
   */
  calculateMaxPositionSize(token, price, options = {}) {
    const {
      riskPercent = this.config.maxPercentPerPosition,
      useAvailable = true
    } = options;
    
    // Calculate base on either available or total capital
    const baseCapital = useAvailable ? this.availableCapital : this.currentCapital;
    
    // Maximum allocation based on percentage
    const maxAllocation = baseCapital * (riskPercent / 100);
    
    // Apply leverage if configured 
    const leveragedAllocation = maxAllocation * this.config.maxLeverage;
    
    // Calculate amount in token units
    const amount = leveragedAllocation / price;
    
    return {
      maxAmount: amount,
      maxValue: leveragedAllocation,
      price,
      token
    };
  }

  /**
   * Get comprehensive portfolio metrics
   * @returns {Object} Detailed portfolio metrics
   */
  getMetrics() {
    // Use cached metrics if recent enough (< 5 seconds)
    if (this.performanceCache && (Date.now() - this.performanceCacheTime < 5000)) {
      return this.performanceCache;
    }
    
    // Count winning and losing positions
    const winningPositions = this.closedPositions.filter(p => p.profit > 0);
    const losingPositions = this.closedPositions.filter(p => p.profit < 0);
    
    // Calculate basic metrics
    const totalProfit = this.currentCapital - this.initialCapital;
    const totalPositions = this.closedPositions.length;
    const winRate = totalPositions > 0 ? (winningPositions.length / totalPositions) * 100 : 0;
    
    // Calculate position metrics
    const averageWin = winningPositions.length > 0 
      ? winningPositions.reduce((sum, pos) => sum + pos.profit, 0) / winningPositions.length 
      : 0;
    
    const averageLoss = losingPositions.length > 0 
      ? losingPositions.reduce((sum, pos) => sum + pos.profit, 0) / losingPositions.length 
      : 0;
    
    const biggestWin = winningPositions.length > 0 
      ? Math.max(...winningPositions.map(p => p.profit)) 
      : 0;
    
    const biggestLoss = losingPositions.length > 0 
      ? Math.min(...losingPositions.map(p => p.profit)) 
      : 0;
    
    // Calculate profit factor
    const grossProfit = winningPositions.reduce((sum, p) => sum + p.profit, 0);
    const grossLoss = Math.abs(losingPositions.reduce((sum, p) => sum + p.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    // Calculate maximum drawdown
    const maxDrawdown = ((this.peakCapital - this.lowestCapital) / this.peakCapital) * 100;
    
    // Calculate holding times
    const avgHoldingPeriod = totalPositions > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.holdingPeriod, 0) / totalPositions
      : 0;
    
    // Calculate total volume traded
    const totalVolume = this.closedPositions.reduce((sum, p) => sum + p.value, 0);
    
    // Calculate total fees paid
    const totalFees = this.closedPositions.reduce((sum, p) => sum + p.fees + (p.exitFees || 0), 0);
    
    // Assemble metrics
    const metrics = {
      initialCapital: this.initialCapital,
      currentCapital: this.currentCapital,
      availableCapital: this.availableCapital,
      totalProfit,
      totalProfitPercentage: (totalProfit / this.initialCapital) * 100,
      totalPositions,
      openPositions: this.openPositions.size,
      winningPositions: winningPositions.length,
      losingPositions: losingPositions.length,
      winRate,
      averageWin,
      averageLoss,
      averageHoldingPeriodMs: avgHoldingPeriod,
      averageHoldingPeriodHours: avgHoldingPeriod / (1000 * 60 * 60),
      biggestWin,
      biggestLoss,
      profitFactor,
      maxDrawdown,
      totalVolume,
      totalFees,
      assetBalances: Object.fromEntries(this.assetBalances),
      lastUpdated: new Date().toISOString()
    };
    
    // Cache metrics
    this.performanceCache = metrics;
    this.performanceCacheTime = Date.now();
    
    return metrics;
  }

  /**
   * Get open positions with current valuations
   * @returns {Array} Open positions
   */
  getOpenPositions() {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get closed positions with profit/loss details
   * @param {number} [limit] - Maximum number of positions to return
   * @param {number} [offset] - Offset for pagination
   * @returns {Array} Closed positions
   */
  getClosedPositions(limit, offset = 0) {
    const positions = [...this.closedPositions]
      .sort((a, b) => b.closeTimestamp - a.closeTimestamp); // Newest first
    
    if (limit) {
      return positions.slice(offset, offset + limit);
    }
    
    return positions;
  }

  /**
   * Get portfolio history
   * @param {number} [limit] - Maximum number of entries to return
   * @returns {Array} Portfolio history entries
   */
  getHistory(limit) {
    const history = [...this.history].sort((a, b) => b.timestamp - a.timestamp);
    
    if (limit) {
      return history.slice(0, limit);
    }
    
    return history;
  }

  /**
   * Add capital to the portfolio
   * @param {number} amount - Amount to add
   * @param {string} [source='DEPOSIT'] - Source of the funds
   * @returns {Object} Updated portfolio metrics
   */
  addCapital(amount, source = 'DEPOSIT') {
    if (amount <= 0) {
      console.warn('Cannot add capital: amount must be positive');
      return null;
    }
    
    this.currentCapital += amount;
    this.availableCapital += amount;
    this.updateAssetBalance('USD', amount, 'add');
    
    // Update peak capital if necessary
    if (this.currentCapital > this.peakCapital) {
      this.peakCapital = this.currentCapital;
    }
    
    // Add to history
    this.history.push({
      timestamp: Date.now(),
      capital: this.currentCapital,
      type: 'ADD_CAPITAL',
      amount,
      source
    });
    
    // Notify listeners
    this.notifyStatsListeners('capital', {
      action: 'add',
      amount,
      newCapital: this.currentCapital,
      source
    });
    
    // Reset performance cache
    this.performanceCache = null;
    
    return this.getMetrics();
  }

  /**
   * Withdraw capital from the portfolio
   * @param {number} amount - Amount to withdraw
   * @param {string} [destination='WITHDRAWAL'] - Destination of the funds
   * @returns {Object|null} Updated portfolio metrics or null if failed
   */
  withdrawCapital(amount, destination = 'WITHDRAWAL') {
    if (amount <= 0) {
      console.warn('Cannot withdraw capital: amount must be positive');
      return null;
    }
    
    if (amount > this.availableCapital) {
      console.warn(`Cannot withdraw capital: amount (${amount}) exceeds available capital (${this.availableCapital})`);
      return null;
    }
    
    this.currentCapital -= amount;
    this.availableCapital -= amount;
    this.updateAssetBalance('USD', -amount, 'add');
    
    // Update lowest capital if necessary
    if (this.currentCapital < this.lowestCapital) {
      this.lowestCapital = this.currentCapital;
    }
    
    // Add to history
    this.history.push({
      timestamp: Date.now(),
      capital: this.currentCapital,
      type: 'WITHDRAW_CAPITAL',
      amount,
      destination
    });
    
    // Notify listeners
    this.notifyStatsListeners('capital', {
      action: 'withdraw',
      amount,
      newCapital: this.currentCapital,
      destination
    });
    
    // Reset performance cache
    this.performanceCache = null;
    
    return this.getMetrics();
  }

  /**
   * Reset portfolio statistics for a new period
   * @param {boolean} [keepPositions=true] - Whether to keep open positions
   * @returns {Object} New portfolio state
   */
  resetPeriod(keepPositions = true) {
    // Store metrics for the completed period
    const completedPeriod = {
      endDate: new Date().toISOString(),
      metrics: this.getMetrics(),
      closedPositions: [...this.closedPositions]
    };
    
    // Reset statistics
    if (keepPositions) {
      // Keep open positions, reset only closed positions and statistics
      this.closedPositions = [];
      this.history = [{
        timestamp: Date.now(),
        capital: this.currentCapital,
        type: 'PERIOD_RESET',
        previousCapital: this.initialCapital,
        previousProfit: this.currentCapital - this.initialCapital
      }];
      
      // Set initial capital to current capital for the new period
      this.initialCapital = this.currentCapital;
      this.peakCapital = this.currentCapital;
      this.lowestCapital = this.currentCapital;
    } else {
      // Close all open positions at current valuation
      // This would need current price data, so it's a placeholder
      // In a real implementation, you'd pass in current prices and close positions
      
      // Reset everything
      this.openPositions = new Map();
      this.closedPositions = [];
      this.history = [{
        timestamp: Date.now(),
        capital: this.currentCapital,
        type: 'FULL_RESET',
        previousCapital: this.initialCapital
      }];
      
      // Set initial capital to current capital for the new period
      this.initialCapital = this.currentCapital;
      this.availableCapital = this.currentCapital;
      this.peakCapital = this.currentCapital;
      this.lowestCapital = this.currentCapital;
    }
    
    // Reset daily stats
    this.resetDailyStats();
    
    // Reset performance cache
    this.performanceCache = null;
    
    // Notify listeners
    this.notifyStatsListeners('reset', {
      keepPositions,
      completedPeriod
    });
    
    return {
      currentCapital: this.currentCapital,
      availableCapital: this.availableCapital,
      openPositions: this.getOpenPositions(),
      completedPeriod
    };
  }

  /**
   * Generate a unique position ID
   * @private
   * @param {string} token - Token identifier
   * @returns {string} Unique position ID
   */
  generatePositionId(token) {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `${token}-${timestamp}-${random}`;
  }

  /**
   * Update daily statistics
   * @private
   * @param {number} profit - Profit from a closed position
   * @param {number} volume - Trading volume
   * @param {number} fees - Fees paid
   */
  updateDailyStats(profit, volume, fees) {
    const currentDate = new Date().toISOString().split('T')[0];
    
    // If we've moved to a new day, reset the stats
    if (currentDate !== this.dailyStats.date) {
      this.resetDailyStats();
    }
    
    // Update the daily stats
    this.dailyStats.profit += profit;
    this.dailyStats.volume += volume;
    this.dailyStats.fees += fees;
    
    // Notify listeners
    this.notifyStatsListeners('daily', this.dailyStats);
  }

  /**
   * Reset daily statistics
   * @private
   */
  resetDailyStats() {
    this.dailyStats = {
      date: new Date().toISOString().split('T')[0],
      profit: 0,
      trades: 0,
      volume: 0,
      fees: 0
    };
  }

  /**
   * Update asset balance
   * @private
   * @param {string} asset - Asset identifier
   * @param {number} amount - Amount to add or set
   * @param {string} [operation='set'] - Operation: 'add' or 'set'
   */
  updateAssetBalance(asset, amount, operation = 'set') {
    const currentBalance = this.assetBalances.get(asset) || 0;
    
    if (operation === 'add') {
      this.assetBalances.set(asset, currentBalance + amount);
    } else {
      this.assetBalances.set(asset, amount);
    }
    
    // Remove zero balances
    if (this.assetBalances.get(asset) === 0) {
      this.assetBalances.delete(asset);
    }
  }

  /**
   * Add a position change listener
   * @param {Function} callback - Callback function
   * @returns {Function} Unsubscribe function
   */
  onPositionChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.positionListeners.push(callback);
    
    // Return unsubscribe function
    return () => {
      this.positionListeners = this.positionListeners.filter(cb => cb !== callback);
    };
  }

  /**
   * Add a stats change listener
   * @param {Function} callback - Callback function
   * @returns {Function} Unsubscribe function
   */
  onStatsChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.statsListeners.push(callback);
    
    // Return unsubscribe function
    return () => {
      this.statsListeners = this.statsListeners.filter(cb => cb !== callback);
    };
  }

  /**
   * Notify position listeners of a change
   * @private
   * @param {string} event - Event type
   * @param {Object} position - Position data
   */
  notifyPositionListeners(event, position) {
    this.positionListeners.forEach(callback => {
      try {
        callback(event, position);
      } catch (error) {
        console.error('Error in position listener callback:', error);
      }
    });
  }

  /**
   * Notify stats listeners of a change
   * @private
   * @param {string} event - Event type
   * @param {Object} data - Stats data
   */
  notifyStatsListeners(event, data) {
    this.statsListeners.forEach(callback => {
      try {
        callback(event, data);
      } catch (error) {
        console.error('Error in stats listener callback:', error);
      }
    });
  }

  /**
   * Get daily performance statistics
   * @returns {Object} Daily performance data
   */
  getDailyStats() {
    return { ...this.dailyStats };
  }
  
  /**
   * Calculate portfolio valuation including open positions
   * @param {Object} currentPrices - Current prices by token
   * @returns {Object} Total portfolio valuation
   */
  getPortfolioValuation(currentPrices) {
    // Update position values with current prices
    const valuation = this.updatePositionValues(currentPrices);
    
    return {
      ...valuation,
      initialCapital: this.initialCapital,
      totalProfit: (valuation.portfolioValue - this.initialCapital),
      totalProfitPercentage: ((valuation.portfolioValue - this.initialCapital) / this.initialCapital) * 100,
      timestamp: Date.now()
    };
  }

  /**
   * Export portfolio data
   * @param {boolean} [includeHistory=true] - Whether to include full history
   * @returns {Object} Portfolio data
   */
  exportData(includeHistory = true) {
    const exportData = {
      metrics: this.getMetrics(),
      openPositions: this.getOpenPositions(),
      closedPositions: this.getClosedPositions(),
      assetBalances: Object.fromEntries(this.assetBalances),
      config: { ...this.config },
      exportTime: new Date().toISOString()
    };
    
    if (includeHistory) {
      exportData.history = this.getHistory();
    }
    
    return exportData;
  }

  /**
   * Import portfolio data
   * @param {Object} data - Portfolio data to import
   * @param {boolean} [merge=false] - Whether to merge with existing data
   * @returns {boolean} Success or failure
   */
  importData(data, merge = false) {
    try {
      if (!data || !data.metrics) {
        console.error('Invalid portfolio data format');
        return false;
      }
      
      if (!merge) {
        // Replace all data
        this.initialCapital = data.metrics.initialCapital;
        this.currentCapital = data.metrics.currentCapital;
        this.availableCapital = data.metrics.availableCapital;
        this.peakCapital = data.metrics.initialCapital;
        this.lowestCapital = data.metrics.initialCapital;
        
        this.openPositions = new Map();
        this.closedPositions = [];
        this.history = [];
        this.assetBalances = new Map();
        
        // Import asset balances
        if (data.assetBalances) {
          Object.entries(data.assetBalances).forEach(([asset, balance]) => {
            this.assetBalances.set(asset, balance);
          });
        }
        
        // Import open positions
        if (data.openPositions) {
          data.openPositions.forEach(position => {
            this.openPositions.set(position.id, { ...position });
          });
        }
        
        // Import closed positions
        if (data.closedPositions) {
          this.closedPositions = [...data.closedPositions];
        }
        
        // Import history
        if (data.history) {
          this.history = [...data.history];
        }
        
        // Config
        if (data.config) {
          this.config = { ...this.config, ...data.config };
        }
      } else {
        // Merge data
        // This would be more complex and require careful handling of conflicts
        // Not fully implemented in this example
        console.warn('Merge import not fully implemented');
        return false;
      }
      
      // Recalculate statistics
      this.performanceCache = null;
      this.getMetrics();
      
      return true;
    } catch (error) {
      console.error('Error importing portfolio data:', error);
      return false;
    }
  }
}

export default PortfolioManager;