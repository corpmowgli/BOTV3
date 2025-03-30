export class PortfolioManager {
  constructor(initialCapital, options = {}) {
    this.initialCapital = initialCapital;
    this.currentCapital = initialCapital;
    this.availableCapital = initialCapital;
    this.peakCapital = initialCapital;
    this.lowestCapital = initialCapital;
    
    this.openPositions = new Map();
    this.closedPositions = [];
    this.history = [{
      timestamp: Date.now(),
      capital: initialCapital,
      type: 'INITIALIZATION',
      change: 0,
      changePercent: 0
    }];
    
    this.dailyStats = {
      date: new Date().toISOString().split('T')[0],
      profit: 0,
      trades: 0,
      volume: 0,
      fees: 0
    };
    
    this.config = {
      feePercentage: options.feePercentage || 0.1,
      trackFees: options.trackFees !== undefined ? options.trackFees : true,
      maxPositions: options.maxPositions || 10,
      maxPercentPerPosition: options.maxPercentPerPosition || 20,
      maxLeverage: options.maxLeverage || 1,
      stopLoss: options.stopLoss || 5,
      takeProfit: options.takeProfit || 15,
      reserveCapital: options.reserveCapital || 10,
      autoPeriodReset: options.autoPeriodReset || false,
      ...options
    };
    
    this.assetBalances = new Map();
    this.assetBalances.set('USD', initialCapital);
    
    this.positionListeners = [];
    this.statsListeners = [];
    
    this.performanceCache = null;
    this.performanceCacheTime = 0;
  }

  openPosition(token, entryPrice, amount, metadata = {}) {
    if (this.openPositions.size >= this.config.maxPositions) {
      console.warn(`Cannot open position: maximum positions (${this.config.maxPositions}) reached`);
      return null;
    }
    
    const positionValue = entryPrice * amount;
    const fees = this.config.trackFees ? (positionValue * this.config.feePercentage / 100) : 0;
    const totalCost = positionValue + fees;
    
    if (totalCost > this.availableCapital) {
      console.warn(`Cannot open position: insufficient capital (need ${totalCost}, have ${this.availableCapital})`);
      return null;
    }
    
    const maxPositionSize = this.currentCapital * (this.config.maxPercentPerPosition / 100);
    if (positionValue > maxPositionSize) {
      console.warn(`Position size ${positionValue} exceeds maximum allowed (${maxPositionSize})`);
      return null;
    }
    
    const positionId = this.generatePositionId(token);
    
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
    
    this.availableCapital -= totalCost;
    
    this.updateAssetBalance(token, amount, 'add');
    this.updateAssetBalance('USD', -totalCost, 'add');
    
    this.openPositions.set(positionId, position);
    
    this.dailyStats.trades += 1;
    this.dailyStats.volume += positionValue;
    this.dailyStats.fees += fees;
    
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
    
    this.notifyPositionListeners('open', position);
    
    return position;
  }

  closePosition(positionId, exitPrice, metadata = {}) {
    if (!this.openPositions.has(positionId)) {
      console.warn(`Cannot close position: position with ID ${positionId} not found`);
      return null;
    }
    
    const position = this.openPositions.get(positionId);
    const { token, amount, entryPrice, fees: entryFees } = position;
    
    const exitValue = exitPrice * amount;
    const exitFees = this.config.trackFees ? (exitValue * this.config.feePercentage / 100) : 0;
    
    const profit = exitValue - (position.value + entryFees + exitFees);
    const profitPercentage = (profit / position.value) * 100;
    
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
    
    this.openPositions.delete(positionId);
    this.closedPositions.push(closedPosition);
    
    this.currentCapital += profit;
    this.availableCapital += exitValue - exitFees;
    
    this.updateAssetBalance(token, -amount, 'add');
    this.updateAssetBalance('USD', exitValue - exitFees, 'add');
    
    if (this.currentCapital > this.peakCapital) this.peakCapital = this.currentCapital;
    if (this.currentCapital < this.lowestCapital) this.lowestCapital = this.currentCapital;
    
    this.updateDailyStats(profit, exitValue, exitFees);
    
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
    
    this.notifyPositionListeners('close', closedPosition);
    this.performanceCache = null;
    
    return closedPosition;
  }

  updatePositionValues(currentPrices) {
    let portfolioValue = this.availableCapital;
    let unrealizedProfit = 0;
    
    // Ensure currentPrices is usable regardless of being a Map or object
    const getPriceForToken = (token) => {
      if (!token) return null;
      if (currentPrices instanceof Map) return currentPrices.get(token);
      return typeof currentPrices === 'object' ? currentPrices[token] : null;
    };
    
    for (const [positionId, position] of this.openPositions.entries()) {
      if (!position || !position.token) continue;
      
      const currentPrice = getPriceForToken(position.token);
      
      if (currentPrice) {
        const currentValue = currentPrice * position.amount;
        const positionProfit = currentValue - position.value - (position.fees || 0);
        const profitPercentage = (positionProfit / position.value) * 100;
        
        position.currentPrice = currentPrice;
        position.currentValue = currentValue;
        position.unrealizedProfit = positionProfit;
        position.unrealizedProfitPercentage = profitPercentage;
        
        portfolioValue += currentValue;
        unrealizedProfit += positionProfit;
      }
    }
    
    this.checkPositionTriggers(currentPrices);
    
    return {
      portfolioValue,
      openPositionsValue: portfolioValue - this.availableCapital,
      availableCapital: this.availableCapital,
      unrealizedProfit,
      unrealizedProfitPercentage: this.currentCapital ? (unrealizedProfit / this.currentCapital) * 100 : 0
    };
  }

  checkPositionTriggers(currentPrices) {
    const closedPositions = [];
    
    // Normalize currentPrices to be able to check consistently
    const getPriceForToken = (token) => {
      if (!token) return null;
      if (currentPrices instanceof Map) return currentPrices.get(token);
      return typeof currentPrices === 'object' ? currentPrices[token] : null;
    };
    
    for (const [positionId, position] of this.openPositions.entries()) {
      const currentPrice = getPriceForToken(position.token);
      
      if (!currentPrice) continue;
      
      if (position.stopLoss && currentPrice <= position.stopLoss) {
        const closed = this.closePosition(positionId, currentPrice, {
          triggerType: 'STOP_LOSS',
          automatic: true
        });
        
        if (closed) closedPositions.push(closed);
      } else if (position.takeProfit && currentPrice >= position.takeProfit) {
        const closed = this.closePosition(positionId, currentPrice, {
          triggerType: 'TAKE_PROFIT',
          automatic: true
        });
        
        if (closed) closedPositions.push(closed);
      }
    }
    
    return closedPositions;
  }

  updatePositionParameters(positionId, updates) {
    if (!this.openPositions.has(positionId)) {
      console.warn(`Cannot update position: position with ID ${positionId} not found`);
      return false;
    }
    
    const position = this.openPositions.get(positionId);
    
    if (updates.stopLoss !== undefined) position.stopLoss = updates.stopLoss;
    if (updates.takeProfit !== undefined) position.takeProfit = updates.takeProfit;
    if (updates.metadata) position.metadata = { ...position.metadata, ...updates.metadata };
    
    this.history.push({
      timestamp: Date.now(),
      type: 'UPDATE_POSITION',
      positionId,
      updates
    });
    
    return true;
  }

  calculateMaxPositionSize(token, price, options = {}) {
    const {
      riskPercent = this.config.maxPercentPerPosition,
      useAvailable = true
    } = options;
    
    const baseCapital = useAvailable ? this.availableCapital : this.currentCapital;
    const maxAllocation = baseCapital * (riskPercent / 100);
    const leveragedAllocation = maxAllocation * this.config.maxLeverage;
    const amount = leveragedAllocation / price;
    
    return {
      maxAmount: amount,
      maxValue: leveragedAllocation,
      price,
      token
    };
  }

  updatePortfolio(position) {
    if (!position) return false;
    
    // Check if this is a closed position being processed
    if (position.status === 'CLOSED' || position.exitPrice) {
      const profit = position.profit || 0;
      this.currentCapital += profit;
      
      // Update asset balances
      if (position.token) {
        this.updateAssetBalance(position.token, -position.amount, 'add');
      }
      
      // Add to available capital
      const exitValue = position.exitPrice * position.amount;
      const exitFees = position.exitFees || 0;
      this.availableCapital += exitValue - exitFees;
      
      // Update peak and lowest capital
      if (this.currentCapital > this.peakCapital) this.peakCapital = this.currentCapital;
      if (this.currentCapital < this.lowestCapital) this.lowestCapital = this.currentCapital;
      
      // Add to closed positions history
      this.closedPositions.push({...position});
      
      this.history.push({
        timestamp: Date.now(),
        capital: this.currentCapital,
        type: 'POSITION_CLOSED',
        token: position.token,
        profit: profit,
        profitPercentage: position.profitPercentage || 0
      });
      
      // Reset performance cache
      this.performanceCache = null;
      return true;
    }
    
    return false;
  }

  getMetrics() {
    if (this.performanceCache && (Date.now() - this.performanceCacheTime < 5000)) {
      return this.performanceCache;
    }
    
    const winningPositions = this.closedPositions.filter(p => p.profit > 0);
    const losingPositions = this.closedPositions.filter(p => p.profit < 0);
    
    const totalProfit = this.currentCapital - this.initialCapital;
    const totalPositions = this.closedPositions.length;
    const winRate = totalPositions > 0 ? (winningPositions.length / totalPositions) * 100 : 0;
    
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
    
    const grossProfit = winningPositions.reduce((sum, p) => sum + p.profit, 0);
    const grossLoss = Math.abs(losingPositions.reduce((sum, p) => sum + p.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    const maxDrawdown = ((this.peakCapital - this.lowestCapital) / this.peakCapital) * 100;
    
    const avgHoldingPeriod = totalPositions > 0
      ? this.closedPositions.reduce((sum, p) => sum + p.holdingPeriod, 0) / totalPositions
      : 0;
    
    const totalVolume = this.closedPositions.reduce((sum, p) => sum + p.value, 0);
    const totalFees = this.closedPositions.reduce((sum, p) => sum + p.fees + (p.exitFees || 0), 0);
    
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
    
    this.performanceCache = metrics;
    this.performanceCacheTime = Date.now();
    
    return metrics;
  }

  getOpenPositions() {
    return Array.from(this.openPositions.values());
  }

  getClosedPositions(limit, offset = 0) {
    const positions = [...this.closedPositions]
      .sort((a, b) => b.closeTimestamp - a.closeTimestamp);
    
    if (limit) return positions.slice(offset, offset + limit);
    return positions;
  }

  getHistory(limit) {
    const history = [...this.history].sort((a, b) => b.timestamp - a.timestamp);
    
    if (limit) return history.slice(0, limit);
    return history;
  }

  addCapital(amount, source = 'DEPOSIT') {
    if (amount <= 0) {
      console.warn('Cannot add capital: amount must be positive');
      return null;
    }
    
    this.currentCapital += amount;
    this.availableCapital += amount;
    this.updateAssetBalance('USD', amount, 'add');
    
    if (this.currentCapital > this.peakCapital) this.peakCapital = this.currentCapital;
    
    this.history.push({
      timestamp: Date.now(),
      capital: this.currentCapital,
      type: 'ADD_CAPITAL',
      amount,
      source
    });
    
    this.notifyStatsListeners('capital', {
      action: 'add',
      amount,
      newCapital: this.currentCapital,
      source
    });
    
    this.performanceCache = null;
    
    return this.getMetrics();
  }

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
    
    if (this.currentCapital < this.lowestCapital) this.lowestCapital = this.currentCapital;
    
    this.history.push({
      timestamp: Date.now(),
      capital: this.currentCapital,
      type: 'WITHDRAW_CAPITAL',
      amount,
      destination
    });
    
    this.notifyStatsListeners('capital', {
      action: 'withdraw',
      amount,
      newCapital: this.currentCapital,
      destination
    });
    
    this.performanceCache = null;
    
    return this.getMetrics();
  }

  resetPeriod(keepPositions = true) {
    const completedPeriod = {
      endDate: new Date().toISOString(),
      metrics: this.getMetrics(),
      closedPositions: [...this.closedPositions]
    };
    
    if (keepPositions) {
      this.closedPositions = [];
      this.history = [{
        timestamp: Date.now(),
        capital: this.currentCapital,
        type: 'PERIOD_RESET',
        previousCapital: this.initialCapital,
        previousProfit: this.currentCapital - this.initialCapital
      }];
      
      this.initialCapital = this.currentCapital;
      this.peakCapital = this.currentCapital;
      this.lowestCapital = this.currentCapital;
    } else {
      this.openPositions = new Map();
      this.closedPositions = [];
      this.history = [{
        timestamp: Date.now(),
        capital: this.currentCapital,
        type: 'FULL_RESET',
        previousCapital: this.initialCapital
      }];
      
      this.initialCapital = this.currentCapital;
      this.availableCapital = this.currentCapital;
      this.peakCapital = this.currentCapital;
      this.lowestCapital = this.currentCapital;
    }
    
    this.resetDailyStats();
    this.performanceCache = null;
    this.notifyStatsListeners('reset', { keepPositions, completedPeriod });
    
    return {
      currentCapital: this.currentCapital,
      availableCapital: this.availableCapital,
      openPositions: this.getOpenPositions(),
      completedPeriod
    };
  }

  generatePositionId(token) {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 10000);
    return `${token}-${timestamp}-${random}`;
  }

  updateDailyStats(profit, volume, fees) {
    const currentDate = new Date().toISOString().split('T')[0];
    
    if (currentDate !== this.dailyStats.date) this.resetDailyStats();
    
    this.dailyStats.profit += profit;
    this.dailyStats.volume += volume;
    this.dailyStats.fees += fees;
    
    this.notifyStatsListeners('daily', this.dailyStats);
  }

  resetDailyStats() {
    this.dailyStats = {
      date: new Date().toISOString().split('T')[0],
      profit: 0, trades: 0, volume: 0, fees: 0
    };
  }

  updateAssetBalance(asset, amount, operation = 'set') {
    const currentBalance = this.assetBalances.get(asset) || 0;
    
    if (operation === 'add') {
      this.assetBalances.set(asset, currentBalance + amount);
    } else {
      this.assetBalances.set(asset, amount);
    }
    
    if (this.assetBalances.get(asset) === 0) this.assetBalances.delete(asset);
  }

  onPositionChange(callback) {
    if (typeof callback !== 'function') throw new Error('Callback must be a function');
    
    this.positionListeners.push(callback);
    return () => { this.positionListeners = this.positionListeners.filter(cb => cb !== callback); };
  }

  onStatsChange(callback) {
    if (typeof callback !== 'function') throw new Error('Callback must be a function');
    
    this.statsListeners.push(callback);
    return () => { this.statsListeners = this.statsListeners.filter(cb => cb !== callback); };
  }

  notifyPositionListeners(event, position) {
    this.positionListeners.forEach(callback => {
      try {
        callback(event, position);
      } catch (error) {
        console.error('Error in position listener callback:', error);
      }
    });
  }

  notifyStatsListeners(event, data) {
    this.statsListeners.forEach(callback => {
      try {
        callback(event, data);
      } catch (error) {
        console.error('Error in stats listener callback:', error);
      }
    });
  }

  getDailyStats() {
    return { ...this.dailyStats };
  }
  
  getPortfolioValuation(currentPrices) {
    const valuation = this.updatePositionValues(currentPrices);
    
    return {
      ...valuation,
      initialCapital: this.initialCapital,
      totalProfit: (valuation.portfolioValue - this.initialCapital),
      totalProfitPercentage: ((valuation.portfolioValue - this.initialCapital) / this.initialCapital) * 100,
      timestamp: Date.now()
    };
  }

  exportData(includeHistory = true) {
    const exportData = {
      metrics: this.getMetrics(),
      openPositions: this.getOpenPositions(),
      closedPositions: this.getClosedPositions(),
      assetBalances: Object.fromEntries(this.assetBalances),
      config: { ...this.config },
      exportTime: new Date().toISOString()
    };
    
    if (includeHistory) exportData.history = this.getHistory();
    
    return exportData;
  }

  importData(data, merge = false) {
    try {
      if (!data || !data.metrics) {
        console.error('Invalid portfolio data format');
        return false;
      }
      
      if (!merge) {
        this.initialCapital = data.metrics.initialCapital;
        this.currentCapital = data.metrics.currentCapital;
        this.availableCapital = data.metrics.availableCapital;
        this.peakCapital = data.metrics.initialCapital;
        this.lowestCapital = data.metrics.initialCapital;
        
        this.openPositions = new Map();
        this.closedPositions = [];
        this.history = [];
        this.assetBalances = new Map();
        
        if (data.assetBalances) {
          Object.entries(data.assetBalances).forEach(([asset, balance]) => {
            this.assetBalances.set(asset, balance);
          });
        }
        
        if (data.openPositions) {
          data.openPositions.forEach(position => {
            this.openPositions.set(position.id, { ...position });
          });
        }
        
        if (data.closedPositions) this.closedPositions = [...data.closedPositions];
        if (data.history) this.history = [...data.history];
        if (data.config) this.config = { ...this.config, ...data.config };
      } else {
        console.warn('Merge import not fully implemented');
        return false;
      }
      
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