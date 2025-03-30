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
    this.simulationState = {isRunning:false,startTime:0,endTime:0,progress:0,currentToken:null,processedTokens:0,totalTokens:0};
    this.simulationResults = {totalTrades:0,winningTrades:0,losingTrades:0,totalProfit:0,maxDrawdown:0,sharpeRatio:0,winRate:0,trades:[],dailyPerformance:[],tokenPerformance:[]};
  }

  async runSimulation(startDate, endDate, customConfig = null) {
    try {
      const startTime = typeof startDate === 'object' ? startDate.getTime() : Number(startDate);
      const endTime = typeof endDate === 'object' ? endDate.getTime() : Number(endDate);
      if(isNaN(startTime) || isNaN(endTime)) throw new Error('Dates de simulation invalides');
      if(startTime >= endTime) throw new Error('La date de début doit être antérieure à la date de fin');
      this.simulationState = {isRunning:true,startTime,endTime,progress:0,currentToken:null,processedTokens:0,totalTokens:0};
      const originalConfig = {...this.config};
      if(customConfig) {
        this.config = {...this.config,...customConfig};
        this.strategy.updateConfig(this.config);
        this.riskManager.updateConfig(this.config);
      }
      const initialCapital = this.config.simulation.initialCapital || 10000;
      const portfolio = {initialCapital,currentCapital:initialCapital,positions:[],closedTrades:[],peakCapital:initialCapital,maxDrawdown:0};
      this.emit('simulation_info', {message:'Récupération des données historiques...'});
      const tokens = await this._getHistoricalTokens(startTime, endTime);
      this.simulationState.totalTokens = tokens.length;
      this.emit('simulation_info', {message:`${tokens.length} tokens identifiés pour simulation`});
      const millisecondsPerDay = 24*60*60*1000;
      const dailyResults = [];
      for(let currentDay = startTime; currentDay <= endTime; currentDay += millisecondsPerDay) {
        const dayEnd = Math.min(currentDay + millisecondsPerDay, endTime);
        const dayResult = await this._processDay(currentDay, dayEnd, tokens, portfolio);
        dailyResults.push(dayResult);
        this.simulationState.progress = (currentDay - startTime) / (endTime - startTime) * 100;
        this.emit('simulation_progress', {progress:this.simulationState.progress});
        await this._checkPositionsForDay(dayEnd, portfolio);
      }
      this._closeAllOpenPositions(endTime, portfolio);
      const results = this._calculatePerformanceMetrics(portfolio, dailyResults, tokens);
      this.config = originalConfig;
      this.strategy.updateConfig(originalConfig);
      this.riskManager.updateConfig(originalConfig);
      this.simulationState.isRunning = false;
      this.simulationState.progress = 100;
      this.simulationResults = results;
      this.emit('simulation_completed', results);
      return {success:true,simulationPeriod:{start:new Date(startTime).toISOString(),end:new Date(endTime).toISOString()},config:customConfig||this.config,...results};
    } catch(error) {
      this.simulationState.isRunning = false;
      this.emit('simulation_error', {error:error.message});
      return {success:false,error:error.message,errorDetails:error.stack};
    }
  }

  async optimizeParameters(startDate, endDate, parametersToOptimize) {
    try {
      if(!parametersToOptimize || Object.keys(parametersToOptimize).length === 0) throw new Error('Aucun paramètre à optimiser spécifié');
      this.emit('optimization_start', {message:'Démarrage de l\'optimisation des paramètres',parameters:parametersToOptimize});
      const originalConfig = {...this.config};
      const parameterCombinations = this._generateParameterCombinations(parametersToOptimize);
      this.emit('optimization_info', {message:`${parameterCombinations.length} combinaisons de paramètres à tester`});
      const optimizationResults = [];
      for(let i=0; i<parameterCombinations.length; i++) {
        const parameterSet = parameterCombinations[i];
        const customConfig = this._buildConfigFromParameters(parameterSet);
        this.emit('optimization_progress', {combinationIndex:i+1,totalCombinations:parameterCombinations.length,progress:((i+1)/parameterCombinations.length)*100,currentParameters:parameterSet});
        const simulationResult = await this.runSimulation(startDate, endDate, customConfig);
        if(simulationResult.success) {
          optimizationResults.push({parameters:parameterSet,performance:{totalProfit:simulationResult.totalProfit,profitPercentage:simulationResult.profitPercentage,winRate:simulationResult.winRate,profitFactor:simulationResult.profitFactor,maxDrawdown:simulationResult.maxDrawdown,sharpeRatio:simulationResult.sharpeRatio,trades:simulationResult.totalTrades}});
        }
        await delay(10);
      }
      this.config = originalConfig;
      this.strategy.updateConfig(originalConfig);
      this.riskManager.updateConfig(originalConfig);
      optimizationResults.sort((a,b) => b.performance.sharpeRatio - a.performance.sharpeRatio);
      const optimizationReport = {success:true,startDate:new Date(startDate).toISOString(),endDate:new Date(endDate).toISOString(),parametersOptimized:Object.keys(parametersToOptimize),combinationsTested:parameterCombinations.length,bestParameters:optimizationResults.length>0?optimizationResults[0].parameters:null,bestPerformance:optimizationResults.length>0?optimizationResults[0].performance:null,allResults:optimizationResults.slice(0,10)};
      this.emit('optimization_completed', optimizationReport);
      return optimizationReport;
    } catch(error) {
      this.emit('optimization_error', {error:error.message});
      return {success:false,error:error.message,errorDetails:error.stack};
    }
  }

  async _getHistoricalTokens(startTime, endTime) {
    try {
      // Added proper parameters to match expected signature
      const topTokens = await this.dataManager.getTopTokens(
        this.config.trading.maxTokensToAnalyze || 50,
        this.config.trading.minLiquidity,
        this.config.trading.minVolume24h
      );
      
      if(topTokens && topTokens.length > 0) return topTokens;
      
      // Default tokens if none returned
      return [
        {token_mint:'SOL',symbol:'SOL',name:'Solana'},
        {token_mint:'RAY',symbol:'RAY',name:'Raydium'},
        {token_mint:'SRM',symbol:'SRM',name:'Serum'},
        {token_mint:'FIDA',symbol:'FIDA',name:'Bonfida'},
        {token_mint:'MNGO',symbol:'MNGO',name:'Mango Markets'}
      ];
    } catch(error) {
      this.emit('simulation_warning', {
        message:`Erreur lors de la récupération des tokens: ${error.message}`,
        fallback:'Utilisation des tokens par défaut'
      });
      
      return [
        {token_mint:'SOL',symbol:'SOL',name:'Solana'},
        {token_mint:'RAY',symbol:'RAY',name:'Raydium'},
        {token_mint:'SRM',symbol:'SRM',name:'Serum'},
        {token_mint:'FIDA',symbol:'FIDA',name:'Bonfida'},
        {token_mint:'MNGO',symbol:'MNGO',name:'Mango Markets'}
      ];
    }
  }

  async _processDay(dayStart, dayEnd, tokens, portfolio) {
    const dayResult = {date:new Date(dayStart).toISOString().split('T')[0],startCapital:portfolio.currentCapital,endCapital:portfolio.currentCapital,profit:0,trades:[],tokenSignals:[]};
    const batchSize = 3;
    for(let i=0; i<tokens.length; i+=batchSize) {
      const batch = tokens.slice(i, i+batchSize);
      await Promise.all(batch.map(async token => {
        this.simulationState.currentToken = token.token_mint || token.symbol;
        try {
          const tokenData = await this._getHistoricalDataForToken(token, dayStart, dayEnd);
          if(!tokenData || !tokenData.prices || tokenData.prices.length < 20) return;
          const signal = await this.strategy.analyze(token.token_mint || token.symbol, tokenData.prices, tokenData.volumes, {liquidity:tokenData.liquidity,volume24h:tokenData.volume24h,volatility:tokenData.volatility});
          dayResult.tokenSignals.push({token:token.token_mint || token.symbol,signal:signal.type,confidence:signal.confidence});
          if(signal.type !== 'NONE' && signal.confidence >= this.config.trading.minConfidenceThreshold) {
            const canTrade = this._canTakePosition(token, portfolio, signal);
            if(canTrade) {
              const position = this._openSimulatedPosition(token, tokenData, signal, portfolio, dayEnd);
              if(position) {
                portfolio.positions.push(position);
                dayResult.trades.push({type:'OPEN',token:position.token,price:position.entryPrice,amount:position.amount,value:position.value,direction:position.direction});
              }
            }
          }
        } catch(error) {
          this.emit('simulation_warning', {message:`Erreur analyse de ${token.token_mint || token.symbol}: ${error.message}`});
        }
        this.simulationState.processedTokens++;
      }));
    }
    dayResult.endCapital = portfolio.currentCapital;
    dayResult.profit = dayResult.endCapital - dayResult.startCapital;
    if(portfolio.currentCapital > portfolio.peakCapital) {
      portfolio.peakCapital = portfolio.currentCapital;
    } else {
      const currentDrawdown = (portfolio.peakCapital - portfolio.currentCapital) / portfolio.peakCapital * 100;
      if(currentDrawdown > portfolio.maxDrawdown) {
        portfolio.maxDrawdown = currentDrawdown;
      }
    }
    return dayResult;
  }

  async _getHistoricalDataForToken(token, dayStart, dayEnd) {
    try {
      const lookbackPeriod = 7*24*60*60*1000;
      const startTime = dayStart - lookbackPeriod;
      const tokenMint = token.token_mint || token.symbol;
      const historicalData = await this.dataManager.getHistoricalData(tokenMint, '1h', Math.ceil(lookbackPeriod/(24*60*60*1000)));
      if(!historicalData || !historicalData.prices || historicalData.prices.length === 0) return null;
      const recentPrices = historicalData.prices.slice(-48);
      let volatility = 'medium';
      if(recentPrices.length >= 24) {
        const priceChanges = [];
        for(let i=1; i<recentPrices.length; i++) {
          priceChanges.push(Math.abs((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]));
        }
        const avgChange = priceChanges.reduce((sum, val) => sum + val, 0) / priceChanges.length * 100;
        if(avgChange < 1.5) volatility = 'low';
        else if(avgChange > 5) volatility = 'high';
      }
      let liquidity = 0;
      let volume24h = 0;
      try {
        const tokenData = await this.dataManager.getTokenData(tokenMint);
        if(tokenData) {
          liquidity = tokenData.liquidity || 0;
          volume24h = tokenData.volume24h || 0;
        }
      } catch(error) {
        liquidity = 500000;
        volume24h = 100000;
      }
      return {prices:historicalData.prices,volumes:historicalData.volumes || new Array(historicalData.prices.length).fill(volume24h/24),timestamps:historicalData.timestamps || [],liquidity,volume24h,volatility};
    } catch(error) {
      this.emit('simulation_warning', {message:`Erreur données historiques pour ${token.token_mint || token.symbol}: ${error.message}`});
      return null;
    }
  }

  _canTakePosition(token, portfolio, signal) {
    if(portfolio.positions.length >= this.config.trading.maxOpenPositions) return false;
    if(portfolio.positions.some(p => p.token === (token.token_mint || token.symbol))) return false;
    const maxPositionValue = portfolio.currentCapital * (this.config.trading.tradeSize / 100);
    if(maxPositionValue < this.config.trading.minTradeAmount) return false;
    return true;
  }

  _openSimulatedPosition(token, tokenData, signal, portfolio, timestamp) {
    try {
      const tokenMint = token.token_mint || token.symbol;
      const currentPrice = tokenData.prices[tokenData.prices.length - 1];
      if(!currentPrice) return null;
      const positionSizePercent = this.config.trading.tradeSize;
      const positionValue = portfolio.currentCapital * (positionSizePercent / 100);
      const amount = positionValue / currentPrice;
      const stopLossPercent = this.config.trading.stopLoss;
      const takeProfitPercent = this.config.trading.takeProfit;
      const stopLoss = signal.type === 'BUY' ? currentPrice * (1 - stopLossPercent/100) : currentPrice * (1 + stopLossPercent/100);
      const takeProfit = signal.type === 'BUY' ? currentPrice * (1 + takeProfitPercent/100) : currentPrice * (1 - takeProfitPercent/100);
      return {id:`sim_${tokenMint}_${timestamp}`,token:tokenMint,direction:signal.type,entryPrice:currentPrice,amount,value:positionValue,entryTime:timestamp,stopLoss,takeProfit,trailingStop:this.config.trading.trailingStopLoss?{enabled:true,distance:this.config.trading.trailingStopDistance,current:stopLoss}:null,signal:{type:signal.type,confidence:signal.confidence,reasons:signal.reasons}};
    } catch(error) {
      this.emit('simulation_warning', {message:`Erreur lors de l'ouverture de position simulée: ${error.message}`});
      return null;
    }
  }

  async _checkPositionsForDay(dayEnd, portfolio) {
    if(portfolio.positions.length === 0) return;
    const positionsToClose = [];
    for(const position of portfolio.positions) {
      try {
        const currentPrice = await this._getCurrentPriceForToken(position.token, dayEnd);
        if(!currentPrice) continue;
        let closeReason = null;
        const effectiveStopLoss = position.trailingStop?.enabled ? position.trailingStop.current : position.stopLoss;
        if(position.direction === 'BUY') {
          if(currentPrice <= effectiveStopLoss) closeReason = 'STOP_LOSS';
          else if(currentPrice >= position.takeProfit) closeReason = 'TAKE_PROFIT';
          if(position.trailingStop?.enabled && currentPrice > position.entryPrice) {
            const newStopLoss = currentPrice * (1 - position.trailingStop.distance/100);
            if(newStopLoss > position.trailingStop.current) position.trailingStop.current = newStopLoss;
          }
        } else if(position.direction === 'SELL') {
          if(currentPrice >= effectiveStopLoss) closeReason = 'STOP_LOSS';
          else if(currentPrice <= position.takeProfit) closeReason = 'TAKE_PROFIT';
          if(position.trailingStop?.enabled && currentPrice < position.entryPrice) {
            const newStopLoss = currentPrice * (1 + position.trailingStop.distance/100);
            if(newStopLoss < position.trailingStop.current) position.trailingStop.current = newStopLoss;
          }
        }
        if(closeReason) positionsToClose.push({position, currentPrice, reason:closeReason});
      } catch(error) {
        this.emit('simulation_warning', {message:`Erreur lors de la vérification de la position pour ${position.token}: ${error.message}`});
      }
    }
    for(const {position, currentPrice, reason} of positionsToClose) {
      await this._closeSimulatedPosition(position, portfolio, currentPrice, reason, dayEnd);
    }
  }

  async _getCurrentPriceForToken(tokenMint, timestamp) {
    try {
      const priceData = await this.dataManager.getTokenPrice(tokenMint, timestamp);
      return priceData?.price || null;
    } catch(error) {
      return null;
    }
  }

  async _closeSimulatedPosition(position, portfolio, currentPrice, reason, timestamp) {
    if(!position || !currentPrice) return null;
    const pnl = position.direction === 'BUY' ? (currentPrice - position.entryPrice) * position.amount : (position.entryPrice - currentPrice) * position.amount;
    const pnlPercent = position.direction === 'BUY' ? (currentPrice - position.entryPrice) / position.entryPrice * 100 : (position.entryPrice - currentPrice) / position.entryPrice * 100;
    const closedPosition = {...position,exitPrice:currentPrice,exitTime:timestamp,profit:pnl,profitPercentage:pnlPercent,closeReason:reason};
    portfolio.positions = portfolio.positions.filter(p => p.id !== position.id);
    portfolio.closedTrades.push(closedPosition);
    portfolio.currentCapital += pnl;
    if(portfolio.currentCapital > portfolio.peakCapital) portfolio.peakCapital = portfolio.currentCapital;
    return closedPosition;
  }

  _closeAllOpenPositions(timestamp, portfolio) {
    const results = [];
    for(const position of [...portfolio.positions]) {
      const closeResult = this._closeSimulatedPosition(position, portfolio, position.entryPrice, 'END_OF_SIMULATION', timestamp);
      if(closeResult) results.push(closeResult);
    }
    return results;
  }

  _calculatePerformanceMetrics(portfolio, dailyResults, tokens) {
    const metrics = {totalTrades:portfolio.closedTrades.length,winningTrades:0,losingTrades:0,totalProfit:portfolio.currentCapital - portfolio.initialCapital,profitPercentage:((portfolio.currentCapital - portfolio.initialCapital) / portfolio.initialCapital) * 100,maxDrawdown:portfolio.maxDrawdown,sharpeRatio:0,winRate:0,trades:portfolio.closedTrades,dailyPerformance:[],tokenPerformance:[]};
    portfolio.closedTrades.forEach(trade => {
      if(trade.profit > 0) metrics.winningTrades++;
      else metrics.losingTrades++;
    });
    metrics.winRate = metrics.totalTrades > 0 ? (metrics.winningTrades / metrics.totalTrades) * 100 : 0;
    metrics.sharpeRatio = this._calculateSharpeRatio(dailyResults);
    metrics.dailyPerformance = dailyResults.map(day => ({date:day.date,profit:day.profit,profitPercentage:(day.profit / day.startCapital) * 100,trades:day.trades.length}));
    const tokenMetrics = new Map();
    portfolio.closedTrades.forEach(trade => {
      if(!tokenMetrics.has(trade.token)) tokenMetrics.set(trade.token, {token:trade.token,trades:0,winning:0,losing:0,profit:0,volume:0});
      const metrics = tokenMetrics.get(trade.token);
      metrics.trades++;
      if(trade.profit > 0) metrics.winning++;
      else metrics.losing++;
      metrics.profit += trade.profit;
      metrics.volume += trade.value;
    });
    metrics.tokenPerformance = Array.from(tokenMetrics.values()).map(tm => ({...tm,winRate:tm.trades > 0 ? (tm.winning / tm.trades) * 100 : 0}));
    return metrics;
  }

  _calculateSharpeRatio(dailyResults) {
    if(!dailyResults || dailyResults.length < 7) return 0;
    const returns = dailyResults.map(day => day.profit);
    const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length);
    return stdDev === 0 ? 0 : (avgReturn * 252) / (stdDev * Math.sqrt(252));
  }

  _generateParameterCombinations(parameters) {
    const combinations = [{}];
    for(const param in parameters) {
      const values = parameters[param].values || this._generateParameterValues(parameters[param]);
      const newCombinations = [];
      for(const combination of combinations) {
        for(const value of values) {
          newCombinations.push({...combination,[param]:value});
        }
      }
      if(newCombinations.length > 0) Object.assign(combinations, newCombinations);
    }
    return combinations;
  }

  _generateParameterValues(paramConfig) {
    const {min, max, step} = paramConfig;
    const values = [];
    for(let value = min; value <= max; value += step) {
      values.push(value);
    }
    return values;
  }

  _buildConfigFromParameters(parameters) {
    const config = {};
    for(const [param, value] of Object.entries(parameters)) {
      const pathParts = param.split('.');
      let current = config;
      for(let i = 0; i < pathParts.length - 1; i++) {
        if(!current[pathParts[i]]) current[pathParts[i]] = {};
        current = current[pathParts[i]];
      }
      current[pathParts[pathParts.length - 1]] = value;
    }
    return config;
  }
}