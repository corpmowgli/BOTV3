// config/tradingConfig.js - Configuration optimisée pour Solana
export const tradingConfig = {
    // Configuration API pour les endpoints Solana
    api: {
      // Jupiter - Source principale de prix pour Solana
      jupiterBaseUrl: 'https://price.jup.ag/v4',
      jupiterEndpoints: {
        price: '/price',
        swap: '/swap',
        quotes: '/quotes'
      },
      
      // Raydium - Source de liquidité et données historiques
      raydiumBaseUrl: 'https://api.raydium.io/v2',
      raydiumEndpoints: {
        pools: '/pools',
        tokens: '/tokens',
        liquidity: '/liquidity',
        charts: '/charts'
      },
      
      // CoinGecko - Source secondaire pour données marché
      coingeckoBaseUrl: 'https://api.coingecko.com/api/v3',
      coingeckoEndpoints: {
        tokenPrice: '/simple/token_price/solana',
        global: '/global',
        coins: '/coins',
        markets: '/coins/markets'
      },
      
      // Endpoints RPC Solana
      solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
        commitment: 'confirmed'
      },
      
      // Rate Limits
      rateLimits: {
        jupiter: {
          requests: 30,
          period: 60000
        },
        raydium: {
          requests: 10,
          period: 60000
        },
        coingecko: {
          requests: 30,
          period: 60000,
          retryAfter: 60000
        },
        solana: {
          requests: 100,
          period: 10000
        }
      },
      
      // Fallbacks et résilience
      fallbacks: {
        enabled: true,
        maxRetries: 3,
        retryDelay: 1000,
        alternativeRpcUrls: [
          'https://solana-api.projectserum.com',
          'https://rpc.ankr.com/solana',
          'https://mainnet.solana.rpcpool.com'
        ],
        timeouts: {
          default: 10000,
          priceData: 5000,
          historical: 15000
        }
      }
    },
    
    // Paramètres de trading
    trading: {
      // Intervalles de cycle de trading
      cycleInterval: 60000, // 1 minute
      analysisInterval: 300000, // 5 minutes
      
      // Gestion des positions
      tradeSize: 2, // % du portefeuille par trade
      maxOpenPositions: 5, // Max positions simultanées
      maxExposurePerToken: 20, // % max du portefeuille par token
      closePositionsOnStop: true, // Fermer toutes les positions à l'arrêt
      
      // Stop loss et take profit
      stopLoss: 5, // 5% stop loss
      takeProfit: 15, // 15% take profit
      trailingStopLoss: true, // Activer le trailing stop
      trailingStopDistance: 2, // Distance du trailing stop (%)
      
      // Exigences de qualité des tokens Solana
      minLiquidity: 200000, // Liquidité minimale en USD
      minVolume24h: 100000, // Volume minimal 24h en USD
      minTradeAmount: 10, // Montant minimal de trade en USD
      
      // Filtres et seuils
      minConfidenceThreshold: 0.65, // Seuil minimal de confiance pour les signaux
      maxLossPerTrade: 3, // Perte max par trade (%)
      maxDailyLoss: 5, // Perte quotidienne maximale (%)
      
      // Circuit breaker Solana
      circuitBreaker: {
        enabled: true,
        consecutiveLosses: 3,
        timeoutMinutes: 60,
        maxDailyLossPercent: 5
      },
      
      // Paramètres spécifiques à Solana
      solanaSpecific: {
        preferHighTVL: true, // Préférer tokens avec TVL élevée
        avoidNewTokens: true, // Éviter tokens trop récents
        trackDeveloperActivity: true, // Suivre activité dev
        considerSolanaEcosystem: true // Tenir compte de l'écosystème
      }
    },
    
    // Indicateurs techniques
    indicators: {
      rsi: {
        period: 14,
        oversold: 30,
        overbought: 70
      },
      macd: {
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9
      },
      bollingerBands: {
        period: 20,
        stdDev: 2
      },
      volumeProfile: {
        lookback: 24,
        threshold: 1.5
      },
      // Enhanced indicators for Solana
      solanaSpecific: {
        // Paramètres pour détecter la liquidité sur les marchés Solana
        priceImpact: {
          threshold: 1.5, // Seuil d'impact prix en %
          amount: 1000 // Montant en USD pour calculer l'impact
        }
      }
    },
    
    // Paramètres de simulation et backtest
    simulation: {
      initialCapital: 10000,
      backtestDays: 30,
      minProfitableRatio: 0.6,
      maxDrawdown: 15,
      scenarioTesting: {
        volatilityScenarios: {
          low: 0.5,
          normal: 1.0,
          high: 2.0
        }
      }
    },
    
    // Paramètres de logging
    logging: {
      enabled: true,
      level: 'info', // debug, info, warn, error
      persistentStorage: true,
      storageType: 'file',
      filePath: './logs/trades/',
      autoExport: {
        enabled: true,
        interval: 86400000, // 24h
        format: 'json'
      }
    },
    
    // Paramètres de performance
    performance: {
      tokenConcurrency: 5, // Nombre de tokens traités simultanément
      enableAutomaticRestarts: true, // Redémarrage automatique en cas de problème
      memoryThreshold: 1536, // Seuil mémoire en MB
      memoryCheckInterval: 300000, // Intervalle de vérification mémoire (5min)
      cacheSettings: {
        pricesTTL: 60000, // 1min
        historicalTTL: 1800000, // 30min
        tokenInfoTTL: 300000 // 5min
      }
    },
    
    // Stratégie par défaut
    strategy: {
      type: 'ENHANCED_MOMENTUM',
      timeframes: ['1h', '4h', '1d'],
      minimumConfirmations: 2,
      marketRegimeDetection: true,
      volatilityAdjustment: true
    }
  };
  
  // Config avancée pour les timeframes
  export const timeframeConfig = {
    '5m': {
      weight: 0.2,
      lookbackPeriods: 72, // 6h
      stopLossMultiplier: 1.2,
      takeProfitMultiplier: 0.8
    },
    '15m': {
      weight: 0.3,
      lookbackPeriods: 96, // 24h
      stopLossMultiplier: 1.1,
      takeProfitMultiplier: 0.9
    },
    '1h': {
      weight: 0.5, 
      lookbackPeriods: 48, // 2j
      stopLossMultiplier: 1.0,
      takeProfitMultiplier: 1.0
    },
    '4h': {
      weight: 0.7,
      lookbackPeriods: 42, // 7j
      stopLossMultiplier: 0.9,
      takeProfitMultiplier: 1.1
    },
    '1d': {
      weight: 1.0,
      lookbackPeriods: 30, // 30j
      stopLossMultiplier: 0.8,
      takeProfitMultiplier: 1.2
    }
  };
  
  // Configuration des optimisations
  export const optimizationConfig = {
    parameterRanges: {
      'indicators.rsi.oversold': { min: 20, max: 40, step: 5 },
      'indicators.rsi.overbought': { min: 60, max: 80, step: 5 },
      'trading.stopLoss': { min: 3, max: 10, step: 1 },
      'trading.takeProfit': { min: 5, max: 25, step: 5 },
      'trading.trailingStopDistance': { min: 1, max: 5, step: 0.5 }
    },
    objectives: {
      primary: 'sharpeRatio',
      secondary: ['profitFactor', 'maxDrawdown']
    },
    evaluationMetrics: {
      profitFactor: { weight: 0.3, target: 'maximize' },
      sharpeRatio: { weight: 0.3, target: 'maximize' },
      maxDrawdown: { weight: 0.2, target: 'minimize' },
      winRate: { weight: 0.2, target: 'maximize' }
    }
  };