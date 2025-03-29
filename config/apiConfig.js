export const apiConfig = {
  raydium: {baseUrl:'https://api.raydium.io/v2',endpoints:{pools:'/pools',tokens:'/tokens',liquidity:'/liquidity',charts:'/charts'},rateLimits:{requests:10,period:60000}},
  jupiter: {baseUrl:'https://price.jup.ag/v4',endpoints:{price:'/price',swap:'/swap',quotes:'/quotes'},rateLimits:{requests:30,period:60000}},
  coingecko: {baseUrl:'https://api.coingecko.com/api/v3',endpoints:{tokenPrice:'/simple/token_price/solana',global:'/global',coins:'/coins',markets:'/coins/markets'},rateLimits:{requests:30,period:60000,retryAfter:60000},params:{currency:'usd',order:'market_cap_desc',includePlatform:true}},
  solana: {rpcUrl:'https://api.mainnet-beta.solana.com',wsUrl:'wss://api.mainnet-beta.solana.com',commitment:'confirmed',rateLimits:{requests:100,period:10000}},
  fallbacks: {enabled:true,maxRetries:3,retryDelay:1000,alternativeRpcUrls:['https://solana-api.projectserum.com','https://rpc.ankr.com/solana'],timeouts:{default:10000,priceData:5000,historical:15000}},
  proxy: {enabled:false,url:'http://localhost:8080',cacheEnabled:true,cacheTtl:300000}
};

export default apiConfig;