import EventEmitter from 'events';

export class RiskManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.riskParams = {
      maxDrawdown: config.simulation?.maxDrawdown || 15,
      maxLossPerTrade: config.trading?.maxLossPerTrade || 3,
      maxDailyLoss: config.trading?.maxDailyLoss || 5,
      maxExposurePerToken: config.trading?.maxExposurePerToken || 20,
      maxOpenPositions: config.trading?.maxOpenPositions || 3,
      minLiquidity: config.trading?.minLiquidity || 200000, // Increased minimum liquidity
      minVolume24h: config.trading?.minVolume24h || 100000, // Increased minimum volume
      minTradeAmount: config.trading?.minTradeAmount || 10,
      tradeSize: config.trading?.tradeSize || 2,
      stopLoss: config.trading?.stopLoss || 5,
      takeProfit: config.trading?.takeProfit || 15,
      trailingStopLoss: config.trading?.trailingStopLoss !== false, // Default to true
      trailingStopDistance: config.trading?.trailingStopDistance || 2,
      minConfidenceThreshold: config.trading?.minConfidenceThreshold || 0.65, // Increased threshold
      volatilityMultiplier: config.trading?.volatilityMultiplier || {
        low: 1.2, // Take more risk in low volatility
        medium: 1.0,
        high: 0.7  // Take less risk in high volatility
      },
      // Dynamic position sizing based on multiple factors
      positionSizing: {
        base: config.trading?.tradeSize || 2,
        maxSize: config.trading?.maxPositionSize || 5,
        minSize: config.trading?.minPositionSize || 1,
        confidenceMultiplier: 0.2, // 0.2% increase per 0.1 confidence above threshold
        signalQualityMultiplier: 0.3 // 0.3% increase for high-quality signals
      },
      // Improved circuit breaker with more options
      circuitBreaker: {
        enabled: config.trading?.circuitBreaker?.enabled !== false,
        consecutiveLosses: config.trading?.circuitBreaker?.consecutiveLosses || 3,
        timeoutMinutes: config.trading?.circuitBreaker?.timeoutMinutes || 60,
        maxDailyLossPercent: config.trading?.circuitBreaker?.maxDailyLossPercent || 5,
        maxLossSizePercent: config.trading?.circuitBreaker?.maxLossSizePercent || 3,
        reactivationThreshold: config.trading?.circuitBreaker?.reactivationThreshold || 'manual' // or 'time'
      },
      // Time-based risk adjustments
      timeRisk: {
        reducePositionSizeAfterHours: config.trading?.reducePositionSizeAfterHours || false,
        afterHoursReduction: config.trading?.afterHoursReduction || 0.5,
        weekendTrading: config.trading?.weekendTrading !== false,
        weekendPositionSizeMultiplier: config.trading?.weekendPositionSizeMultiplier || 0.7
      },
      // Market correlation risk
      marketCorrelation: {
        enabled: config.trading?.considerMarketCorrelation !== false,
        maxCorrelatedExposure: config.trading?.maxCorrelatedExposure || 30,
        correlationThreshold: config.trading?.correlationThreshold || 0.7
      },
      // Advanced risk metrics
      riskMetrics: {
        trackSharpeRatio: true,
        trackSortino: true,
        targetSharpe: 1.5,
        minimumTrades: 20
      }
    };
    
    this.state = {
      circuitBreakerTriggered: false,
      circuitBreakerExpiry: null,
      consecutiveLosses: 0,
      dailyLoss: 0,
      dailyLossResetTime: this._getEndOfDay(),
      tradingEnabled: true,
      currentDrawdown: 0,
      peakValue: config.simulation?.initialCapital || 10000,
      exposureByToken: new Map(),
      tradingLimitsByToken: new Map(),
      correlationMatrix: new Map(),
      tokenGroups: new Map(),
      positionRiskScores: new Map(),
      volatilityByToken: new Map(),
      tradeStats: {
        winCount: 0,
        lossCount: 0,
        totalProfit: 0,
        totalLoss: 0,
        avgWin: 0,
        avgLoss: 0
      },
      // Market condition awareness
      marketCondition: 'normal', // 'normal', 'volatile', 'trending'
      marketTrend: 'neutral', // 'bullish', 'bearish', 'neutral'
      // History of risk decisions for self-tuning
      riskDecisionHistory: [],
      lastRiskAssessment: Date.now()
    };
    
    // Initialize token correlation groups (tokens likely to move together)
    this.initializeTokenGroups();
    
    // Start periodic risk assessment
    this.startPeriodicRiskAssessment();
  }

  initializeTokenGroups() {
    // Example token groups based on assumed correlations in Solana ecosystem
    // In production, this should be data-driven, potentially from ML models
    const defiGroup = ['RAY', 'SRM', 'FIDA', 'OXY', 'STEP', 'COPE'];
    const nftGroup = ['MANGO', 'SAMO', 'BONK', 'BOKU'];
    const infraGroup = ['PORT', 'MNDE', 'JET', 'GST'];
    
    defiGroup.forEach(token => this.state.tokenGroups.set(token, 'defi'));
    nftGroup.forEach(token => this.state.tokenGroups.set(token, 'nft'));
    infraGroup.forEach(token => this.state.tokenGroups.set(token, 'infra'));
  }

  startPeriodicRiskAssessment() {
    // Run full risk assessment every hour
    setInterval(() => this.assessOverallRisk(), 60 * 60 * 1000);
  }

  assessOverallRisk() {
    this.state.lastRiskAssessment = Date.now();
    
    // Check current drawdown
    if (this.state.currentDrawdown > this.riskParams.maxDrawdown * 0.8) {
      this.reduceRiskExposure(0.7);
      this.emit('risk_assessment', {
        type: 'HIGH_DRAWDOWN',
        action: 'REDUCING_EXPOSURE',
        drawdown: this.state.currentDrawdown,
        threshold: this.riskParams.maxDrawdown
      });
    }
    
    // Check daily loss
    if (this.state.dailyLoss > this.riskParams.maxDailyLoss * 0.7) {
      this.reduceRiskExposure(0.8);
      this.emit('risk_assessment', {
        type: 'APPROACHING_DAILY_LOSS_LIMIT',
        action: 'REDUCING_EXPOSURE',
        dailyLoss: this.state.dailyLoss,
        threshold: this.riskParams.maxDailyLoss
      });
    }
    
    // Check win/loss ratio
    const totalTrades = this.state.tradeStats.winCount + this.state.tradeStats.lossCount;
    if (totalTrades > 10) {
      const winRate = this.state.tradeStats.winCount / totalTrades;
      if (winRate < 0.4) {
        this.reduceRiskExposure(0.6);
        this.emit('risk_assessment', {
          type: 'LOW_WIN_RATE',
          action: 'REDUCING_EXPOSURE',
          winRate,
          threshold: 0.4
        });
      } else if (winRate > 0.6) {
        this.increaseRiskExposure(1.1);
        this.emit('risk_assessment', {
          type: 'HIGH_WIN_RATE',
          action: 'INCREASING_EXPOSURE',
          winRate,
          threshold: 0.6
        });
      }
    }
    
    // Check time-based risk factors
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    if (isWeekend && !this.riskParams.timeRisk.weekendTrading) {
      this.reduceRiskExposure(0);
      this.emit('risk_assessment', {
        type: 'WEEKEND_TRADING_DISABLED',
        action: 'PAUSING_TRADING'
      });
    } else if (isWeekend && this.riskParams.timeRisk.weekendTrading) {
      this.reduceRiskExposure(this.riskParams.timeRisk.weekendPositionSizeMultiplier);
      this.emit('risk_assessment', {
        type: 'WEEKEND_TRADING_ADJUSTED',
        action: 'REDUCING_POSITION_SIZE'
      });
    }
    
    // After hours check (simplified, should be refined for crypto 24/7 market)
    const hour = now.getHours();
    if (this.riskParams.timeRisk.reducePositionSizeAfterHours && (hour < 8 || hour > 20)) {
      this.reduceRiskExposure(this.riskParams.timeRisk.afterHoursReduction);
      this.emit('risk_assessment', {
        type: 'AFTER_HOURS_TRADING',
        action: 'REDUCING_POSITION_SIZE'
      });
    }
  }

  reduceRiskExposure(factor) {
    // Adjust position sizing temporarily
    this.riskParams.positionSizing._tempAdjustment = factor;
    
    // If factor is 0, disable trading temporarily
    if (factor === 0) {
      this.state.tradingEnabled = false;
      
      // Re-enable after 6 hours unless manually re-enabled
      setTimeout(() => {
        this.state.tradingEnabled = true;
        this.riskParams.positionSizing._tempAdjustment = 1;
      }, 6 * 60 * 60 * 1000);
    }
  }

  increaseRiskExposure(factor) {
    // Only allow moderate increases
    const maxIncrease = 1.2;
    const adjustedFactor = Math.min(factor, maxIncrease);
    
    this.riskParams.positionSizing._tempAdjustment = adjustedFactor;
  }

  updateConfig(newConfig) {
    if (newConfig.trading) {
      const t = newConfig.trading;
      if (t.maxLossPerTrade !== undefined) this.riskParams.maxLossPerTrade = t.maxLossPerTrade;
      if (t.maxDailyLoss !== undefined) this.riskParams.maxDailyLoss = t.maxDailyLoss;
      if (t.maxExposurePerToken !== undefined) this.riskParams.maxExposurePerToken = t.maxExposurePerToken;
      if (t.maxOpenPositions !== undefined) this.riskParams.maxOpenPositions = t.maxOpenPositions;
      if (t.minLiquidity !== undefined) this.riskParams.minLiquidity = t.minLiquidity;
      if (t.minVolume24h !== undefined) this.riskParams.minVolume24h = t.minVolume24h;
      if (t.stopLoss !== undefined) this.riskParams.stopLoss = t.stopLoss;
      if (t.takeProfit !== undefined) this.riskParams.takeProfit = t.takeProfit;
      if (t.trailingStopLoss !== undefined) this.riskParams.trailingStopLoss = t.trailingStopLoss;
      if (t.trailingStopDistance !== undefined) this.riskParams.trailingStopDistance = t.trailingStopDistance;
      if (t.tradeSize !== undefined) {
        this.riskParams.tradeSize = t.tradeSize;
        this.riskParams.positionSizing.base = t.tradeSize;
      }
      
      // Update position sizing parameters
      if (t.maxPositionSize !== undefined) this.riskParams.positionSizing.maxSize = t.maxPositionSize;
      if (t.minPositionSize !== undefined) this.riskParams.positionSizing.minSize = t.minPositionSize;
      
      // Update time-based risk parameters
      if (t.reducePositionSizeAfterHours !== undefined) 
        this.riskParams.timeRisk.reducePositionSizeAfterHours = t.reducePositionSizeAfterHours;
      if (t.afterHoursReduction !== undefined)
        this.riskParams.timeRisk.afterHoursReduction = t.afterHoursReduction;
      if (t.weekendTrading !== undefined)
        this.riskParams.timeRisk.weekendTrading = t.weekendTrading;
      if (t.weekendPositionSizeMultiplier !== undefined)
        this.riskParams.timeRisk.weekendPositionSizeMultiplier = t.weekendPositionSizeMultiplier;
      
      // Update market correlation parameters
      if (t.considerMarketCorrelation !== undefined)
        this.riskParams.marketCorrelation.enabled = t.considerMarketCorrelation;
      if (t.maxCorrelatedExposure !== undefined)
        this.riskParams.marketCorrelation.maxCorrelatedExposure = t.maxCorrelatedExposure;
      if (t.correlationThreshold !== undefined)
        this.riskParams.marketCorrelation.correlationThreshold = t.correlationThreshold;
    }
    
    if (newConfig.simulation?.maxDrawdown !== undefined) this.riskParams.maxDrawdown = newConfig.simulation.maxDrawdown;
    
    if (newConfig.trading?.circuitBreaker) {
      this.riskParams.circuitBreaker = {
        ...this.riskParams.circuitBreaker,
        ...newConfig.trading.circuitBreaker
      };
    }
    
    this.config = { ...this.config, ...newConfig };
  }

  canTrade(portfolioManager) {
    // Reset daily limits if needed
    this._resetDailyLimitsIfNeeded();
    
    // Check if trading is explicitly disabled by risk assessment
    if (!this.state.tradingEnabled) {
      this.emit('risk_limit_reached', {
        type: 'TRADING_DISABLED',
        reason: 'Trading temporarily disabled by risk assessment'
      });
      return false;
    }
    
    // Check circuit breaker first
    if (this.state.circuitBreakerTriggered && Date.now() < this.state.circuitBreakerExpiry) {
      this.emit('risk_limit_reached', {
        type: 'CIRCUIT_BREAKER_ACTIVE',
        reason: `Circuit breaker active until ${new Date(this.state.circuitBreakerExpiry).toLocaleString()}`
      });
      return false;
    }
    
    // Check if we've hit max open positions
    const openPositionsCount = portfolioManager.getOpenPositions().length;
    if (openPositionsCount >= this.riskParams.maxOpenPositions) {
      this.emit('risk_limit_reached', {
        type: 'MAX_POSITIONS_REACHED',
        reason: `Maximum open positions (${this.riskParams.maxOpenPositions}) reached`
      });
      return false;
    }
    
    // Check if we've hit daily loss limit
    if (this.state.dailyLoss > this.riskParams.maxDailyLoss) {
      this.emit('risk_limit_reached', {
        type: 'MAX_DAILY_LOSS',
        reason: `Daily loss limit (${this.riskParams.maxDailyLoss}%) reached`
      });
      return false;
    }
    
    // Check if we've hit max drawdown
    if (this.state.currentDrawdown > this.riskParams.maxDrawdown) {
      this.emit('risk_limit_reached', {
        type: 'MAX_DRAWDOWN',
        reason: `Max drawdown (${this.riskParams.maxDrawdown}%) reached`
      });
      return false;
    }
    
    // Check weekend trading restrictions
    if (this._isWeekend() && !this.riskParams.timeRisk.weekendTrading) {
      this.emit('risk_limit_reached', {
        type: 'WEEKEND_TRADING_DISABLED',
        reason: 'Trading on weekends is disabled'
      });
      return false;
    }
    
    return true;
  }

  checkPositionAllowed(position, marketData) {
    this._resetDailyLimitsIfNeeded();
    
    // Quick checks that would immediately disqualify the position
    const checks = [
      {
        condition: !this.state.tradingEnabled,
        reason: 'Trading temporarily disabled by risk assessment'
      },
      {
        condition: this.state.circuitBreakerTripped && Date.now() < this.state.circuitBreakerExpiry,
        reason: `Circuit breaker active until ${new Date(this.state.circuitBreakerExpiry).toLocaleTimeString()}`
      },
      {
        condition: position.totalPositions >= this.riskParams.maxOpenPositions,
        reason: `Maximum open positions limit reached (${this.riskParams.maxOpenPositions})`
      },
      {
        condition: marketData?.liquidity && marketData.liquidity < this.riskParams.minLiquidity,
        reason: `Insufficient liquidity (${marketData?.liquidity} < ${this.riskParams.minLiquidity})`
      },
      {
        condition: marketData?.volume24h && marketData.volume24h < this.riskParams.minVolume24h,
        reason: `Insufficient 24h volume (${marketData?.volume24h} < ${this.riskParams.minVolume24h})`
      },
      {
        condition: (this.state.exposureByToken.get(position.token) || 0) + position.amount > this.riskParams.maxExposurePerToken,
        reason: `Maximum exposure per token exceeded`
      },
      {
        condition: this.state.currentDrawdown > this.riskParams.maxDrawdown,
        reason: `Drawdown limit exceeded (${this.state.currentDrawdown.toFixed(2)}% > ${this.riskParams.maxDrawdown}%)`
      },
      {
        condition: this.state.dailyLoss > this.riskParams.maxDailyLoss,
        reason: `Daily loss limit exceeded (${this.state.dailyLoss.toFixed(2)}% > ${this.riskParams.maxDailyLoss}%)`
      },
      {
        condition: this._isWeekend() && !this.riskParams.timeRisk.weekendTrading,
        reason: 'Trading on weekends is disabled'
      }
    ];
    
    for (const check of checks) {
      if (check.condition) return { allowed: false, reason: check.reason };
    }
    
    // Additional checks for correlated tokens
    if (this.riskParams.marketCorrelation.enabled) {
      const correlatedExposure = this._calculateCorrelatedExposure(position.token);
      if (correlatedExposure > this.riskParams.marketCorrelation.maxCorrelatedExposure) {
        return { 
          allowed: false, 
          reason: `Correlated token exposure exceeded (${correlatedExposure.toFixed(2)}% > ${this.riskParams.marketCorrelation.maxCorrelatedExposure}%)`
        };
      }
    }
    
    return { allowed: true };
  }

  calculatePositionSize(price, portfolioManager) {
    if (!price || price <= 0 || !portfolioManager) {
      return 0;
    }
    
    const currentCapital = portfolioManager.currentCapital;
    
    // Get base trade size percentage and adjust based on current risk factors
    let tradeSize = this.riskParams.positionSizing.base / 100; // Convert from percentage to decimal
    
    // Apply any temporary adjustments from risk assessment
    if (this.riskParams.positionSizing._tempAdjustment) {
      tradeSize *= this.riskParams.positionSizing._tempAdjustment;
    }
    
    // Apply weekend adjustments if applicable
    if (this._isWeekend() && this.riskParams.timeRisk.weekendTrading) {
      tradeSize *= this.riskParams.timeRisk.weekendPositionSizeMultiplier;
    }
    
    // Apply after-hours adjustment if applicable
    if (this._isAfterHours() && this.riskParams.timeRisk.reducePositionSizeAfterHours) {
      tradeSize *= this.riskParams.timeRisk.afterHoursReduction;
    }
    
    // Calculate position value with all adjustments
    const positionValue = currentCapital * tradeSize;
    
    // Ensure minimum trade amount
    if (positionValue < this.riskParams.minTradeAmount) {
      return 0;
    }
    
    // Calculate amount of token to buy
    const amount = positionValue / price;
    
    return amount;
  }

  calculatePositionRisk(token, entryPrice, amount, confidence, marketData = {}) {
    // Start with base stop loss and take profit percentages
    let stopLossPercent = this.riskParams.stopLoss;
    let takeProfitPercent = this.riskParams.takeProfit;
    
    // Adjust based on volatility
    if (marketData.volatility) {
      const multiplier = this._getVolatilityMultiplier(marketData.volatility);
      stopLossPercent *= multiplier;
      takeProfitPercent *= multiplier;
    }
    
    // Adjust based on signal confidence
    if (confidence) {
      // Higher confidence allows for tighter stop loss and higher take profit
      const confidenceMultiplier = 0.8 + (confidence * 0.4); // Range: 0.8-1.2
      takeProfitPercent *= confidenceMultiplier;
      
      // Very high confidence signals can have slightly tighter stops
      if (confidence > 0.8) {
        stopLossPercent *= 0.9;
      }
    }
    
    // Calculate actual stop loss and take profit values
    const stopLossValue = entryPrice * (1 - (stopLossPercent / 100));
    const takeProfitValue = entryPrice * (1 + (takeProfitPercent / 100));
    
    // Calculate risk/reward ratio
    const risk = entryPrice - stopLossValue;
    const reward = takeProfitValue - entryPrice;
    const riskRewardRatio = reward / (risk || 1);
    
    // Adjust position size based on risk/reward and confidence
    let positionSize = this.riskParams.positionSizing.base;
    
    // Reduce size for poor risk/reward ratio
    if (riskRewardRatio < 2 || confidence < 0.7) {
      positionSize *= 0.8;
    } 
    // Increase size for excellent risk/reward with high confidence
    else if (riskRewardRatio > 3 && confidence > 0.8) {
      positionSize *= 1.2;
    }
    
    // Reduce size for high volatility
    if (marketData.volatility === 'high') {
      positionSize *= 0.7;
    }
    
    // Ensure position size is within allowable range
    positionSize = Math.max(
      this.riskParams.positionSizing.minSize, 
      Math.min(positionSize, this.riskParams.positionSizing.maxSize)
    );
    
    // Create and configure trailing stop if enabled
    const trailingStop = this.riskParams.trailingStopLoss ? {
      enabled: true,
      distance: this.riskParams.trailingStopDistance,
      current: stopLossValue
    } : { enabled: false };
    
    return {
      stopLoss: stopLossValue,
      takeProfit: takeProfitValue,
      positionSize,
      riskRewardRatio,
      isGoodOpportunity: riskRewardRatio >= 1.5,
      trailingStop,
      risk: { stopLossPercent, takeProfitPercent }
    };
  }

  updateDrawdown(currentValue, initialCapital) {
    if (currentValue > this.state.peakValue) this.state.peakValue = currentValue;
    const drawdown = ((this.state.peakValue - currentValue) / this.state.peakValue) * 100;
    this.state.currentDrawdown = drawdown;
    
    if (drawdown > this.riskParams.maxDrawdown) {
      this.emit('risk_limit_reached', {
        type: 'DRAWDOWN_LIMIT',
        drawdown,
        maxAllowed: this.riskParams.maxDrawdown,
        reason: `Drawdown of ${drawdown.toFixed(2)}% exceeds limit of ${this.riskParams.maxDrawdown}%`
      });
      return false;
    }
    return true;
  }

  updateExposure(token, amount, operation = 'add') {
    const currentExposure = this.state.exposureByToken.get(token) || 0;
    if (operation === 'add') {
      this.state.exposureByToken.set(token, currentExposure + amount);
    } else if (operation === 'subtract') {
      const newExposure = Math.max(0, currentExposure - amount);
      if (newExposure === 0) this.state.exposureByToken.delete(token);
      else this.state.exposureByToken.set(token, newExposure);
    }
  }

  recordTradeResult(profit, percentage, initialCapital) {
    const isLoss = profit < 0;
    
    // Update trade statistics
    if (isLoss) {
      this.state.consecutiveLosses++;
      this.state.dailyLoss += Math.abs(percentage);
      this.state.tradeStats.lossCount++;
      this.state.tradeStats.totalLoss += Math.abs(profit);
      
      // Check circuit breaker conditions
      if (this.riskParams.circuitBreaker.enabled) {
        // Check for consecutive losses trigger
        if (this.state.consecutiveLosses >= this.riskParams.circuitBreaker.consecutiveLosses) {
          return this._triggerCircuitBreaker('Too many consecutive losses');
        }
        
        // Check for daily loss percentage trigger
        if (this.state.dailyLoss >= this.riskParams.circuitBreaker.maxDailyLossPercent) {
          return this._triggerCircuitBreaker('Maximum daily loss percentage exceeded');
        }
        
        // Check for single large loss trigger
        if (Math.abs(percentage) >= this.riskParams.circuitBreaker.maxLossSizePercent) {
          return this._triggerCircuitBreaker('Single large loss triggered circuit breaker');
        }
      }
    } else {
      this.state.consecutiveLosses = 0;
      this.state.tradeStats.winCount++;
      this.state.tradeStats.totalProfit += profit;
    }
    
    // Update average win/loss statistics
    if (this.state.tradeStats.winCount > 0) {
      this.state.tradeStats.avgWin = this.state.tradeStats.totalProfit / this.state.tradeStats.winCount;
    }
    
    if (this.state.tradeStats.lossCount > 0) {
      this.state.tradeStats.avgLoss = this.state.tradeStats.totalLoss / this.state.tradeStats.lossCount;
    }
    
    // Check drawdown
    return this.updateDrawdown(initialCapital + profit, initialCapital);
  }

  adjustTrailingStop(position, currentPrice) {
    if (!position.trailingStop?.enabled) return position;
    
    const isLong = position.direction === 'BUY';
    let updatedStop = position.trailingStop.current;
    
    if (isLong) {
      // In a long position, we raise the stop when price goes up
      const potentialStop = currentPrice * (1 - (position.trailingStop.distance / 100));
      if (potentialStop > updatedStop) updatedStop = potentialStop;
    } else {
      // In a short position, we lower the stop when price goes down
      const potentialStop = currentPrice * (1 + (position.trailingStop.distance / 100));
      if (potentialStop < updatedStop) updatedStop = potentialStop;
    }
    
    return {...position, trailingStop: {...position.trailingStop, current: updatedStop}};
  }

  shouldClosePosition(position, currentPrice) {
    if (!position || !currentPrice) {
      return { shouldClose: false, reason: 'INVALID_INPUT' };
    }
    
    const isLong = position.direction === 'BUY';
    const effectiveStopLoss = position.trailingStop?.enabled 
      ? position.trailingStop.current 
      : position.stopLoss;
    
    // Check stop loss
    if (isLong && currentPrice <= effectiveStopLoss) {
      return { shouldClose: true, reason: 'STOP_LOSS' };
    }
    
    if (!isLong && currentPrice >= effectiveStopLoss) {
      return { shouldClose: true, reason: 'STOP_LOSS' };
    }
    
    // Check take profit
    if (isLong && currentPrice >= position.takeProfit) {
      return { shouldClose: true, reason: 'TAKE_PROFIT' };
    }
    
    if (!isLong && currentPrice <= position.takeProfit) {
      return { shouldClose: true, reason: 'TAKE_PROFIT' };
    }
    
    // Check max duration
    if (position.maxDuration && (Date.now() - position.entryTime) > position.maxDuration) {
      return { shouldClose: true, reason: 'MAX_DURATION_EXCEEDED' };
    }
    
    // Partial take profit feature
    if (position.partialTakeProfit) {
      const targets = position.partialTakeProfit.targets || [];
      for (const target of targets) {
        if (!target.executed && 
            ((isLong && currentPrice >= target.price) || 
             (!isLong && currentPrice <= target.price))) {
          return { 
            shouldClose: true, 
            reason: 'PARTIAL_TAKE_PROFIT',
            percentage: target.percentage
          };
        }