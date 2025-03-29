import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pipelineAsync = promisify(pipeline);

class LogService {
  constructor(config) {
    this.config = config;
    this.loggers = {};
    this.logLevel = config.logging?.level || 'info';
    this.logsDir = path.join(__dirname, '..', config.logging?.filePath || 'logs');
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
    this.initializeLoggers();
  }

  initializeLoggers() {
    const customFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    );
    
    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(info => {
        const { timestamp, level, message, ...rest } = info;
        let logMessage = `[${timestamp}] ${level}: ${message}`;
        if (Object.keys(rest).length > 0) logMessage += ` ${JSON.stringify(rest)}`;
        return logMessage;
      })
    );
    
    this.loggers.system = winston.createLogger({
      level: this.logLevel,
      format: customFormat,
      defaultMeta: { service: 'trading-bot-system' },
      transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
          filename: path.join(this.logsDir, 'system.log'),
          level: 'info',
          maxsize: 5242880,
          maxFiles: 5
        }),
        new winston.transports.File({
          filename: path.join(this.logsDir, 'error.log'),
          level: 'error',
          maxsize: 5242880,
          maxFiles: 10
        })
      ]
    });
    
    this.loggers.trading = winston.createLogger({
      level: this.logLevel,
      format: customFormat,
      defaultMeta: { service: 'trading-bot-trading' },
      transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
          filename: path.join(this.logsDir, 'trading.log'),
          level: 'info',
          maxsize: 5242880,
          maxFiles: 10
        })
      ]
    });
    
    this.loggers.api = winston.createLogger({
      level: this.logLevel,
      format: customFormat,
      defaultMeta: { service: 'trading-bot-api' },
      transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
          filename: path.join(this.logsDir, 'api.log'),
          level: 'info',
          maxsize: 5242880,
          maxFiles: 5
        })
      ]
    });
    
    this.loggers.security = winston.createLogger({
      level: 'info',
      format: customFormat,
      defaultMeta: { service: 'trading-bot-security' },
      transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
          filename: path.join(this.logsDir, 'security.log'),
          maxsize: 5242880,
          maxFiles: 10
        })
      ]
    });
    
    this.logger = this.loggers.system;
  }

  log(level, message, meta = {}, category = 'system') {
    if (!this.loggers[category]) category = 'system';
    this.loggers[category].log(level, message, meta);
  }

  debug(message, meta = {}, category = 'system') {
    this.log('debug', message, meta, category);
  }

  info(message, meta = {}, category = 'system') {
    this.log('info', message, meta, category);
  }

  warn(message, meta = {}, category = 'system') {
    this.log('warn', message, meta, category);
  }

  error(message, meta = {}, category = 'system') {
    if (meta instanceof Error) {
      meta = {
        error: meta.message,
        stack: meta.stack,
        name: meta.name,
        code: meta.code
      };
    }
    this.log('error', message, meta, category);
  }

  logTrade(trade) {
    if (!trade) return;
    const logEntry = {
      timestamp: trade.timestamp || Date.now(),
      token: trade.token,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      amount: trade.amount,
      profit: trade.profit,
      profitPercentage: trade.profitPercentage,
      signal: trade.signal,
      signalConfidence: trade.signalConfidence,
      holdingPeriod: trade.holdingPeriod,
      tradeId: trade.id
    };
    this.info('Trade executed', logEntry, 'trading');
    this.saveTradeToFile(logEntry);
    return logEntry;
  }

  async saveTradeToFile(trade) {
    if (!trade) return;
    try {
      const tradesDir = path.join(this.logsDir, 'trades');
      if (!fs.existsSync(tradesDir)) fs.mkdirSync(tradesDir, { recursive: true });
      
      const date = new Date(trade.timestamp);
      const dateStr = date.toISOString().split('T')[0];
      const fileName = path.join(tradesDir, `trades_${dateStr}.json`);
      
      let trades = [];
      if (fs.existsSync(fileName)) {
        const fileContent = await fs.promises.readFile(fileName, 'utf8');
        try {
          trades = JSON.parse(fileContent);
        } catch (error) {
          this.error(`Error parsing trades file: ${fileName}`, error);
          trades = [];
        }
      }
      
      trades.push(trade);
      await fs.promises.writeFile(fileName, JSON.stringify(trades, null, 2));
    } catch (error) {
      this.error('Error saving trade to file', error);
    }
  }

  logApiRequest(req, res, time) {
    const logEntry = {
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      userId: req.user?.id,
      statusCode: res.statusCode,
      responseTime: time
    };
    this.info('API request', logEntry, 'api');
  }

  logSecurityEvent(action, details, success = true) {
    const logEntry = {
      action,
      success,
      ...details,
      timestamp: Date.now()
    };
    
    if (process.env.NODE_ENV === 'production' && this.config.security?.anonymize) {
      if (logEntry.password) delete logEntry.password;
      if (logEntry.token) delete logEntry.token;
      if (logEntry.ip) logEntry.ip = this.anonymizeIp(logEntry.ip);
    }
    
    this.info(`Security event: ${action}`, logEntry, 'security');
  }

  anonymizeIp(ip) {
    if (!ip) return 'unknown';
    if (ip.includes('.')) return ip.replace(/\d+$/, '0');
    else if (ip.includes(':')) {
      const parts = ip.split(':');
      return parts.slice(0, 4).concat(Array(parts.length - 4).fill('0')).join(':');
    }
    return ip;
  }

  async cleanupOldLogs(daysToKeep = 30) {
    try {
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
      let deletedCount = 0;
      const allFiles = await this.getAllLogFiles();
      
      for (const file of allFiles) {
        try {
          const stats = await fs.promises.stat(file);
          const fileAge = now - stats.mtime.getTime();
          if (fileAge > maxAge) {
            await fs.promises.unlink(file);
            deletedCount++;
            this.info(`Deleted old log file: ${file}`);
          }
        } catch (err) {
          this.error(`Error processing file ${file}`, err);
        }
      }
      
      return deletedCount;
    } catch (error) {
      this.error('Error cleaning up old logs', error);
      throw error;
    }
  }

  async getAllLogFiles() {
    const result = [];
    
    async function walk(dir) {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          await walk(filePath);
        } else if (stats.isFile() && (file.endsWith('.log') || file.endsWith('.json'))) {
          result.push(filePath);
        }
      }
    }
    
    await walk(this.logsDir);
    return result;
  }

  async exportLogs(format = 'json', compress = false) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = format === 'json' ? 'json' : 'log';
      const fileName = `logs_export_${timestamp}.${extension}${compress ? '.gz' : ''}`;
      const outputPath = path.join(this.logsDir, 'exports', fileName);
      
      const exportsDir = path.join(this.logsDir, 'exports');
      if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
      
      const logFiles = await this.getAllLogFiles();
      let content = '';
      
      if (format === 'json') {
        const logs = {};
        for (const file of logFiles) {
          const category = path.basename(file, path.extname(file));
          try {
            const fileContent = await fs.promises.readFile(file, 'utf8');
            if (file.endsWith('.json')) {
              logs[category] = JSON.parse(fileContent);
            } else {
              logs[category] = fileContent.split('\n').filter(line => line.trim());
            }
          } catch (err) {
            this.error(`Error reading log file ${file}`, err);
          }
        }
        content = JSON.stringify({ exportDate: new Date().toISOString(), logs }, null, 2);
      } else {
        for (const file of logFiles) {
          try {
            const category = path.basename(file, path.extname(file));
            const fileContent = await fs.promises.readFile(file, 'utf8');
            content += `\n\n=== ${category} ===\n\n${fileContent}`;
          } catch (err) {
            this.error(`Error reading log file ${file}`, err);
          }
        }
      }
      
      if (compress) {
        const gzip = createGzip();
        const source = Buffer.from(content);
        const destination = fs.createWriteStream(outputPath);
        await pipelineAsync(source, gzip, destination);
      } else {
        await fs.promises.writeFile(outputPath, content);
      }
      
      return outputPath;
    } catch (error) {
      this.error('Error exporting logs', error);
      throw error;
    }
  }

  async streamLogs(writeStream, options = {}) {
    const {
      type = 'system',
      format = 'json',
      compress = false,
      limit = 1000,
      startDate,
      endDate
    } = options;
    
    try {
      let logFile;
      if (type === 'trade' || type === 'trades') {
        const tradesDir = path.join(this.logsDir, 'trades');
        if (fs.existsSync(tradesDir)) {
          const tradeFiles = await fs.promises.readdir(tradesDir);
          const filteredFiles = tradeFiles
            .filter(file => file.startsWith('trades_') && file.endsWith('.json'))
            .sort((a, b) => b.localeCompare(a));
          if (filteredFiles.length > 0) logFile = path.join(tradesDir, filteredFiles[0]);
        }
      } else {
        logFile = path.join(this.logsDir, `${type}.log`);
      }
      
      if (!logFile || !fs.existsSync(logFile)) {
        writeStream.write(JSON.stringify({ error: 'No logs found' }));
        writeStream.end();
        return;
      }
      
      const fileContent = await fs.promises.readFile(logFile, 'utf8');
      let logs;
      
      if (logFile.endsWith('.json')) {
        logs = JSON.parse(fileContent);
        if (startDate || endDate) {
          const start = startDate ? new Date(startDate).getTime() : 0;
          const end = endDate ? new Date(endDate).getTime() : Date.now();
          logs = logs.filter(log => {
            const timestamp = new Date(log.timestamp).getTime();
            return timestamp >= start && timestamp <= end;
          });
        }
        if (limit && logs.length > limit) logs = logs.slice(0, limit);
      } else {
        logs = fileContent.split('\n').filter(line => line.trim());
        if (limit && logs.length > limit) logs = logs.slice(0, limit);
      }
      
      let content;
      if (format === 'json') {
        content = JSON.stringify({
          type,
          timestamp: new Date().toISOString(),
          count: logs.length,
          logs
        });
      } else {
        content = logs.join('\n');
      }
      
      if (compress) {
        const gzip = createGzip();
        const source = Buffer.from(content);
        await pipelineAsync(source, gzip, writeStream);
      } else {
        writeStream.write(content);
        writeStream.end();
      }
    } catch (error) {
      this.error('Error streaming logs', error);
      writeStream.write(JSON.stringify({ error: 'Error streaming logs' }));
      writeStream.end();
    }
  }
  
  static createDefault(config = {}) {
    const defaultConfig = {
      logging: {
        level: 'info',
        filePath: 'logs'
      }
    };
    return new LogService({ ...defaultConfig, ...config });
  }
}

export default LogService;