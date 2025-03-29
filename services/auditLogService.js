import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';
import EventEmitter from 'events';

const pipelineAsync = promisify(pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AuditLogService extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      enabled: config.enabled !== false,
      logDirectory: config.logDirectory || path.join(__dirname, '../logs/audit'),
      rotationInterval: config.rotationInterval || 86400000,
      compressionEnabled: config.compressionEnabled !== false,
      verificationEnabled: config.verificationEnabled !== false,
      hashAlgorithm: config.hashAlgorithm || 'sha256',
      signatureKey: config.signatureKey || process.env.AUDIT_SIGNATURE_KEY || crypto.randomBytes(32).toString('hex'),
      encryptionEnabled: config.encryptionEnabled || false,
      encryptionKey: config.encryptionKey || process.env.AUDIT_ENCRYPTION_KEY,
      metadataFields: config.metadataFields || ['username', 'ipAddress', 'timestamp'],
      retentionPolicy: {
        enabled: config.retentionPolicy?.enabled !== false,
        days: config.retentionPolicy?.days || 365,
        archiveEnabled: config.retentionPolicy?.archiveEnabled !== false
      }
    };
    
    this.state = {
      currentLogFile: null,
      previousHash: null,
      rotationTimer: null,
      lastRotation: Date.now(),
      totalEvents: 0,
      verificationResults: [],
      active: false
    };
    
    this._initialize();
  }

  async _initialize() {
    try {
      if (!fs.existsSync(this.config.logDirectory)) {
        fs.mkdirSync(this.config.logDirectory, { recursive: true });
      }
      
      await this._findOrCreateCurrentLogFile();
      this._setupLogRotation();
      
      this.state.active = true;
      this.emit('initialized', { logFile: this.state.currentLogFile });
      
      if (this.config.verificationEnabled) {
        this.verifyChain()
          .then(result => this.emit('verification', result))
          .catch(err => this.emit('error', { message: 'Erreur de vérification', error: err }));
      }
    } catch (error) {
      this.emit('error', { message: 'Erreur d\'initialisation', error });
    }
  }

  async logEvent(eventType, data, metadata = {}) {
    if (!this.config.enabled || !this.state.active) return null;
    
    try {
      if (!eventType || typeof eventType !== 'string') {
        throw new Error('Type d\'événement invalide ou manquant');
      }
      
      if (!data || typeof data !== 'object') {
        throw new Error('Données d\'événement invalides ou manquantes');
      }
      
      const timestamp = new Date().toISOString();
      const eventId = this._generateEventId(eventType, timestamp);
      
      const filteredMetadata = {};
      for (const field of this.config.metadataFields) {
        if (metadata[field] !== undefined) filteredMetadata[field] = metadata[field];
      }
      
      if (!filteredMetadata.timestamp) filteredMetadata.timestamp = timestamp;
      
      const entry = {
        eventId,
        timestamp,
        eventType,
        data,
        metadata: filteredMetadata,
        previousHash: this.state.previousHash
      };
      
      const entryHash = this._calculateHash(entry);
      entry.hash = entryHash;
      
      if (this.config.signatureKey) entry.signature = this._signEntry(entry);
      
      let serializedEntry = JSON.stringify(entry);
      let finalEntry = serializedEntry;
      
      if (this.config.encryptionEnabled && this.config.encryptionKey) {
        finalEntry = this._encryptEntry(serializedEntry);
      }
      
      await this._appendToLog(finalEntry);
      
      this.state.previousHash = entryHash;
      this.state.totalEvents++;
      
      this.emit('logged', {
        eventId,
        eventType,
        timestamp,
        hash: entryHash
      });
      
      return { eventId, eventType, timestamp, hash: entryHash };
    } catch (error) {
      this.emit('error', { message: 'Erreur de journalisation', error });
      throw error;
    }
  }

  async logTrade(trade, metadata = {}) {
    if (!trade) throw new Error('Données de trade manquantes');
    return this.logEvent('TRADE', trade, metadata);
  }

  async logConfigChange(oldConfig, newConfig, metadata = {}) {
    if (!oldConfig || !newConfig) throw new Error('Données de configuration manquantes');
    const sanitizedOldConfig = this._sanitizeConfig(oldConfig);
    const sanitizedNewConfig = this._sanitizeConfig(newConfig);
    
    return this.logEvent('CONFIG_CHANGE', {
      oldConfig: sanitizedOldConfig,
      newConfig: sanitizedNewConfig
    }, metadata);
  }

  async logSecurityEvent(action, details, metadata = {}) {
    if (!action) throw new Error('Action de sécurité manquante');
    return this.logEvent('SECURITY', { action, details }, metadata);
  }

  async logBotStateChange(newState, details = {}, metadata = {}) {
    if (!newState) throw new Error('État du bot manquant');
    return this.logEvent('BOT_STATE', { state: newState, details }, metadata);
  }

  async verifyChain(fileName = null) {
    if (!this.config.verificationEnabled) {
      return { verified: false, reason: 'Vérification désactivée' };
    }
    
    try {
      let files = [];
      
      if (fileName) {
        const filePath = path.join(this.config.logDirectory, fileName);
        if (fs.existsSync(filePath)) {
          files.push(fileName);
        } else {
          throw new Error(`Fichier non trouvé: ${fileName}`);
        }
      } else {
        files = fs.readdirSync(this.config.logDirectory)
          .filter(file => file.endsWith('.json') || file.endsWith('.gz'))
          .sort();
      }
      
      if (files.length === 0) {
        return { verified: true, message: 'Aucun fichier à vérifier' };
      }
      
      const results = {
        verified: true,
        filesChecked: files.length,
        entriesChecked: 0,
        failures: []
      };
      
      let previousHash = null;
      
      for (const file of files) {
        const filePath = path.join(this.config.logDirectory, file);
        
        let content;
        if (file.endsWith('.gz')) {
          content = await this._readCompressedFile(filePath);
        } else {
          content = fs.readFileSync(filePath, 'utf8');
        }
        
        const lines = content.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          let entry;
          
          try {
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            if (entry.signature && !this._verifySignature(entry)) {
              results.failures.push({
                file,
                eventId: entry.eventId,
                reason: 'Signature invalide'
              });
              results.verified = false;
              continue;
            }
            
            const savedHash = entry.hash;
            const computedHash = this._calculateHash({ ...entry, hash: undefined });
            
            if (savedHash !== computedHash) {
              results.failures.push({
                file,
                eventId: entry.eventId,
                reason: 'Hash invalide'
              });
              results.verified = false;
              continue;
            }
            
            if (previousHash !== null && entry.previousHash !== previousHash) {
              results.failures.push({
                file,
                eventId: entry.eventId,
                reason: 'Chaîne de hash brisée'
              });
              results.verified = false;
            }
            
            previousHash = entry.hash;
            results.entriesChecked++;
            
          } catch (err) {
            results.failures.push({
              file,
              line: line.substring(0, 50) + '...',
              reason: 'Format invalide ou corruption'
            });
            results.verified = false;
          }
        }
      }
      
      this.state.verificationResults.push({
        timestamp: new Date().toISOString(),
        verified: results.verified,
        filesChecked: results.filesChecked,
        entriesChecked: results.entriesChecked,
        failureCount: results.failures.length
      });
      
      if (this.state.verificationResults.length > 10) {
        this.state.verificationResults = this.state.verificationResults.slice(-10);
      }
      
      return results;
    } catch (error) {
      this.emit('error', { message: 'Erreur de vérification', error });
      return { verified: false, error: error.message };
    }
  }

  async exportLogs(options = {}) {
    const {
      startDate,
      endDate,
      format = 'json',
      compress = true,
      eventTypes = null,
      outputPath = null
    } = options;
    
    try {
      const start = startDate ? new Date(startDate) : new Date(0);
      const end = endDate ? new Date(endDate) : new Date();
      
      const files = this._getLogFilesForPeriod(start, end);
      
      if (files.length === 0) {
        throw new Error('Aucun fichier de log trouvé pour la période demandée');
      }
      
      const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
      const defaultFileName = `audit_export_${timestamp}.${format}${compress ? '.gz' : ''}`;
      const outputFilePath = outputPath || path.join(this.config.logDirectory, 'exports', defaultFileName);
      
      const exportDir = path.dirname(outputFilePath);
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      const events = [];
      
      for (const file of files) {
        const filePath = path.join(this.config.logDirectory, file);
        
        let content;
        if (file.endsWith('.gz')) {
          content = await this._readCompressedFile(filePath);
        } else {
          content = fs.readFileSync(filePath, 'utf8');
        }
        
        const lines = content.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            let entry;
            
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            const eventDate = new Date(entry.timestamp);
            if (eventDate >= start && eventDate <= end) {
              if (!eventTypes || eventTypes.includes(entry.eventType)) {
                events.push(entry);
              }
            }
          } catch (err) {
            this.emit('error', { message: 'Erreur de lecture d\'entrée de log', error: err });
          }
        }
      }
      
      let outputContent;
      if (format === 'json') {
        outputContent = JSON.stringify(events, null, 2);
      } else if (format === 'csv') {
        outputContent = this._convertToCSV(events);
      } else {
        throw new Error(`Format non pris en charge: ${format}`);
      }
      
      if (compress) {
        const gzip = createGzip();
        const output = fs.createWriteStream(outputFilePath);
        
        const source = require('stream').Readable.from([outputContent]);
        await pipelineAsync(source, gzip, output);
      } else {
        fs.writeFileSync(outputFilePath, outputContent);
      }
      
      this.emit('exported', {
        path: outputFilePath,
        events: events.length,
        startDate: start,
        endDate: end
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('error', { message: 'Erreur d\'exportation', error });
      throw error;
    }
  }

  async applyRetentionPolicy() {
    if (!this.config.retentionPolicy.enabled) {
      return { success: true, message: 'Politique de rétention désactivée' };
    }
    
    try {
      const retentionDays = this.config.retentionPolicy.days;
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - retentionDays);
      
      const files = fs.readdirSync(this.config.logDirectory)
        .filter(file => file.endsWith('.json') || file.endsWith('.gz'))
        .sort();
      
      const result = {
        success: true,
        processed: 0,
        archived: 0,
        deleted: 0
      };
      
      for (const file of files) {
        if (path.join(this.config.logDirectory, file) === this.state.currentLogFile) {
          continue;
        }
        
        const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        
        const fileDate = new Date(dateMatch[1]);
        if (isNaN(fileDate.getTime())) continue;
        
        if (fileDate < retentionDate) {
          const filePath = path.join(this.config.logDirectory, file);
          
          if (this.config.retentionPolicy.archiveEnabled) {
            const archiveDir = path.join(this.config.logDirectory, 'archive');
            if (!fs.existsSync(archiveDir)) {
              fs.mkdirSync(archiveDir, { recursive: true });
            }
            
            const archivePath = path.join(archiveDir, file);
            
            if (!file.endsWith('.gz')) {
              const gzippedPath = path.join(archiveDir, `${file}.gz`);
              const readStream = fs.createReadStream(filePath);
              const writeStream = fs.createWriteStream(gzippedPath);
              
              await pipelineAsync(readStream, createGzip(), writeStream);
              fs.unlinkSync(filePath);
              
              result.archived++;
            } else {
              fs.renameSync(filePath, archivePath);
              result.archived++;
            }
          } else {
            fs.unlinkSync(filePath);
            result.deleted++;
          }
          
          result.processed++;
        }
      }
      
      this.emit('retention-applied', result);
      return result;
    } catch (error) {
      this.emit('error', { message: 'Erreur d\'application de la politique de rétention', error });
      return { success: false, error: error.message };
    }
  }

  async getEventById(eventId) {
    if (!eventId) throw new Error('ID d\'événement manquant');
    
    try {
      const files = fs.readdirSync(this.config.logDirectory)
        .filter(file => file.endsWith('.json') || file.endsWith('.gz'))
        .sort();
      
      for (const file of files) {
        const filePath = path.join(this.config.logDirectory, file);
        
        let content;
        if (file.endsWith('.gz')) {
          content = await this._readCompressedFile(filePath);
        } else {
          content = fs.readFileSync(filePath, 'utf8');
        }
        
        const lines = content.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            let entry;
            
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            if (entry.eventId === eventId) return entry;
          } catch (err) {
            continue;
          }
        }
      }
      
      return null;
    } catch (error) {
      this.emit('error', { message: 'Erreur de recherche d\'événement', error });
      throw error;
    }
  }

  async getRecentEvents(limit = 10, eventTypes = null) {
    try {
      if (!this.state.currentLogFile || !fs.existsSync(this.state.currentLogFile)) {
        return [];
      }
      
      const content = fs.readFileSync(this.state.currentLogFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      const events = [];
      
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        try {
          let entry;
          
          if (this.config.encryptionEnabled && this.config.encryptionKey) {
            const decrypted = this._decryptEntry(lines[i]);
            entry = JSON.parse(decrypted);
          } else {
            entry = JSON.parse(lines[i]);
          }
          
          if (!eventTypes || eventTypes.includes(entry.eventType)) {
            events.push(entry);
          }
        } catch (err) {
          continue;
        }
      }
      
      return events;
    } catch (error) {
      this.emit('error', { message: 'Erreur de récupération des événements récents', error });
      throw error;
    }
  }

  async getStats() {
    try {
      const files = fs.readdirSync(this.config.logDirectory)
        .filter(file => file.endsWith('.json') || file.endsWith('.gz'))
        .sort();
      
      const stats = {
        totalEvents: this.state.totalEvents,
        totalFiles: files.length,
        oldestEvent: null,
        newestEvent: null,
        eventsByType: {},
        eventsByDay: {},
        verificationHistory: this.state.verificationResults
      };
      
      if (files.length === 0) return stats;
      
      const sampledFiles = [
        files[0],
        ...(files.length > 2 ? [files[Math.floor(files.length / 2)]] : []),
        files[files.length - 1]
      ].filter(Boolean);
      
      for (const file of sampledFiles) {
        const filePath = path.join(this.config.logDirectory, file);
        
        let content;
        if (file.endsWith('.gz')) {
          content = await this._readCompressedFile(filePath);
        } else {
          content = fs.readFileSync(filePath, 'utf8');
        }
        
        const lines = content.split('\n').filter(line => line.trim());
        
        if (lines.length > 0) {
          try {
            let firstEntry, lastEntry;
            
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(lines[0]);
              firstEntry = JSON.parse(decrypted);
            } else {
              firstEntry = JSON.parse(lines[0]);
            }
            
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(lines[lines.length - 1]);
              lastEntry = JSON.parse(decrypted);
            } else {
              lastEntry = JSON.parse(lines[lines.length - 1]);
            }
            
            if (!stats.oldestEvent || new Date(firstEntry.timestamp) < new Date(stats.oldestEvent)) {
              stats.oldestEvent = firstEntry.timestamp;
            }
            
            if (!stats.newestEvent || new Date(lastEntry.timestamp) > new Date(stats.newestEvent)) {
              stats.newestEvent = lastEntry.timestamp;
            }
          } catch (err) {}
        }
      }
      
      const recentFile = path.join(this.config.logDirectory, files[files.length - 1]);
      let recentContent;
      
      if (recentFile.endsWith('.gz')) {
        recentContent = await this._readCompressedFile(recentFile);
      } else {
        recentContent = fs.readFileSync(recentFile, 'utf8');
      }
      
      const recentLines = recentContent.split('\n').filter(line => line.trim());
      const maxLinesToAnalyze = Math.min(1000, recentLines.length);
      
      for (let i = recentLines.length - 1; i >= Math.max(0, recentLines.length - maxLinesToAnalyze); i--) {
        try {
          let entry;
          
          if (this.config.encryptionEnabled && this.config.encryptionKey) {
            const decrypted = this._decryptEntry(recentLines[i]);
            entry = JSON.parse(decrypted);
          } else {
            entry = JSON.parse(recentLines[i]);
          }
          
          stats.eventsByType[entry.eventType] = (stats.eventsByType[entry.eventType] || 0) + 1;
          
          const day = entry.timestamp.split('T')[0];
          stats.eventsByDay[day] = (stats.eventsByDay[day] || 0) + 1;
        } catch (err) {}
      }
      
      return stats;
    } catch (error) {
      this.emit('error', { message: 'Erreur de calcul des statistiques', error });
      return { totalEvents: this.state.totalEvents, error: error.message };
    }
  }

  async search(criteria = {}) {
    const {
      startDate,
      endDate,
      eventTypes,
      query,
      limit = 100,
      offset = 0
    } = criteria;
    
    try {
      const start = startDate ? new Date(startDate) : new Date(0);
      const end = endDate ? new Date(endDate) : new Date();
      
      const files = this._getLogFilesForPeriod(start, end);
      
      if (files.length === 0) return { results: [], total: 0 };
      
      const results = [];
      let total = 0;
      
      for (const file of files) {
        const filePath = path.join(this.config.logDirectory, file);
        
        let content;
        if (file.endsWith('.gz')) {
          content = await this._readCompressedFile(filePath);
        } else {
          content = fs.readFileSync(filePath, 'utf8');
        }
        
        const lines = content.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            let entry;
            
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            const eventDate = new Date(entry.timestamp);
            if (eventDate >= start && eventDate <= end) {
              if (!eventTypes || eventTypes.includes(entry.eventType)) {
                if (!query || JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())) {
                  total++;
                  
                  if (total > offset && results.length < limit) {
                    results.push(entry);
                  }
                  
                  if (results.length >= limit) break;
                }
              }
            }
          } catch (err) {}
        }
        
        if (results.length >= limit) break;
      }
      
      return { results, total };
    } catch (error) {
      this.emit('error', { message: 'Erreur de recherche', error });
      throw error;
    }
  }

  async _findOrCreateCurrentLogFile() {
    const today = new Date().toISOString().split('T')[0];
    const fileName = `audit-${today}.json`;
    const filePath = path.join(this.config.logDirectory, fileName);
    
    if (fs.existsSync(filePath)) {
      let lastHash = null;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());
        
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          
          let lastEntry;
          if (this.config.encryptionEnabled && this.config.encryptionKey) {
            const decrypted = this._decryptEntry(lastLine);
            lastEntry = JSON.parse(decrypted);
          } else {
            lastEntry = JSON.parse(lastLine);
          }
          
          lastHash = lastEntry.hash;
        }
      } catch (error) {
        this.emit('error', { message: 'Erreur lors de la lecture du dernier hash', error });
      }
      
      this.state.previousHash = lastHash;
      this.state.currentLogFile = filePath;
    } else {
      this.state.currentLogFile = filePath;
      
      const initEntry = {
        eventId: this._generateEventId('INIT', new Date().toISOString()),
        timestamp: new Date().toISOString(),
        eventType: 'INIT',
        data: {
          version: '1.0.0',
          description: 'Initialisation du journal d\'audit',
          config: {
            rotationInterval: this.config.rotationInterval,
            hashAlgorithm: this.config.hashAlgorithm
          }
        },
        metadata: {
          timestamp: new Date().toISOString()
        },
        previousHash: null
      };
      
      const initHash = this._calculateHash(initEntry);
      initEntry.hash = initHash;
      
      if (this.config.signatureKey) {
        initEntry.signature = this._signEntry(initEntry);
      }
      
      let serializedEntry = JSON.stringify(initEntry);
      let finalEntry = serializedEntry;
      
      if (this.config.encryptionEnabled && this.config.encryptionKey) {
        finalEntry = this._encryptEntry(serializedEntry);
      }
      
      fs.writeFileSync(filePath, finalEntry + '\n');
      
      this.state.previousHash = initHash;
    }
  }

  _setupLogRotation() {
    if (this.state.rotationTimer) {
      clearInterval(this.state.rotationTimer);
    }
    
    this.state.rotationTimer = setInterval(() => {
      this._rotateLogFile();
    }, this.config.rotationInterval);
  }

  async _rotateLogFile() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const fileName = `audit-${today}.json`;
      const filePath = path.join(this.config.logDirectory, fileName);
      
      if (this.state.currentLogFile === filePath) return;
      
      if (this.config.compressionEnabled && 
          this.state.currentLogFile && 
          fs.existsSync(this.state.currentLogFile) &&
          !this.state.currentLogFile.endsWith('.gz')) {
        
        const gzippedPath = `${this.state.currentLogFile}.gz`;
        const readStream = fs.createReadStream(this.state.currentLogFile);
        const writeStream = fs.createWriteStream(gzippedPath);
        
        await pipelineAsync(readStream, createGzip(), writeStream);
        fs.unlinkSync(this.state.currentLogFile);
        
        this.emit('log-compressed', { 
          original: this.state.currentLogFile,
          compressed: gzippedPath
        });
      }
      
      this.state.currentLogFile = filePath;
      this.state.lastRotation = Date.now();
      
      if (!fs.existsSync(filePath)) {
        const initEntry = {
          eventId: this._generateEventId('ROTATION', new Date().toISOString()),
          timestamp: new Date().toISOString(),
          eventType: 'ROTATION',
          data: {
            previousFile: path.basename(this.state.currentLogFile)
          },
          metadata: {
            timestamp: new Date().toISOString()
          },
          previousHash: this.state.previousHash
        };
        
        const initHash = this._calculateHash(initEntry);
        initEntry.hash = initHash;
        
        if (this.config.signatureKey) {
          initEntry.signature = this._signEntry(initEntry);
        }
        
        let serializedEntry = JSON.stringify(initEntry);
        let finalEntry = serializedEntry;
        
        if (this.config.encryptionEnabled && this.config.encryptionKey) {
          finalEntry = this._encryptEntry(serializedEntry);
        }
        
        fs.writeFileSync(filePath, finalEntry + '\n');
        
        this.state.previousHash = initHash;
      }
      
      this.emit('log-rotated', { newFile: this.state.currentLogFile });
    } catch (error) {
      this.emit('error', { message: 'Erreur lors de la rotation des logs', error });
    }
  }

  async _appendToLog(entry) {
    if (!this.state.currentLogFile) {
      await this._findOrCreateCurrentLogFile();
    }
    
    return new Promise((resolve, reject) => {
      fs.appendFile(this.state.currentLogFile, entry + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  _calculateHash(entry) {
    const entryToHash = { ...entry };
    delete entryToHash.hash;
    delete entryToHash.signature;
    
    const normalized = JSON.stringify(entryToHash, Object.keys(entryToHash).sort());
    
    return crypto
      .createHash(this.config.hashAlgorithm)
      .update(normalized)
      .digest('hex');
  }

  _signEntry(entry) {
    const entryToSign = { ...entry };
    delete entryToSign.signature;
    
    const normalized = JSON.stringify(entryToSign, Object.keys(entryToSign).sort());
    
    return crypto
      .createHmac(this.config.hashAlgorithm, this.config.signatureKey)
      .update(normalized)
      .digest('base64');
  }

  _verifySignature(entry) {
    if (!entry.signature) return false;
    const originalSignature = entry.signature;
    const calculatedSignature = this._signEntry(entry);
    return originalSignature === calculatedSignature;
  }

  _encryptEntry(serializedEntry) {
    if (!this.config.encryptionKey) {
      throw new Error('Clé de chiffrement non configurée');
    }
    
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(this.config.encryptionKey).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(serializedEntry, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    return iv.toString('hex') + ':' + encrypted;
  }

  _decryptEntry(encryptedEntry) {
    if (!this.config.encryptionKey) {
      throw new Error('Clé de chiffrement non configurée');
    }
    
    if (!encryptedEntry.includes(':')) {
      return encryptedEntry;
    }
    
    const [ivHex, encrypted] = encryptedEntry.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(this.config.encryptionKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  _generateEventId(eventType, timestamp) {
    const datePart = timestamp.replace(/\D/g, '').substring(0, 14);
    const randomPart = crypto.randomBytes(4).toString('hex');
    return `${eventType}_${datePart}_${randomPart}`;
  }

  async _readCompressedFile(filePath) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const gunzip = require('zlib').createGunzip();
      const readStream = fs.createReadStream(filePath);
      
      readStream.pipe(gunzip);
      
      gunzip.on('data', (chunk) => chunks.push(chunk));
      gunzip.on('end', () => resolve(Buffer.concat(chunks).toString()));
      gunzip.on('error', (err) => reject(err));
      readStream.on('error', (err) => reject(err));
    });
  }

  _convertToCSV(objects) {
    if (!objects || objects.length === 0) return '';
    
    const allKeys = new Set();
    objects.forEach(obj => {
      Object.keys(obj).forEach(key => allKeys.add(key));
    });
    
    const keys = ['eventId', 'timestamp', 'eventType'];
    Array.from(allKeys)
      .filter(key => !keys.includes(key) && key !== 'data' && key !== 'metadata')
      .forEach(key => keys.push(key));
    
    keys.push('dataJson', 'metadataJson');
    
    let csv = keys.map(key => `"${key}"`).join(',') + '\n';
    
    objects.forEach(obj => {
      const values = keys.map(key => {
        if (key === 'dataJson' && obj.data) {
          return `"${JSON.stringify(obj.data).replace(/"/g, '""')}"`;
        } else if (key === 'metadataJson' && obj.metadata) {
          return `"${JSON.stringify(obj.metadata).replace(/"/g, '""')}"`;
        } else if (obj[key] === undefined) {
          return '""';
        } else if (typeof obj[key] === 'object') {
          return `"${JSON.stringify(obj[key]).replace(/"/g, '""')}"`;
        } else {
          return `"${String(obj[key]).replace(/"/g, '""')}"`;
        }
      });
      
      csv += values.join(',') + '\n';
    });
    
    return csv;
  }

  _getLogFilesForPeriod(startDate, endDate) {
    const allFiles = fs.readdirSync(this.config.logDirectory)
      .filter(file => file.match(/audit-\d{4}-\d{2}-\d{2}(\.json|\.json\.gz)$/))
      .sort();
    
    return allFiles.filter(file => {
      const match = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
      if (!match) return false;
      
      const fileDate = new Date(match[1]);
      const adjustedEndDate = new Date(endDate);
      adjustedEndDate.setHours(23, 59, 59, 999);
      
      return fileDate >= startDate && fileDate <= adjustedEndDate;
    });
  }

  _sanitizeConfig(config) {
    const sensitiveKeys = [
      'signatureKey', 'encryptionKey', 'password', 'secret', 'token', 
      'privateKey', 'apiKey', 'auth', 'credentials'
    ];
    
    const sanitized = {};
    
    const sanitizeRecursive = (obj, target) => {
      for (const [key, value] of Object.entries(obj)) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
          target[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          target[key] = Array.isArray(value) ? [] : {};
          sanitizeRecursive(value, target[key]);
        } else {
          target[key] = value;
        }
      }
    };
    
    sanitizeRecursive(config, sanitized);
    return sanitized;
  }

  async close() {
    if (this.state.rotationTimer) {
      clearInterval(this.state.rotationTimer);
      this.state.rotationTimer = null;
    }
    
    if (this.state.active) {
      try {
        await this.logEvent('SHUTDOWN', {
          reason: 'Service shutdown',
          timestamp: new Date().toISOString()
        });
      } catch (error) {}
    }
    
    this.state.active = false;
    this.emit('closed');
  }
}