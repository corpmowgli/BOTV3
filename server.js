// server.js - Serveur principal optimisé
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { fileURLToPath } from 'url';
import path from 'path';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

// Utilitaires et configuration
import { LRUCache } from './utils/cache.js';
import { authenticateJWT, authorizeRoles, login, logout, refreshToken, loginRateLimiter, 
         apiRateLimiter, csrfProtection, securityMiddleware } from './middleware/auth.js';
import { validate, validationRules, sanitizeAllInputs } from './middleware/validation.js';
import { TradingBot } from './bot/tradingBot.js';
import { securityConfig } from './config/securityConfig.js';
import { tradingConfig } from './config/tradingConfig.js';
import { apiConfig } from './config/apiConfig.js';
import LogService from './services/logService.js';

dotenv.config();

// Configuration
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache et logging
const apiCache = new LRUCache(100);
const healthCheckCache = new LRUCache(1);
const logService = new LogService({
  logging: { level: process.env.LOG_LEVEL || 'info', filePath: path.join(__dirname, 'logs') }
});

// Bot configuration
const botConfig = {
  ...tradingConfig,
  security: securityConfig,
  api: apiConfig,
  performance: {
    tokenConcurrency: 5,
    enableAutomaticRestarts: true,
    memoryThreshold: 1536,
    memoryCheckInterval: 300000
  }
};
const tradingBot = new TradingBot(botConfig);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  }
}));
app.use(cors({ origin: ENV === 'production' ? false : '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(securityMiddleware);
app.use(sanitizeAllInputs);

// Logging
morgan.token('body-size', req => req.body ? JSON.stringify(req.body).length : 0);
app.use(morgan(':method :url :status :response-time ms - :body-size bytes', {
  stream: { write: msg => logService.info(msg.trim(), {}, 'api') }
}));

// Rate limiters
app.use('/api/', apiRateLimiter);

// Middleware de cache
const cacheMiddleware = duration => (req, res, next) => {
  const key = req.originalUrl || req.url;
  const cachedResponse = apiCache.get(key);
  
  if (cachedResponse) {
    res.set('X-Cache', 'HIT');
    return res.json(cachedResponse);
  }
  
  const originalJson = res.json;
  res.json = function(body) {
    if (res.statusCode === 200) {
      apiCache.set(key, body);
      setTimeout(() => apiCache.delete(key), duration);
    }
    res.set('X-Cache', 'MISS');
    return originalJson.call(this, body);
  };
  
  next();
};

// Performance monitoring
app.use((req, res, next) => {
  const start = Date.now();
  const originalJson = res.json;
  
  res.json = function(body) {
    res.jsonBody = body;
    return originalJson.call(this, body);
  };
  
  res.on('finish', () => {
    const time = Date.now() - start;
    let responseBody = res.jsonBody;
    
    if (responseBody && JSON.stringify(responseBody).length > 1000) {
      responseBody = { 
        type: typeof responseBody, 
        size: JSON.stringify(responseBody).length,
        sample: '(truncated for logging)'
      };
    }
    
    logService.logApiRequest(req, res, time, responseBody);
  });
  
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: ENV === 'production' ? '1d' : 0
}));

// Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: ENV === 'production' ? false : '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Routes
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Auth routes
app.post('/api/login', loginRateLimiter, validationRules.login, validate, login);
app.post('/api/logout', authenticateJWT, logout);
app.post('/api/refresh-token', refreshToken);
app.get('/api/csrf-token', csrfProtection, (req, res) => res.json({ csrfToken: req.csrfToken() }));
app.get('/api/verify-auth', authenticateJWT, (req, res) => res.json({
  authenticated: true,
  user: { username: req.user.username, role: req.user.role }
}));

// Health endpoint
app.get('/api/health', cacheMiddleware(30000), (req, res) => {
  const cachedHealth = healthCheckCache.get('health');
  if (cachedHealth && Date.now() - cachedHealth.timestamp < 5000) {
    return res.json(cachedHealth.data);
  }
  
  const healthData = {
    status: tradingBot.isRunning ? 'running' : 'stopped',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: Date.now()
  };
  
  healthCheckCache.set('health', { data: healthData, timestamp: Date.now() });
  res.json(healthData);
});

// Status routes
app.get('/api/status', authenticateJWT, (req, res) => {
  const isRunning = tradingBot.isRunning;
  let metrics = null;
  
  if (isRunning) {
    const fullMetrics = tradingBot.getPerformanceReport();
    metrics = {
      portfolio: fullMetrics.portfolioMetrics,
      trades: {
        total: fullMetrics.metrics.totalTrades,
        winning: fullMetrics.metrics.winningTrades,
        losing: fullMetrics.metrics.losingTrades,
        winRate: fullMetrics.metrics.winRate
      },
      bot: {
        uptime: fullMetrics.botMetrics.uptime,
        cycles: fullMetrics.botMetrics.cyclesRun,
        lastCycle: fullMetrics.botMetrics.lastCycleTime
      }
    };
  }
  
  res.json({
    status: isRunning ? 'running' : 'stopped',
    isPaused: tradingBot.isPaused,
    uptime: isRunning ? tradingBot._calculateRuntime() : 0,
    metrics
  });
});

app.get('/api/status/detailed', authenticateJWT, authorizeRoles('admin'), (req, res) => {
  res.json({
    health: tradingBot.getHealthStatus(),
    performance: tradingBot.performanceMetrics,
    dataCacheStats: tradingBot.dataManager.getStats(),
    apiStats: tradingBot.marketData.getStats()
  });
});

// Bot control routes
app.post('/api/start', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  logService.logSecurityEvent('bot_start_attempt', { ip: req.ip, user: req.user.username });
  
  if (tradingBot.isRunning) {
    return res.status(400).json({ error: 'Le bot est déjà en cours d\'exécution' });
  }
  
  try {
    const success = await tradingBot.start();
    if (success) {
      apiCache.delete('/api/status');
      logService.logSecurityEvent('bot_start_success', { ip: req.ip, user: req.user.username });
      res.json({ success: true, message: 'Bot démarré avec succès' });
      io.emit('bot_status_change', { isRunning: true });
    } else {
      throw new Error('Échec du démarrage du bot');
    }
  } catch (error) {
    logService.error('Erreur lors du démarrage du bot', error);
    logService.logSecurityEvent('bot_start_failure', { ip: req.ip, error: error.message, user: req.user.username }, false);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  logService.logSecurityEvent('bot_stop_attempt', { ip: req.ip, user: req.user.username });
  
  if (!tradingBot.isRunning) {
    return res.status(400).json({ error: 'Le bot n\'est pas en cours d\'exécution' });
  }
  
  try {
    const report = await tradingBot.stop();
    apiCache.delete('/api/status');
    logService.logSecurityEvent('bot_stop_success', { ip: req.ip, user: req.user.username });
    res.json({ 
      success: true, 
      message: 'Bot arrêté avec succès',
      report: {
        profitLoss: report.metrics.totalProfit,
        winRate: report.metrics.winRate,
        trades: report.metrics.totalTrades
      }
    });
    io.emit('bot_status_change', { isRunning: false });
  } catch (error) {
    logService.error('Erreur lors de l\'arrêt du bot', error);
    logService.logSecurityEvent('bot_stop_failure', { ip: req.ip, error: error.message, user: req.user.username }, false);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pause', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  logService.logSecurityEvent('bot_pause_attempt', { ip: req.ip, user: req.user.username });
  
  if (!tradingBot.isRunning || tradingBot.isPaused) {
    return res.status(400).json({ error: 'Le bot n\'est pas en cours d\'exécution ou est déjà en pause' });
  }
  
  try {
    const success = await tradingBot.pause();
    if (success) {
      apiCache.delete('/api/status');
      logService.logSecurityEvent('bot_pause_success', { ip: req.ip, user: req.user.username });
      res.json({ success: true, message: 'Bot mis en pause avec succès' });
      io.emit('bot_status_change', { isPaused: true });
    } else {
      throw new Error('Échec de la mise en pause du bot');
    }
  } catch (error) {
    logService.error('Erreur lors de la mise en pause du bot', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/resume', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  logService.logSecurityEvent('bot_resume_attempt', { ip: req.ip, user: req.user.username });
  
  if (!tradingBot.isRunning || !tradingBot.isPaused) {
    return res.status(400).json({ error: 'Le bot n\'est pas en cours d\'exécution ou n\'est pas en pause' });
  }
  
  try {
    const success = await tradingBot.resume();
    if (success) {
      apiCache.delete('/api/status');
      logService.logSecurityEvent('bot_resume_success', { ip: req.ip, user: req.user.username });
      res.json({ success: true, message: 'Bot repris avec succès' });
      io.emit('bot_status_change', { isPaused: false });
    } else {
      throw new Error('Échec de la reprise du bot');
    }
  } catch (error) {
    logService.error('Erreur lors de la reprise du bot', error);
    res.status(500).json({ error: error.message });
  }
});

// Simulation and optimization routes
app.post('/api/simulation', authenticateJWT, csrfProtection, validationRules.simulation, validate, async (req, res) => {
  const { startDate, endDate, parameters } = req.body;
  
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Les dates de début et de fin sont requises' });
  }
  
  try {
    const simulationResults = await tradingBot.runSimulation(
      new Date(startDate), 
      new Date(endDate),
      parameters
    );
    res.json(simulationResults);
  } catch (error) {
    logService.error('Erreur lors de la simulation', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/optimize', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  const { startDate, endDate, parameters } = req.body;
  
  if (!startDate || !endDate || !parameters) {
    return res.status(400).json({ error: 'Les dates de début et de fin, ainsi que les paramètres sont requis' });
  }
  
  try {
    const optimizationResults = await tradingBot.optimizeStrategy(startDate, endDate, parameters);
    res.json(optimizationResults);
  } catch (error) {
    logService.error('Erreur lors de l\'optimisation de la stratégie', error);
    res.status(500).json({ error: error.message });
  }
});

// Data routes
app.get('/api/trades', authenticateJWT, validationRules.getTrades, validate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const trades = tradingBot.logger.getRecentTrades(limit, offset);
    
    res.json({
      trades,
      pagination: {
        total: tradingBot.logger.getTotalTradesCount(),
        limit,
        offset,
        hasMore: (offset + trades.length) < tradingBot.logger.getTotalTradesCount()
      }
    });
  } catch (error) {
    logService.error('Erreur lors de la récupération des trades', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/daily-performance', authenticateJWT, validationRules.getDailyPerformance, validate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const offset = parseInt(req.query.offset) || 0;
    const dailyPerformance = tradingBot.logger.getDailyPerformance().slice(offset, offset + limit);
    
    res.json({
      data: dailyPerformance,
      pagination: {
        total: tradingBot.logger.getDailyPerformance().length,
        limit,
        offset
      }
    });
  } catch (error) {
    logService.error('Erreur lors de la récupération des performances quotidiennes', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/portfolio', authenticateJWT, (req, res) => {
  try {
    const metrics = tradingBot.portfolioManager.getMetrics();
    res.json(metrics);
  } catch (error) {
    logService.error('Erreur lors de la récupération des données du portefeuille', error);
    res.status(500).json({ error: error.message });
  }
});

// Export logs
app.get('/api/logs', authenticateJWT, authorizeRoles('admin'), async (req, res) => {
  const { format = 'json', days = 7 } = req.query;
  
  try {
    const logs = tradingBot.exportTradingLogs(format);
    res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=trading-logs.${format}`);
    res.send(logs);
  } catch (error) {
    logService.error('Erreur lors de l\'exportation des logs', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export-logs', authenticateJWT, validationRules.exportLogs, validate, async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const compress = req.query.compress === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 1000;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    
    await logService.streamLogs(res, format, { startDate, endDate, page, limit, compress });
  } catch (error) {
    logService.error('Erreur lors de l\'exportation des logs', error);
    res.status(500).json({ error: 'Échec de l\'exportation des logs', details: error.message });
  }
});

// Config update
app.post('/api/config', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  const { config } = req.body;
  
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Un objet de configuration valide est requis' });
  }
  
  try {
    const result = tradingBot.updateConfig(config);
    apiCache.clear();
    
    if (result.success) {
      res.json({
        success: true,
        restartNeeded: result.restartNeeded,
        message: result.restartNeeded 
          ? 'Configuration mise à jour, redémarrage recommandé pour que tous les changements prennent effet'
          : 'Configuration mise à jour avec succès'
      });
    } else {
      throw new Error(result.error || 'Échec de la mise à jour de la configuration');
    }
  } catch (error) {
    logService.error('Erreur lors de la mise à jour de la configuration', error);
    res.status(500).json({ error: error.message });
  }
});

// Bot restart
app.post('/api/restart', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  logService.logSecurityEvent('bot_restart_attempt', { ip: req.ip, user: req.user.username });
  
  try {
    const success = await tradingBot.restart();
    apiCache.clear();
    
    if (success) {
      logService.logSecurityEvent('bot_restart_success', { ip: req.ip, user: req.user.username });
      res.json({ success: true, message: 'Bot redémarré avec succès' });
      io.emit('bot_status_change', { isRunning: true });
    } else {
      res.json({ success: false, message: 'Le bot n\'était pas en cours d\'exécution, aucun redémarrage nécessaire' });
    }
  } catch (error) {
    logService.error('Erreur lors du redémarrage du bot', error);
    logService.logSecurityEvent('bot_restart_failure', { ip: req.ip, error: error.message, user: req.user.username }, false);
    res.status(500).json({ error: error.message });
  }
});

// Cache clearing
app.post('/api/clear-cache', authenticateJWT, authorizeRoles('admin'), csrfProtection, async (req, res) => {
  try {
    tradingBot.dataManager.clearCaches();
    tradingBot.marketData.clearCaches();
    apiCache.clear();
    res.json({ success: true, message: 'Caches vidés avec succès' });
  } catch (error) {
    logService.error('Erreur lors du vidage des caches', error);
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Nouveau client connecté', socket.id);
  
  // Auth check
  const token = socket.handshake.auth.token;
  if (!token) {
    socket.emit('auth_error', { message: 'Authentification requise' });
    socket.disconnect();
    return;
  }
  
  try {
    jwt.verify(token, process.env.JWT_SECRET || securityConfig.jwt.secret);
    socket.emit('bot_status', { 
      isRunning: tradingBot.isRunning, 
      isPaused: tradingBot.isPaused 
    });
    
    socket.on('disconnect', () => console.log('Client déconnecté', socket.id));
    socket.on('request_update', () => broadcastUpdates(socket));
  } catch (error) {
    console.error('Erreur d\'authentification socket:', error);
    socket.emit('auth_error', { message: 'Authentification invalide' });
    socket.disconnect();
  }
});

// Regular client updates
const broadcastUpdates = async (socket = null) => {
  try {
    if (tradingBot.isRunning) {
      const report = tradingBot.getPerformanceReport();
      const recentTrades = tradingBot.logger.getRecentTrades(5);
      const updateData = { 
        report, 
        recentTrades, 
        timestamp: new Date().toISOString(),
        status: {
          isRunning: tradingBot.isRunning,
          isPaused: tradingBot.isPaused,
          memoryUsage: process.memoryUsage()
        }
      };
      
      if (socket) {
        socket.emit('bot_update', updateData);
      } else {
        io.emit('bot_update', updateData);
      }
    }
  } catch (error) {
    console.error('Erreur lors de la diffusion des mises à jour:', error);
  }
};

// Set update interval
setInterval(() => broadcastUpdates(), 10000);

// Schedule log cleanup
const scheduleLogCleanup = async () => {
  try {
    await logService.cleanupOldLogs(90);
    console.log('Nettoyage planifié des logs terminé');
  } catch (error) {
    console.error('Erreur lors du nettoyage planifié des logs:', error);
  }
};

// Schedule next cleanup at midnight
const scheduleNextCleanup = () => {
  const now = new Date();
  const night = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  
  setTimeout(() => {
    scheduleLogCleanup();
    scheduleNextCleanup();
  }, night.getTime() - now.getTime());
};

scheduleNextCleanup();

// Error handlers
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not Found', message: 'La ressource demandée n\'a pas été trouvée' });
});

app.use((err, req, res, next) => {
  logService.error('Erreur serveur', err);
  
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({
      error: 'Session invalide ou expirée',
      message: 'Veuillez rafraîchir la page et réessayer',
      code: 'CSRF_ERROR'
    });
  }
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Erreur de validation',
      message: err.message,
      details: err.errors
    });
  }
  
  res.status(500).json({
    error: 'Erreur serveur',
    message: ENV === 'production' ? 'Une erreur inattendue est survenue' : err.message,
    code: err.code || 'INTERNAL_ERROR'
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Environnement: ${ENV}`);
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Dashboard disponible à http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM reçu, arrêt en cours...');
  if (tradingBot.isRunning) await tradingBot.stop();
  server.close(() => {
    console.log('Arrêt du serveur complet');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT reçu, arrêt en cours...');
  if (tradingBot.isRunning) await tradingBot.stop();
  server.close(() => {
    console.log('Arrêt du serveur complet');
    process.exit(0);
  });
});

process.on('uncaughtException', async (error) => {
  logService.error('Exception non interceptée', error);
  try {
    if (tradingBot.isRunning) await tradingBot.stop();
    server.close(() => {
      logService.info('Serveur arrêté après une exception non interceptée');
      process.exit(1);
    });
  } catch (shutdownError) {
    logService.error('Erreur lors de l\'arrêt d\'urgence', shutdownError);
    process.exit(1);
  }
});

export default app;