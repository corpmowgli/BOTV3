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
      minLiquidity: config.trading?.minLiquidity || 100000,
      minVolume24h: config.trading?.minVolume24h || 50000,
      minTradeAmount: config.trading?.minTradeAmount || 10,
      tradeSize: config.trading?.tradeSize || 2,
      stopLoss: config.trading?.stopLoss || 5,
      takeProfit: config.trading?.takeProfit || 15,
      trailingStopLoss: config.trading?.trailingStopLoss || false,
      trailingStopDistance: config.trading?.trailingStopDistance || 2,
      minConfidenceThreshold: config.trading?.minConfidenceThreshold || 0.6,
      volatilityMultiplier: config.trading?.volatilityMultiplier || {
        low: 1.0, medium: 0.8, high: 0.6
      },
      circuitBreaker: {
        enabled: config.trading?.circuitBreaker?.enabled !== false,
        consecutiveLosses: config.trading?.circuitBreaker?.consecutiveLosses || 3,
        timeoutMinutes: config.trading?.circuitBreaker?.timeoutMinutes || 30,
        maxDailyLossPercent: config.trading?.circuitBreaker?.maxDailyLossPercent || 5
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
      tradingLimitsByToken: new Map()
    };
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
      if (t.tradeSize !== undefined) this.riskParams.tradeSize = t.tradeSize;
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
    // Check circuit breaker first
    if (this.state.circuitBreakerTriggered && Date.now() < this.state.circuitBreakerExpiry) {
      this.emit('risk_limit_reached', {
        type: 'CIRCUIT_BREAKER_ACTIVE',
        reason: `Circuit breaker active until ${new Date(this.state.circuitBreakerExpiry).toLocaleString()}`
      });
      return false;
    }
    
    // Reset daily limits if needed
    this._resetDailyLimitsIfNeeded();
    
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
    
    return true;
  }

  checkPositionAllowed(position, marketData) {
    this._resetDailyLimitsIfNeeded();
    const checks = [
      {
        condition: this.state.circuitBreakerTriggered && Date.now() < this.state.circuitBreakerExpiry,
        reason: `Circuit breaker actif jusqu'à ${new Date(this.state.circuitBreakerExpiry).toLocaleTimeString()}`
      },
      {
        condition: position.totalPositions >= this.riskParams.maxOpenPositions,
        reason: `Nombre maximum de positions ouvertes atteint (${this.riskParams.maxOpenPositions})`
      },
      {
        condition: marketData?.liquidity && marketData.liquidity < this.riskParams.minLiquidity,
        reason: `Liquidité insuffisante (${marketData?.liquidity} < ${this.riskParams.minLiquidity})`
      },
      {
        condition: marketData?.volume24h && marketData.volume24h < this.riskParams.minVolume24h,
        reason: `Volume 24h insuffisant (${marketData?.volume24h} < ${this.riskParams.minVolume24h})`
      },
      {
        condition: (this.state.exposureByToken.get(position.token) || 0) + position.amount > this.riskParams.maxExposurePerToken,
        reason: `Exposition maximale par token dépassée`
      },
      {
        condition: this.state.currentDrawdown > this.riskParams.maxDrawdown,
        reason: `Drawdown maximal dépassé (${this.state.currentDrawdown.toFixed(2)}% > ${this.riskParams.maxDrawdown}%)`
      },
      {
        condition: this.state.dailyLoss > this.riskParams.maxDailyLoss,
        reason: `Perte quotidienne maximale dépassée (${this.state.dailyLoss.toFixed(2)}% > ${this.riskParams.maxDailyLoss}%)`
      }
    ];
    for (const check of checks) if (check.condition) return { allowed: false, reason: check.reason };
    return { allowed: true };
  }

  calculatePositionSize(price, portfolioManager) {
    if (!price || price <= 0 || !portfolioManager) {
      return 0;
    }
    
    const currentCapital = portfolioManager.currentCapital;
    const tradeSize = this.riskParams.tradeSize / 100; // Convert from percentage to decimal
    
    // Calculate position size based on percentage of capital
    const positionValue = currentCapital * tradeSize;
    
    // Ensure minimum trade amount
    if (positionValue < this.riskParams.minTradeAmount) {
      return 0;
    }
    
    // Calculate amount
    const amount = positionValue / price;
    
    return amount;
  }

  calculatePositionRisk(token, entryPrice, amount, confidence, marketData = {}) {
    let stopLossPercent = this.riskParams.stopLoss;
    let takeProfitPercent = this.riskParams.takeProfit;
    if (marketData.volatility) {
      const multiplier = this._getVolatilityMultiplier(marketData.volatility);
      stopLossPercent *= multiplier;
      takeProfitPercent *= multiplier;
    }
    if (confidence) {
      const confidenceMultiplier = 0.8 + (confidence * 0.4);
      takeProfitPercent *= confidenceMultiplier;
      if (confidence > 0.8) stopLossPercent *= 0.9;
    }
    const stopLossValue = entryPrice * (1 - (stopLossPercent / 100));
    const takeProfitValue = entryPrice * (1 + (takeProfitPercent / 100));
    const risk = entryPrice - stopLossValue;
    const reward = takeProfitValue - entryPrice;
    const riskRewardRatio = reward / (risk || 1);
    let positionSize = this.riskParams.tradeSize;
    if (riskRewardRatio < 2 || confidence < 0.7) positionSize *= 0.8;
    else if (riskRewardRatio > 3 && confidence > 0.8) positionSize *= 1.2;
    if (marketData.volatility === 'high') positionSize *= 0.7;
    positionSize = Math.max(
      this.riskParams.minTradeAmount, 
      Math.min(positionSize, this.riskParams.maxExposurePerToken)
    );
    return {
      stopLoss: stopLossValue,
      takeProfit: takeProfitValue,
      positionSize,
      riskRewardRatio,
      isGoodOpportunity: riskRewardRatio >= 1.5,
      trailingStop: this.riskParams.trailingStopLoss ? {
        enabled: true,
        distance: this.riskParams.trailingStopDistance,
        current: stopLossValue
      } : { enabled: false },
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
        reason: `Drawdown de ${drawdown.toFixed(2)}% supérieur à la limite de ${this.riskParams.maxDrawdown}%`
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
    if (isLoss) {
      this.state.consecutiveLosses++;
      this.state.dailyLoss += Math.abs(percentage);
      if (this.riskParams.circuitBreaker.enabled) {
        if (this.state.consecutiveLosses >= this.riskParams.circuitBreaker.consecutiveLosses) 
          return this._triggerCircuitBreaker('Trop de pertes consécutives');
        if (this.state.dailyLoss >= this.riskParams.circuitBreaker.maxDailyLossPercent)
          return this._triggerCircuitBreaker('Perte quotidienne maximale dépassée');
      }
    } else this.state.consecutiveLosses = 0;
    return this.updateDrawdown(initialCapital + profit, initialCapital);
  }

  adjustTrailingStop(position, currentPrice) {
    if (!position.trailingStop?.enabled) return position;
    const isLong = position.direction === 'BUY';
    let updatedStop = position.trailingStop.current;
    if (isLong) {
      const potentialStop = currentPrice * (1 - (position.trailingStop.distance / 100));
      if (potentialStop > updatedStop) updatedStop = potentialStop;
    } else {
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
    
    return { shouldClose: false };
  }

  isTokenAllowed(token, marketData) {
    const tradingLimit = this.state.tradingLimitsByToken.get(token);
    if (tradingLimit && tradingLimit.expiry > Date.now()) 
      return { allowed: false, reason: tradingLimit.reason };
    if (marketData) {
      if (marketData.liquidity && marketData.liquidity < this.riskParams.minLiquidity) {
        this._addTradingLimit(token, 'LIQUIDITY_TOO_LOW', 24 * 60 * 60 * 1000);
        return { allowed: false, reason: 'Liquidité insuffisante' };
      }
      if (marketData.volume24h && marketData.volume24h < this.riskParams.minVolume24h) {
        this._addTradingLimit(token, 'VOLUME_TOO_LOW', 12 * 60 * 60 * 1000);
        return { allowed: false, reason: 'Volume insuffisant' };
      }
    }
    return { allowed: true };
  }

  calculateMaxPositionSize(token, price, portfolioValue) {
    const maxSizeByPortfolio = (portfolioValue * (this.riskParams.maxExposurePerToken / 100)) / price;
    const currentExposure = this.state.exposureByToken.get(token) || 0;
    const remainingExposure = (this.riskParams.maxExposurePerToken - currentExposure) / 100;
    const maxSizeByExposure = (portfolioValue * remainingExposure) / price;
    return Math.min(maxSizeByPortfolio, maxSizeByExposure);
  }

  _getVolatilityMultiplier(volatility) {
    return this.riskParams.volatilityMultiplier[volatility] || this.riskParams.volatilityMultiplier.medium;
  }

  _triggerCircuitBreaker(reason) {
    this.state.circuitBreakerTriggered = true;
    this.state.circuitBreakerExpiry = Date.now() + (this.riskParams.circuitBreaker.timeoutMinutes * 60 * 1000);
    this.emit('risk_limit_reached', {
      type: 'CIRCUIT_BREAKER',
      reason: `Circuit breaker déclenché: ${reason}`,
      expiryTime: new Date(this.state.circuitBreakerExpiry).toISOString()
    });
    return false;
  }

  _resetCircuitBreaker() {
    this.state.circuitBreakerTriggered = false;
    this.state.circuitBreakerExpiry = null;
    this.state.consecutiveLosses = 0;
  }

  _resetDailyLimitsIfNeeded() {
    if (Date.now() >= this.state.dailyLossResetTime) {
      this.state.dailyLoss = 0;
      this.state.dailyLossResetTime = this._getEndOfDay();
    }
  }

  _getEndOfDay() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  }

  _addTradingLimit(token, reason, duration) {
    this.state.tradingLimitsByToken.set(token, {reason, expiry: Date.now() + duration});
  }

  getState() {
    return {
      ...this.state,
      exposureByToken: Object.fromEntries(this.state.exposureByToken),
      tradingLimitsByToken: Object.fromEntries(this.state.tradingLimitsByToken),
      params: { ...this.riskParams }
    };
  }
}