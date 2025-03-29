// config/securityConfig.js

/**
 * Configuration de sécurité pour le trading bot
 * Paramètres pour l'authentification, le chiffrement, la protection API, etc.
 */
export const securityConfig = {
    // Paramètres JWT pour l'authentification
    jwt: {
      secret: process.env.JWT_SECRET || 'votre_secret_jwt_tres_securise_a_changer_en_production',
      expiresIn: '24h',
      refreshExpiresIn: '7d',
      issuer: 'trading-bot-dashboard',
      audience: 'client'
    },
    
    // Paramètres de hachage pour les mots de passe
    password: {
      saltRounds: 12,
      minLength: 8,
      requireComplexity: true, // Exige majuscules, minuscules, chiffres et caractères spéciaux
      maxAge: 90, // Jours avant expiration du mot de passe
      preventReuse: 3 // Empêche de réutiliser les 3 derniers mots de passe
    },
    
    // Protection contre les attaques par force brute
    rateLimiting: {
      login: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5, // 5 tentatives par fenêtre
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Trop de tentatives de connexion, veuillez réessayer plus tard' }
      },
      api: {
        windowMs: 60 * 1000, // 1 minute
        max: 100, // 100 requêtes par minute
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Trop de requêtes, veuillez réessayer plus tard' }
      }
    },
    
    // Protection CSRF
    csrf: {
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 3600000 // 1 heure
      }
    },
    
    // Configuration des cookies
    cookies: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: {
        session: 24 * 60 * 60 * 1000, // 24 heures
        refresh: 7 * 24 * 60 * 60 * 1000 // 7 jours
      }
    },
    
    // Protection des en-têtes HTTP
    headers: {
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
      },
      xssFilter: true,
      noSniff: true,
      referrerPolicy: { policy: 'same-origin' },
      hsts: {
        maxAge: 15552000, // 180 jours
        includeSubDomains: true
      }
    },
    
    // Configuration API keys / Secret management
    keys: {
      encryptionEnabled: true,
      encryptionAlgorithm: 'aes-256-gcm',
      keyRotationInterval: 90, // Jours
      storageMethod: 'env', // 'env', 'file', 'vault'
      vaultUrl: process.env.VAULT_URL || 'http://localhost:8200',
      vaultToken: process.env.VAULT_TOKEN || ''
    },
    
    // Validation et sanitisation des entrées
    inputValidation: {
      sanitizeAll: true,
      validateContent: true,
      xssProtection: true
    },
    
    // Journalisation de sécurité
    logging: {
      enabled: true,
      logLevel: 'info', // debug, info, warn, error
      logAuth: true,
      logAccess: true,
      anonymize: process.env.NODE_ENV === 'production',
      logFormat: 'combined'
    },
    
    // Paramètres TLS/SSL
    tls: {
      enabled: process.env.NODE_ENV === 'production',
      minVersion: 'TLSv1.2',
      ciphers: ['ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES128-GCM-SHA256'].join(':'),
      honorCipherOrder: true,
      requireCert: false
    }
  };
  
  export default securityConfig;