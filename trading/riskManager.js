// riskManager.js - Version optimisée
import EventEmitter from 'events';

export class RiskManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    
    // Paramètres de risque
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
        low: 1.0,
        medium: 0.8,
        high: 0.6
      },
      circuitBreaker: {
        enabled: config.trading?.circuitBreaker?.enabled !== false,
        consecutiveLosses: config.trading?.circuitBreaker?.consecutiveLosses || 3,
        timeoutMinutes: config.trading?.circuitBreaker?.timeoutMinutes || 30,
        maxDailyLossPercent: config.trading?.circuitBreaker?.maxDailyLossPercent || 5
      }
    };
    
    // État
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
    // Mise à jour des paramètres essentiels
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
    
    if (newConfig.simulation?.maxDrawdown !== undefined) {
      this.riskParams.maxDrawdown = newConfig.simulation.maxDrawdown;
    }
    
    if (newConfig.trading?.circuitBreaker) {
      this.riskParams.circuitBreaker = {
        ...this.riskParams.circuitBreaker,
        ...newConfig.trading.circuitBreaker
      };
    }
    
    this.config = { ...this.config, ...newConfig };
  }

  checkPositionAllowed(position, marketData) {
    // Reset limites quotidiennes si nécessaire
    this._resetDailyLimitsIfNeeded();
    
    // Vérifications
    const checks = [
      // Circuit breaker
      {
        condition: this.state.circuitBreakerTriggered && Date.now() < this.state.circuitBreakerExpiry,
        reason: `Circuit breaker actif jusqu'à ${new Date(this.state.circuitBreakerExpiry).toLocaleTimeString()}`
      },
      // Nombre max de positions
      {
        condition: position.totalPositions >= this.riskParams.maxOpenPositions,
        reason: `Nombre maximum de positions ouvertes atteint (${this.riskParams.maxOpenPositions})`
      },
      // Liquidité minimale
      {
        condition: marketData?.liquidity && marketData.liquidity < this.riskParams.minLiquidity,
        reason: `Liquidité insuffisante (${marketData?.liquidity} < ${this.riskParams.minLiquidity})`
      },
      // Volume minimal
      {
        condition: marketData?.volume24h && marketData.volume24h < this.riskParams.minVolume24h,
        reason: `Volume 24h insuffisant (${marketData?.volume24h} < ${this.riskParams.minVolume24h})`
      },
      // Exposition maximale par token
      {
        condition: (this.state.exposureByToken.get(position.token) || 0) + position.amount > this.riskParams.maxExposurePerToken,
        reason: `Exposition maximale par token dépassée`
      },
      // Drawdown actuel
      {
        condition: this.state.currentDrawdown > this.riskParams.maxDrawdown,
        reason: `Drawdown maximal dépassé (${this.state.currentDrawdown.toFixed(2)}% > ${this.riskParams.maxDrawdown}%)`
      },
      // Pertes quotidiennes
      {
        condition: this.state.dailyLoss > this.riskParams.maxDailyLoss,
        reason: `Perte quotidienne maximale dépassée (${this.state.dailyLoss.toFixed(2)}% > ${this.riskParams.maxDailyLoss}%)`
      }
    ];
    
    // Vérifier chaque condition
    for (const check of checks) {
      if (check.condition) {
        return { allowed: false, reason: check.reason };
      }
    }
    
    // Si toutes les vérifications passent
    return { allowed: true };
  }

  calculatePositionRisk(token, entryPrice, amount, confidence, marketData = {}) {
    // Calcul de base du stop loss et take profit
    let stopLossPercent = this.riskParams.stopLoss;
    let takeProfitPercent = this.riskParams.takeProfit;
    
    // Ajustements en fonction de la volatilité et confiance
    if (marketData.volatility) {
      const multiplier = this._getVolatilityMultiplier(marketData.volatility);
      stopLossPercent *= multiplier;
      takeProfitPercent *= multiplier;
    }
    
    if (confidence) {
      const confidenceMultiplier = 0.8 + (confidence * 0.4); // 0.8 à 1.2
      takeProfitPercent *= confidenceMultiplier;
      
      if (confidence > 0.8) {
        stopLossPercent *= 0.9; // Stop loss plus serré
      }
    }
    
    // Calcul des valeurs
    const stopLossValue = entryPrice * (1 - (stopLossPercent / 100));
    const takeProfitValue = entryPrice * (1 + (takeProfitPercent / 100));
    
    // Calcul du rapport risque/récompense
    const risk = entryPrice - stopLossValue;
    const reward = takeProfitValue - entryPrice;
    const riskRewardRatio = reward / (risk || 1);
    
    // Ajustement de la taille de position
    let positionSize = this.riskParams.tradeSize;
    
    if (riskRewardRatio < 2 || confidence < 0.7) {
      positionSize *= 0.8;
    } else if (riskRewardRatio > 3 && confidence > 0.8) {
      positionSize *= 1.2;
    }
    
    if (marketData.volatility === 'high') {
      positionSize *= 0.7;
    }
    
    // Limites
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
      } : {
        enabled: false
      },
      risk: { 
        stopLossPercent,
        takeProfitPercent 
      }
    };
  }

  updateDrawdown(currentValue, initialCapital) {
    // Mettre à jour la valeur de pointe
    if (currentValue > this.state.peakValue) {
      this.state.peakValue = currentValue;
    }
    
    // Calculer drawdown
    const drawdown = ((this.state.peakValue - currentValue) / this.state.peakValue) * 100;
    this.state.currentDrawdown = drawdown;
    
    // Vérifier limites
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
      if (newExposure === 0) {
        this.state.exposureByToken.delete(token);
      } else {
        this.state.exposureByToken.set(token, newExposure);
      }
    }
  }

  recordTradeResult(profit, percentage, initialCapital) {
    const isLoss = profit < 0;
    
    // Gestion des pertes
    if (isLoss) {
      this.state.consecutiveLosses++;
      this.state.dailyLoss += Math.abs(percentage);
      
      // Circuit breaker check
      if (this.riskParams.circuitBreaker.enabled) {
        if (this.state.consecutiveLosses >= this.riskParams.circuitBreaker.consecutiveLosses) {
          return this._triggerCircuitBreaker('Trop de pertes consécutives');
        }
        
        if (this.state.dailyLoss >= this.riskParams.circuitBreaker.maxDailyLossPercent) {
          return this._triggerCircuitBreaker('Perte quotidienne maximale dépassée');
        }
      }
    } else {
      // Reset des pertes consécutives
      this.state.consecutiveLosses = 0;
    }
    
    // Mise à jour du drawdown
    return this.updateDrawdown(initialCapital + profit, initialCapital);
  }

  adjustTrailingStop(position, currentPrice) {
    if (!position.trailingStop?.enabled) return position;
    
    const isLong = position.direction === 'BUY';
    let updatedStop = position.trailingStop.current;
    
    // Calcul du nouveau stop
    if (isLong) {
      const potentialStop = currentPrice * (1 - (position.trailingStop.distance / 100));
      if (potentialStop > updatedStop) {
        updatedStop = potentialStop;
      }
    } else {
      const potentialStop = currentPrice * (1 + (position.trailingStop.distance / 100));
      if (potentialStop < updatedStop) {
        updatedStop = potentialStop;
      }
    }
    
    return {
      ...position,
      trailingStop: {
        ...position.trailingStop,
        current: updatedStop
      }
    };
  }

  shouldClosePosition(position, currentPrice) {
    const isLong = position.direction === 'BUY';
    const effectiveStopLoss = position.trailingStop?.enabled 
      ? position.trailingStop.current 
      : position.stopLoss;
    
    // Vérifications de fermeture
    const checks = [
      // Stop loss
      {
        condition: (isLong && currentPrice <= effectiveStopLoss) || 
                  (!isLong && currentPrice >= effectiveStopLoss),
        reason: 'STOP_LOSS'
      },
      // Take profit
      {
        condition: (isLong && currentPrice >= position.takeProfit) ||
                  (!isLong && currentPrice <= position.takeProfit),
        reason: 'TAKE_PROFIT'
      },
      // Durée maximale
      {
        condition: position.maxDuration && (Date.now() - position.entryTime) > position.maxDuration,
        reason: 'MAX_DURATION_EXCEEDED'
      }
    ];
    
    // Vérifier chaque condition
    for (const check of checks) {
      if (check.condition) {
        return {
          shouldClose: true,
          reason: check.reason
        };
      }
    }
    
    return { shouldClose: false };
  }

  isTokenAllowed(token, marketData) {
    // Vérifier limites
    const tradingLimit = this.state.tradingLimitsByToken.get(token);
    if (tradingLimit && tradingLimit.expiry > Date.now()) {
      return {
        allowed: false,
        reason: tradingLimit.reason
      };
    }
    
    // Vérifications
    if (marketData) {
      if (marketData.liquidity && marketData.liquidity < this.riskParams.minLiquidity) {
        this._addTradingLimit(token, 'LIQUIDITY_TOO_LOW', 24 * 60 * 60 * 1000);
        return {
          allowed: false,
          reason: 'Liquidité insuffisante'
        };
      }
      
      if (marketData.volume24h && marketData.volume24h < this.riskParams.minVolume24h) {
        this._addTradingLimit(token, 'VOLUME_TOO_LOW', 12 * 60 * 60 * 1000);
        return {
          allowed: false,
          reason: 'Volume insuffisant'
        };
      }
    }
    
    return { allowed: true };
  }

  calculateMaxPositionSize(token, price, portfolioValue) {
    // Calcul basé sur le portefeuille
    const maxSizeByPortfolio = (portfolioValue * (this.riskParams.maxExposurePerToken / 100)) / price;
    
    // Calcul basé sur l'exposition restante
    const currentExposure = this.state.exposureByToken.get(token) || 0;
    const remainingExposure = (this.riskParams.maxExposurePerToken - currentExposure) / 100;
    const maxSizeByExposure = (portfolioValue * remainingExposure) / price;
    
    // Prendre le minimum
    return Math.min(maxSizeByPortfolio, maxSizeByExposure);
  }

  // Méthodes privées
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
    this.state.tradingLimitsByToken.set(token, {
      reason,
      expiry: Date.now() + duration
    });
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