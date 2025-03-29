// services/auditLogService.js - Journal d'audit cryptographique
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

/**
 * Service de journalisation d'audit cryptographique qui maintient
 * un enregistrement immuable et vérifiable de toutes les opérations
 * liées au trading.
 */
export class AuditLogService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // Configuration
    this.config = {
      enabled: config.enabled !== false,
      logDirectory: config.logDirectory || path.join(__dirname, '../logs/audit'),
      rotationInterval: config.rotationInterval || 86400000, // 24 heures par défaut
      compressionEnabled: config.compressionEnabled !== false,
      verificationEnabled: config.verificationEnabled !== false,
      hashAlgorithm: config.hashAlgorithm || 'sha256',
      signatureKey: config.signatureKey || process.env.AUDIT_SIGNATURE_KEY || crypto.randomBytes(32).toString('hex'),
      encryptionEnabled: config.encryptionEnabled || false,
      encryptionKey: config.encryptionKey || process.env.AUDIT_ENCRYPTION_KEY,
      metadataFields: config.metadataFields || ['username', 'ipAddress', 'timestamp'],
      retentionPolicy: {
        enabled: config.retentionPolicy?.enabled !== false,
        days: config.retentionPolicy?.days || 365, // 1 an par défaut
        archiveEnabled: config.retentionPolicy?.archiveEnabled !== false
      }
    };
    
    // État
    this.state = {
      currentLogFile: null,
      previousHash: null,
      rotationTimer: null,
      lastRotation: Date.now(),
      totalEvents: 0,
      verificationResults: [],
      active: false
    };
    
    // Initialiser le service
    this._initialize();
  }

  /**
   * Initialise le service de journalisation d'audit
   */
  async _initialize() {
    try {
      // Créer le répertoire de logs s'il n'existe pas
      if (!fs.existsSync(this.config.logDirectory)) {
        fs.mkdirSync(this.config.logDirectory, { recursive: true });
      }
      
      // Charger/vérifier le dernier fichier de log existant
      await this._findOrCreateCurrentLogFile();
      
      // Configurer la rotation des logs
      this._setupLogRotation();
      
      this.state.active = true;
      this.emit('initialized', { logFile: this.state.currentLogFile });
      
      // Vérification à l'initialisation si activée
      if (this.config.verificationEnabled) {
        this.verifyChain()
          .then(result => this.emit('verification', result))
          .catch(err => this.emit('error', { message: 'Erreur de vérification', error: err }));
      }
    } catch (error) {
      this.emit('error', { message: 'Erreur d\'initialisation', error });
    }
  }

  /**
   * Enregistre un événement d'audit
   * @param {string} eventType - Type d'événement (TRADE, CONFIG_CHANGE, etc.)
   * @param {Object} data - Données de l'événement
   * @param {Object} metadata - Métadonnées (utilisateur, adresse IP, etc.)
   * @returns {Promise<Object>} - Détails de l'entrée de journal
   */
  async logEvent(eventType, data, metadata = {}) {
    if (!this.config.enabled || !this.state.active) {
      return null;
    }
    
    try {
      // Valider les données d'entrée
      if (!eventType || typeof eventType !== 'string') {
        throw new Error('Type d\'événement invalide ou manquant');
      }
      
      if (!data || typeof data !== 'object') {
        throw new Error('Données d\'événement invalides ou manquantes');
      }
      
      // Créer l'entrée de journal avec métadonnées
      const timestamp = new Date().toISOString();
      const eventId = this._generateEventId(eventType, timestamp);
      
      // Filtrer les métadonnées pour ne conserver que les champs autorisés
      const filteredMetadata = {};
      for (const field of this.config.metadataFields) {
        if (metadata[field] !== undefined) {
          filteredMetadata[field] = metadata[field];
        }
      }
      
      // Ajouter un timestamp aux métadonnées si non fourni
      if (!filteredMetadata.timestamp) {
        filteredMetadata.timestamp = timestamp;
      }
      
      // Créer l'entrée complète
      const entry = {
        eventId,
        timestamp,
        eventType,
        data,
        metadata: filteredMetadata,
        previousHash: this.state.previousHash
      };
      
      // Calculer le hash cryptographique de cette entrée
      const entryHash = this._calculateHash(entry);
      entry.hash = entryHash;
      
      // Créer une signature numérique si une clé est configurée
      if (this.config.signatureKey) {
        entry.signature = this._signEntry(entry);
      }
      
      // Sérialiser et chiffrer si nécessaire
      let serializedEntry = JSON.stringify(entry);
      let finalEntry = serializedEntry;
      
      if (this.config.encryptionEnabled && this.config.encryptionKey) {
        finalEntry = this._encryptEntry(serializedEntry);
      }
      
      // Écrire dans le fichier journal
      await this._appendToLog(finalEntry);
      
      // Mettre à jour l'état
      this.state.previousHash = entryHash;
      this.state.totalEvents++;
      
      // Émettre l'événement
      this.emit('logged', {
        eventId,
        eventType,
        timestamp,
        hash: entryHash
      });
      
      return {
        eventId,
        eventType,
        timestamp,
        hash: entryHash
      };
    } catch (error) {
      this.emit('error', { message: 'Erreur de journalisation', error });
      throw error;
    }
  }

  /**
   * Enregistre un événement de trade
   * @param {Object} trade - Données de la transaction
   * @param {Object} metadata - Métadonnées
   * @returns {Promise<Object>} - Détails de l'entrée de journal
   */
  async logTrade(trade, metadata = {}) {
    if (!trade) {
      throw new Error('Données de trade manquantes');
    }
    
    return this.logEvent('TRADE', trade, metadata);
  }

  /**
   * Enregistre un changement de configuration
   * @param {Object} oldConfig - Ancienne configuration
   * @param {Object} newConfig - Nouvelle configuration 
   * @param {Object} metadata - Métadonnées
   * @returns {Promise<Object>} - Détails de l'entrée de journal
   */
  async logConfigChange(oldConfig, newConfig, metadata = {}) {
    if (!oldConfig || !newConfig) {
      throw new Error('Données de configuration manquantes');
    }
    
    // Ne pas stocker de clés sensibles
    const sanitizedOldConfig = this._sanitizeConfig(oldConfig);
    const sanitizedNewConfig = this._sanitizeConfig(newConfig);
    
    return this.logEvent('CONFIG_CHANGE', {
      oldConfig: sanitizedOldConfig,
      newConfig: sanitizedNewConfig
    }, metadata);
  }

  /**
   * Enregistre un événement de sécurité
   * @param {string} action - Action de sécurité
   * @param {Object} details - Détails de l'événement
   * @param {Object} metadata - Métadonnées
   * @returns {Promise<Object>} - Détails de l'entrée de journal
   */
  async logSecurityEvent(action, details, metadata = {}) {
    if (!action) {
      throw new Error('Action de sécurité manquante');
    }
    
    return this.logEvent('SECURITY', {
      action,
      details
    }, metadata);
  }

  /**
   * Enregistre un changement d'état du bot
   * @param {string} newState - Nouvel état (STARTED, STOPPED, etc.)
   * @param {Object} details - Détails supplémentaires
   * @param {Object} metadata - Métadonnées
   * @returns {Promise<Object>} - Détails de l'entrée de journal
   */
  async logBotStateChange(newState, details = {}, metadata = {}) {
    if (!newState) {
      throw new Error('État du bot manquant');
    }
    
    return this.logEvent('BOT_STATE', {
      state: newState,
      details
    }, metadata);
  }

  /**
   * Vérifie l'intégrité de la chaîne de logs d'audit
   * @param {string} [fileName] - Fichier spécifique à vérifier (sinon tous)
   * @returns {Promise<Object>} - Résultats de la vérification
   */
  async verifyChain(fileName = null) {
    if (!this.config.verificationEnabled) {
      return { verified: false, reason: 'Vérification désactivée' };
    }
    
    try {
      let files = [];
      
      if (fileName) {
        // Vérifier un fichier spécifique
        const filePath = path.join(this.config.logDirectory, fileName);
        if (fs.existsSync(filePath)) {
          files.push(fileName);
        } else {
          throw new Error(`Fichier non trouvé: ${fileName}`);
        }
      } else {
        // Récupérer tous les fichiers de log dans l'ordre chronologique
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
      
      // Vérifier chaque fichier
      for (const file of files) {
        const filePath = path.join(this.config.logDirectory, file);
        
        // Lire le contenu et décompresser si nécessaire
        let content;
        if (file.endsWith('.gz')) {
          content = await this._readCompressedFile(filePath);
        } else {
          content = fs.readFileSync(filePath, 'utf8');
        }
        
        // Diviser en lignes et vérifier chaque entrée
        const lines = content.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          let entry;
          
          try {
            // Déchiffrer si nécessaire
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            // Vérifier la signature
            if (entry.signature && !this._verifySignature(entry)) {
              results.failures.push({
                file,
                eventId: entry.eventId,
                reason: 'Signature invalide'
              });
              results.verified = false;
              continue;
            }
            
            // Vérifier le hash
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
            
            // Vérifier la chaîne (sauf pour la première entrée)
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
      
      // Sauvegarder les résultats de vérification
      this.state.verificationResults.push({
        timestamp: new Date().toISOString(),
        verified: results.verified,
        filesChecked: results.filesChecked,
        entriesChecked: results.entriesChecked,
        failureCount: results.failures.length
      });
      
      // Limiter l'historique des vérifications
      if (this.state.verificationResults.length > 10) {
        this.state.verificationResults = this.state.verificationResults.slice(-10);
      }
      
      return results;
    } catch (error) {
      this.emit('error', { message: 'Erreur de vérification', error });
      return {
        verified: false,
        error: error.message
      };
    }
  }

  /**
   * Exporte les logs d'audit pour une période donnée
   * @param {Object} options - Options d'exportation
   * @returns {Promise<string>} - Chemin vers le fichier exporté
   */
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
      // Déterminer la période à exporter
      const start = startDate ? new Date(startDate) : new Date(0);
      const end = endDate ? new Date(endDate) : new Date();
      
      // Récupérer les fichiers de log concernés
      const files = this._getLogFilesForPeriod(start, end);
      
      if (files.length === 0) {
        throw new Error('Aucun fichier de log trouvé pour la période demandée');
      }
      
      // Préparer le fichier de sortie
      const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
      const defaultFileName = `audit_export_${timestamp}.${format}${compress ? '.gz' : ''}`;
      const outputFilePath = outputPath || path.join(this.config.logDirectory, 'exports', defaultFileName);
      
      // Créer le répertoire d'exportation si nécessaire
      const exportDir = path.dirname(outputFilePath);
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      // Temporaire: collecter tous les événements, filtrer, puis écrire
      const events = [];
      
      // Lire chaque fichier
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
            
            // Déchiffrer si nécessaire
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            // Filtrer par date
            const eventDate = new Date(entry.timestamp);
            if (eventDate >= start && eventDate <= end) {
              // Filtrer par type d'événement si spécifié
              if (!eventTypes || eventTypes.includes(entry.eventType)) {
                events.push(entry);
              }
            }
          } catch (err) {
            this.emit('error', { message: 'Erreur de lecture d\'entrée de log', error: err });
          }
        }
      }
      
      // Formater selon le format demandé
      let outputContent;
      if (format === 'json') {
        outputContent = JSON.stringify(events, null, 2);
      } else if (format === 'csv') {
        outputContent = this._convertToCSV(events);
      } else {
        throw new Error(`Format non pris en charge: ${format}`);
      }
      
      // Écrire le fichier de sortie (avec compression si demandée)
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

  /**
   * Applique la politique de rétention des logs
   * @returns {Promise<Object>} - Résultat du nettoyage
   */
  async applyRetentionPolicy() {
    if (!this.config.retentionPolicy.enabled) {
      return { success: true, message: 'Politique de rétention désactivée' };
    }
    
    try {
      const retentionDays = this.config.retentionPolicy.days;
      const retentionDate = new Date();
      retentionDate.setDate(retentionDate.getDate() - retentionDays);
      
      // Lister tous les fichiers de logs
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
        // Ignorer le fichier courant
        if (path.join(this.config.logDirectory, file) === this.state.currentLogFile) {
          continue;
        }
        
        // Extraire la date du nom de fichier (format: audit-YYYY-MM-DD.json)
        const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        
        const fileDate = new Date(dateMatch[1]);
        if (isNaN(fileDate.getTime())) continue;
        
        // Si le fichier est plus ancien que la période de rétention
        if (fileDate < retentionDate) {
          const filePath = path.join(this.config.logDirectory, file);
          
          if (this.config.retentionPolicy.archiveEnabled) {
            // Archiver le fichier
            const archiveDir = path.join(this.config.logDirectory, 'archive');
            if (!fs.existsSync(archiveDir)) {
              fs.mkdirSync(archiveDir, { recursive: true });
            }
            
            const archivePath = path.join(archiveDir, file);
            
            // Compresser si pas déjà fait
            if (!file.endsWith('.gz')) {
              const gzippedPath = path.join(archiveDir, `${file}.gz`);
              const readStream = fs.createReadStream(filePath);
              const writeStream = fs.createWriteStream(gzippedPath);
              
              await pipelineAsync(readStream, createGzip(), writeStream);
              fs.unlinkSync(filePath);
              
              result.archived++;
            } else {
              // Déplacer simplement le fichier déjà compressé
              fs.renameSync(filePath, archivePath);
              result.archived++;
            }
          } else {
            // Supprimer le fichier
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
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Récupère une entrée de journal spécifique par son ID
   * @param {string} eventId - ID de l'événement
   * @returns {Promise<Object>} - Entrée de journal
   */
  async getEventById(eventId) {
    if (!eventId) {
      throw new Error('ID d\'événement manquant');
    }
    
    try {
      // Récupérer tous les fichiers de log
      const files = fs.readdirSync(this.config.logDirectory)
        .filter(file => file.endsWith('.json') || file.endsWith('.gz'))
        .sort();
      
      // Chercher dans chaque fichier
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
            
            // Déchiffrer si nécessaire
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            if (entry.eventId === eventId) {
              return entry;
            }
          } catch (err) {
            // Ignorer les entrées mal formatées
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

  /**
   * Récupère les dernières entrées du journal d'audit
   * @param {number} limit - Nombre d'entrées à récupérer
   * @param {string[]} eventTypes - Types d'événements à inclure
   * @returns {Promise<Array>} - Entrées de journal
   */
  async getRecentEvents(limit = 10, eventTypes = null) {
    try {
      // Lire le fichier courant
      if (!this.state.currentLogFile || !fs.existsSync(this.state.currentLogFile)) {
        return [];
      }
      
      const content = fs.readFileSync(this.state.currentLogFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      // Collecter les événements en commençant par les plus récents
      const events = [];
      
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        try {
          let entry;
          
          // Déchiffrer si nécessaire
          if (this.config.encryptionEnabled && this.config.encryptionKey) {
            const decrypted = this._decryptEntry(lines[i]);
            entry = JSON.parse(decrypted);
          } else {
            entry = JSON.parse(lines[i]);
          }
          
          // Filtrer par type d'événement si spécifié
          if (!eventTypes || eventTypes.includes(entry.eventType)) {
            events.push(entry);
          }
        } catch (err) {
          // Ignorer les entrées mal formatées
          continue;
        }
      }
      
      return events;
    } catch (error) {
      this.emit('error', { message: 'Erreur de récupération des événements récents', error });
      throw error;
    }
  }

  /**
   * Calcule des statistiques sur les logs d'audit
   * @returns {Promise<Object>} - Statistiques
   */
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
      
      // Si aucun fichier, retourner les stats de base
      if (files.length === 0) {
        return stats;
      }
      
      // Echantillonner pour éviter de tout lire
      const samplesToRead = Math.min(5, files.length);
      const sampledFiles = [
        files[0], // Le plus ancien
        ...(files.length > 2 ? [files[Math.floor(files.length / 2)]] : []), // Le milieu
        files[files.length - 1] // Le plus récent
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
        
        // Lire première et dernière entrée pour déterminer la plage
        if (lines.length > 0) {
          try {
            let firstEntry, lastEntry;
            
            // Première entrée
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(lines[0]);
              firstEntry = JSON.parse(decrypted);
            } else {
              firstEntry = JSON.parse(lines[0]);
            }
            
            // Dernière entrée
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(lines[lines.length - 1]);
              lastEntry = JSON.parse(decrypted);
            } else {
              lastEntry = JSON.parse(lines[lines.length - 1]);
            }
            
            // Mettre à jour les dates min/max
            if (!stats.oldestEvent || new Date(firstEntry.timestamp) < new Date(stats.oldestEvent)) {
              stats.oldestEvent = firstEntry.timestamp;
            }
            
            if (!stats.newestEvent || new Date(lastEntry.timestamp) > new Date(stats.newestEvent)) {
              stats.newestEvent = lastEntry.timestamp;
            }
          } catch (err) {
            // Ignorer les erreurs de parsing
          }
        }
      }
      
      // Lecture du fichier le plus récent pour les stats par type
      const recentFile = path.join(this.config.logDirectory, files[files.length - 1]);
      let recentContent;
      
      if (recentFile.endsWith('.gz')) {
        recentContent = await this._readCompressedFile(recentFile);
      } else {
        recentContent = fs.readFileSync(recentFile, 'utf8');
      }
      
      const recentLines = recentContent.split('\n').filter(line => line.trim());
      
      // Analyser jusqu'à 1000 entrées récentes pour stats par type
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
          
          // Compter par type
          stats.eventsByType[entry.eventType] = (stats.eventsByType[entry.eventType] || 0) + 1;
          
          // Compter par jour
          const day = entry.timestamp.split('T')[0];
          stats.eventsByDay[day] = (stats.eventsByDay[day] || 0) + 1;
        } catch (err) {
          // Ignorer les erreurs de parsing
        }
      }
      
      return stats;
    } catch (error) {
      this.emit('error', { message: 'Erreur de calcul des statistiques', error });
      return {
        totalEvents: this.state.totalEvents,
        error: error.message
      };
    }
  }

  /**
   * Recherche dans les logs d'audit
   * @param {Object} criteria - Critères de recherche
   * @returns {Promise<Array>} - Résultats de recherche
   */
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
      // Déterminer la période à rechercher
      const start = startDate ? new Date(startDate) : new Date(0);
      const end = endDate ? new Date(endDate) : new Date();
      
      // Récupérer les fichiers de log concernés
      const files = this._getLogFilesForPeriod(start, end);
      
      if (files.length === 0) {
        return { results: [], total: 0 };
      }
      
      // Collecter les résultats
      const results = [];
      let total = 0;
      
      // Lire chaque fichier
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
            
            // Déchiffrer si nécessaire
            if (this.config.encryptionEnabled && this.config.encryptionKey) {
              const decrypted = this._decryptEntry(line);
              entry = JSON.parse(decrypted);
            } else {
              entry = JSON.parse(line);
            }
            
            // Filtrer par date
            const eventDate = new Date(entry.timestamp);
            if (eventDate >= start && eventDate <= end) {
              // Filtrer par type d'événement si spécifié
              if (!eventTypes || eventTypes.includes(entry.eventType)) {
                // Filtrer par texte de recherche si spécifié
                if (!query || JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())) {
                  total++;
                  
                  // Appliquer offset et limit
                  if (total > offset && results.length < limit) {
                    results.push(entry);
                  }
                  
                  // Optimisation: ne pas traiter plus que nécessaire
                  if (results.length >= limit) {
                    break;
                  }
                }
              }
            }
          } catch (err) {
            // Ignorer les entrées mal formatées
          }
        }
        
        // Arrêter si on a assez de résultats
        if (results.length >= limit) {
          break;
        }
      }
      
      return { results, total };
    } catch (error) {
      this.emit('error', { message: 'Erreur de recherche', error });
      throw error;
    }
  }

  /**
   * Trouve ou crée le fichier de log actuel
   */
  async _findOrCreateCurrentLogFile() {
    const today = new Date().toISOString().split('T')[0];
    const fileName = `audit-${today}.json`;
    const filePath = path.join(this.config.logDirectory, fileName);
    
    // Vérifier si le fichier existe déjà
    if (fs.existsSync(filePath)) {
      // Lire le dernier hash
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
      // Créer un nouveau fichier
      this.state.currentLogFile = filePath;
      
      // Écrire l'entrée d'initialisation
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
      
      // Calculer le hash
      const initHash = this._calculateHash(initEntry);
      initEntry.hash = initHash;
      
      // Signer si une clé est configurée
      if (this.config.signatureKey) {
        initEntry.signature = this._signEntry(initEntry);
      }
      
      // Sérialiser et chiffrer si nécessaire
      let serializedEntry = JSON.stringify(initEntry);
      let finalEntry = serializedEntry;
      
      if (this.config.encryptionEnabled && this.config.encryptionKey) {
        finalEntry = this._encryptEntry(serializedEntry);
      }
      
      // Créer le fichier
      fs.writeFileSync(filePath, finalEntry + '\n');
      
      this.state.previousHash = initHash;
    }
  }

  /**
   * Configure la rotation des fichiers de log
   */
  _setupLogRotation() {
    if (this.state.rotationTimer) {
      clearInterval(this.state.rotationTimer);
    }
    
    // Rotation quotidienne par défaut
    this.state.rotationTimer = setInterval(() => {
      this._rotateLogFile();
    }, this.config.rotationInterval);
  }

  /**
   * Effectue la rotation du fichier de log
   */
  async _rotateLogFile() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const fileName = `audit-${today}.json`;
      const filePath = path.join(this.config.logDirectory, fileName);
      
      // Si le fichier actuel correspond déjà à la date du jour, rien à faire
      if (this.state.currentLogFile === filePath) {
        return;
      }
      
      // Compresser l'ancien fichier si nécessaire
      if (this.config.compressionEnabled && 
          this.state.currentLogFile && 
          fs.existsSync(this.state.currentLogFile) &&
          !this.state.currentLogFile.endsWith('.gz')) {
        
        const gzippedPath = `${this.state.currentLogFile}.gz`;
        const readStream = fs.createReadStream(this.state.currentLogFile);
        const writeStream = fs.createWriteStream(gzippedPath);
        
        await pipelineAsync(readStream, createGzip(), writeStream);
        
        // Supprimer l'original après compression
        fs.unlinkSync(this.state.currentLogFile);
        
        this.emit('log-compressed', { 
          original: this.state.currentLogFile,
          compressed: gzippedPath
        });
      }
      
      // Mettre à jour le fichier actuel
      this.state.currentLogFile = filePath;
      this.state.lastRotation = Date.now();
      
      // Vérifier si le nouveau fichier existe déjà
      if (!fs.existsSync(filePath)) {
        // Écrire l'entrée d'initialisation
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
        
        // Calculer le hash
        const initHash = this._calculateHash(initEntry);
        initEntry.hash = initHash;
        
        // Signer si une clé est configurée
        if (this.config.signatureKey) {
          initEntry.signature = this._signEntry(initEntry);
        }
        
        // Sérialiser et chiffrer si nécessaire
        let serializedEntry = JSON.stringify(initEntry);
        let finalEntry = serializedEntry;
        
        if (this.config.encryptionEnabled && this.config.encryptionKey) {
          finalEntry = this._encryptEntry(serializedEntry);
        }
        
        // Créer le fichier
        fs.writeFileSync(filePath, finalEntry + '\n');
        
        this.state.previousHash = initHash;
      }
      
      this.emit('log-rotated', { 
        newFile: this.state.currentLogFile
      });
    } catch (error) {
      this.emit('error', { message: 'Erreur lors de la rotation des logs', error });
    }
  }

  /**
   * Ajoute une entrée au fichier de log
   * @param {string} entry - Entrée sérialisée et préparée
   */
  async _appendToLog(entry) {
    if (!this.state.currentLogFile) {
      await this._findOrCreateCurrentLogFile();
    }
    
    return new Promise((resolve, reject) => {
      fs.appendFile(this.state.currentLogFile, entry + '\n', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Calcule un hash cryptographique pour une entrée
   * @param {Object} entry - Entrée de journal
   * @returns {string} - Hash hexadécimal
   */
  _calculateHash(entry) {
    // Cloner pour éviter de modifier l'original
    const entryToHash = { ...entry };
    
    // Ne pas inclure le hash ni la signature dans le calcul
    delete entryToHash.hash;
    delete entryToHash.signature;
    
    // Normaliser l'ordre des clés pour un hash consistant
    const normalized = JSON.stringify(entryToHash, Object.keys(entryToHash).sort());
    
    // Calculer le hash avec l'algorithme configuré
    return crypto
      .createHash(this.config.hashAlgorithm)
      .update(normalized)
      .digest('hex');
  }

  /**
   * Génère une signature numérique pour une entrée
   * @param {Object} entry - Entrée de journal
   * @returns {string} - Signature en base64
   */
  _signEntry(entry) {
    // Cloner pour éviter de modifier l'original
    const entryToSign = { ...entry };
    
    // Ne pas inclure la signature dans le calcul
    delete entryToSign.signature;
    
    // Normaliser l'ordre des clés
    const normalized = JSON.stringify(entryToSign, Object.keys(entryToSign).sort());
    
    // Calculer la signature HMAC avec la clé de signature
    return crypto
      .createHmac(this.config.hashAlgorithm, this.config.signatureKey)
      .update(normalized)
      .digest('base64');
  }

  /**
   * Vérifie la signature d'une entrée
   * @param {Object} entry - Entrée de journal
   * @returns {boolean} - Vrai si la signature est valide
   */
  _verifySignature(entry) {
    if (!entry.signature) return false;
    
    // Extraire la signature originale
    const originalSignature = entry.signature;
    
    // Recalculer la signature
    const calculatedSignature = this._signEntry(entry);
    
    // Comparer les signatures
    return originalSignature === calculatedSignature;
  }

  /**
   * Chiffre une entrée de journal
   * @param {string} serializedEntry - Entrée sérialisée
   * @returns {string} - Entrée chiffrée en base64
   */
  _encryptEntry(serializedEntry) {
    if (!this.config.encryptionKey) {
      throw new Error('Clé de chiffrement non configurée');
    }
    
    // Générer un IV aléatoire
    const iv = crypto.randomBytes(16);
    
    // Dériver une clé de 32 octets à partir de la clé configurée
    const key = crypto
      .createHash('sha256')
      .update(this.config.encryptionKey)
      .digest();
    
    // Chiffrer l'entrée
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(serializedEntry, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    
    // Combiner IV et données chiffrées
    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Déchiffre une entrée de journal
   * @param {string} encryptedEntry - Entrée chiffrée en base64
   * @returns {string} - Entrée déchiffrée
   */
  _decryptEntry(encryptedEntry) {
    if (!this.config.encryptionKey) {
      throw new Error('Clé de chiffrement non configurée');
    }
    
    // Vérifier si l'entrée est chiffrée
    if (!encryptedEntry.includes(':')) {
      return encryptedEntry; // Probablement pas chiffrée
    }
    
    // Extraire IV et données chiffrées
    const [ivHex, encrypted] = encryptedEntry.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    
    // Dériver la clé
    const key = crypto
      .createHash('sha256')
      .update(this.config.encryptionKey)
      .digest();
    
    // Déchiffrer
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * Génère un ID unique pour un événement
   * @param {string} eventType - Type d'événement
   * @param {string} timestamp - Horodatage ISO
   * @returns {string} - ID d'événement
   */
  _generateEventId(eventType, timestamp) {
    const datePart = timestamp.replace(/\D/g, '').substring(0, 14);
    const randomPart = crypto.randomBytes(4).toString('hex');
    return `${eventType}_${datePart}_${randomPart}`;
  }

  /**
   * Lit un fichier compressé
   * @param {string} filePath - Chemin du fichier
   * @returns {Promise<string>} - Contenu décompressé
   */
  async _readCompressedFile(filePath) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const gunzip = require('zlib').createGunzip();
      const readStream = fs.createReadStream(filePath);
      
      readStream.pipe(gunzip);
      
      gunzip.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      gunzip.on('end', () => {
        resolve(Buffer.concat(chunks).toString());
      });
      
      gunzip.on('error', (err) => {
        reject(err);
      });
      
      readStream.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Convertit des objets en CSV
   * @param {Array} objects - Objets à convertir
   * @returns {string} - Contenu CSV
   */
  _convertToCSV(objects) {
    if (!objects || objects.length === 0) return '';
    
    // Extraire toutes les clés uniques de tous les objets
    const allKeys = new Set();
    objects.forEach(obj => {
      Object.keys(obj).forEach(key => allKeys.add(key));
    });
    
    const keys = ['eventId', 'timestamp', 'eventType']; // Clés prioritaires
    Array.from(allKeys)
      .filter(key => !keys.includes(key) && key !== 'data' && key !== 'metadata')
      .forEach(key => keys.push(key));
    
    // Ajouter des colonnes pour les données et métadonnées courantes
    keys.push('dataJson', 'metadataJson');
    
    // Générer l'en-tête CSV
    let csv = keys.map(key => `"${key}"`).join(',') + '\n';
    
    // Générer les lignes de données
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

  /**
   * Récupère les fichiers de log pour une période
   * @param {Date} startDate - Date de début
   * @param {Date} endDate - Date de fin
   * @returns {Array<string>} - Noms de fichiers
   */
  _getLogFilesForPeriod(startDate, endDate) {
    // Récupérer tous les fichiers de log
    const allFiles = fs.readdirSync(this.config.logDirectory)
      .filter(file => file.match(/audit-\d{4}-\d{2}-\d{2}(\.json|\.json\.gz)$/))
      .sort();
    
    // Filtrer par date
    return allFiles.filter(file => {
      const match = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
      if (!match) return false;
      
      const fileDate = new Date(match[1]);
      // Ajuster à la fin de la journée pour endDate
      const adjustedEndDate = new Date(endDate);
      adjustedEndDate.setHours(23, 59, 59, 999);
      
      return fileDate >= startDate && fileDate <= adjustedEndDate;
    });
  }

  /**
   * Nettoie les données de configuration pour retirer les informations sensibles
   * @param {Object} config - Configuration
   * @returns {Object} - Configuration nettoyée
   */
  _sanitizeConfig(config) {
    const sensitiveKeys = [
      'signatureKey', 'encryptionKey', 'password', 'secret', 'token', 
      'privateKey', 'apiKey', 'auth', 'credentials'
    ];
    
    const sanitized = {};
    
    // Parcourir récursivement et masquer les données sensibles
    const sanitizeRecursive = (obj, target) => {
      for (const [key, value] of Object.entries(obj)) {
        // Vérifier si la clé contient un mot sensible
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
          target[key] = '[REDACTED]';
        } else if (typeof value === 'object' && value !== null) {
          // Récursion pour les objets imbriqués
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

  /**
   * Ferme proprement le service
   */
  async close() {
    // Arrêter le timer de rotation
    if (this.state.rotationTimer) {
      clearInterval(this.state.rotationTimer);
      this.state.rotationTimer = null;
    }
    
    // Écrire une entrée de fermeture
    if (this.state.active) {
      try {
        await this.logEvent('SHUTDOWN', {
          reason: 'Service shutdown',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        // Ignorer les erreurs lors de la fermeture
      }
    }
    
    this.state.active = false;
    this.emit('closed');
  }
}