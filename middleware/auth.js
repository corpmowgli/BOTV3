import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import csurf from 'csurf';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'votre_secret_jwt_très_sécurisé';
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '24h';
const REFRESH_TOKEN_EXPIRATION = process.env.REFRESH_TOKEN_EXPIRATION || '7d';

const users = [{id:1,username:'admin',passwordHash:'$2b$10$IfBBb.oKhXe6YVRBYp8/WOJAPmFW5PBgAqJVx5.GS1XJWMoAB7aY2',role:'admin',refreshTokens:[]}];

export const loginRateLimiter = rateLimit({windowMs:15*60*1000,max:5,standardHeaders:true,legacyHeaders:false,message:{error:'Trop de tentatives de connexion, veuillez réessayer plus tard'},skipSuccessfulRequests:true});

export const apiRateLimiter = rateLimit({windowMs:60*1000,max:100,standardHeaders:true,legacyHeaders:false,message:{error:'Trop de requêtes, veuillez réessayer plus tard'}});

export const csrfProtection = csurf({cookie:{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:3600000}});

export const authenticateJWT = (req, res, next) => {
  const token = req.cookies.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  if(!token) return res.status(401).json({error:'Accès non autorisé'});
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const tokenExp = new Date(decoded.exp * 1000);
    const now = new Date();
    if((tokenExp.getTime() - now.getTime()) < 5*60*1000) {
      const refreshToken = req.cookies.refreshToken;
      if(refreshToken) {
        try {
          const refreshDecoded = jwt.verify(refreshToken, JWT_SECRET);
          const user = users.find(u => u.id === refreshDecoded.id);
          if(user && user.refreshTokens.includes(refreshToken)) {
            const newToken = generateAccessToken(user);
            res.cookie('token', newToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:24*60*60*1000});
            decoded.exp = jwt.decode(newToken).exp;
          }
        } catch(err) {
          console.error('Error refreshing token:', err);
        }
      }
    }
    req.user = decoded;
    next();
  } catch(error) {
    if(error.name === 'TokenExpiredError') return res.status(401).json({error:'Session expirée',code:'TOKEN_EXPIRED'});
    return res.status(403).json({error:'Token invalide',code:'INVALID_TOKEN'});
  }
};

export const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if(!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({error:'Accès interdit'});
    }
    next();
  };
};

export const login = async (req, res) => {
  const {username, password} = req.body;
  if(!username || !password) {
    return res.status(400).json({error:'Nom d\'utilisateur et mot de passe requis'});
  }
  const user = users.find(u => u.username === username);
  if(!user) return res.status(401).json({error:'Identifiants invalides'});
  try {
    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if(!passwordValid) return res.status(401).json({error:'Identifiants invalides'});
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    user.refreshTokens = user.refreshTokens || [];
    user.refreshTokens.push(refreshToken);
    if(user.refreshTokens.length > 5) {
      user.refreshTokens = user.refreshTokens.slice(-5);
    }
    res.cookie('token', accessToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:24*60*60*1000});
    res.cookie('refreshToken', refreshToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:7*24*60*60*1000});
    return res.json({message:'Connexion réussie',user:{id:user.id,username:user.username,role:user.role}});
  } catch(error) {
    console.error('Login error:', error);
    return res.status(500).json({error:'Erreur lors de la connexion'});
  }
};

export const logout = (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if(req.user) {
    const user = users.find(u => u.id === req.user.id);
    if(user && refreshToken) {
      user.refreshTokens = user.refreshTokens.filter(token => token !== refreshToken);
    }
  }
  res.clearCookie('token');
  res.clearCookie('refreshToken');
  return res.json({message:'Déconnexion réussie'});
};

export const refreshToken = (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if(!refreshToken) {
    return res.status(401).json({error:'Refresh token manquant'});
  }
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    const user = users.find(u => u.id === decoded.id);
    if(!user || !user.refreshTokens.includes(refreshToken)) {
      return res.status(403).json({error:'Refresh token invalide'});
    }
    const accessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    user.refreshTokens = user.refreshTokens.filter(token => token !== refreshToken);
    user.refreshTokens.push(newRefreshToken);
    res.cookie('token', accessToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:24*60*60*1000});
    res.cookie('refreshToken', newRefreshToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:7*24*60*60*1000});
    return res.json({message:'Token rafraîchi avec succès'});
  } catch(error) {
    if(error.name === 'TokenExpiredError') {
      return res.status(401).json({error:'Refresh token expiré'});
    }
    return res.status(403).json({error:'Refresh token invalide'});
  }
};

export const securityMiddleware = [
  helmet({
    contentSecurityPolicy:{
      directives:{
        defaultSrc:["'self'"],
        scriptSrc:["'self'","'unsafe-inline'","https://cdn.jsdelivr.net"],
        styleSrc:["'self'","'unsafe-inline'","https://cdn.jsdelivr.net"],
        imgSrc:["'self'","data:","https://cdn.jsdelivr.net"],
        connectSrc:["'self'","wss:","ws:"],
        fontSrc:["'self'","https://cdn.jsdelivr.net"],
        objectSrc:["'none'"],
        upgradeInsecureRequests:[]
      }
    },
    xssFilter:true,
    noSniff:true,
    referrerPolicy:{policy:'same-origin'},
    hsts:{maxAge:15552000,includeSubDomains:true}
  }),
  cookieParser()
];

function generateAccessToken(user) {
  return jwt.sign({id:user.id,username:user.username,role:user.role}, JWT_SECRET, {expiresIn:JWT_EXPIRATION});
}

function generateRefreshToken(user) {
  return jwt.sign({id:user.id,type:'refresh'}, JWT_SECRET, {expiresIn:REFRESH_TOKEN_EXPIRATION});
}

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(12);
  return bcrypt.hash(password, salt);
};

export const generateRandomPassword = (length = 16) => {
  const upperChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowerChars = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const specialChars = '!@#$%^&*()-_=+[]{}|;:,.<>?';
  const allChars = upperChars + lowerChars + numbers + specialChars;
  let password = '';
  password += upperChars.charAt(Math.floor(Math.random() * upperChars.length));
  password += lowerChars.charAt(Math.floor(Math.random() * lowerChars.length));
  password += numbers.charAt(Math.floor(Math.random() * numbers.length));
  password += specialChars.charAt(Math.floor(Math.random() * specialChars.length));
  for(let i=4; i<length; i++) {
    password += allChars.charAt(Math.floor(Math.random() * allChars.length));
  }
  return password.split('').sort(() => 0.5 - Math.random()).join('');
};