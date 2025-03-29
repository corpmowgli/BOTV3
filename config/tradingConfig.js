export const tradingConfig = {
  api: {jupiterBaseUrl:'https://price.jup.ag/v4',jupiterEndpoints:{price:'/price',swap:'/swap',quotes:'/quotes'},raydiumBaseUrl:'https://api.raydium.io/v2',raydiumEndpoints:{pools:'/pools',tokens:'/tokens',liquidity:'/liquidity',charts:'/charts'},coingeckoBaseUrl:'https://api.coingecko.com/api/v3',coingeckoEndpoints:{tokenPrice:'/simple/token_price/solana',global:'/global',coins:'/coins',markets:'/coins/markets'},solana:{rpcUrl:process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',wsUrl:process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',commitment:'confirmed'},rateLimits:{jupiter:{requests:30,period:60000},raydium:{requests:10,period:60000},coingecko:{requests:30,period:60000,retryAfter:60000},solana:{requests:100,period:10000}},fallbacks:{enabled:true,maxRetries:3,retryDelay:1000,alternativeRpcUrls:['https://solana-api.projectserum.com','https://rpc.ankr.com/solana','https://mainnet.solana.rpcpool.com'],timeouts:{default:10000,priceData:5000,historical:15000}}},
  trading: {cycleInterval:60000,analysisInterval:300000,tradeSize:2,maxOpenPositions:5,maxExposurePerToken:20,closePositionsOnStop:true,stopLoss:5,takeProfit:15,trailingStopLoss:true,trailingStopDistance:2,minLiquidity:200000,minVolume24h:100000,minTradeAmount:10,minConfidenceThreshold:0.65,maxLossPerTrade:3,maxDailyLoss:5,circuitBreaker:{enabled:true,consecutiveLosses:3,timeoutMinutes:60,maxDailyLossPercent:5},solanaSpecific:{preferHighTVL:true,avoidNewTokens:true,trackDeveloperActivity:true,considerSolanaEcosystem:true}},
  indicators: {rsi:{period:14,oversold:30,overbought:70},macd:{fastPeriod:12,slowPeriod:26,signalPeriod:9},bollingerBands:{period:20,stdDev:2},volumeProfile:{lookback:24,threshold:1.5},solanaSpecific:{priceImpact:{threshold:1.5,amount:1000}}},
  simulation: {initialCapital:10000,backtestDays:30,minProfitableRatio:0.6,maxDrawdown:15,scenarioTesting:{volatilityScenarios:{low:0.5,normal:1.0,high:2.0}}},
  logging: {enabled:true,level:'info',persistentStorage:true,storageType:'file',filePath:'./logs/trades/',autoExport:{enabled:true,interval:86400000,format:'json'}},
  performance: {tokenConcurrency:5,enableAutomaticRestarts:true,memoryThreshold:1536,memoryCheckInterval:300000,cacheSettings:{pricesTTL:60000,historicalTTL:1800000,tokenInfoTTL:300000}},
  strategy: {type:'ENHANCED_MOMENTUM',timeframes:['1h','4h','1d'],minimumConfirmations:2,marketRegimeDetection:true,volatilityAdjustment:true}
};

export const timeframeConfig = {
  '5m':{weight:0.2,lookbackPeriods:72,stopLossMultiplier:1.2,takeProfitMultiplier:0.8},
  '15m':{weight:0.3,lookbackPeriods:96,stopLossMultiplier:1.1,takeProfitMultiplier:0.9},
  '1h':{weight:0.5,lookbackPeriods:48,stopLossMultiplier:1.0,takeProfitMultiplier:1.0},
  '4h':{weight:0.7,lookbackPeriods:42,stopLossMultiplier:0.9,takeProfitMultiplier:1.1},
  '1d':{weight:1.0,lookbackPeriods:30,stopLossMultiplier:0.8,takeProfitMultiplier:1.2}
};

export const optimizationConfig = {
  parameterRanges:{'indicators.rsi.oversold':{min:20,max:40,step:5},'indicators.rsi.overbought':{min:60,max:80,step:5},'trading.stopLoss':{min:3,max:10,step:1},'trading.takeProfit':{min:5,max:25,step:5},'trading.trailingStopDistance':{min:1,max:5,step:0.5}},
  objectives:{primary:'sharpeRatio',secondary:['profitFactor','maxDrawdown']},
  evaluationMetrics:{profitFactor:{weight:0.3,target:'maximize'},sharpeRatio:{weight:0.3,target:'maximize'},maxDrawdown:{weight:0.2,target:'minimize'},winRate:{weight:0.2,target:'maximize'}}
};