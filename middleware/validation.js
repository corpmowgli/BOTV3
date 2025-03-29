// middleware/validation.js
import { body, param, query, validationResult } from 'express-validator';
import xss from 'xss';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

// Create DOMPurify instance for server-side sanitization
const window = new JSDOM('').window;
const purify = DOMPurify(window);

// Custom error formatting for validation
export const validate = (req, res, next) => {
  const errors = validationResult(req).formatWith(({ location, msg, param, value, nestedErrors }) => {
    return {
      type: 'validation_error',
      location,
      param,
      msg,
      value: process.env.NODE_ENV === 'production' ? undefined : value
    };
  });
  
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation Error',
      errors: errors.array() 
    });
  }
  
  next();
};

// Enhanced sanitization for input strings
export const sanitizeInput = (input) => {
  if (typeof input === 'string') {
    // Apply multiple layers of sanitization for better security
    let sanitized = input.trim();
    sanitized = xss(sanitized);
    sanitized = purify.sanitize(sanitized);
    return sanitized;
  }
  
  // For arrays, recursively sanitize elements
  if (Array.isArray(input)) {
    return input.map(item => sanitizeInput(item));
  }
  
  // For objects, recursively sanitize values
  if (input !== null && typeof input === 'object') {
    const result = {};
    for (const key in input) {
      result[key] = sanitizeInput(input[key]);
    }
    return result;
  }
  
  return input;
};

// Middleware to sanitize all inputs in request body, params, and query
export const sanitizeAllInputs = (req, res, next) => {
  if (req.body) {
    req.body = sanitizeInput(req.body);
  }
  
  if (req.params) {
    req.params = sanitizeInput(req.params);
  }
  
  if (req.query) {
    req.query = sanitizeInput(req.query);
  }
  
  next();
};

// Common validation utility functions
const validationUtils = {
  // Check if a date is valid and not in the future
  isPastOrPresentDate: (value) => {
    const date = new Date(value);
    const now = new Date();
    
    return !isNaN(date.getTime()) && date <= now;
  },
  
  // Check if a date is within a valid range (e.g., not too far in the past or future)
  isDateInRange: (value, minDate, maxDate) => {
    const date = new Date(value);
    return !isNaN(date.getTime()) && date >= minDate && date <= maxDate;
  },
  
  // Validate positive numbers
  isPositiveNumber: (value) => {
    const num = Number(value);
    return !isNaN(num) && num > 0;
  }
};

// Validation rules for different endpoints
export const validationRules = {
  // Login validation
  login: [
    body('username')
      .trim()
      .notEmpty().withMessage('Nom d\'utilisateur requis')
      .isLength({ min: 3, max: 50 }).withMessage('Le nom d\'utilisateur doit contenir entre 3 et 50 caractères')
      .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres, tirets et underscores'),
    
    body('password')
      .trim()
      .notEmpty().withMessage('Mot de passe requis')
      .isLength({ min: 6 }).withMessage('Le mot de passe doit contenir au moins 6 caractères')
  ],
  
  // Simulation validation
  simulation: [
    body('startDate')
      .isISO8601().withMessage('Date de début invalide')
      .custom((value) => {
        // Check if date is not too far in the past (e.g., max 5 years)
        const fiveYearsAgo = new Date();
        fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
        
        return validationUtils.isDateInRange(value, fiveYearsAgo, new Date());
      }).withMessage('La date de début doit être dans les 5 dernières années'),
    
    body('endDate')
      .isISO8601().withMessage('Date de fin invalide')
      .custom((value, { req }) => {
        if (new Date(value) <= new Date(req.body.startDate)) {
          throw new Error('La date de fin doit être postérieure à la date de début');
        }
        return true;
      }),
    
    // Optional config validation
    body('config').optional()
      .isObject().withMessage('La configuration doit être un objet'),
    
    body('config.trading.tradeSize').optional()
      .isFloat({ min: 0.1, max: 50 }).withMessage('La taille de trade doit être entre 0.1 et 50%'),
    
    body('config.trading.stopLoss').optional()
      .isFloat({ min: 0.1, max: 50 }).withMessage('Le stop loss doit être entre 0.1 et 50%'),
    
    body('config.trading.takeProfit').optional()
      .isFloat({ min: 0.1, max: 200 }).withMessage('Le take profit doit être entre 0.1 et 200%')
  ],
  
  // Trades query validation
  getTrades: [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 1000 }).withMessage('La limite doit être un entier entre 1 et 1000')
      .toInt(),
    
    query('offset')
      .optional()
      .isInt({ min: 0 }).withMessage('L\'offset doit être un entier positif ou zéro')
      .toInt(),
      
    query('token')
      .optional()
      .isString().withMessage('Le token doit être une chaîne de caractères')
      .isLength({ min: 1, max: 100 }).withMessage('Le token doit contenir entre 1 et 100 caractères'),
      
    query('startDate')
      .optional()
      .isISO8601().withMessage('Date de début invalide'),
      
    query('endDate')
      .optional()
      .isISO8601().withMessage('Date de fin invalide')
  ],
  
  // Daily performance query validation
  getDailyPerformance: [
    query('limit')
      .optional()
      .isInt({ min: 1, max: 365 }).withMessage('La limite doit être un entier entre 1 et 365')
      .toInt(),
      
    query('offset')
      .optional()
      .isInt({ min: 0 }).withMessage('L\'offset doit être un entier positif ou zéro')
      .toInt()
  ],
  
  // Log export validation
  exportLogs: [
    query('format')
      .isIn(['json', 'csv']).withMessage('Le format doit être "json" ou "csv"'),
      
    query('compress')
      .optional()
      .isBoolean().withMessage('La compression doit être "true" ou "false"')
      .toBoolean(),
      
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('La page doit être un entier positif')
      .toInt(),
      
    query('limit')
      .optional()
      .isInt({ min: 1, max: 5000 }).withMessage('La limite doit être un entier entre 1 et 5000')
      .toInt(),
      
    query('startDate')
      .optional()
      .isISO8601().withMessage('Date de début invalide'),
      
    query('endDate')
      .optional()
      .isISO8601().withMessage('Date de fin invalide')
      .custom((value, { req }) => {
        if (req.query.startDate && new Date(value) <= new Date(req.query.startDate)) {
          throw new Error('La date de fin doit être postérieure à la date de début');
        }
        return true;
      })
  ],
  
  // User profile update validation
  updateProfile: [
    body('email')
      .optional()
      .isEmail().withMessage('Email invalide'),
      
    body('oldPassword')
      .optional()
      .isLength({ min: 6 }).withMessage('Le mot de passe actuel doit contenir au moins 6 caractères'),
      
    body('newPassword')
      .optional()
      .isLength({ min: 8 }).withMessage('Le nouveau mot de passe doit contenir au moins 8 caractères')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      .withMessage('Le mot de passe doit contenir au moins une lettre majuscule, une lettre minuscule, un chiffre et un caractère spécial'),
      
    body('newPasswordConfirm')
      .optional()
      .custom((value, { req }) => {
        if (value !== req.body.newPassword) {
          throw new Error('Les mots de passe ne correspondent pas');
        }
        return true;
      })
  ]
};