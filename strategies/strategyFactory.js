// strategies/strategyFactory.js - Usine de création des stratégies
import { EnhancedMomentumStrategy } from './enhancedMomentumStrategy.js';

/**
 * Factory pour créer des instances de stratégies de trading
 */
export class StrategyFactory {
  /**
   * Crée une instance de stratégie en fonction du type spécifié
   * @param {string} strategyType - Type de stratégie (par défaut: ENHANCED_MOMENTUM)
   * @param {Object} config - Configuration pour initialiser la stratégie
   * @returns {Object} Instance de la stratégie
   * @throws {Error} Si le type de stratégie n'est pas reconnu
   */
  static createStrategy(strategyType = 'ENHANCED_MOMENTUM', config) {
    // Normaliser le type de stratégie (majuscules)
    const normalizedType = String(strategyType).toUpperCase();
    
    switch (normalizedType) {
      case 'ENHANCED_MOMENTUM':
        return new EnhancedMomentumStrategy(config);
      
      // D'autres stratégies peuvent être ajoutées ici
      case 'TREND_FOLLOWING':
        // return new TrendFollowingStrategy(config);
        throw new Error('Stratégie TREND_FOLLOWING non implémentée');
        
      case 'MEAN_REVERSION':
        // return new MeanReversionStrategy(config);
        throw new Error('Stratégie MEAN_REVERSION non implémentée');
        
      case 'BREAKOUT':
        // return new BreakoutStrategy(config);
        throw new Error('Stratégie BREAKOUT non implémentée');
        
      case 'VOLATILITY':
        // return new VolatilityStrategy(config);
        throw new Error('Stratégie VOLATILITY non implémentée');
        
      default:
        throw new Error(`Stratégie non reconnue: ${strategyType}`);
    }
  }
  
  /**
   * Liste toutes les stratégies disponibles avec leurs descriptions
   * @returns {Array<Object>} Liste des stratégies
   */
  static getAvailableStrategies() {
    return [
      {
        type: 'ENHANCED_MOMENTUM',
        name: 'Enhanced Momentum',
        description: 'Stratégie de momentum améliorée qui combine RSI, MACD, et analyse de volume pour détecter les mouvements de prix avec élan significatif',
        parameters: [
          { name: 'rsi.oversold', default: 30, min: 10, max: 40 },
          { name: 'rsi.overbought', default: 70, min: 60, max: 90 },
          { name: 'volumeThresholds.significant', default: 1.5, min: 1, max: 3 }
        ],
        implementationStatus: 'ACTIVE'
      },
      {
        type: 'TREND_FOLLOWING',
        name: 'Trend Following',
        description: 'Stratégie qui suit les tendances établies en utilisant des moyennes mobiles et indicateurs de tendance',
        parameters: [
          { name: 'shortEMA', default: 9, min: 5, max: 20 },
          { name: 'longEMA', default: 21, min: 15, max: 50 },
          { name: 'confirmationPeriod', default: 3, min: 1, max: 10 }
        ],
        implementationStatus: 'PLANNED'
      },
      {
        type: 'MEAN_REVERSION',
        name: 'Mean Reversion',
        description: 'Stratégie qui identifie les déviations extrêmes par rapport à la moyenne et mise sur un retour à la normale',
        parameters: [
          { name: 'lookbackPeriod', default: 20, min: 10, max: 50 },
          { name: 'deviationThreshold', default: 2, min: 1, max: 4 },
          { name: 'exitThreshold', default: 0.5, min: 0.1, max: 1 }
        ],
        implementationStatus: 'PLANNED'
      },
      {
        type: 'BREAKOUT',
        name: 'Breakout',
        description: 'Stratégie qui identifie les ruptures de niveaux de support/résistance ou de consolidation',
        parameters: [
          { name: 'consolidationPeriod', default: 14, min: 7, max: 30 },
          { name: 'breakoutThreshold', default: 3, min: 1, max: 5 },
          { name: 'volumeConfirmation', default: true }
        ],
        implementationStatus: 'PLANNED'
      },
      {
        type: 'VOLATILITY',
        name: 'Volatility',
        description: 'Stratégie qui exploite les périodes de forte volatilité ou de volatilité croissante',
        parameters: [
          { name: 'atrPeriod', default: 14, min: 7, max: 21 },
          { name: 'volatilityThreshold', default: 2.5, min: 1, max: 5 },
          { name: 'profitTarget', default: 1.5, min: 0.5, max: 3 }
        ],
        implementationStatus: 'PLANNED'
      }
    ];
  }
  
  /**
   * Vérifie si un type de stratégie est disponible
   * @param {string} strategyType - Type de stratégie à vérifier
   * @returns {boolean} True si la stratégie est disponible
   */
  static isStrategyAvailable(strategyType) {
    const normalizedType = String(strategyType).toUpperCase();
    return this.getAvailableStrategies()
      .some(strategy => strategy.type === normalizedType && strategy.implementationStatus === 'ACTIVE');
  }
  
  /**
   * Récupère les paramètres par défaut pour un type de stratégie
   * @param {string} strategyType - Type de stratégie
   * @returns {Object|null} Paramètres par défaut ou null si stratégie non trouvée
   */
  static getDefaultParameters(strategyType) {
    const normalizedType = String(strategyType).toUpperCase();
    const strategy = this.getAvailableStrategies().find(s => s.type === normalizedType);
    
    if (!strategy) return null;
    
    const defaultParams = {};
    strategy.parameters.forEach(param => {
      const nameParts = param.name.split('.');
      let current = defaultParams;
      
      for (let i = 0; i < nameParts.length - 1; i++) {
        if (!current[nameParts[i]]) {
          current[nameParts[i]] = {};
        }
        current = current[nameParts[i]];
      }
      
      current[nameParts[nameParts.length - 1]] = param.default;
    });
    
    return defaultParams;
  }
}

export default StrategyFactory;