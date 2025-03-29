// trading/tradeLogger.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { 
  formatTimestamp, 
  generateUUID, 
  calculateMaxDrawdown,
  daysBetween
} from '../utils/helpers.js';

const pipelineAsync = promisify(pipeline);

/**
 * TradeLogger - A comprehensive logging system for trading activities
 * Handles trade logging, performance metrics, storage, and exports
 */
export class TradeLogger {
  /**
   * Create a new TradeLogger instance
   * @param {Object} config - The configuration object
   */
  constructor(config) {
    this.config = config;
    this.tradeLogs = [];
    this.dailyLogs = new Map(); // Map with date string keys
    this.monthlyLogs = new Map(); // Map with month string keys
    this.tokenMetrics = new Map(); // Map with token keys
    
    // Statistics cache for better performance
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
    
    // Initialize persistent storage if configured
    if (this.config.logging?.persistentStorage) {
      this.initializeStorage();
    }
    
    // Setup event emitter for trade updates
    this.tradeSubscribers = [];
  }

  /**
   * Initialize storage for persistent logging
   * @private
   */
  initializeStorage() {
    try {
      // Get current directory path
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      
      // Define log directory path
      this.logDirectory = path.join(__dirname, '..', this.config.logging.filePath || 'logs/trades');
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
      }
      
      // Load existing logs at startup
      this.loadLogsFromStorage();
      
      // Setup auto-export if enabled
      if (this.config.logging.autoExport?.enabled) {
        const interval = this.config.logging.autoExport.interval || 86400000; // Default: 24 hours
        this.autoExportInterval = setInterval(() => {
          const format = this.config.logging.autoExport.format || 'json';
          this.exportAndSaveLogs(format);
        }, interval);
      }
    } catch (error) {
      console.error('Error initializing storage:', error);
    }
  }

  /**
   * Load existing logs from storage
   * @private
   */
  async loadLogsFromStorage() {
    try {
      if (!this.logDirectory) return;
      
      // Read all log files in the directory
      const files = await fs.promises.readdir(this.logDirectory);
      let loadedLogs = [];
      
      // Process only trade log files (not exports or other files)
      const tradeLogFiles = files.filter(file => file.startsWith('trades_') && file.endsWith('.json'));
      
      for (const file of tradeLogFiles) {
        const filePath = path.join(this.logDirectory, file);
        try {
          const data = await fs.promises.readFile(filePath, 'utf8');
          const logs = JSON.parse(data);
          
          if (Array.isArray(logs)) {
            loadedLogs = [...loadedLogs, ...logs];
          }
        } catch (error) {
          console.error(`Error parsing log file ${file}:`, error);
        }
      }
      
      // Update logs and recalculate statistics
      if (loadedLogs.length > 0) {
        // Sort logs by timestamp (newest first)
        this.tradeLogs = loadedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        // Recalculate all statistics
        this.recalculateStats();
        console.log(`Loaded ${this.tradeLogs.length} trades from storage`);
      }
    } catch (error) {
      console.error('Error loading logs from storage:', error);
    }
  }

  /**
   * Recalculate all statistics from trade logs
   * @private
   */
  recalculateStats() {
    // Reset statistics
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
    
    // Recalculate from all trades
    for (const trade of this.tradeLogs) {
      this.updateTotalStats(trade);
      this.updateDailyStats(trade);
      this.updateMonthlyStats(trade);
      this.updateTokenStats(trade);
    }
    
    // Mark statistics as updated
    this.statsCache.needsUpdate = false;
    this.statsCache.performanceCache = null;
    this.statsCache.performanceCacheExpiry = 0;
  }

  /**
   * Log a trade
   * @param {Object} trade - The trade to log
   * @returns {Object|null} The logged trade or null if error
   */
  logTrade(trade) {
    // Check required data
    if (!trade.token || !trade.timestamp) {
      console.error('Invalid trade data:', trade);
      return null;
    }
    
    try {
      // Format trade data for logging
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

      // Add log to trades array (at beginning for newest first)
      this.tradeLogs.unshift(tradeLog);
      
      // Update statistics
      this.updateTotalStats(tradeLog);
      this.updateDailyStats(tradeLog);
      this.updateMonthlyStats(tradeLog);
      this.updateTokenStats(tradeLog);
      
      // Mark stats cache as needing update
      this.statsCache.needsUpdate = true;
      this.statsCache.performanceCache = null;
      
      // If configured, save to persistent storage
      if (this.config.logging?.persistentStorage) {
        this.saveToStorage(tradeLog);
      }
      
      // Notify subscribers
      this.notifyTradeSubscribers(tradeLog);
      
      return tradeLog;
    } catch (error) {
      console.error('Error logging trade:', error);
      return null;
    }
  }

  /**
   * Subscribe to trade updates
   * @param {Function} callback - Function to call when a trade is logged
   * @returns {Function} Unsubscribe function
   */
  subscribeToTrades(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.tradeSubscribers.push(callback);
    
    // Return unsubscribe function
    return () => {
      this.tradeSubscribers = this.tradeSubscribers.filter(cb => cb !== callback);
    };
  }

  /**
   * Notify all subscribers of a new trade
   * @private
   * @param {Object} trade - The trade that was logged
   */
  notifyTradeSubscribers(trade) {
    this.tradeSubscribers.forEach(callback => {
      try {
        callback(trade);
      } catch (error) {
        console.error('Error in trade subscriber callback:', error);
      }
    });
  }

  /**
   * Update total statistics with a trade
   * @private
   * @param {Object} trade - The trade to add to statistics
   */
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

  /**
   * Update daily statistics with a trade
   * @private
   * @param {Object} trade - The trade to add to daily statistics
   */
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
    
    if (trade.profit > 0) {
      dailyLog.winningTrades++;
    } else {
      dailyLog.losingTrades++;
    }
  }

  /**
   * Update monthly statistics with a trade
   * @private
   * @param {Object} trade - The trade to add to monthly statistics
   */
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
    
    if (trade.profit > 0) {
      monthlyLog.winningTrades++;
    } else {
      monthlyLog.losingTrades++;
    }
  }

  /**
   * Update token-specific statistics with a trade
   * @private
   * @param {Object} trade - The trade to add to token statistics
   */
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
    
    if (trade.profit > 0) {
      tokenStat.winningTrades++;
    } else {
      tokenStat.losingTrades++;
    }
  }

  /**
   * Get trades by token
   * @param {string} token - The token to filter by
   * @returns {Array} Array of trades for the token
   */
  getTradesByToken(token) {
    return this.tradeLogs.filter(trade => trade.token === token);
  }

  /**
   * Get trades by date range
   * @param {string|Date} startDate - Start date
   * @param {string|Date} endDate - End date
   * @returns {Array} Array of trades in the date range
   */
  getTradesByDateRange(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    return this.tradeLogs.filter(trade => {
      const tradeDate = new Date(trade.timestamp);
      return tradeDate >= start && tradeDate <= end;
    });
  }

  /**
   * Get daily performance statistics
   * @param {boolean} sortByDate - Whether to sort by date (true = oldest first)
   * @returns {Array} Array of daily performance statistics
   */
  getDailyPerformance(sortByDate = false) {
    const dailyStats = Array.from(this.dailyLogs.values()).map(dailyLog => ({
      ...dailyLog,
      tokens: Array.from(dailyLog.tokens),
      winRate: dailyLog.trades > 0 ? (dailyLog.winningTrades / dailyLog.trades) * 100 : 0
    }));
    
    if (sortByDate) {
      // Sort by date (oldest first)
      return dailyStats.sort((a, b) => new Date(a.date) - new Date(b.date));
    } else {
      // Default: Sort by date (newest first)
      return dailyStats.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
  }

  /**
   * Get monthly performance statistics
   * @returns {Array} Array of monthly performance statistics
   */
  getMonthlyPerformance() {
    return Array.from(this.monthlyLogs.values()).map(monthlyLog => ({
      ...monthlyLog,
      tokens: Array.from(monthlyLog.tokens),
      winRate: monthlyLog.trades > 0 ? (monthlyLog.winningTrades / monthlyLog.trades) * 100 : 0
    })).sort((a, b) => b.month.localeCompare(a.month)); // Sort by month (newest first)
  }

  /**
   * Get token performance statistics
   * @param {number} minTrades - Minimum number of trades to include a token
   * @returns {Array} Array of token performance statistics
   */
  getTokenPerformance(minTrades = 0) {
    return Array.from(this.tokenMetrics.values())
      .filter(token => token.trades >= minTrades)
      .map(token => ({
        ...token,
        winRate: token.trades > 0 ? (token.winningTrades / token.trades) * 100 : 0,
        averageProfit: token.trades > 0 ? token.profit / token.trades : 0
      }))
      .sort((a, b) => b.profit - a.profit); // Sort by profit (highest first)
  }

  /**
   * Get comprehensive performance metrics
   * @returns {Object} Performance metrics
   */
  getPerformanceMetrics() {
    // Use cached performance if available and recent
    if (this.statsCache.performanceCache && 
        Date.now() - this.statsCache.performanceCacheExpiry < 60000 &&
        !this.statsCache.needsUpdate) {
      return this.statsCache.performanceCache;
    }
    
    const stats = this.statsCache.totalStats;
    const winRate = stats.totalTrades > 0
      ? (stats.winningTrades / stats.totalTrades) * 100
      : 0;
    
    // Calculate average win and loss
    const winningTrades = this.tradeLogs.filter(t => t.profit > 0);
    const losingTrades = this.tradeLogs.filter(t => t.profit < 0);
    
    const averageWin = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.profit, 0) / winningTrades.length
      : 0;
    
    const averageLoss = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.profit, 0) / losingTrades.length
      : 0;
    
    // Calculate profit factor
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    
    // Calculate average holding period
    const avgHoldingPeriod = this.tradeLogs.length > 0
      ? this.tradeLogs.reduce((sum, t) => sum + (t.holdingPeriod || 0), 0) / this.tradeLogs.length
      : 0;
    
    // Calculate drawdown
    let maxDrawdown = 0;
    if (this.tradeLogs.length > 0) {
      // Sort trades by timestamp for drawdown calculation
      const sortedTrades = [...this.tradeLogs].sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );
      
      // Calculate cumulative profit for drawdown
      let runningBalance = 0;
      const balanceHistory = sortedTrades.map(trade => {
        runningBalance += trade.profit;
        return runningBalance;
      });
      
      maxDrawdown = calculateMaxDrawdown(balanceHistory);
    }
    
    // Calculate expectancy
    const expectancy = winRate / 100 * averageWin + (1 - winRate / 100) * averageLoss;
    
    // Calculate win-loss ratio
    const winLossRatio = averageLoss !== 0 ? Math.abs(averageWin / averageLoss) : Infinity;
    
    // Calculate trades per day
    const firstTradeDate = this.tradeLogs.length > 0 
      ? new Date(this.tradeLogs[this.tradeLogs.length - 1].timestamp) 
      : new Date();
    const daysTrading = Math.max(1, daysBetween(firstTradeDate, new Date()));
    const tradesPerDay = stats.totalTrades / daysTrading;
    
    // Assemble complete metrics
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
    
    // Cache the computed metrics
    this.statsCache.performanceCache = metrics;
    this.statsCache.performanceCacheExpiry = Date.now();
    
    return metrics;
  }

  /**
   * Calculate Sharpe ratio based on daily returns
   * @private
   * @param {number} riskFreeRate - Annual risk-free rate (default: 2%)
   * @returns {number} The Sharpe ratio
   */
  calculateSharpeRatio(riskFreeRate = 2.0) {
    const dailyStats = this.getDailyPerformance(true);
    
    if (dailyStats.length < 7) { // Need at least a week of data
      return 0;
    }
    
    // Calculate daily returns as percentage
    const dailyReturns = dailyStats.map(day => {
      return day.profit; // Already in percentage form
    });
    
    // Calculate average daily return
    const avgDailyReturn = dailyReturns.reduce((sum, ret) => sum + ret, 0) / dailyReturns.length;
    
    // Calculate daily standard deviation
    const sumSquaredDiff = dailyReturns.reduce((sum, ret) => {
      const diff = ret - avgDailyReturn;
      return sum + diff * diff;
    }, 0);
    
    const stdDev = Math.sqrt(sumSquaredDiff / dailyReturns.length);
    
    if (stdDev === 0) return 0; // Avoid division by zero
    
    // Annualize the returns and standard deviation
    const annualizedReturn = avgDailyReturn * 252; // Assuming 252 trading days per year
    const annualizedStdDev = stdDev * Math.sqrt(252);
    
    // Daily risk-free rate
    const dailyRiskFree = riskFreeRate / 100 / 252;
    
    // Sharpe ratio
    return (annualizedReturn - riskFreeRate) / annualizedStdDev;
  }

  /**
   * Get recent trades
   * @param {number} limit - Maximum number of trades to return
   * @param {number} offset - Offset for pagination
   * @returns {Array} Array of recent trades
   */
  getRecentTrades(limit = 10, offset = 0) {
    return this.tradeLogs.slice(offset, offset + limit);
  }

  /**
   * Get the total number of trades
   * @returns {number} Total number of trades
   */
  getTotalTradesCount() {
    return this.tradeLogs.length;
  }

  /**
   * Save a trade to storage
   * @private
   * @param {Object} tradeLog - The trade to save
   * @returns {boolean} Success or failure
   */
  async saveToStorage(tradeLog) {
    try {
      if (!this.logDirectory) return false;
      
      // Filename based on date (one file per day)
      const dateStr = formatTimestamp(tradeLog.timestamp, false).replace(/\//g, '-');
      const logFile = path.join(this.logDirectory, `trades_${dateStr}.json`);
      
      let existingLogs = [];
      
      // Load existing logs if file exists
      if (fs.existsSync(logFile)) {
        try {
          const data = await fs.promises.readFile(logFile, 'utf8');
          existingLogs = JSON.parse(data);
        } catch (error) {
          console.error(`Error parsing existing log file ${logFile}:`, error);
          existingLogs = [];
        }
      }
      
      // Add new log
      existingLogs.push(tradeLog);
      
      // Write to file
      await fs.promises.writeFile(logFile, JSON.stringify(existingLogs, null, 2));
      
      return true;
    } catch (error) {
      console.error('Error saving trade to storage:', error);
      return false;
    }
  }

  /**
   * Export logs in the specified format
   * @param {string} format - Export format ('json' or 'csv')
   * @returns {string} Exported data
   */
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

  /**
   * Export and save logs to file
   * @param {string} format - Export format ('json' or 'csv')
   * @param {boolean} compress - Whether to compress the output
   * @returns {boolean} Success or failure
   */
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
        // Compress with gzip
        const input = Buffer.from(data);
        const output = fs.createWriteStream(exportFile);
        const gzip = createGzip();
        
        await pipelineAsync(
          Readable.from(input),
          gzip,
          output
        );
      } else {
        // Write without compression
        await fs.promises.writeFile(exportFile, data);
      }
      
      console.log(`Logs exported to ${exportFile}`);
      
      return true;
    } catch (error) {
      console.error('Error exporting and saving logs:', error);
      return false;
    }
  }

  /**
   * Generate CSV export
   * @private
   * @returns {string} CSV data
   */
  generateCSV() {
    try {
      // Generate CSV from trade logs
      const headers = [
        'id',
        'date',
        'token',
        'entryPrice',
        'exitPrice',
        'amount',
        'profit',
        'profitPercentage',
        'signal',
        'signalConfidence',
        'holdingPeriod',
        'stopLoss',
        'takeProfit'
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
  
  /**
   * Clean up old logs
   * @param {number} olderThanDays - Delete logs older than this many days
   * @returns {number} Number of files deleted or -1 if error
   */
  async cleanupOldLogs(olderThanDays = 90) {
    try {
      if (!this.logDirectory) return 0;
      
      const files = await fs.promises.readdir(this.logDirectory);
      const now = new Date();
      let deletedCount = 0;
      
      for (const file of files) {
        // Only delete daily trade log files, not exports
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
      
      // If files were deleted, we need to reload logs and recalculate stats
      if (deletedCount > 0) {
        await this.loadLogsFromStorage();
      }
      
      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up old logs:', error);
      return -1;
    }
  }
  
  /**
   * Get a complete performance report
   * @returns {Object} Comprehensive performance report
   */
  getPerformanceReport() {
    return {
      metrics: this.getPerformanceMetrics(),
      recentTrades: this.getRecentTrades(10),
      dailyPerformance: this.getDailyPerformance().slice(0, 30),
      monthlyPerformance: this.getMonthlyPerformance(),
      tokenPerformance: this.getTokenPerformance(5)
    };
  }
  
  /**
   * Clean up resources when shutting down
   */
  cleanup() {
    if (this.autoExportInterval) {
      clearInterval(this.autoExportInterval);
    }
    
    // Save any pending data
    if (this.config.logging?.persistentStorage) {
      this.exportAndSaveLogs('json', true)
        .catch(err => console.error('Error exporting logs during cleanup:', err));
    }
  }

  /**
   * Create a new instance with default configuration
   * @static
   * @returns {TradeLogger} A new TradeLogger instance with default config
   */
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
          interval: 86400000, // Daily (in ms)
          format: 'json'
        }
      }
    };
    
    return new TradeLogger(defaultConfig);
  }
  
  /**
   * @typedef {Object} StreamOptions
   * @property {boolean} [compress=false] - Whether to compress the output
   * @property {string} [format='json'] - Format ('json' or 'csv')
   * @property {number} [limit=1000] - Maximum records to include
   * @property {number} [page=1] - Page number for pagination
   * @property {string} [startDate] - Start date filter (ISO string)
   * @property {string} [endDate] - End date filter (ISO string)
   */
  
  /**
   * Stream logs to a writable stream
   * @param {stream.Writable} writeStream - The stream to write to
   * @param {StreamOptions} options - Stream options
   * @returns {Promise<void>}
   */
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
      // Filter logs by date range if specified
      let filteredLogs = this.tradeLogs;
      if (startDate || endDate) {
        const start = startDate ? new Date(startDate) : new Date(0);
        const end = endDate ? new Date(endDate) : new Date();
        
        filteredLogs = filteredLogs.filter(log => {
          const logDate = new Date(log.timestamp);
          return logDate >= start && logDate <= end;
        });
      }
      
      // Apply pagination
      const startIndex = (page - 1) * limit;
      const paginatedLogs = filteredLogs.slice(startIndex, startIndex + limit);
      
      // Create data based on format
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
        // Generate CSV headers
        const headers = [
          'id',
          'date',
          'token',
          'entryPrice',
          'exitPrice',
          'amount',
          'profit',
          'profitPercentage',
          'signal',
          'signalConfidence',
          'holdingPeriod'
        ].join(',');
        
        // Generate CSV rows
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
        // Stream with compression
        const gzip = createGzip();
        const inputStream = Readable.from(Buffer.from(data));
        await pipelineAsync(inputStream, gzip, writeStream);
      } else {
        // Stream without compression
        writeStream.write(data);
        writeStream.end();
      }
    } catch (error) {
      console.error('Error streaming logs:', error);
      writeStream.end(`Error streaming logs: ${error.message}`);
    }
  }
}

// For CommonJS compatibility
export default TradeLogger;