// bot/simulationEngine.js - Moteur de simulation pour backtesting et optimisation
import EventEmitter from 'events';
import { delay } from '../utils/helpers.js';

/**
 * SimulationEngine - Moteur de backtesting et d'optimisation pour les stratégies de trading
 */
export class SimulationEngine extends EventEmitter {
  /**
   * Crée une nouvelle instance du moteur de simulation
   * @param {Object} config - Configuration globale
   * @param {Object} strategy - Stratégie de trading à simuler
   * @param {Object} riskManager - Gestionnaire de risque
   * @param {Object} dataManager - Gestionnaire de données
   * @param {Object} logger - Logger pour enregistrer les opérations
   */
  constructor(config, strategy, riskManager, dataManager, logger) {
    super();
    this.config = config;
    this.strategy = strategy;
    this.riskManager = riskManager;
    this.dataManager = dataManager;
    this.logger = logger;
    
    // État de la simulation
    this.simulationState = {
      isRunning: false,
      startTime: 0,
      endTime: 0,
      progress: 0,
      currentToken: null,
      processedTokens: 0,
      totalTokens: 0
    };
    
    // Résultats de la simulation
    this.simulationResults = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      winRate: 0,
      trades: [],
      dailyPerformance: [],
      tokenPerformance: []
    };
  }

  /**
   * Exécute une simulation de trading sur une période historique
   * @param {Date|number} startDate - Date de début
   * @param {Date|number} endDate - Date de fin
   * @param {Object} customConfig - Configuration personnalisée pour la simulation
   * @returns {Promise<Object>} Résultats de la simulation
   */
  async runSimulation(startDate, endDate, customConfig = null) {
    try {
      // Convertir les dates en timestamps si nécessaire
      const startTime = typeof startDate === 'object' ? startDate.getTime() : Number(startDate);
      const endTime = typeof endDate === 'object' ? endDate.getTime() : Number(endDate);
      
      if (isNaN(startTime) || isNaN(endTime)) {
        throw new Error('Dates de simulation invalides');
      }
      
      if (startTime >= endTime) {
        throw new Error('La date de début doit être antérieure à la date de fin');
      }
      
      // Initialiser l'état de la simulation
      this.simulationState = {
        isRunning: true,
        startTime,
        endTime,
        progress: 0,
        currentToken: null,
        processedTokens: 0,
        totalTokens: 0
      };
      
      // Restaurer la configuration originale à la fin
      const originalConfig = { ...this.config };
      
      // Appliquer la configuration personnalisée si fournie
      if (customConfig) {
        this.config = { ...this.config, ...customConfig };
        this.strategy.updateConfig(this.config);
        this.riskManager.updateConfig(this.config);
      }
      
      // Initialisation du portefeuille simulé
      const initialCapital = this.config.simulation.initialCapital || 10000;
      const portfolio = {
        initialCapital,
        currentCapital: initialCapital,
        positions: [],
        closedTrades: [],
        peakCapital: initialCapital,
        maxDrawdown: 0
      };
      
      // Obtenir les tokens à analyser pour la période
      this.emit('simulation_info', { message: 'Récupération des données historiques...' });
      const tokens = await this._getHistoricalTokens(startTime, endTime);
      
      this.simulationState.totalTokens = tokens.length;
      this.emit('simulation_info', { message: `${tokens.length} tokens identifiés pour simulation` });
      
      // Parcourir chaque jour de la période
      const millisecondsPerDay = 24 * 60 * 60 * 1000;
      const dailyResults = [];
      
      for (let currentDay = startTime; currentDay <= endTime; currentDay += millisecondsPerDay) {
        const dayEnd = Math.min(currentDay + millisecondsPerDay, endTime);
        
        // Traiter le jour courant
        const dayResult = await this._processDay(currentDay, dayEnd, tokens, portfolio);
        dailyResults.push(dayResult);
        
        // Mettre à jour la progression
        this.simulationState.progress = (currentDay - startTime) / (endTime - startTime) * 100;
        this.emit('simulation_progress', { progress: this.simulationState.progress });
        
        // Vérifier s'il faut fermer des positions
        await this._checkPositionsForDay(dayEnd, portfolio);
      }
      
      // Fermer toutes les positions ouvertes à la fin de la simulation
      this._closeAllOpenPositions(endTime, portfolio);
      
      // Calculer les métriques de performance
      const results = this._calculatePerformanceMetrics(portfolio, dailyResults, tokens);
      
      // Restaurer la configuration originale
      this.config = originalConfig;
      this.strategy.updateConfig(originalConfig);
      this.riskManager.updateConfig(originalConfig);
      
      // Terminer la simulation
      this.simulationState.isRunning = false;
      this.simulationState.progress = 100;
      this.simulationResults = results;
      
      this.emit('simulation_completed', results);
      
      return {
        success: true,
        simulationPeriod: {
          start: new Date(startTime).toISOString(),
          end: new Date(endTime).toISOString()
        },
        config: customConfig || this.config,
        ...results
      };
    } catch (error) {
      this.simulationState.isRunning = false;
      this.emit('simulation_error', { error: error.message });
      
      return {
        success: false,
        error: error.message,
        errorDetails: error.stack
      };
    }
  }

  /**
   * Optimise les paramètres de la stratégie
   * @param {Date|number} startDate - Date de début
   * @param {Date|number} endDate - Date de fin
   * @param {Object} parametersToOptimize - Paramètres à optimiser avec leurs plages
   * @returns {Promise<Object>} Résultats de l'optimisation
   */
  async optimizeParameters(startDate, endDate, parametersToOptimize) {
    try {
      // Validation des paramètres
      if (!parametersToOptimize || Object.keys(parametersToOptimize).length === 0) {
        throw new Error('Aucun paramètre à optimiser spécifié');
      }
      
      this.emit('optimization_start', { 
        message: 'Démarrage de l\'optimisation des paramètres',
        parameters: parametersToOptimize
      });
      
      // Configuration originale à restaurer à la fin
      const originalConfig = { ...this.config };
      
      // Générer les combinaisons de paramètres à tester
      const parameterCombinations = this._generateParameterCombinations(parametersToOptimize);
      
      this.emit('optimization_info', { 
        message: `${parameterCombinations.length} combinaisons de paramètres à tester`
      });
      
      // Résultats des optimisations
      const optimizationResults = [];
      
      // Tester chaque combinaison
      for (let i = 0; i < parameterCombinations.length; i++) {
        const parameterSet = parameterCombinations[i];
        
        // Créer la configuration personnalisée
        const customConfig = this._buildConfigFromParameters(parameterSet);
        
        this.emit('optimization_progress', { 
          combinationIndex: i + 1, 
          totalCombinations: parameterCombinations.length,
          progress: ((i + 1) / parameterCombinations.length) * 100,
          currentParameters: parameterSet
        });
        
        // Exécuter la simulation avec cette configuration
        const simulationResult = await this.runSimulation(startDate, endDate, customConfig);
        
        if (simulationResult.success) {
          // Enregistrer le résultat avec les paramètres utilisés
          optimizationResults.push({
            parameters: parameterSet,
            performance: {
              totalProfit: simulationResult.totalProfit,
              profitPercentage: simulationResult.profitPercentage,
              winRate: simulationResult.winRate,
              profitFactor: simulationResult.profitFactor,
              maxDrawdown: simulationResult.maxDrawdown,
              sharpeRatio: simulationResult.sharpeRatio,
              trades: simulationResult.totalTrades
            }
          });
        }
        
        // Pause courte pour éviter de surcharger le système
        await delay(10);
      }
      
      // Restaurer la configuration originale
      this.config = originalConfig;
      this.strategy.updateConfig(originalConfig);
      this.riskManager.updateConfig(originalConfig);
      
      // Trier les résultats par profit total décroissant
      optimizationResults.sort((a, b) => b.performance.sharpeRatio - a.performance.sharpeRatio);
      
      // Créer le rapport d'optimisation
      const optimizationReport = {
        success: true,
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate).toISOString(),
        parametersOptimized: Object.keys(parametersToOptimize),
        combinationsTested: parameterCombinations.length,
        bestParameters: optimizationResults.length > 0 ? optimizationResults[0].parameters : null,
        bestPerformance: optimizationResults.length > 0 ? optimizationResults[0].performance : null,
        allResults: optimizationResults.slice(0, 10) // Top 10 résultats
      };
      
      this.emit('optimization_completed', optimizationReport);
      
      return optimizationReport;
    } catch (error) {
      this.emit('optimization_error', { error: error.message });
      
      return {
        success: false,
        error: error.message,
        errorDetails: error.stack
      };
    }
  }

  /**
   * Récupère la liste des tokens historiques pour la période
   * @private
   * @param {number} startTime - Timestamp de début
   * @param {number} endTime - Timestamp de fin
   * @returns {Promise<Array>} Liste des tokens
   */
  async _getHistoricalTokens(startTime, endTime) {
    // Dans une implémentation réelle, cette méthode devrait récupérer
    // les tokens qui étaient disponibles durant la période spécifiée
    // Pour cet exemple, nous utilisons une liste fixe
    
    try {
      // Essayer de récupérer les tokens depuis les données historiques
      const topTokens = await this.dataManager.getTopTokens(
        this.config.trading.maxTokensToAnalyze || 50
      );
      
      if (topTokens && topTokens.length > 0) {
        return topTokens;
      }
      
      // Si aucune donnée disponible, utiliser des tokens par défaut
      return [
        { token_mint: 'SOL', symbol: 'SOL', name: 'Solana' },
        { token_mint: 'RAY', symbol: 'RAY', name: 'Raydium' },
        { token_mint: 'SRM', symbol: 'SRM', name: 'Serum' },
        { token_mint: 'FIDA', symbol: 'FIDA', name: 'Bonfida' },
        { token_mint: 'MNGO', symbol: 'MNGO', name: 'Mango Markets' }
      ];
    } catch (error) {
      this.emit('simulation_warning', { 
        message: `Erreur lors de la récupération des tokens historiques: ${error.message}`,
        fallback: 'Utilisation des tokens par défaut'
      });
      
      return [
        { token_mint: 'SOL', symbol: 'SOL', name: 'Solana' },
        { token_mint: 'RAY', symbol: 'RAY', name: 'Raydium' },
        { token_mint: 'SRM', symbol: 'SRM', name: 'Serum' },
        { token_mint: 'FIDA', symbol: 'FIDA', name: 'Bonfida' },
        { token_mint: 'MNGO', symbol: 'MNGO', name: 'Mango Markets' }
      ];
    }
  }

  /**
   * Traite un jour de simulation
   * @private
   * @param {number} dayStart - Timestamp de début de journée
   * @param {number} dayEnd - Timestamp de fin de journée
   * @param {Array} tokens - Liste des tokens à analyser
   * @param {Object} portfolio - État du portefeuille
   * @returns {Promise<Object>} Résultats de la journée
   */
  async _processDay(dayStart, dayEnd, tokens, portfolio) {
    const dayResult = {
      date: new Date(dayStart).toISOString().split('T')[0],
      startCapital: portfolio.currentCapital,
      endCapital: portfolio.currentCapital,
      profit: 0,
      trades: [],
      tokenSignals: []
    };
    
    // Analyser chaque token
    for (const token of tokens) {
      this.simulationState.currentToken = token.token_mint || token.symbol;
      
      try {
        // Récupérer les données historiques pour le token
        const tokenData = await this._getHistoricalDataForToken(token, dayStart, dayEnd);
        
        if (!tokenData || !tokenData.prices || tokenData.prices.length < 20) {
          continue; // Pas assez de données pour l'analyse
        }
        
        // Analyser avec la stratégie
        const signal = await this.strategy.analyze(
          token.token_mint || token.symbol,
          tokenData.prices,
          tokenData.volumes,
          {
            liquidity: tokenData.liquidity,
            volume24h: tokenData.volume24h,
            volatility: tokenData.volatility
          }
        );
        
        // Enregistrer le signal pour les statistiques
        dayResult.tokenSignals.push({
          token: token.token_mint || token.symbol,
          signal: signal.type,
          confidence: signal.confidence
        });
        
        // Traiter le signal si suffisamment fort
        if (signal.type !== 'NONE' && signal.confidence >= this.config.trading.minConfidenceThreshold) {
          // Vérifier si on peut prendre une position
          const canTrade = this._canTakePosition(token, portfolio, signal);
          
          if (canTrade) {
            // Calculer la position
            const position = this._openSimulatedPosition(token, tokenData, signal, portfolio, dayEnd);
            
            if (position) {
              portfolio.positions.push(position);
              dayResult.trades.push({
                type: 'OPEN',
                token: position.token,
                price: position.entryPrice,
                amount: position.amount,
                value: position.value,
                direction: position.direction
              });
            }
          }
        }
      } catch (error) {
        this.emit('simulation_warning', { 
          message: `Erreur lors de l'analyse de ${token.token_mint || token.symbol}: ${error.message}`
        });
      }
      
      this.simulationState.processedTokens++;
    }
    
    // Calculer les résultats de la journée
    dayResult.endCapital = portfolio.currentCapital;
    dayResult.profit = dayResult.endCapital - dayResult.startCapital;
    
    // Mise à jour du drawdown
    if (portfolio.currentCapital > portfolio.peakCapital) {
      portfolio.peakCapital = portfolio.currentCapital;
    } else {
      const currentDrawdown = (portfolio.peakCapital - portfolio.currentCapital) / portfolio.peakCapital * 100;
      if (currentDrawdown > portfolio.maxDrawdown) {
        portfolio.maxDrawdown = currentDrawdown;
      }
    }
    
    return dayResult;
  }

  /**
   * Récupère les données historiques pour un token
   * @private
   * @param {Object} token - Token à analyser
   * @param {number} dayStart - Timestamp de début
   * @param {number} dayEnd - Timestamp de fin
   * @returns {Promise<Object>} Données historiques
   */
  async _getHistoricalDataForToken(token, dayStart, dayEnd) {
    try {
      // Récupérer un historique suffisant (7 jours avant pour les indicateurs)
      const lookbackPeriod = 7 * 24 * 60 * 60 * 1000; // 7 jours
      const startTime = dayStart - lookbackPeriod;
      const tokenMint = token.token_mint || token.symbol;
      
      // Récupérer les prix et volumes historiques
      const historicalData = await this.dataManager.getHistoricalData(
        tokenMint, 
        '1h', 
        Math.ceil(lookbackPeriod / (24 * 60 * 60 * 1000))
      );
      
      if (!historicalData || !historicalData.prices || historicalData.prices.length === 0) {
        return null;
      }
      
      // Calculer la volatilité sur la dernière semaine
      const recentPrices = historicalData.prices.slice(-48); // Dernières 48 heures
      let volatility = 'medium';
      
      if (recentPrices.length >= 24) {
        const priceChanges = [];
        for (let i = 1; i < recentPrices.length; i++) {
          priceChanges.push(Math.abs((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]));
        }
        
        // Moyenne des changements de prix en pourcentage
        const avgChange = priceChanges.reduce((sum, val) => sum + val, 0) / priceChanges.length * 100;
        
        if (avgChange < 1.5) {
          volatility = 'low';
        } else if (avgChange > 5) {
          volatility = 'high';
        }
      }
      
      // Récupérer les données de liquidité et volume si disponibles
      let liquidity = 0;
      let volume24h = 0;
      
      try {
        const tokenData = await this.dataManager.getTokenData(tokenMint);
        if (tokenData) {
          liquidity = tokenData.liquidity || 0;
          volume24h = tokenData.volume24h || 0;
        }
      } catch (error) {
        // En cas d'erreur, utiliser des estimations
        liquidity = 500000; // 500k $ par défaut
        volume24h = 100000; // 100k $ par défaut
      }
      
      return {
        prices: historicalData.prices,
        volumes: historicalData.volumes || new Array(historicalData.prices.length).fill(volume24h / 24),
        timestamps: historicalData.timestamps || [],
        liquidity,
        volume24h,
        volatility
      };
    } catch (error) {
      this.emit('simulation_warning', { 
        message: `Erreur lors de la récupération des données historiques pour ${token.token_mint || token.symbol}: ${error.message}`
      });
      return null;
    }
  }

  /**
   * Vérifie si une position peut être prise
   * @private
   * @param {Object} token - Token à trader
   * @param {Object} portfolio - État du portefeuille
   * @param {Object} signal - Signal de trading
   * @returns {boolean} True si une position peut être prise
   */
  _canTakePosition(token, portfolio, signal) {
    // Vérifier le nombre de positions ouvertes
    if (portfolio.positions.length >= this.config.trading.maxOpenPositions) {
      return false;
    }
    
    // Vérifier si une position est déjà ouverte sur ce token
    const hasExistingPosition = portfolio.positions.some(p => p.token === (token.token_mint || token.symbol));
    if (hasExistingPosition) {
      return false;
    }
    
    // Vérifier le capital disponible
    const maxPositionValue = portfolio.currentCapital * (this.config.trading.tradeSize / 100);
    if (maxPositionValue < this.config.trading.minTradeAmount) {
      return false;
    }
    
    return true;
  }

  /**
   * Ouvre une position simulée
   * @private
   * @param {Object} token - Token à trader
   * @param {Object} tokenData - Données du token
   * @param {Object} signal - Signal de trading
   * @param {Object} portfolio - État du portefeuille
   * @param {number} timestamp - Timestamp d'ouverture
   * @returns {Object|null} Position ouverte ou null si erreur
   */
  _openSimulatedPosition(token, tokenData, signal, portfolio, timestamp) {
    try {
      const tokenMint = token.token_mint || token.symbol;
      const currentPrice = tokenData.prices[tokenData.prices.length - 1];
      
      if (!currentPrice) return null;
      
      // Calculer la taille de la position
      const positionSizePercent = this.config.trading.tradeSize;
      const positionValue = portfolio.currentCapital * (positionSizePercent / 100);
      const amount = positionValue / currentPrice;
      
      // Calculer le stop loss et take profit
      const stopLossPercent = this.config.trading.stopLoss;
      const takeProfitPercent = this.config.trading.takeProfit;
      
      const stopLoss = signal.type === 'BUY'
        ? currentPrice * (1 - stopLossPercent / 100)
        : currentPrice * (1 + stopLossPercent / 100);
        
      const takeProfit = signal.type === 'BUY'
        ? currentPrice * (1 + takeProfitPercent / 100)
        : currentPrice * (1 - takeProfitPercent / 100);
      
      // Créer la position
      return {
        id: `sim_${tokenMint}_${timestamp}`,
        token: tokenMint,
        direction: signal.type,
        entryPrice: currentPrice,
        amount,
        value: positionValue,
        entryTime: timestamp,
        stopLoss,
        takeProfit,
        trailingStop: this.config.trading.trailingStopLoss ? {
          enabled: true,
          distance: this.config.trading.trailingStopDistance,
          current: stopLoss
        } : null,
        signal: {
          type: signal.type,
          confidence: signal.confidence,
          reasons: signal.reasons
        }
      };
    } catch (error) {
      this.emit('simulation_warning', { 
        message: `Erreur lors de l'ouverture de position simulée: ${error.message}`
      });
      return null;
    }
  }

  /**
   * Vérifie les positions pour un jour de simulation
   * @private
   * @param {number} dayEnd - Timestamp de fin de journée
   * @param {Object} portfolio - État du portefeuille
   * @returns {Promise<void>}
   */
  async _checkPositionsForDay(dayEnd, portfolio) {
    if (portfolio.positions.length === 0) return;
    
    const positionsToClose = [];
    
    // Vérifier chaque position
    for (const position of portfolio.positions) {
      try {
        // Récupérer le prix actuel
        const currentPrice = await this._getCurrentPriceForToken(position.token, dayEnd);
        
        if (!currentPrice) continue;
        
        // Vérifier les conditions de fermeture
        let closeReason = null;
        
        // Stop loss
        const effectiveStopLoss = position.trailingStop?.enabled 
          ? position.trailingStop.current 
          : position.stopLoss;
          
        if (position.direction === 'BUY' && currentPrice <= effectiveStopLoss) {
          closeReason = 'STOP_LOSS';
        } else if (position.direction === 'SELL' && currentPrice >= effectiveStopLoss) {
          closeReason = 'STOP_LOSS';
        }
        
        // Take profit
        if (!closeReason) {
          if (position.direction === 'BUY' && currentPrice >= position.takeProfit) {
            closeReason = 'TAKE_PROFIT';
          } else if (position.direction === 'SELL' && currentPrice <= position.takeProfit) {
            closeReason = 'TAKE_PROFIT';
          }
        }
        
        // Max duration (7 jours par défaut)
        const maxDuration = 7 * 24 * 60 * 60 * 1000;
        if (!closeReason && (dayEnd - position.entryTime) > maxDuration) {
          closeReason = 'MAX_DURATION';
        }
        
        // Mettre à jour le trailing stop si applicable
        if (!closeReason && position.trailingStop?.enabled) {
          if (position.direction === 'BUY' && currentPrice > position.entryPrice) {
            const newStopLoss = currentPrice * (1 - position.trailingStop.distance / 100);
            if (newStopLoss > position.trailingStop.current) {
              position.trailingStop.current = newStopLoss;
            }
          } else if (position.direction === 'SELL' && currentPrice < position.entryPrice) {
            const newStopLoss = currentPrice * (1 + position.trailingStop.distance / 100);
            if (newStopLoss < position.trailingStop.current) {
              position.trailingStop.current = newStopLoss;
            }
          }
        }
        
        // Si une raison de fermeture est trouvée, ajouter à la liste
        if (closeReason) {
          positionsToClose.push({
            position,
            currentPrice,
            reason: closeReason
          });
        }
      } catch (error) {
        this.emit('simulation_warning', { 
          message: `Erreur lors de la vérification de position pour ${position.token}: ${error.message}`
        });
      }
    }
    
    // Fermer les positions identifiées
    for (const { position, currentPrice, reason } of positionsToClose) {
      this._closeSimulatedPosition(position, currentPrice, reason, dayEnd, portfolio);
    }
  }

  /**
   * Ferme une position simulée
   * @private
   * @param {Object} position - Position à fermer
   * @param {number} exitPrice - Prix de sortie
   * @param {string} reason - Raison de fermeture
   * @param {number} timestamp - Timestamp de fermeture
   * @param {Object} portfolio - État du portefeuille
   * @returns {Object|null} Détails de la position fermée
   */
  _closeSimulatedPosition(position, exitPrice, reason, timestamp, portfolio) {
    try {
      // Calculer le P&L
      const isLong = position.direction === 'BUY';
      const priceDiff = isLong 
        ? exitPrice - position.entryPrice 
        : position.entryPrice - exitPrice;
      
      const profitPercentage = (priceDiff / position.entryPrice) * 100;
      const profit = position.value * (profitPercentage / 100);
      
      // Mettre à jour le portefeuille
      portfolio.currentCapital += position.value + profit;
      
      // Créer la position fermée
      const closedPosition = {
        ...position,
        exitPrice,
        exitTime: timestamp,
        holdingTime: timestamp - position.entryTime,
        profit,
        profitPercentage,
        closeReason: reason
      };
      
      // Ajouter aux trades fermés
      portfolio.closedTrades.push(closedPosition);
      
      // Retirer de la liste des positions ouvertes
      portfolio.positions = portfolio.positions.filter(p => p.id !== position.id);
      
      return closedPosition;
    } catch (error) {
      this.emit('simulation_warning', { 
        message: `Erreur lors de la fermeture de position simulée: ${error.message}`
      });
      return null;
    }
  }

  /**
   * Récupère le prix actuel d'un token
   * @private
   * @param {string} token - Token à consulter
   * @param {number} timestamp - Timestamp pour le prix
   * @returns {Promise<number|null>} Prix actuel
   */
  async _getCurrentPriceForToken(token, timestamp) {
    try {
      // Dans une implémentation réelle, on récupérerait le prix historique exact
      // Pour cet exemple, utiliser les données les plus récentes
      const histData = await this.dataManager.getHistoricalData(token, '1h', 1);
      
      if (histData && histData.prices && histData.prices.length > 0) {
        return histData.prices[histData.prices.length - 1];
      }
      
      // Fallback: simuler un prix aléatoire ±5%
      return await this.dataManager.getTokenPrice(token);
    } catch (error) {
      // Fallback vers un prix simulé
      return 1.0;
    }
  }

  /**
   * Ferme toutes les positions ouvertes
   * @private
   * @param {number} timestamp - Timestamp de fermeture
   * @param {Object} portfolio - État du portefeuille
   */
  _closeAllOpenPositions(timestamp, portfolio) {
    const positionsToClose = [...portfolio.positions];
    
    for (const position of positionsToClose) {
      // Récupérer le dernier prix connu
      this._getCurrentPriceForToken(position.token, timestamp)
        .then(currentPrice => {
          if (currentPrice) {
            this._closeSimulatedPosition(
              position, 
              currentPrice, 
              'END_OF_SIMULATION', 
              timestamp, 
              portfolio
            );
          }
        })
        .catch(() => {
          // En cas d'erreur, fermer au prix d'entrée (sans profit)
          this._closeSimulatedPosition(
            position, 
            position.entryPrice, 
            'END_OF_SIMULATION', 
            timestamp, 
            portfolio
          );
        });
    }
  }

  /**
   * Calcule les métriques de performance
   * @private
   * @param {Object} portfolio - État du portefeuille
   * @param {Array} dailyResults - Résultats quotidiens
   * @param {Array} tokens - Liste des tokens analysés
   * @returns {Object} Métriques de performance
   */
  _calculatePerformanceMetrics(portfolio, dailyResults, tokens) {
    // Statistiques de base
    const totalTrades = portfolio.closedTrades.length;
    const winningTrades = portfolio.closedTrades.filter(t => t.profit > 0).length;
    const losingTrades = portfolio.closedTrades.filter(t => t.profit < 0).length;
    
    const totalProfit = portfolio.currentCapital - portfolio.initialCapital;
    const profitPercentage = (totalProfit / portfolio.initialCapital) * 100;
    
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    
    // Profit factor
    const grossProfit = portfolio.closedTrades
      .filter(t => t.profit > 0)
      .reduce((sum, t) => sum + t.profit, 0);
      
    const grossLoss = Math.abs(portfolio.closedTrades
      .filter(t => t.profit < 0)
      .reduce((sum, t) => sum + t.profit, 0));
      
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    // Calculer les métriques quotidiennes
    const formattedDailyPerformance = dailyResults.map(day => {
      return {
        date: day.date,
        startCapital: day.startCapital,
        endCapital: day.endCapital,
        profit: day.profit,
        profitPercentage: (day.profit / day.startCapital) * 100,
        trades: day.trades.length
      };
    });
    
    // Calculer la performance par token
    const tokenPerformanceMap = new Map();
    
    portfolio.closedTrades.forEach(trade => {
      if (!tokenPerformanceMap.has(trade.token)) {
        tokenPerformanceMap.set(trade.token, {
          token: trade.token,
          trades: 0,
          winningTrades: 0,
          losingTrades: 0,
          totalProfit: 0,
          profitPercentage: 0
        });
      }
      
      const tokenStats = tokenPerformanceMap.get(trade.token);
      tokenStats.trades++;
      
      if (trade.profit > 0) {
        tokenStats.winningTrades++;
      } else if (trade.profit < 0) {
        tokenStats.losingTrades++;
      }
      
      tokenStats.totalProfit += trade.profit;
    });
    
    // Calculer les pourcentages et le win rate par token
    const tokenPerformance = Array.from(tokenPerformanceMap.values()).map(stats => {
      const tokenInitialCapital = portfolio.initialCapital / tokens.length; // Estimation simplifiée
      stats.profitPercentage = (stats.totalProfit / tokenInitialCapital) * 100;
      stats.winRate = stats.trades > 0 ? (stats.winningTrades / stats.trades) * 100 : 0;
      return stats;
    });
    
    // Calculer le Sharpe Ratio
    let sharpeRatio = 0;
    if (dailyResults.length > 10) {
      const dailyReturns = dailyResults.map(day => (day.profit / day.startCapital) * 100);
      const meanReturn = dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length;
      
      const variance = dailyReturns.reduce((sum, ret) => {
        const diff = ret - meanReturn;
        return sum + (diff * diff);
      }, 0) / dailyReturns.length;
      
      const stdDev = Math.sqrt(variance);
      const annualizedReturn = meanReturn * 252; // 252 jours de trading par an
      
      sharpeRatio = stdDev > 0 ? annualizedReturn / stdDev : 0;
    }
    
    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      totalProfit,
      profitPercentage,
      initialCapital: portfolio.initialCapital,
      finalCapital: portfolio.currentCapital,
      maxDrawdown: portfolio.maxDrawdown,
      profitFactor,
      sharpeRatio,
      dailyPerformance: formattedDailyPerformance,
      tokenPerformance,
      trades: portfolio.closedTrades
    };
  }

  /**
   * Génère toutes les combinaisons de paramètres à tester
   * @private
   * @param {Object} parametersToOptimize - Paramètres avec leurs plages
   * @returns {Array<Object>} Liste des combinaisons de paramètres
   */
  _generateParameterCombinations(parametersToOptimize) {
    // Transformer les paramètres en tableau de valeurs
    const paramEntries = Object.entries(parametersToOptimize).map(([paramPath, range]) => {
      const values = [];
      
      if (range.values) {
        // Utiliser les valeurs explicites
        values.push(...range.values);
      } else {
        // Générer des valeurs dans l'intervalle
        const min = range.min !== undefined ? range.min : 0;
        const max = range.max !== undefined ? range.max : 100;
        const step = range.step !== undefined ? range.step : 1;
        
        for (let val = min; val <= max; val += step) {
          values.push(val);
        }
      }
      
      return { paramPath, values };
    });
    
    // Fonction récursive pour générer les combinaisons
    const generateCombinations = (index, currentCombination) => {
      if (index >= paramEntries.length) {
        return [currentCombination];
      }
      
      const { paramPath, values } = paramEntries[index];
      const combinations = [];
      
      for (const value of values) {
        const newCombination = { ...currentCombination, [paramPath]: value };
        combinations.push(...generateCombinations(index + 1, newCombination));
      }
      
      return combinations;
    };
    
    return generateCombinations(0, {});
  }

  /**
   * Construit une configuration à partir d'un ensemble de paramètres
   * @private
   * @param {Object} parameterSet - Ensemble de paramètres (chemins et valeurs)
   * @returns {Object} Configuration complète
   */
  _buildConfigFromParameters(parameterSet) {
    // Copier la configuration de base
    const config = JSON.parse(JSON.stringify(this.config));
    
    // Appliquer chaque paramètre
    Object.entries(parameterSet).forEach(([paramPath, value]) => {
      // Diviser le chemin en segments (ex: "indicators.rsi.oversold")
      const pathSegments = paramPath.split('.');
      
      // Naviguer dans l'objet de configuration
      let current = config;
      for (let i = 0; i < pathSegments.length - 1; i++) {
        const segment = pathSegments[i];
        
        // Créer l'objet s'il n'existe pas
        if (!current[segment]) {
          current[segment] = {};
        }
        
        current = current[segment];
      }
      
      // Définir la valeur
      const lastSegment = pathSegments[pathSegments.length - 1];
      current[lastSegment] = value;
    });
    
    return config;
  }

  /**
   * Récupère l'état actuel de la simulation
   * @returns {Object} État de la simulation
   */
  getSimulationState() {
    return { ...this.simulationState };
  }

  /**
   * Récupère les derniers résultats de simulation
   * @returns {Object} Résultats de la dernière simulation
   */
  getLastSimulationResults() {
    return { ...this.simulationResults };
  }
}

export default SimulationEngine;