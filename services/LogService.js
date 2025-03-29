// services/LogService.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import winston from 'winston';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { format as formatDate } from 'date-fns';

// Helper pour obtenir le chemin du fichier
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Promisify pipeline pour les streams
const pipelineAsync = promisify(pipeline);

/**
 * Service de journalisation centralisé pour l'application
 * Gère tous les aspects de la journalisation avec différents niveaux et destinations
 */
class LogService {
  /**
   * Crée une nouvelle instance du service de journalisation
   * @param {Object} config - Configuration de l'application
   */
  constructor(config) {
    this.config = config;
    this.loggers = {};
    
    // Déterminer le niveau de journalisation par défaut
    this.logLevel = config.logging?.level || 'info';
    
    // Créer le répertoire de logs s'il n'existe pas
    this.logsDir = path.join(__dirname, '..', config.logging?.filePath || 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
    
    // Initialiser les différents loggers
    this.initializeLoggers();
  }

  /**
   * Initialise les loggers pour différents composants de l'application
   * @private
   */
  initializeLoggers() {
    // Format personnalisé pour les logs
    const customFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    );
    
    // Format pour la console
    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(info => {
        const { timestamp, level, message, ...rest } = info;
        let logMessage = `[${timestamp}] ${level}: ${message}`;
        
        // Ajouter les métadonnées si présentes
        if (Object.keys(rest).length > 0) {
          logMessage += ` ${JSON.stringify(rest)}`;
        }
        
        return logMessage;
      })
    );
    
    // Créer le logger système
    this.loggers.system = winston.createLogger({
      level: this.logLevel,
      format: customFormat,
      defaultMeta: { service: 'trading-bot-system' },
      transports: [
        // Logs de tous niveaux vers la console
        new winston.transports.Console({
          format: consoleFormat
        }),
        // Logs de niveau info et plus vers fichier
        new winston.transports.File({
          filename: path.join(this.logsDir, 'system.log'),
          level: 'info',
          maxsize: 5242880, // 5MB
          maxFiles: 5
        }),
        // Logs d'erreur vers fichier séparé
        new winston.transports.File({
          filename: path.join(this.logsDir, 'error.log'),
          level: 'error',
          maxsize: 5242880, // 5MB
          maxFiles: 10
        })
      ]
    });
    
    // Créer le logger de trading
    this.loggers.trading = winston.createLogger({
      level: this.logLevel,
      format: customFormat,
      defaultMeta: { service: 'trading-bot-trading' },
      transports: [
        // Logs de tous niveaux vers la console
        new winston.transports.Console({
          format: consoleFormat
        }),
        // Logs de niveau info et plus vers fichier
        new winston.transports.File({
          filename: path.join(this.logsDir, 'trading.log'),
          level: 'info',
          maxsize: 5242880, // 5MB
          maxFiles: 10
        })
      ]
    });
    
    // Créer le logger d'API
    this.loggers.api = winston.createLogger({
      level: this.logLevel,
      format: customFormat,
      defaultMeta: { service: 'trading-bot-api' },
      transports: [
        // Logs de tous niveaux vers la console
        new winston.transports.Console({
          format: consoleFormat
        }),
        // Logs de niveau info et plus vers fichier
        new winston.transports.File({
          filename: path.join(this.logsDir, 'api.log'),
          level: 'info',
          maxsize: 5242880, // 5MB
          maxFiles: 5
        })
      ]
    });
    
    // Créer le logger de sécurité
    this.loggers.security = winston.createLogger({
      level: 'info', // Toujours au niveau info pour la sécurité
      format: customFormat,
      defaultMeta: { service: 'trading-bot-security' },
      transports: [
        // Logs de sécurité vers la console et fichier
        new winston.transports.Console({
          format: consoleFormat
        }),
        new winston.transports.File({
          filename: path.join(this.logsDir, 'security.log'),
          maxsize: 5242880, // 5MB
          maxFiles: 10
        })
      ]
    });
    
    // Logger par défaut
    this.logger = this.loggers.system;
  }

  /**
   * Méthode de journalisation générique
   * @param {string} level - Niveau de log (debug, info, warn, error)
   * @param {string} message - Message à journaliser
   * @param {Object} [meta={}] - Métadonnées supplémentaires
   * @param {string} [category='system'] - Catégorie de log (system, trading, api, security)
   */
  log(level, message, meta = {}, category = 'system') {
    if (!this.loggers[category]) {
      category = 'system';
    }
    
    this.loggers[category].log(level, message, meta);
  }

  /**
   * Journalise un message de niveau debug
   * @param {string} message - Message à journaliser
   * @param {Object} [meta={}] - Métadonnées supplémentaires
   * @param {string} [category='system'] - Catégorie de log
   */
  debug(message, meta = {}, category = 'system') {
    this.log('debug', message, meta, category);
  }

  /**
   * Journalise un message de niveau info
   * @param {string} message - Message à journaliser
   * @param {Object} [meta={}] - Métadonnées supplémentaires
   * @param {string} [category='system'] - Catégorie de log
   */
  info(message, meta = {}, category = 'system') {
    this.log('info', message, meta, category);
  }

  /**
   * Journalise un message de niveau warn
   * @param {string} message - Message à journaliser
   * @param {Object} [meta={}] - Métadonnées supplémentaires
   * @param {string} [category='system'] - Catégorie de log
   */
  warn(message, meta = {}, category = 'system') {
    this.log('warn', message, meta, category);
  }

  /**
   * Journalise un message de niveau error
   * @param {string} message - Message à journaliser
   * @param {Object|Error} [meta={}] - Métadonnées ou objet Error
   * @param {string} [category='system'] - Catégorie de log
   */
  error(message, meta = {}, category = 'system') {
    // Si meta est une instance d'Error, la convertir en objet
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

  /**
   * Journalise une transaction de trading
   * @param {Object} trade - Détails de la transaction
   */
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

  /**
   * Sauvegarde une transaction dans un fichier dédié
   * @private
   * @param {Object} trade - Détails de la transaction
   */
  async saveTradeToFile(trade) {
    if (!trade) return;
    
    try {
      // Créer le répertoire de trades s'il n'existe pas
      const tradesDir = path.join(this.logsDir, 'trades');
      if (!fs.existsSync(tradesDir)) {
        fs.mkdirSync(tradesDir, { recursive: true });
      }
      
      // Nom de fichier basé sur la date
      const date = new Date(trade.timestamp);
      const dateStr = formatDate(date, 'yyyy-MM-dd');
      const fileName = path.join(tradesDir, `trades_${dateStr}.json`);
      
      // Charger les trades existants ou créer un tableau vide
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
      
      // Ajouter le nouveau trade
      trades.push(trade);
      
      // Sauvegarder le fichier
      await fs.promises.writeFile(fileName, JSON.stringify(trades, null, 2));
    } catch (error) {
      this.error('Error saving trade to file', error);
    }
  }

  /**
   * Journalise une activité d'API
   * @param {Object} req - Objet requête Express
   * @param {Object} res - Objet réponse Express
   * @param {number} time - Temps de traitement en ms
   */
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

  /**
   * Journalise une activité de sécurité
   * @param {string} action - Type d'action (login, logout, access, etc.)
   * @param {Object} details - Détails de l'activité
   * @param {boolean} [success=true] - Si l'action a réussi
   */
  logSecurityEvent(action, details, success = true) {
    const logEntry = {
      action,
      success,
      ...details,
      timestamp: Date.now()
    };
    
    // Anonymiser les données sensibles en production
    if (process.env.NODE_ENV === 'production' && this.config.security?.anonymize) {
      if (logEntry.password) delete logEntry.password;
      if (logEntry.token) delete logEntry.token;
      if (logEntry.ip) logEntry.ip = this.anonymizeIp(logEntry.ip);
    }
    
    this.info(`Security event: ${action}`, logEntry, 'security');
  }

  /**
   * Anonymise une adresse IP pour la confidentialité
   * @private
   * @param {string} ip - Adresse IP à anonymiser
   * @returns {string} Adresse IP anonymisée
   */
  anonymizeIp(ip) {
    if (!ip) return 'unknown';
    
    // Pour IPv4: remplacer le dernier octet par 0
    if (ip.includes('.')) {
      return ip.replace(/\d+$/, '0');
    }
    // Pour IPv6: remplacer la dernière moitié
    else if (ip.includes(':')) {
      const parts = ip.split(':');
      const anonymized = parts.slice(0, 4).concat(Array(parts.length - 4).fill('0')).join(':');
      return anonymized;
    }
    
    return ip;
  }

  /**
   * Nettoie les anciens logs
   * @param {number} daysToKeep - Nombre de jours à conserver
   * @returns {Promise<number>} Nombre de fichiers supprimés
   */
  async cleanupOldLogs(daysToKeep = 30) {
    try {
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000; // Conversion en ms
      let deletedCount = 0;
      
      // Lire tous les fichiers dans le répertoire des logs
      const allFiles = await this.getAllLogFiles();
      
      for (const file of allFiles) {
        try {
          const stats = await fs.promises.stat(file);
          const fileAge = now - stats.mtime.getTime();
          
          // Supprimer les fichiers plus anciens que maxAge
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

  /**
   * Récupère tous les fichiers de logs récursivement
   * @private
   * @returns {Promise<Array<string>>} Liste des chemins de fichiers
   */
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

  /**
   * Exporte les logs dans un format spécifique
   * @param {string} format - Format d'export ('json' ou 'text')
   * @param {boolean} compress - Si le fichier doit être compressé
   * @returns {Promise<string>} Chemin du fichier exporté
   */
  async exportLogs(format = 'json', compress = false) {
    try {
      // Déterminer le nom de fichier
      const timestamp = formatDate(new Date(), 'yyyy-MM-dd-HH-mm-ss');
      const extension = format === 'json' ? 'json' : 'log';
      const fileName = `logs_export_${timestamp}.${extension}${compress ? '.gz' : ''}`;
      const outputPath = path.join(this.logsDir, 'exports', fileName);
      
      // Créer le répertoire d'exports s'il n'existe pas
      const exportsDir = path.join(this.logsDir, 'exports');
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }
      
      // Lire tous les fichiers de logs
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
              // Pour les fichiers .log, convertir en tableau de lignes
              logs[category] = fileContent.split('\n').filter(line => line.trim());
            }
          } catch (err) {
            this.error(`Error reading log file ${file}`, err);
          }
        }
        
        content = JSON.stringify({
          exportDate: new Date().toISOString(),
          logs
        }, null, 2);
      } else {
        // Format texte: concaténer tous les fichiers
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
      
      // Écrire le contenu (avec ou sans compression)
      if (compress) {
        const gzip = createGzip();
        const source = Buffer.from(content);
        const destination = fs.createWriteStream(outputPath);
        
        await pipelineAsync(
          source,
          gzip,
          destination
        );
      } else {
        await fs.promises.writeFile(outputPath, content);
      }
      
      return outputPath;
    } catch (error) {
      this.error('Error exporting logs', error);
      throw error;
    }
  }

  /**
   * Diffuse les logs vers un flux d'écriture (pour le streaming HTTP)
   * @param {stream.Writable} writeStream - Flux d'écriture
   * @param {Object} options - Options de streaming
   * @returns {Promise<void>}
   */
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
      
      // Déterminer le fichier de log à diffuser
      if (type === 'trade' || type === 'trades') {
        // Pour les trades, trouver tous les fichiers de trades
        const tradesDir = path.join(this.logsDir, 'trades');
        if (fs.existsSync(tradesDir)) {
          const tradeFiles = await fs.promises.readdir(tradesDir);
          // Filtrer et trier les fichiers par date
          const filteredFiles = tradeFiles
            .filter(file => file.startsWith('trades_') && file.endsWith('.json'))
            .sort((a, b) => b.localeCompare(a)); // Plus récent d'abord
          
          if (filteredFiles.length > 0) {
            logFile = path.join(tradesDir, filteredFiles[0]);
          }
        }
      } else {
        // Pour les autres types de logs, utiliser les fichiers standards
        logFile = path.join(this.logsDir, `${type}.log`);
      }
      
      if (!logFile || !fs.existsSync(logFile)) {
        writeStream.write(JSON.stringify({ error: 'No logs found' }));
        writeStream.end();
        return;
      }
      
      // Lire et filtrer les logs
      const fileContent = await fs.promises.readFile(logFile, 'utf8');
      let logs;
      
      if (logFile.endsWith('.json')) {
        logs = JSON.parse(fileContent);
        
        // Filtrer par date si nécessaire
        if (startDate || endDate) {
          const start = startDate ? new Date(startDate).getTime() : 0;
          const end = endDate ? new Date(endDate).getTime() : Date.now();
          
          logs = logs.filter(log => {
            const timestamp = new Date(log.timestamp).getTime();
            return timestamp >= start && timestamp <= end;
          });
        }
        
        // Limiter le nombre de logs
        if (limit && logs.length > limit) {
          logs = logs.slice(0, limit);
        }
      } else {
        // Pour les fichiers texte, diviser par lignes
        logs = fileContent.split('\n').filter(line => line.trim());
        
        // Filtrer et limiter
        if (limit && logs.length > limit) {
          logs = logs.slice(0, limit);
        }
      }
      
      // Formater la réponse
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
      
      // Compresser si demandé
      if (compress) {
        const gzip = createGzip();
        const source = Buffer.from(content);
        
        await pipelineAsync(
          source,
          gzip,
          writeStream
        );
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
  
  /**
   * Crée une instance par défaut du LogService
   * @static
   * @param {Object} [config={}] - Configuration partielle
   * @returns {LogService} Instance du LogService
   */
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