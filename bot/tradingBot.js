import EventEmitter from 'events';
import { CycleManager } from './cycleManager.js';
import { DataManager } from './dataManager.js';
import { SimulationEngine } from './simulationEngine.js';
import { StrategyFactory } from '../strategies/strategyFactory.js';
import { MarketDataService } from '../services/marketDataService.js';
import { RiskManager } from '../trading/riskManager.js';
import { PositionManager } from '../trading/positionManager.js';
import { PortfolioManager } from '../trading/portfolioManager.js';
import { TradeLogger } from '../trading/tradeLogger.js';
import { NotificationService } from '../services/notificationService.js';
import { deepClone, delay, retry } from '../utils/helpers.js';

export class TradingBot extends EventEmitter {
  constructor(customConfig = {}) {
    super();
    this.configureBotComponents(customConfig);
    this.isRunning = false;
    this.isStopping = false;
    this.isPaused = false;
    this.startTime = null;
    this.lastHealthCheck = Date.now();
    this.healthStatus = {status:'idle',memoryUsage:process.memoryUsage(),lastCycle:null,errors:[]};
    this.performanceMetrics = {cycleCount:0,avgCycleTime:0,totalCycleTime:0,maxCycleTime:0,minCycleTime:Infinity,lastApiLatency:0,cacheEfficiency:0,memoryLeakChecks:0};
    this._initializeLogging();
    this._connectComponentEvents();
    this._initializeEventHandlers();
    this._setupHealthCheck();
  }

  configureBotComponents(customConfig) {
    this.config = {...this._getDefaultConfig(),...customConfig};
    this.marketData = new MarketDataService(this.config);
    this.dataManager = new DataManager(this.config, this.marketData);
    this.portfolioManager = new PortfolioManager(this.config.simulation.initialCapital);
    this.riskManager = new RiskManager(this.config);
    this.positionManager = new PositionManager(this.config);
    this.logger = new TradeLogger(this.config);
    this.notificationService = new NotificationService(this.config);
    this.strategy = StrategyFactory.createStrategy(this.config.strategy.type || 'ENHANCED_MOMENTUM', this.config);
    this.cycleManager = new CycleManager(this.config, this.dataManager, this.strategy, this.riskManager, this.positionManager, this.portfolioManager, this.logger);
    this.simulationEngine = new SimulationEngine(this.config, this.strategy, this.riskManager, this.dataManager, this.logger);
  }

  _initializeLogging() {
    const logLevel = this.config.logging.level;
    this.on('trade', trade => {
      this.notificationService.notifyTrade(trade);
      console.log(`[Bot] Trade exécuté: ${trade.token} - Profit: ${trade.profit}`);
    });
    this.on('error', error => {
      this.healthStatus.errors.push({time:Date.now(),message:error.message,stack:error.stack});
      if(this.healthStatus.errors.length > 20) this.healthStatus.errors.shift();
      this.notificationService.notifyError(error);
      console.error(`[Bot] Erreur: ${error.message}`);
    });
    this.on('warning', message => console.warn(`[Bot] Avertissement: ${message}`));
    this.on('info', message => {
      if(logLevel === 'debug' || logLevel === 'info') {
        console.log(`[Bot] Info: ${message}`);
      }
    });
    this.on('debug', message => {
      if(logLevel === 'debug') {
        console.debug(`[Bot] Debug: ${message}`);
      }
    });
  }

  _connectComponentEvents() {
    this.cycleManager.on('error', error => this.emit('error', error));
    this.cycleManager.on('warning', message => this.emit('warning', message));
    this.cycleManager.on('info', message => this.emit('info', message));
    this.cycleManager.on('debug', message => this.emit('debug', message));
    this.positionManager.on('position_closed', position => {
      this.portfolioManager.updatePortfolio(position);
      const tradeLog = this.logger.logTrade(position);
      this.emit('trade', tradeLog);
    });
    this.positionManager.on('position_opened', position => {
      this.emit('info', `Nouvelle position ouverte pour ${position.token} à ${position.entryPrice}`);
    });
    this.riskManager.on('risk_limit_reached', data => {
      this.emit('warning', `Limite de risque atteinte: ${JSON.stringify(data)}`);
      this.notificationService.notifyAlert(`Limite de risque atteinte: ${data.reason}`, 'high', data);
    });
    this.cycleManager.on('cycle_completed', metrics => {
      this.healthStatus.lastCycle = Date.now();
      this.performanceMetrics.cycleCount++;
      this.performanceMetrics.lastCycleTime = metrics.duration;
      this.performanceMetrics.totalCycleTime += metrics.duration;
      this.performanceMetrics.avgCycleTime = this.performanceMetrics.totalCycleTime / this.performanceMetrics.cycleCount;
      this.performanceMetrics.maxCycleTime = Math.max(this.performanceMetrics.maxCycleTime, metrics.duration);
      this.performanceMetrics.minCycleTime = Math.min(this.performanceMetrics.minCycleTime, metrics.duration);
    });
  }

  _initializeEventHandlers() {
    process.on('uncaughtException', error => {
      this.emit('error', new Error(`Exception non capturée: ${error.message}`));
      if(this.isRunning && !this.isStopping) {
        this.emit('warning', 'Erreur critique détectée, arrêt sécurisé du bot...');
        this.stop().catch(e => console.error('Erreur pendant l\'arrêt d\'urgence:', e));
      }
    });
    process.on('unhandledRejection', reason => {
      this.emit('error', new Error(`Rejet non géré: ${reason}`));
    });
  }

  _setupHealthCheck() {
    setInterval(() => {
      if(!this.isRunning) return;
      this._performHealthCheck();
    }, this.config.performance.memoryCheckInterval || 5 * 60 * 1000);
  }

  async _performHealthCheck() {
    try {
      this.healthStatus.memoryUsage = process.memoryUsage();
      this.healthStatus.lastHealthCheck = Date.now();
      const cycleInterval = this.config.trading.cycleInterval || 60000;
      const lastCycleAge = Date.now() - (this.healthStatus.lastCycle || 0);
      if(this.healthStatus.lastCycle && lastCycleAge > cycleInterval * 3) {
        this.emit('warning', `Aucun cycle de trading depuis ${Math.floor(lastCycleAge/1000)}s, vérification de la santé du système...`);
        this.dataManager.clearCaches();
        this.marketData.clearCaches();
        await this.runTradingCycle();
      }
      const heapUsed = this.healthStatus.memoryUsage.heapUsed / 1024 / 1024;
      this.performanceMetrics.memoryLeakChecks++;
      if(heapUsed > 1024) {
        this.emit('warning', `Utilisation élevée de la mémoire détectée: ${heapUsed.toFixed(2)} MB`);
        if(heapUsed > this.config.performance.memoryThreshold) {
          this.emit('error', new Error(`Utilisation critique de la mémoire: ${heapUsed.toFixed(2)} MB, redémarrage...`));
          if(this.config.performance.enableAutomaticRestarts) {
            await this.restart();
          }
        }
      }
      const dataManagerStats = this.dataManager.getStats();
      const totalRequests = dataManagerStats.cacheHits + dataManagerStats.cacheMisses;
      if(totalRequests > 0) {
        this.performanceMetrics.cacheEfficiency = (dataManagerStats.cacheHits / totalRequests) * 100;
      }
      const marketStats = this.marketData.getStats();
      this.performanceMetrics.lastApiLatency = marketStats.averageResponseTime || 0;
      if(this.performanceMetrics.lastApiLatency > 5000) {
        this.emit('warning', `Latence élevée de l'API détectée: ${this.performanceMetrics.lastApiLatency}ms`);
      }
    } catch(error) {
      this.emit('error', new Error(`Échec de la vérification de santé: ${error.message}`));
    }
  }

  _getDefaultConfig() {
    return {
      trading: {cycleInterval:60000,closePositionsOnStop:true,maxOpenPositions:3,tradeSize:2,stopLoss:5,takeProfit:15,minConfidenceThreshold:0.6},
      strategy: {type:'ENHANCED_MOMENTUM'},
      errorHandling: {maxConsecutiveErrors:3,circuitBreakerTimeout:300000},
      logging: {level:'info',persistentStorage:true,filePath:'logs/trades'},
      simulation: {initialCapital:10000,backtestDays:30},
      performance: {tokenConcurrency:5,enableAutomaticRestarts:true,memoryThreshold:1536,memoryCheckInterval:300000}
    };
  }

  async start() {
    if(this.isRunning) {
      this.emit('warning', 'Le bot est déjà en cours d\'exécution');
      return false;
    }
    try {
      this.isRunning = true;
      this.isStopping = false;
      this.isPaused = false;
      this.startTime = Date.now();
      this.healthStatus.status = 'démarrage';
      this.emit('info', `Bot de trading démarré à ${new Date(this.startTime).toISOString()}`);
      await this._preloadCriticalData();
      await this.cycleManager.start();
      this.healthStatus.status = 'en cours d\'exécution';
      this.healthStatus.lastCycle = Date.now();
      this.notificationService.notify({type:'system',title:'Bot Démarré',message:`Bot de trading démarré avec succès à ${new Date().toLocaleString()}`,priority:'medium'});
      return true;
    } catch(error) {
      this.isRunning = false;
      this.healthStatus.status = 'erreur';
      this.emit('error', error);
      return false;
    }
  }

  async _preloadCriticalData() {
    try {
      this.emit('info', 'Préchargement des données critiques du marché...');
      const topTokens = await this.marketData.getTopTokens(20);
      if(topTokens && topTokens.length > 0) {
        const tokenMints = topTokens.map(token => token.token_mint);
        await this.dataManager.getBatchTokenPrices(tokenMints);
        this.dataManager.preloadData(tokenMints);
      }
      this.emit('info', 'Données critiques préchargées');
    } catch(error) {
      this.emit('warning', `Échec du préchargement des données: ${error.message}`);
    }
  }

  async stop() {
    if(!this.isRunning) {
      this.emit('warning', 'Le bot n\'est pas en cours d\'exécution');
      return this.getPerformanceReport();
    }
    try {
      this.isStopping = true;
      this.healthStatus.status = 'arrêt';
      this.emit('info', 'Arrêt du bot de trading...');
      await this.cycleManager.stop();
      if(this.config.trading.closePositionsOnStop) {
        await this.closeAllPositions();
      }
      const report = this.generateConsoleReport();
      console.log(report);
      this.cleanup();
      this.isRunning = false;
      this.isStopping = false;
      this.healthStatus.status = 'arrêté';
      const uptime = this._calculateRuntime();
      this.emit('info', `Bot de trading arrêté. Durée totale d'exécution: ${uptime}`);
      this.notificationService.notify({type:'system',title:'Bot Arrêté',message:`Bot de trading arrêté après ${uptime} d'exécution`,priority:'medium'});
      return this.getPerformanceReport();
    } catch(error) {
      this.emit('error', error);
      this.isRunning = false;
      this.isStopping = false;
      this.healthStatus.status = 'erreur';
      return this.getPerformanceReport();
    }
  }

  async restart() {
    this.emit('info', 'Redémarrage du bot de trading...');
    try {
      const wasRunning = this.isRunning;
      const currentPositions = this.positionManager.getOpenPositions();
      await this.stop();
      this.cleanup();
      this.dataManager.clearCaches();
      this.marketData.clearCaches();
      if(global.gc) {
        global.gc();
      }
      await delay(1000);
      if(wasRunning) {
        await this.start();
        this.notificationService.notify({type:'system',title:'Bot Redémarré',message:`Le bot de trading a été redémarré avec ${currentPositions.length} positions ouvertes`,priority:'high'});
        return true;
      }
      return false;
    } catch(error) {
      this.emit('error', new Error(`Échec du redémarrage: ${error.message}`));
      return false;
    }
  }

  async pause() {
    if(!this.isRunning || this.isPaused) {
      return false;
    }
    try {
      this.isPaused = true;
      this.healthStatus.status = 'en pause';
      this.emit('info', 'Opérations de trading mises en pause');
      this.notificationService.notify({type:'system',title:'Trading en Pause',message:'Les opérations de trading ont été mises en pause',priority:'medium'});
      return true;
    } catch(error) {
      this.emit('error', error);
      return false;
    }
  }

  async resume() {
    if(!this.isRunning || !this.isPaused) {
      return false;
    }
    try {
      this.isPaused = false;
      this.healthStatus.status = 'en cours d\'exécution';
      this.emit('info', 'Opérations de trading reprises');
      await this.runTradingCycle();
      this.notificationService.notify({type:'system',title:'Trading Repris',message:'Les opérations de trading ont été reprises',priority:'medium'});
      return true;
    } catch(error) {
      this.emit('error', error);
      return false;
    }
  }

  async closeAllPositions() {
    try {
      this.emit('info', 'Fermeture de toutes les positions...');
      return await this.positionManager.closeAllPositions(await this.fetchCurrentPrices());
    } catch(error) {
      this.emit('error', new Error(`Échec de la fermeture des positions: ${error.message}`));
      return [];
    }
  }

  async runTradingCycle() {
    if(!this.isRunning) {
      this.emit('warning', 'Le bot n\'est pas en cours d\'exécution');
      return false;
    }
    if(this.isPaused) {
      this.emit('warning', 'Le bot est en pause');
      return false;
    }
    try {
      return await this.cycleManager.runTradingCycle();
    } catch(error) {
      this.emit('error', new Error(`Échec de l'exécution du cycle de trading: ${error.message}`));
      return false;
    }
  }

  async fetchCurrentPrices() {
    const positions = this.positionManager.getOpenPositions();
    const tokenMints = positions.map(position => position.token);
    if(tokenMints.length === 0) {
      return new Map();
    }
    try {
      const prices = await retry(
        async () => this.dataManager.getBatchTokenPrices(tokenMints),
        3,
        1000,
        (retry, delay, error) => this.emit('warning', `Tentative ${retry} de récupération des prix échouée: ${error.message}, nouvelle tentative dans ${delay}ms`)
      );
      const priceMap = new Map();
      for(const [token, price] of Object.entries(prices)) {
        priceMap.set(token, price);
      }
      return priceMap;
    } catch(error) {
      this.emit('error', new Error(`Erreur lors de la récupération des prix actuels: ${error.message}`));
      return new Map();
    }
  }

  async runSimulation(startDate, endDate, parameters = null) {
    if(this.isRunning) {
      this.emit('warning', 'Impossible d\'exécuter une simulation pendant que le bot est en cours d\'exécution');
      return {success:false,error:'Le bot est actuellement en cours d\'exécution'};
    }
    this.emit('info', `Démarrage de la simulation du ${new Date(startDate).toISOString()} au ${new Date(endDate).toISOString()}`);
    try {
      const customConfig = parameters ? {...this.config,...parameters} : null;
      return await this.simulationEngine.runSimulation(startDate, endDate, customConfig);
    } catch(error) {
      this.emit('error', new Error(`Erreur lors de la simulation: ${error.message}`));
      return {success:false,error:error.message,startDate:new Date(startDate).toISOString(),endDate:new Date(endDate).toISOString()};
    }
  }

  async optimizeStrategy(startDate, endDate, parametersToOptimize) {
    if(this.isRunning) {
      this.emit('warning', 'Impossible d\'optimiser pendant que le bot est en cours d\'exécution');
      return {success:false,error:'Le bot est actuellement en cours d\'exécution'};
    }
    this.emit('info', `Démarrage de l'optimisation de la stratégie...`);
    try {
      return await this.simulationEngine.optimizeParameters(startDate, endDate, parametersToOptimize);
    } catch(error) {
      this.emit('error', new Error(`Erreur lors de l'optimisation de la stratégie: ${error.message}`));
      return {success:false,error:error.message};
    }
  }

  updateConfig(newConfig) {
    try {
      const originalConfig = deepClone(this.config);
      this.config = deepClone({...this.config,...newConfig});
      const criticalParameters = ['trading.cycleInterval','trading.maxOpenPositions','strategy.type'];
      let restartNeeded = false;
      for(const param of criticalParameters) {
        const path = param.split('.');
        let origValue = originalConfig;
        let newValue = this.config;
        for(const key of path) {
          origValue = origValue?.[key];
          newValue = newValue?.[key];
        }
        if(origValue !== newValue) {
          restartNeeded = true;
          break;
        }
      }
      this.riskManager.updateConfig(this.config);
      this.positionManager.updateConfig(this.config);
      this.logger.updateConfig(this.config);
      this.dataManager.updateConfig(this.config);
      this.cycleManager.updateConfig(this.config);
      if(this.config.strategy.type !== originalConfig.strategy.type) {
        this.strategy = StrategyFactory.createStrategy(this.config.strategy.type, this.config);
      } else {
        this.strategy.updateConfig(this.config);
      }
      return {success:true,restartNeeded};
    } catch(error) {
      this.emit('error', new Error(`Erreur lors de la mise à jour de la configuration: ${error.message}`));
      return {success:false,error:error.message};
    }
  }

  getPerformanceReport() {
    return {
      metrics:this.logger.getPerformanceMetrics(),
      recentTrades:this.logger.getRecentTrades(10),
      dailyPerformance:this.logger.getDailyPerformance(),
      portfolioMetrics:this.portfolioManager.getMetrics(),
      botMetrics:{
        uptime:this._calculateRuntime(),
        isRunning:this.isRunning,
        isPaused:this.isPaused,
        healthStatus:{...this.healthStatus},
        cyclesRun:this.cycleManager.getMetrics().cycleCount,
        successfulCycles:this.cycleManager.getMetrics().successfulCycles,
        failedCycles:this.cycleManager.getMetrics().failedCycles,
        tokensProcessed:this.cycleManager.getMetrics().tokensProcessed || 0,
        signalsGenerated:this.cycleManager.getMetrics().signalsGenerated || 0,
        lastCycleTime:this.cycleManager.getMetrics().lastCycleTime?new Date(this.cycleManager.getMetrics().lastCycleTime).toISOString():null,
        performanceMetrics:{...this.performanceMetrics},
        dataManagerStats:this.dataManager.getStats(),
        marketDataStats:this.marketData.getStats()
      },
      strategyMetrics:this.strategy.getPerformanceMetrics()
    };
  }

  generateConsoleReport() {
    const report = this.getPerformanceReport();
    let formattedReport = '\n======== RAPPORT DE PERFORMANCE DU BOT DE TRADING ========\n\n';
    formattedReport += `Profit Total: ${report.portfolioMetrics.totalProfit.toFixed(2)} (${report.portfolioMetrics.profitPercentage.toFixed(2)}%)\n`;
    formattedReport += `Trades: ${report.metrics.totalTrades} (${report.metrics.winningTrades} gagnants, ${report.metrics.losingTrades} perdants, ${report.metrics.winRate.toFixed(1)}% taux de réussite)\n`;
    formattedReport += `Gain Moyen: ${report.metrics.averageWin.toFixed(2)} | Perte Moyenne: ${report.metrics.averageLoss.toFixed(2)} | Facteur de Profit: ${report.metrics.profitFactor?.toFixed(2) || 'N/A'}\n\n`;
    formattedReport += '--- TRADES RÉCENTS ---\n';
    report.recentTrades.forEach(trade => {
      formattedReport += `${trade.profit >= 0 ? '✓' : '✗'} ${trade.date} | ${trade.token} | ${trade.profit.toFixed(2)} (${trade.profitPercentage.toFixed(2)}%)\n`;
    });
    formattedReport += '\n--- MÉTRIQUES DU BOT ---\n';
    formattedReport += `Durée d'exécution: ${report.botMetrics.uptime} | Statut: ${report.botMetrics.isRunning ? (report.botMetrics.isPaused ? 'EN PAUSE' : 'EN COURS') : 'ARRÊTÉ'}\n`;
    formattedReport += `Cycles: ${report.botMetrics.cyclesRun} (${report.botMetrics.successfulCycles} réussis, ${report.botMetrics.failedCycles} échecs)\n`;
    formattedReport += `Tokens Traités: ${report.botMetrics.tokensProcessed} | Signaux Générés: ${report.botMetrics.signalsGenerated}\n`;
    formattedReport += `Efficacité du Cache: ${report.botMetrics.performanceMetrics.cacheEfficiency.toFixed(2)}% | Temps Moyen du Cycle: ${report.botMetrics.performanceMetrics.avgCycleTime.toFixed(0)}ms\n\n`;
    const heapUsed = report.botMetrics.healthStatus.memoryUsage?.heapUsed / 1024 / 1024 || 0;
    formattedReport += `Utilisation de la Mémoire: ${heapUsed.toFixed(2)} MB\n`;
    formattedReport += '\n==============================================\n';
    return formattedReport;
  }

  exportTradingLogs(format = 'json') {
    return this.logger.exportLogs(format);
  }

  getHealthStatus() {
    this.healthStatus.memoryUsage = process.memoryUsage();
    if(this.isRunning && !this.isPaused && this.healthStatus.lastCycle) {
      const cycleAge = Date.now() - this.healthStatus.lastCycle;
      const expectedInterval = this.config.trading.cycleInterval || 60000;
      if(cycleAge > expectedInterval * 3) {
        this.healthStatus.status = 'bloqué';
      }
    }
    return {
      ...this.healthStatus,
      openPositions:this.positionManager.getOpenPositions().length,
      queueSizes:{
        high:this.marketData.getStats().queueSizes?.high || 0,
        medium:this.marketData.getStats().queueSizes?.medium || 0,
        low:this.marketData.getStats().queueSizes?.low || 0
      },
      uptime:this._calculateRuntime(),
      tradeCount:this.logger.getPerformanceMetrics().totalTrades || 0,
      lastErrors:this.healthStatus.errors.slice(-5)
    };
  }

  cleanup() {
    this.logger.cleanup();
    this.dataManager.clearCaches();
    this.marketData.clearCaches();
    this.cycleManager.cleanup();
    this.notificationService.setEnabled(false);
  }

  _calculateRuntime() {
    if(!this.startTime) return '0s';
    const runtime = Date.now() - this.startTime;
    const seconds = Math.floor(runtime / 1000) % 60;
    const minutes = Math.floor(runtime / (1000 * 60)) % 60;
    const hours = Math.floor(runtime / (1000 * 60 * 60)) % 24;
    const days = Math.floor(runtime / (1000 * 60 * 60 * 24));
    if(days > 0) {
      return `${days}j ${hours}h ${minutes}m ${seconds}s`;
    } else if(hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if(minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }
}