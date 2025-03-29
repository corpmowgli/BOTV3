// bot/simulationEngine.js - Version ultra-optimisée
import EventEmitter from 'events';
import { delay } from '../utils/helpers.js';

export class SimulationEngine extends EventEmitter {
  constructor(config, strategy, riskManager, dataManager, logger) {
    super();
    this.config = config;
    this.strategy = strategy;
    this.riskManager = riskManager;
    this.dataManager = dataManager;
    this.logger = logger;
    
    // État et résultats
    this.simulationState = {
      isRunning: false, startTime: 0, endTime: 0, progress: 0,
      currentToken: null, processedTokens: 0, totalTokens: 0
    };
    
    this.simulationResults = {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, totalProfit: 0,
      maxDrawdown: 0, sharpeRatio: 0, winRate: 0, trades: [],
      dailyPerformance: [], tokenPerformance: []
    };
  }

  async runSimulation(startDate, endDate, customConfig = null) {
    try {
      // Convertir les dates
      const startTime = typeof startDate === 'object' ? startDate.getTime() : Number(startDate);
      const endTime = typeof endDate === 'object' ? endDate.getTime() : Number(endDate);
      
      if (isNaN(startTime) || isNaN(endTime)) throw new Error('Dates de simulation invalides');
      if (startTime >= endTime) throw new Error('La date de début doit être antérieure à la date de fin');
      
      // Initialiser l'état
      this.simulationState = {
        isRunning: true, startTime, endTime, progress: 0,
        currentToken: null, processedTokens: 0, totalTokens: 0
      };
      
      // Sauvegarder la configuration originale
      const originalConfig = { ...this.config };
      
      // Appliquer la configuration personnalisée
      if (customConfig) {
        this.config = { ...this.config, ...customConfig };
        this.strategy.updateConfig(this.config);
        this.riskManager.updateConfig(this.config);
      }
      
      // Initialisation du portefeuille simulé
      const initialCapital = this.config.simulation.initialCapital || 10000;
      const portfolio = {
        initialCapital, currentCapital: initialCapital, positions: [],
        closedTrades: [], peakCapital: initialCapital, maxDrawdown: 0
      };
      
      // Obtenir les tokens à analyser
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
        
        // Vérifier les positions
        await this._checkPositionsForDay(dayEnd, portfolio);
      }
      
      // Fermer toutes les positions à la fin
      this._closeAllOpenPositions(endTime, portfolio);
      
      // Calculer les métriques
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
      
      const originalConfig = { ...this.config };
      const parameterCombinations = this._generateParameterCombinations(parametersToOptimize);
      
      this.emit('optimization_info', { 
        message: `${parameterCombinations.length} combinaisons de paramètres à tester`
      });
      
      const optimizationResults = [];
      
      for (let i = 0; i < parameterCombinations.length; i++) {
        const parameterSet = parameterCombinations[i];
        const customConfig = this._buildConfigFromParameters(parameterSet);
        
        this.emit('optimization_progress', { 
          combinationIndex: i + 1, 
          totalCombinations: parameterCombinations.length,
          progress: ((i + 1) / parameterCombinations.length) * 100,
          currentParameters: parameterSet
        });
        
        const simulationResult = await this.runSimulation(startDate, endDate, customConfig);
        
        if (simulationResult.success) {
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
        
        await delay(10);
      }
      
      // Restaurer la configuration originale
      this.config = originalConfig;
      this.strategy.updateConfig(originalConfig);
      this.riskManager.updateConfig(originalConfig);
      
      // Trier par Sharpe ratio
      optimizationResults.sort((a, b) => b.performance.sharpeRatio - a.performance.sharpeRatio);
      
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
      return { success: false, error: error.message, errorDetails: error.stack };
    }
  }

  // Méthodes privées
  async _getHistoricalTokens(startTime, endTime) {
    try {
      const topTokens = await this.dataManager.getTopTokens(
        this.config.trading.maxTokensToAnalyze || 50
      );
      
      if (topTokens && topTokens.length > 0) return topTokens;
      
      // Fallback sur une liste par défaut
      return [
        { token_mint: 'SOL', symbol: 'SOL', name: 'Solana' },
        { token_mint: 'RAY', symbol: 'RAY', name: 'Raydium' },
        { token_mint: 'SRM', symbol: 'SRM', name: 'Serum' },
        { token_mint: 'FIDA', symbol: 'FIDA', name: 'Bonfida' },
        { token_mint: 'MNGO', symbol: 'MNGO', name: 'Mango Markets' }
      ];
    } catch (error) {
      this.emit('simulation_warning', { 
        message: `Erreur lors de la récupération des tokens: ${error.message}`,
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

  async _processDay(dayStart, dayEnd, tokens, portfolio) {
    const dayResult = {
      date: new Date(dayStart).toISOString().split('T')[0],
      startCapital: portfolio.currentCapital,
      endCapital: portfolio.currentCapital,
      profit: 0,
      trades: [],
      tokenSignals: []
    };
    
    // Analyser chaque token en parallèle par lots
    const batchSize = 3; // Traiter 3 tokens à la fois
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      await Promise.all(batch.map(async token => {
        this.simulationState.currentToken = token.token_mint || token.symbol;
        
        try {
          // Récupérer les données historiques
          const tokenData = await this._getHistoricalDataForToken(token, dayStart, dayEnd);
          if (!tokenData || !tokenData.prices || tokenData.prices.length < 20) return;
          
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
          
          // Enregistrer le signal
          dayResult.tokenSignals.push({
            token: token.token_mint || token.symbol,
            signal: signal.type,
            confidence: signal.confidence
          });
          
          // Traiter le signal si suffisamment fort
          if (signal.type !== 'NONE' && signal.confidence >= this.config.trading.minConfidenceThreshold) {
            const canTrade = this._canTakePosition(token, portfolio, signal);
            
            if (canTrade) {
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
            message: `Erreur analyse de ${token.token_mint || token.symbol}: ${error.message}`
          });
        }
        
        this.simulationState.processedTokens++;
      }));
    }
    
    // Résultats de la journée
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
  
  async _getHistoricalDataForToken(token, dayStart, dayEnd) {
    try {
      // Récupérer un historique suffisant (7 jours avant pour les indicateurs)
      const lookbackPeriod = 7 * 24 * 60 * 60 * 1000;
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
      const recentPrices = historicalData.prices.slice(-48);
      let volatility = 'medium';
      
      if (recentPrices.length >= 24) {
        const priceChanges = [];
        for (let i = 1; i < recentPrices.length; i++) {
          priceChanges.push(Math.abs((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]));
        }
        
        const avgChange = priceChanges.reduce((sum, val) => sum + val, 0) / priceChanges.length * 100;
        
        if (avgChange < 1.5) {
          volatility = 'low';
        } else if (avgChange > 5) {
          volatility = 'high';
        }
      }
      
      let liquidity = 0;
      let volume24h = 0;
      
      try {
        const tokenData = await this.dataManager.getTokenData(tokenMint);
        if (tokenData) {
          liquidity = tokenData.liquidity || 0;
          volume24h = tokenData.volume24h || 0;
        }
      } catch (error) {
        liquidity = 500000;
        volume24h = 100000;
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
        message: `Erreur données historiques pour ${token.token_mint || token.symbol}: ${error.message}`
      });
      return null;
    }
  }
  
  _canTakePosition(token, portfolio, signal) {
    if (portfolio.positions.length >= this.config.trading.maxOpenPositions) return false;
    if (portfolio.positions.some(p => p.token === (token.token_mint || token.symbol))) return false;
    
    const maxPositionValue = portfolio.currentCapital * (this.config.trading.tradeSize / 100);
    if (maxPositionValue < this.config.trading.minTradeAmount) return false;
    
    return true;
  }
  
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
  
  async _checkPositionsForDay(dayEnd, portfolio) {
    if (portfolio.positions.length === 0) return;
    
    const positionsToClose = [];
    
    for (const position of portfolio.positions) {
      try {
        // Récupérer le prix actuel
        const currentPrice = await this._getCurrentPriceForToken(position.token, dayEnd);
        
        if (!currentPrice) continue;
        
        // Vérifier les conditions de fermeture
        let closeReason = null;
        
        // Stop loss
        const effectiveStopLoss = position.trailingStop?.enabled 
          ? position.tr