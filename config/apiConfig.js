// config/apiConfig.js

/**
 * Configuration des API utilisées par le trading bot
 * Centralise les URLs, clés API, limites de taux, etc.
 */
export const apiConfig = {
    // API Raydium (Solana DEX)
    raydium: {
      baseUrl: 'https://api.raydium.io/v2',
      endpoints: {
        pools: '/pools',
        tokens: '/tokens',
        liquidity: '/liquidity',
        charts: '/charts'
      },
      rateLimits: {
        requests: 10,   // 10 requêtes par minute
        period: 60000   // Période en millisecondes
      }
    },
    
    // API Jupiter (Agrégateur Solana)
    jupiter: {
      baseUrl: 'https://price.jup.ag/v4',
      endpoints: {
        price: '/price',
        swap: '/swap',
        quotes: '/quotes'
      },
      rateLimits: {
        requests: 30,   // 30 requêtes par minute
        period: 60000   // Période en millisecondes
      }
    },
    
    // API CoinGecko (Données de marché)
    coingecko: {
      baseUrl: 'https://api.coingecko.com/api/v3',
      endpoints: {
        tokenPrice: '/simple/token_price/solana',
        global: '/global',
        coins: '/coins',
        markets: '/coins/markets'
      },
      rateLimits: {
        requests: 30,   // 30 requêtes par minute pour le tier gratuit
        period: 60000,  // Période en millisecondes
        retryAfter: 60000 // Attendre 1 minute après une limite atteinte
      },
      params: {
        currency: 'usd',
        order: 'market_cap_desc',
        includePlatform: true
      }
    },
    
    // Paramètres RPC Solana
    solana: {
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      wsUrl: 'wss://api.mainnet-beta.solana.com',
      commitment: 'confirmed',
      rateLimits: {
        requests: 100,   // 100 requêtes par 10 secondes (peut varier selon le service)
        period: 10000    // Période en millisecondes
      }
    },
    
    // Configuration des fallbacks et redondance
    fallbacks: {
      enabled: true,
      maxRetries: 3,
      retryDelay: 1000,  // Délai de base en millisecondes (augmente exponentiellement)
      alternativeRpcUrls: [
        'https://solana-api.projectserum.com',
        'https://rpc.ankr.com/solana'
      ],
      timeouts: {
        default: 10000,  // 10 secondes
        priceData: 5000, // 5 secondes pour les données de prix
        historical: 15000 // 15 secondes pour les données historiques
      }
    },
    
    // Paramètres de proxy/cache (optionnel)
    proxy: {
      enabled: false,
      url: 'http://localhost:8080',
      cacheEnabled: true,
      cacheTtl: 300000  // 5 minutes en millisecondes
    }
  };
  
  export default apiConfig;