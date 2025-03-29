export const securityConfig = {
  jwt: {secret:process.env.JWT_SECRET || 'votre_secret_jwt_tres_securise_a_changer_en_production',expiresIn:'24h',refreshExpiresIn:'7d',issuer:'trading-bot-dashboard',audience:'client'},
  password: {saltRounds:12,minLength:8,requireComplexity:true,maxAge:90,preventReuse:3},
  rateLimiting: {login:{windowMs:15*60*1000,max:5,standardHeaders:true,legacyHeaders:false,message:{error:'Trop de tentatives de connexion, veuillez réessayer plus tard'}},api:{windowMs:60*1000,max:100,standardHeaders:true,legacyHeaders:false,message:{error:'Trop de requêtes, veuillez réessayer plus tard'}}},
  csrf: {cookie:{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:3600000}},
  cookies: {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:{session:24*60*60*1000,refresh:7*24*60*60*1000}},
  headers: {contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'","https://cdn.jsdelivr.net"],styleSrc:["'self'","'unsafe-inline'","https://cdn.jsdelivr.net"],imgSrc:["'self'","data:","https://cdn.jsdelivr.net"],connectSrc:["'self'","wss:","ws:"],fontSrc:["'self'","https://cdn.jsdelivr.net"],objectSrc:["'none'"],upgradeInsecureRequests:[]}},xssFilter:true,noSniff:true,referrerPolicy:{policy:'same-origin'},hsts:{maxAge:15552000,includeSubDomains:true}},
  keys: {encryptionEnabled:true,encryptionAlgorithm:'aes-256-gcm',keyRotationInterval:90,storageMethod:'env',vaultUrl:process.env.VAULT_URL || 'http://localhost:8200',vaultToken:process.env.VAULT_TOKEN || ''},
  inputValidation: {sanitizeAll:true,validateContent:true,xssProtection:true},
  logging: {enabled:true,logLevel:'info',logAuth:true,logAccess:true,anonymize:process.env.NODE_ENV==='production',logFormat:'combined'},
  tls: {enabled:process.env.NODE_ENV==='production',minVersion:'TLSv1.2',ciphers:['ECDHE-RSA-AES256-GCM-SHA384','ECDHE-RSA-AES128-GCM-SHA256'].join(':'),honorCipherOrder:true,requireCert:false}
};

export default securityConfig;