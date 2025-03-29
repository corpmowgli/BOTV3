// trading/riskManager.js - Gestionnaire de risque optimisé
import EventEmitter from 'events';

export class RiskManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    
    // Paramètres par défaut pour la gestion du risque
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
      trailingStopLoss: config.trading?.trailingStopLoss || false,
      trailingStopDistance: config.trading?.trailingStopDistance || 2,
      takeProfit: config.trading?.takeProfit || 15,
      minConfidenceThreshold: config.trading?.minConfidenceThreshold || 0.6,
      // Paramètres spécifiques à Solana
      volatilityMultiplier: config.trading?.volatilityMultiplier || {
        low: 1.0,
        medium: 0.8,
        high: 0.6
      },
      // Circuit Breaker - suspension du trading si trop de pertes
      circuitBreaker: {
        enabled: config.trading?.circuitBreaker?.enabled !== false,
        consecutiveLosses: config.trading?.circuitBreaker?.consecutiveLosses || 3,
        timeoutMinutes: config.trading?.circuitBreaker?.timeoutMinutes || 30,
        maxDailyLossPercent: config.trading?.circuitBreaker?.maxDailyLossPercent || 5
      }
    };
    
    // État du gestionnaire de risque
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
      if (newConfig.trading.maxLossPerTrade !== undefined) 
        this.riskParams.maxLossPerTrade = newConfig.trading.maxLossPerTrade;
        
      if (newConfig.trading.maxDailyLoss !== undefined) 
        this.riskParams.maxDailyLoss = newConfig.trading.maxDailyLoss;
        
      if (newConfig.trading.maxExposurePerToken !== undefined)
        this.riskParams.maxExposurePerToken = newConfig.trading.maxExposurePerToken;
        
      if (newConfig.trading.maxOpenPositions !== undefined)
        this.riskParams.maxOpenPositions = newConfig.trading.maxOpenPositions;
        
      if (newConfig.trading.minLiquidity !== undefined)
        this.riskParams.minLiquidity = newConfig.trading.minLiquidity;
        
      if (newConfig.trading.minVolume24h !== undefined)
        this.riskParams.minVolume24h = newConfig.trading.minVolume24h;
        
      if (newConfig.trading.stopLoss !== undefined)
        this.riskParams.stopLoss = newConfig.trading.stopLoss;
        
      if (newConfig.trading.takeProfit !== undefined)
        this.riskParams.takeProfit = newConfig.trading.takeProfit;
        
      if (newConfig.trading.trailingStopLoss !== undefined)
        this.riskParams.trailingStopLoss = newConfig.trading.trailingStopLoss;
        
      if (newConfig.trading.trailingStopDistance !== undefined)
        this.riskParams.trailingStopDistance = newConfig.trading.trailingStopDistance;

      if (newConfig.trading.tradeSize !== undefined)
        this.riskParams.tradeSize = newConfig.trading.tradeSize;
    }
    
    if (newConfig.simulation && newConfig.simulation.maxDrawdown !== undefined) {
      this.riskParams.maxDrawdown = newConfig.simulation.maxDrawdown;
    }
    
    if (newConfig.trading && newConfig.trading.circuitBreaker) {
      this.riskParams.circuitBreaker = {
        ...this.riskParams.circuitBreaker,
        ...newConfig.trading.circuitBreaker
      };
    }
    
    this.config = { ...this.config, ...newConfig };
  }

  checkPositionAllowed(position, marketData) {
    // Reset des limites quotidiennes si nécessaire
    this._resetDailyLimitsIfNeeded();
    
    // Vérification du circuit breaker
    if (this.state.circuitBreakerTriggered) {
      if (Date.now() < this.state.circuitBreakerExpiry) {
        return {
          allowed: false,
          reason: `Circuit breaker actif jusqu'à ${new Date(this.state.circuitBreakerExpiry).toLocaleTimeString()}`
        };
      } else {
        this._resetCircuitBreaker();
      }
    }
    
    // Vérification du nombre maximal de positions
    if (position.totalPositions >= this.riskParams.maxOpenPositions) {
      return {
        allowed: false,
        reason: `Nombre maximum de positions ouvertes atteint (${this.riskParams.maxOpenPositions})`
      };
    }
    
    // Vérification de la liquidité minimale
    if (marketData && marketData.liquidity && marketData.liquidity < this.riskParams.minLiquidity) {
      return {
        allowed: false,
        reason: `Liquidité insuffisante (${marketData.liquidity} < ${this.riskParams.minLiquidity})`
      };
    }
    
    // Vérification du volume minimal
    if (marketData && marketData.volume24h && marketData.volume24h < this.riskParams.minVolume24h) {
      return {
        allowed: false,
        reason: `Volume 24h insuffisant (${marketData.volume24h} < ${this.riskParams.minVolume24h})`
      };
    }
    
    // Vérification de l'exposition maximale par token
    const tokenExposure = this.state.exposureByToken.get(position.token) || 0;
    if (tokenExposure + position.amount > this.riskParams.maxExposurePerToken) {
      return {
        allowed: false,
        reason: `Exposition maximale par token dépassée (${tokenExposure + position.amount}% > ${this.riskParams.maxExposurePerToken}%)`
      };
    }
    
    // Vérification du drawdown actuel
    if (this.state.currentDrawdown > this.riskParams.maxDrawdown) {
      return {
        allowed: false,
        reason: `Drawdown maximal dépassé (${this.state.currentDrawdown.toFixed(2)}% > ${this.riskParams.maxDrawdown}%)`
      };
    }
    
    // Vérification des limites quotidiennes
    if (this.state.dailyLoss > this.riskParams.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Perte quotidienne maximale dépassée (${this.state.dailyLoss.toFixed(2)}% > ${this.riskParams.maxDailyLoss}%)`
      };
    }
    
    // Si tous les contrôles sont passés
    return { allowed: true };
  }

  calculatePositionRisk(token, entryPrice, amount, confidence, marketData = {}) {
    // Calculer le stop loss et take profit en fonction de la volatilité et de la confiance
    let stopLossPercent = this.riskParams.stopLoss;
    let takeProfitPercent = this.riskParams.takeProfit;
    
    // Ajuster en fonction de la volatilité du marché si disponible
    if (marketData.volatility) {
      const multiplier = this._getVolatilityMultiplier(marketData.volatility);
      stopLossPercent *= multiplier;
      takeProfitPercent *= multiplier;
    }
    
    // Ajuster en fonction de la confiance du signal
    if (confidence) {
      // Plus la confiance est élevée, plus on peut prendre de risque
      const confidenceMultiplier = 0.8 + (confidence * 0.4); // 0.8 à 1.2
      takeProfitPercent *= confidenceMultiplier;
      
      // Et plus on peut serrer le stop loss
      if (confidence > 0.8) {
        stopLossPercent *= 0.9; // Stop loss plus serré pour les signaux à forte confiance
      }
    }
    
    // Calculer les valeurs réelles
    const stopLossValue = entryPrice * (1 - (stopLossPercent / 100));
    const takeProfitValue = entryPrice * (1 + (takeProfitPercent / 100));
    
    // Calculer le rapport risque/récompense
    const risk = entryPrice - stopLossValue;
    const reward = takeProfitValue - entryPrice;
    const riskRewardRatio = reward / (risk || 1);
    
    // Déterminer si c'est une bonne opportunité
    const isGoodOpportunity = riskRewardRatio >= 1.5;
    
    // Ajuster la taille de la position en fonction du risque
    let positionSize = this.riskParams.tradeSize;
    
    // Réduire la taille pour les opportunités à risque élevé ou faible confiance
    if (riskRewardRatio < 2 || confidence < 0.7) {
      positionSize *= 0.8;
    }
    
    // Augmenter légèrement pour les très bonnes opportunités
    if (riskRewardRatio > 3 && confidence > 0.8) {
      positionSize *= 1.2;
    }
    
    // Limiter la taille en fonction de la volatilité
    if (marketData.volatility === 'high') {
      positionSize *= 0.7;
    }
    
    // Arrondir la taille de la position
    positionSize = Math.max(this.riskParams.minTradeAmount, Math.min(positionSize, this.riskParams.maxExposurePerToken));
    
    return {
      stopLoss: stopLossValue,
      takeProfit: takeProfitValue,
      positionSize,
      riskRewardRatio,
      isGoodOpportunity,
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
    
    // Calculer le drawdown actuel
    const drawdown = ((this.state.peakValue - currentValue) / this.state.peakValue) * 100;
    this.state.currentDrawdown = drawdown;
    
    // Vérifier si le drawdown dépasse le maximum autorisé
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
    
    // Mettre à jour les pertes consécutives
    if (isLoss) {
      this.state.consecutiveLosses++;
      this.state.dailyLoss += Math.abs(percentage);
      
      // Vérifier si le circuit breaker doit être déclenché
      if (this.riskParams.circuitBreaker.enabled) {
        if (this.state.consecutiveLosses >= this.riskParams.circuitBreaker.consecutiveLosses) {
          this._triggerCircuitBreaker('Trop de pertes consécutives');
          return false;
        }
        
        if (this.state.dailyLoss >= this.riskParams.circuitBreaker.maxDailyLossPercent) {
          this._triggerCircuitBreaker('Perte quotidienne maximale dépassée');
          return false;
        }
      }
    } else {
      // Réinitialiser le compteur de pertes consécutives
      this.state.consecutiveLosses = 0;
    }
    
    // Mettre à jour le drawdown
    return this.updateDrawdown(initialCapital + profit, initialCapital);
  }

  adjustTrailingStop(position, currentPrice) {
    if (!position.trailingStop || !position.trailingStop.enabled) return position;
    
    const isLong = position.direction === 'BUY';
    let updatedStop = position.trailingStop.current;
    
    if (isLong) {
      // Pour les positions longues
      const potentialStop = currentPrice * (1 - (position.trailingStop.distance / 100));
      if (potentialStop > updatedStop) {
        updatedStop = potentialStop;
      }
    } else {
      // Pour les positions courtes
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
    
    // Vérifier le stop loss
    if (isLong && currentPrice <= (position.trailingStop?.enabled ? position.trailingStop.current : position.stopLoss)) {
      return {
        shouldClose: true,
        reason: 'STOP_LOSS'
      };
    } else if (!isLong && currentPrice >= (position.trailingStop?.enabled ? position.trailingStop.current : position.stopLoss)) {
      return {
        shouldClose: true,
        reason: 'STOP_LOSS'
      };
    }
    
    // Vérifier le take profit
    if (isLong && currentPrice >= position.takeProfit) {
      return {
        shouldClose: true,
        reason: 'TAKE_PROFIT'
      };
    } else if (!isLong && currentPrice <= position.takeProfit) {
      return {
        shouldClose: true,
        reason: 'TAKE_PROFIT'
      };
    }
    
    // Vérifier la durée maximale si définie
    if (position.maxDuration && (Date.now() - position.entryTime) > position.maxDuration) {
      return {
        shouldClose: true,
        reason: 'MAX_DURATION_EXCEEDED'
      };
    }
    
    return {
      shouldClose: false
    };
  }

  isTokenAllowed(token, marketData) {
    // Vérifier si le token est dans les limites de trading
    const tradingLimit = this.state.tradingLimitsByToken.get(token);
    if (tradingLimit && tradingLimit.expiry > Date.now()) {
      return {
        allowed: false,
        reason: tradingLimit.reason
      };
    }
    
    // Vérification de la liquidité et du volume minimaux
    if (marketData) {
      if (marketData.liquidity && marketData.liquidity < this.riskParams.minLiquidity) {
        this._addTradingLimit(token, 'LIQUIDITY_TOO_LOW', 24 * 60 * 60 * 1000); // 24h
        return {
          allowed: false,
          reason: 'Liquidité insuffisante'
        };
      }
      
      if (marketData.volume24h && marketData.volume24h < this.riskParams.minVolume24h) {
        this._addTradingLimit(token, 'VOLUME_TOO_LOW', 12 * 60 * 60 * 1000); // 12h
        return {
          allowed: false,
          reason: 'Volume insuffisant'
        };
      }
    }
    
    return { allowed: true };
  }

  calculateMaxPositionSize(token, price, portfolioValue) {
    // Calculer la taille maximale de position en fonction du portefeuille
    const maxSizeByPortfolio = (portfolioValue * (this.riskParams.maxExposurePerToken / 100)) / price;
    
    // Récupérer l'exposition actuelle
    const currentExposure = this.state.exposureByToken.get(token) || 0;
    const remainingExposure = (this.riskParams.maxExposurePerToken - currentExposure) / 100;
    
    // Calculer la taille maximale en fonction de l'exposition restante
    const maxSizeByExposure = (portfolioValue * remainingExposure) / price;
    
    // Prendre le minimum des deux
    return Math.min(maxSizeByPortfolio, maxSizeByExposure);
  }

  _getVolatilityMultiplier(volatility) {
    switch (volatility) {
      case 'high':
        return this.riskParams.volatilityMultiplier.high;
      case 'medium':
        return this.riskParams.volatilityMultiplier.medium;
      case 'low':
      default:
        return this.riskParams.volatilityMultiplier.low;
    }
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
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return endOfDay.getTime();
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