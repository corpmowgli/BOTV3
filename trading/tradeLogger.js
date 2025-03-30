import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';
import { Readable } from 'stream'; // Added missing import
import { promisify } from 'util';
import { formatTimestamp, generateUUID, calculateMaxDrawdown, daysBetween } from '../utils/helpers.js';

const pipelineAsync = promisify(pipeline);

export class TradeLogger {
  constructor(config) {
    this.config = config;
    this.tradeLogs = [];
    this.dailyLogs = new Map();
    this.monthlyLogs = new Map();
    this.tokenMetrics = new Map();
    this.statsCache = {
      totalStats: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfit: 0,
        totalVolume: 0,
        biggestWin: 0,
        biggestLoss: 0,
        lastUpdated: 0
      },
      needsUpdate: true,
      performanceCache: null,
      performanceCacheExpiry: 0
    };
    
    if (this.config.logging?.persistentStorage) this.initializeStorage();
    this.tradeSubscribers = [];
  }

  initializeStorage() {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      this.logDirectory = path.join(__dirname, '..', this.config.logging.filePath || 'logs/trades');
      
      if (!fs.existsSync(this.logDirectory)) fs.mkdirSync(this.logDirectory, { recursive: true });
      
      this.loadLogsFromStorage();
      
      if (this.config.logging.autoExport?.enabled) {
        const interval = this.config.logging.autoExport.interval || 86400000;
        this.autoExportInterval = setInterval(() => {
          const format = this.config.logging.autoExport.format || 'json';
          this.exportAndSaveLogs(format);
        }, interval);
      }
    } catch (error) {
      console.error('Error initializing storage:', error);
    }
  }

  async loadLogsFromStorage() {
    try {
      if (!this.logDirectory) return;
      
      const files = await fs.promises.readdir(this.logDirectory);
      let loadedLogs = [];
      
      const tradeLogFiles = files.filter(file => file.startsWith('trades_') && file.endsWith('.json'));
      
      for (const file of tradeLogFiles) {
        const filePath = path.join(this.logDirectory, file);
        try {
          const data = await fs.promises.readFile(filePath, 'utf8');
          const logs = JSON.parse(data);
          
          if (Array.isArray(logs)) loadedLogs = [...loadedLogs, ...logs];
        } catch (error) {
          console.error(`Error parsing log file ${file}:`, error);
        }
      }
      
      if (loadedLogs.length > 0) {
        this.tradeLogs = loadedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        this.recalculateStats();
        console.log(`Loaded ${this.tradeLogs.length} trades from storage`);
      }
    } catch (error) {
      console.error('Error loading logs from storage:', error);
    }
  }

  recalculateStats() {
    this.statsCache.totalStats = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      totalVolume: 0,
      biggestWin: 0,
      biggestLoss: 0,
      lastUpdated: Date.now()
    };
    
    this.dailyLogs = new Map();
    this.monthlyLogs = new Map();
    this.tokenMetrics = new Map();
    
    for (const trade of this.tradeLogs) {
      this.updateTotalStats(trade);
      this.updateDailyStats(trade);
      this.updateMonthlyStats(trade);
      this.updateTokenStats(trade);
    }
    
    this.statsCache.needsUpdate = false;
    this.statsCache.performanceCache = null;
    this.statsCache.performanceCacheExpiry = 0;
  }

  logTrade(trade) {
    if (!trade.token || !trade.timestamp) {
      console.error('Invalid trade data:', trade);
      return null;
    }
    
    try {
      const tradeLog = {
        id: trade.id || generateUUID(),
        token: trade.token,
        timestamp: trade.timestamp,
        date: formatTimestamp(trade.timestamp, false),
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        amount: trade.amount,
        profit: trade.profit || 0,
        profitPercentage: trade.profitPercentage || 
          ((trade.exitPrice && trade.entryPrice) 
            ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100 
            : 0),
        signal: trade.signal || 'UNKNOWN',
        signalConfidence: trade.signalConfidence || 0,
        signalReasons: trade.signalReasons || [],
        holdingPeriod: trade.holdingTime || 0,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit
      };

      this.tradeLogs.unshift(tradeLog);
      
      this.updateTotalStats(tradeLog);
      this.updateDailyStats(tradeLog);
      this.updateMonthlyStats(tradeLog);
      this.updateTokenStats(tradeLog);
      
      this.statsCache.needsUpdate = true;
      this.statsCache.performanceCache = null;
      
      if (this.config.logging?.persistentStorage) this.saveToStorage(tradeLog);
      
      this.notifyTradeSubscribers(tradeLog);
      
      return tradeLog;
    } catch (error) {
      console.error('Error logging trade:', error);
      return null;
    }
  }

  subscribeToTrades(callback) {
    if (typeof callback !== 'function') throw new Error('Callback must be a function');
    
    this.tradeSubscribers.push(callback);
    return () => { this.tradeSubscribers = this.tradeSubscribers.filter(cb => cb !== callback); };
  }

  notifyTradeSubscribers(trade) {
    this.tradeSubscribers.forEach(callback => {
      try {
        callback(trade);
      } catch (error) {
        console.error('Error in trade subscriber callback:', error);
      }
    });
  }

  updateTotalStats(trade) {
    const stats = this.statsCache.totalStats;
    
    stats.totalTrades++;
    stats.totalProfit += trade.profit;
    stats.totalVolume += trade.amount * trade.entryPrice;
    
    if (trade.profit > 0) {
      stats.winningTrades++;
      stats.biggestWin = Math.max(stats.biggestWin, trade.profit);
    } else {
      stats.losingTrades++;
      stats.biggestLoss = Math.min(stats.biggestLoss, trade.profit);
    }
    
    stats.lastUpdated = Date.now();
  }

  updateDailyStats(trade) {
    const date = formatTimestamp(trade.timestamp, false);
    
    if (!this.dailyLogs.has(date)) {
      this.dailyLogs.set(date, {
        date,
        trades: 0,
        winningTrades: 0,
        losingTrades: 0,
        profit: 0,
        volume: 0,
        tokens: new Set(),
        tradeIds: []
      });
    }
    
    const dailyLog = this.dailyLogs.get(date);
    dailyLog.trades++;
    dailyLog.profit += trade.profit;
    dailyLog.volume += trade.amount * trade.entryPrice;
    dailyLog.tokens.add(trade.token);
    dailyLog.tradeIds.push(trade.id);
    
    if (trade.profit > 0) dailyLog.winningTrades++;
    else dailyLog.losingTrades++;
  }

  updateMonthlyStats(trade) {
    const date = new Date(trade.timestamp);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    
    if (!this.monthlyLogs.has(month)) {
      this.monthlyLogs.set(month, {
        month,
        monthName: date.toLocaleString('default', { month: 'long', year: 'numeric' }),
        trades: 0,
        winningTrades: 0,
        losingTrades: 0,
        profit: 0,
        volume: 0,
        tokens: new Set(),
        tradeIds: []
      });
    }
    
    const monthlyLog = this.monthlyLogs.get(month);
    monthlyLog.trades++;
    monthlyLog.profit += trade.profit;
    monthlyLog.volume += trade.amount * trade.entryPrice;
    monthlyLog.tokens.add(trade.token);
    monthlyLog.tradeIds.push(trade.id);
    
    if (trade.profit > 0) monthlyLog.winningTrades++;
    else monthlyLog.losingTrades++;
  }

  updateTokenStats(trade) {
    if (!this.tokenMetrics.has(trade.token)) {
      this.tokenMetrics.set(trade.token, {
        token: trade.token,
        trades: 0,
        winningTrades: 0,
        losingTrades: 0,
        profit: 0,
        volume: 0,
        firstTradeDate: trade.timestamp,
        lastTradeDate: trade.timestamp,
        tradeIds: []
      });
    }
    
    const tokenStat = this.tokenMetrics.get(trade.token);
    tokenStat.trades++;
    tokenStat.profit += trade.profit;
    tokenStat.volume += trade.amount * trade.entryPrice;
    tokenStat.lastTradeDate = trade.timestamp;
    tokenStat.tradeIds.push(trade.id);
    
    if (trade.profit > 0) tokenStat.winningTrades++;
    else tokenStat.losingTrades++;
  }

  getTradesByToken(token) {
    return this.tradeLogs.filter(trade => trade.token === token);
  }

  getTradesByDateRange(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    return this.tradeLogs.filter(trade => {
      const tradeDate = new Date(trade.timestamp);
      return tradeDate >= start && tradeDate <= end;
    });
  }

  getDailyPerformance(sortByDate = false) {
    const dailyStats = Array.from(this.dailyLogs.values()).map(dailyLog => ({
      ...dailyLog,
      tokens: Array.from(dailyLog.tokens),
      winRate: dailyLog.trades > 0 ? (dailyLog.winningTrades / dailyLog.trades) * 100 : 0
    }));
    
    if (sortByDate) return dailyStats.sort((a, b) => new Date(a.date) - new Date(b.date));
    else return dailyStats.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  getMonthlyPerformance() {
    return Array.from(this.monthlyLogs.values()).map(monthlyLog => ({
      ...monthlyLog,
      tokens: Array.from(monthlyLog.tokens),
      winRate: monthlyLog.trades > 0 ? (monthlyLog.winningTrades / monthlyLog.trades) * 100 : 0
    })).sort((a, b) => b.month.localeCompare(a.month));
  }

  getTokenPerformance(minTrades = 0) {
    return Array.from(this.tokenMetrics.values())
      .filter(token => token.trades >= minTrades)
      .map(token => ({
        ...token,
        winRate: token.trades > 0 ? (token.winningTrades / token.trades) * 100 : 0,
        averageProfit: token.trades > 0 ? token.profit / token.trades : 0
      }))
      .sort((a, b) => b.profit - a.profit);
  }

  getPerformanceMetrics() {
    if (this.statsCache.performanceCache && 
        Date.now() - this.statsCache.performanceCacheExpiry < 60000 &&
        !this.statsCache.needsUpdate) {
      return this.statsCache.performanceCache;
    }
    
    const stats = this.statsCache.totalStats;
    const winRate = stats.totalTrades > 0
      ? (stats.winningTrades / stats.totalTrades) * 100
      : 0;
    
    const winningTrades = this.tradeLogs.filter(t => t.profit > 0);
    const losingTrades = this.tradeLogs.filter(t => t.profit < 0);
    
    const averageWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.profit, 0) / winningTrades.length
      : 0;
    
    const averageLoss = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.profit, 0) / losingTrades.length
      : 0;
    
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    const avgHoldingPeriod = this.tradeLogs.length > 0
      ? this.tradeLogs.reduce((sum, t) => sum + (t.holdingPeriod || 0), 0) / this.tradeLogs.length
      : 0;
    
    let maxDrawdown = 0;
    if (this.tradeLogs.length > 0) {
      const sortedTrades = [...this.tradeLogs].sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );
      
      let runningBalance = 0;
      const balanceHistory = sortedTrades.map(trade => {
        runningBalance += trade.profit;
        return runningBalance;
      });
      
      maxDrawdown = calculateMaxDrawdown(balanceHistory);
    }
    
    const expectancy = winRate / 100 * averageWin + (1 - winRate / 100) * averageLoss;
    const winLossRatio = averageLoss !== 0 ? Math.abs(averageWin / averageLoss) : Infinity;
    
    const firstTradeDate = this.tradeLogs.length > 0 
      ? new Date(this.tradeLogs[this.tradeLogs.length - 1].timestamp) 
      : new Date();
    const daysTrading = Math.max(1, daysBetween(firstTradeDate, new Date()));
    const tradesPerDay = stats.totalTrades / daysTrading;
    
    const metrics = {
      totalTrades: stats.totalTrades,
      winningTrades: stats.winningTrades,
      losingTrades: stats.losingTrades,
      winRate,
      expectancy,
      winLossRatio,
      totalProfit: stats.totalProfit,
      totalVolume: stats.totalVolume,
      averageWin,
      averageLoss,
      biggestWin: stats.biggestWin,
      biggestLoss: stats.biggestLoss,
      profitFactor,
      maxDrawdown,
      sharpeRatio: this.calculateSharpeRatio(),
      avgTradesPerDay: tradesPerDay,
      avgHoldingPeriodMs: avgHoldingPeriod,
      avgHoldingPeriodHours: avgHoldingPeriod / (1000 * 60 * 60),
      firstTradeDate: firstTradeDate.toISOString(),
      lastTradeDate: this.tradeLogs.length > 0 ? this.tradeLogs[0].timestamp : new Date().toISOString(),
      daysTrading
    };
    
    this.statsCache.performanceCache = metrics;
    this.statsCache.performanceCacheExpiry = Date.now();
    
    return metrics;
  }

  calculateSharpeRatio(riskFreeRate = 2.0) {
    const dailyStats = this.getDailyPerformance(true);
    
    if (dailyStats.length < 7) return 0;
    
    const dailyReturns = dailyStats.map(day => day.profit);
    const avgDailyReturn = dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length;
    
    const sumSquaredDiff = dailyReturns.reduce((sum, ret) => {
      const diff = ret - avgDailyReturn;
      return sum + diff * diff;
    }, 0);
    
    const stdDev = Math.sqrt(sumSquaredDiff / dailyReturns.length);
    
    if (stdDev === 0) return 0;
    
    const annualizedReturn = avgDailyReturn * 252;
    const annualizedStdDev = stdDev * Math.sqrt(252);
    const dailyRiskFree = riskFreeRate / 100 / 252;
    
    return (annualizedReturn - riskFreeRate) / annualizedStdDev;
  }

  getRecentTrades(limit = 10, offset = 0) {
    return this.tradeLogs.slice(offset, offset + limit);
  }

  getTotalTradesCount() {
    return this.tradeLogs.length;
  }

  async saveToStorage(tradeLog) {
    if (!tradeLog) return false;
    try {
      if (!this.logDirectory) return false;
      
      const tradesDir = path.join(this.logDirectory, 'trades');
      if (!fs.existsSync(tradesDir)) fs.mkdirSync(tradesDir, { recursive: true });
      
      const date = new Date(tradeLog.timestamp);
      const dateStr = date.toISOString().split('T')[0];
      const fileName = path.join(tradesDir, `trades_${dateStr}.json`);
      
      let trades = [];
      if (fs.existsSync(fileName)) {
        const fileContent = await fs.promises.readFile(fileName, 'utf8');
        try {
          trades = JSON.parse(fileContent);
        } catch (error) {
          console.error(`Error parsing trades file: ${fileName}`, error);
          trades = [];
        }
      }
      
      trades.push(tradeLog);
      await fs.promises.writeFile(fileName, JSON.stringify(trades, null, 2));
      
      return true;
    } catch (error) {
      console.error('Error saving trade to storage:', error);
      return false;
    }
  }

  exportLogs(format = 'json') {
    try {
      if (format === 'json') {
        return JSON.stringify({
          metadata: {
            exportDate: new Date().toISOString(),
            totalTrades: this.tradeLogs.length,
            version: '2.0'
          },
          performance: this.getPerformanceMetrics(),
          trades: this.tradeLogs,
          dailyPerformance: this.getDailyPerformance(true),
          monthlyPerformance: this.getMonthlyPerformance(),
          tokenPerformance: this.getTokenPerformance()
        }, null, 2);
      } else if (format === 'csv') {
        return this.generateCSV();
      } else {
        throw new Error(`Unsupported export format: ${format}`);
      }
    } catch (error) {
      console.error('Error exporting logs:', error);
      return format === 'json' 
        ? JSON.stringify({ error: 'Failed to export logs' }) 
        : 'error,failed to export logs';
    }
  }

  async exportAndSaveLogs(format = 'json', compress = false) {
    try {
      if (!this.logDirectory) return false;
      
      const data = this.exportLogs(format);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFile = path.join(
        this.logDirectory, 
        `export_${timestamp}.${format}${compress ? '.gz' : ''}`
      );
      
      if (compress) {
        const input = Buffer.from(data);
        const output = fs.createWriteStream(exportFile);
        const gzip = createGzip();
        
        await pipelineAsync(
          Readable.from(input),
          gzip,
          output
        );
      } else {
        await fs.promises.writeFile(exportFile, data);
      }
      
      console.log(`Logs exported to ${exportFile}`);
      return true;
    } catch (error) {
      console.error('Error exporting and saving logs:', error);
      return false;
    }
  }

  generateCSV() {
    try {
      const headers = [
        'id', 'date', 'token', 'entryPrice', 'exitPrice', 'amount', 'profit',
        'profitPercentage', 'signal', 'signalConfidence', 'holdingPeriod', 
        'stopLoss', 'takeProfit'
      ].join(',');
      
      const rows = this.tradeLogs.map(trade =>
        [
          trade.id,
          formatTimestamp(trade.timestamp),
          trade.token,
          trade.entryPrice,
          trade.exitPrice,
          trade.amount,
          trade.profit,
          trade.profitPercentage,
          trade.signal,
          trade.signalConfidence,
          trade.holdingPeriod,
          trade.stopLoss,
          trade.takeProfit
        ].join(',')
      );
      
      return [headers, ...rows].join('\n');
    } catch (error) {
      console.error('Error generating CSV:', error);
      return 'error,generating,csv';
    }
  }
  
  async cleanupOldLogs(olderThanDays = 90) {
    try {
      if (!this.logDirectory) return 0;
      
      const files = await fs.promises.readdir(this.logDirectory);
      const now = new Date();
      let deletedCount = 0;
      
      for (const file of files) {
        if (file.startsWith('trades_') && (file.endsWith('.json') || file.endsWith('.csv'))) {
          const filePath = path.join(this.logDirectory, file);
          const stats = await fs.promises.stat(filePath);
          
          const fileAge = (now - stats.mtime) / (1000 * 60 * 60 * 24);
          
          if (fileAge > olderThanDays) {
            await fs.promises.unlink(filePath);
            deletedCount++;
            console.log(`Deleted old log file: ${file}`);
          }
        }
      }
      
      if (deletedCount > 0) await this.loadLogsFromStorage();
      
      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up old logs:', error);
      return -1;
    }
  }
  
  getPerformanceReport() {
    return {
      metrics: this.getPerformanceMetrics(),
      recentTrades: this.getRecentTrades(10),
      dailyPerformance: this.getDailyPerformance().slice(0, 30),
      monthlyPerformance: this.getMonthlyPerformance(),
      tokenPerformance: this.getTokenPerformance(5)
    };
  }
  
  cleanup() {
    if (this.autoExportInterval) clearInterval(this.autoExportInterval);
    
    if (this.config.logging?.persistentStorage) {
      this.exportAndSaveLogs('json', true)
        .catch(err => console.error('Error exporting logs during cleanup:', err));
    }
  }

  static createDefault() {
    const defaultConfig = {
      logging: {
        enabled: true,
        level: 'info',
        persistentStorage: true,
        storageType: 'file',
        filePath: './logs/trades/',
        autoExport: {
          enabled: true,
          interval: 86400000,
          format: 'json'
        }
      }
    };
    
    return new TradeLogger(defaultConfig);
  }
  
  async streamLogsToStream(writeStream, options = {}) {
    const {
      compress = false,
      format = 'json',
      limit = 1000,
      page = 1,
      startDate,
      endDate
    } = options;
    
    try {
      let filteredLogs = this.tradeLogs;
      if (startDate || endDate) {
        const start = startDate ? new Date(startDate) : new Date(0);
        const end = endDate ? new Date(endDate) : new Date();
        
        filteredLogs = filteredLogs.filter(log => {
          const logDate = new Date(log.timestamp);
          return logDate >= start && logDate <= end;
        });
      }
      
      const startIndex = (page - 1) * limit;
      const paginatedLogs = filteredLogs.slice(startIndex, startIndex + limit);
      
      let data;
      if (format === 'json') {
        data = JSON.stringify({
          metadata: {
            exportDate: new Date().toISOString(),
            totalTrades: filteredLogs.length,
            page,
            limit,
            totalPages: Math.ceil(filteredLogs.length / limit)
          },
          trades: paginatedLogs
        }, null, 2);
      } else if (format === 'csv') {
        const headers = [
          'id', 'date', 'token', 'entryPrice', 'exitPrice', 'amount', 'profit',
          'profitPercentage', 'signal', 'signalConfidence', 'holdingPeriod'
        ].join(',');
        
        const rows = paginatedLogs.map(trade =>
          [
            trade.id,
            formatTimestamp(trade.timestamp),
            trade.token,
            trade.entryPrice,
            trade.exitPrice,
            trade.amount,
            trade.profit,
            trade.profitPercentage,
            trade.signal,
            trade.signalConfidence,
            trade.holdingPeriod
          ].join(',')
        );
        
        data = [headers, ...rows].join('\n');
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }
      
      if (compress) {
        const gzip = createGzip();
        const inputStream = Readable.from(Buffer.from(data));
        await pipelineAsync(inputStream, gzip, writeStream);
      } else {
        writeStream.write(data);
        writeStream.end();
      }
    } catch (error) {
      console.error('Error streaming logs:', error);
      writeStream.end(`Error streaming logs: ${error.message}`);
    }
  }
}

export default TradeLogger;