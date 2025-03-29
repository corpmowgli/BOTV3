// utils/indicators.js - Indicateurs techniques optimisés

export const technicalAnalysis = {
  _cache: new Map(),
  
  // Nettoie le cache interne
  clearCache() { this._cache.clear(); },
  
  // Calcule l'indicateur RSI
  calculateRSI(prices, period = 14) {
    if (!prices || prices.length < period + 1) return { values: [], last: null };
    
    // Vérifier si le résultat est en cache
    const cacheKey = `rsi:${period}:${prices.length}:${prices[prices.length-1]}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    
    // Calculer les variations de prix
    const changes = new Float64Array(prices.length - 1);
    for (let i = 1; i < prices.length; i++) changes[i - 1] = prices[i] - prices[i - 1];
    
    // Calculer les gains et pertes
    const gains = new Float64Array(changes.length);
    const losses = new Float64Array(changes.length);
    
    for (let i = 0; i < changes.length; i++) {
      gains[i] = changes[i] > 0 ? changes[i] : 0;
      losses[i] = changes[i] < 0 ? -changes[i] : 0;
    }
    
    // Moyennes initiales
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
      avgGain += gains[i];
      avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;
    
    // Calculer le RSI pour chaque point
    const rsiData = new Array(prices.length - period);
    
    // Premier RSI
    let rs = avgGain / (avgLoss === 0 ? 1e-10 : avgLoss);
    let rsi = 100 - (100 / (1 + rs));
    rsiData[0] = rsi;
    
    // Reste des valeurs RSI
    for (let i = period; i < changes.length; i++) {
      avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
      avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
      
      rs = avgGain / (avgLoss === 0 ? 1e-10 : avgLoss);
      rsi = 100 - (100 / (1 + rs));
      
      rsiData[i - period + 1] = rsi;
    }
    
    const result = { values: rsiData, last: rsiData[rsiData.length - 1] };
    this._cache.set(cacheKey, result);
    return result;
  },
  
  // Calcule le MACD
  calculateMACD(prices, options = {}) {
    const fastPeriod = options.fastPeriod || 12;
    const slowPeriod = options.slowPeriod || 26;
    const signalPeriod = options.signalPeriod || 9;
    
    if (!prices || prices.length < Math.max(fastPeriod, slowPeriod) + signalPeriod) {
      return { macdLine: [], signalLine: [], histogram: [], previousHistogram: null, lastHistogram: null };
    }
    
    // Vérifier si le résultat est en cache
    const cacheKey = `macd:${fastPeriod}:${slowPeriod}:${signalPeriod}:${prices.length}:${prices[prices.length-1]}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    
    // Calcul des EMA
    const ema12 = this.calculateEMA(prices, fastPeriod);
    const ema26 = this.calculateEMA(prices, slowPeriod);
    
    // Ligne MACD
    const macdLine = new Array(ema12.length);
    for (let i = 0; i < ema12.length; i++) {
      macdLine[i] = ema12[i] - (i < ema26.length ? ema26[i] : 0);
    }
    
    // Ligne de signal
    const signalLine = this.calculateEMA(macdLine, signalPeriod);
    
    // Histogramme
    const histogram = new Array(macdLine.length);
    for (let i = 0; i < macdLine.length; i++) {
      histogram[i] = macdLine[i] - (i < signalLine.length ? signalLine[i] : 0);
    }
    
    const result = {
      macdLine,
      signalLine,
      histogram,
      previousHistogram: histogram.length > 1 ? histogram[histogram.length - 2] : null,
      lastHistogram: histogram.length > 0 ? histogram[histogram.length - 1] : null
    };
    
    this._cache.set(cacheKey, result);
    return result;
  },
  
  // Calcule les Bandes de Bollinger
  calculateBollingerBands(prices, period = 20, stdDev = 2) {
    if (!prices || prices.length < period) return { upper: null, middle: null, lower: null };
    
    // Vérifier si le résultat est en cache
    const cacheKey = `bb:${period}:${stdDev}:${prices.length}:${prices[prices.length-1]}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    
    // SMA pour la bande du milieu
    let sum = 0;
    for (let i = prices.length - period; i < prices.length; i++) sum += prices[i];
    const middle = sum / period;
    
    // Écart type
    let squaredDiffSum = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
      squaredDiffSum += Math.pow(prices[i] - middle, 2);
    }
    const standardDeviation = Math.sqrt(squaredDiffSum / period);
    
    // Bandes supérieure et inférieure
    const upper = middle + (standardDeviation * stdDev);
    const lower = middle - (standardDeviation * stdDev);
    
    const result = { upper, middle, lower };
    this._cache.set(cacheKey, result);
    return result;
  },
  
  // Calcule l'EMA
  calculateEMA(prices, period) {
    if (!prices || prices.length === 0 || period <= 0) return [];
    if (prices.length < period) return [prices[0]];
    
    // Vérifier si le résultat est en cache
    const cacheKey = `ema:${period}:${prices.length}:${prices[prices.length-1]}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    
    const multiplier = 2 / (period + 1);
    const ema = new Array(prices.length);
    
    // SMA initiale
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    ema[period - 1] = sum / period;
    
    // Calculer le reste des valeurs EMA
    for (let i = period; i < prices.length; i++) {
      ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
    }
    
    // Version compacte
    const resultEma = ema.slice(period - 1);
    this._cache.set(cacheKey, resultEma);
    return resultEma;
  },
  
  // Calcule la SMA
  calculateSMA(prices, period) {
    if (!prices || prices.length === 0 || period <= 0) return [];
    if (prices.length < period) return [];
    
    // Vérifier si le résultat est en cache
    const cacheKey = `sma:${period}:${prices.length}:${prices[prices.length-1]}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    
    const sma = new Array(prices.length - period + 1);
    
    // Première somme
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    sma[0] = sum / period;
    
    // Fenêtre glissante
    for (let i = period; i < prices.length; i++) {
      sum = sum + prices[i] - prices[i - period];
      sma[i - period + 1] = sum / period;
    }
    
    this._cache.set(cacheKey, sma);
    return sma;
  },
  
  // Calcule l'écart type
  standardDeviation(values) {
    if (!values || values.length < 2) return 0;
    
    const n = values.length;
    let sum = 0, sumSq = 0;
    
    for (let i = 0; i < n; i++) {
      sum += values[i];
      sumSq += values[i] * values[i];
    }
    
    const mean = sum / n;
    const variance = (sumSq / n) - (mean * mean);
    
    return Math.sqrt(variance);
  },
  
  // Calcule tous les indicateurs
  calculateIndicators(prices, options = {}) {
    if (!prices || prices.length < 30) return { rsi: null, macd: null, bb: null };
    
    const rsiPeriod = options.rsiPeriod || 14;
    const macdOptions = {
      fastPeriod: options.fastPeriod || 12,
      slowPeriod: options.slowPeriod || 26,
      signalPeriod: options.signalPeriod || 9
    };
    const bbPeriod = options.bbPeriod || 20;
    const bbStdDev = options.bbStdDev || 2;
    
    // Calculer tous les indicateurs
    const rsi = this.calculateRSI(prices, rsiPeriod);
    const macd = this.calculateMACD(prices, macdOptions);
    const bb = this.calculateBollingerBands(prices, bbPeriod, bbStdDev);
    
    return { rsi: rsi.last, macd, bb };
  },
  
  // Calcule l'ATR
  calculateATR(high, low, close, period = 14) {
    if (!high || !low || !close || high.length !== low.length || high.length !== close.length || high.length < period + 1) {
      return [];
    }
    
    // True Range
    const tr = new Array(high.length - 1);
    tr[0] = high[0] - low[0];
    
    for (let i = 1; i < high.length; i++) {
      const trueHigh = Math.max(high[i], close[i - 1]);
      const trueLow = Math.min(low[i], close[i - 1]);
      tr[i-1] = trueHigh - trueLow;
    }
    
    // ATR initial (moyenne simple)
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    
    const atr = new Array(tr.length - period + 1);
    atr[0] = sum / period;
    
    // ATR lissé
    for (let i = period; i < tr.length; i++) {
      atr[i - period + 1] = ((atr[i - period] * (period - 1)) + tr[i]) / period;
    }
    
    return atr;
  },
  
  // Calcule le Stochastic Oscillator
  calculateStochastic(high, low, close, kPeriod = 14, dPeriod = 3) {
    if (!high || !low || !close || high.length < kPeriod) {
      return { k: [], d: [] };
    }
    
    const k = new Array(close.length - kPeriod + 1);
    
    // Calculer %K
    for (let i = kPeriod - 1; i < close.length; i++) {
      let highestHigh = high[i];
      let lowestLow = low[i];
      
      for (let j = 0; j < kPeriod; j++) {
        highestHigh = Math.max(highestHigh, high[i - j]);
        lowestLow = Math.min(lowestLow, low[i - j]);
      }
      
      k[i - kPeriod + 1] = ((close[i] - lowestLow) / (highestHigh - lowestLow)) * 100;
    }
    
    // Calculer %D
    const d = this.calculateSMA(k, dPeriod);
    
    return { k, d };
  },
  
  // Analyse complète
  analyzeAll(prices, volumes, options = {}) {
    if (!prices || prices.length < 30) return { error: 'Insufficient data' };
    
    const indicators = this.calculateIndicators(prices, options);
    
    // Moyennes mobiles
    const ema50 = prices.length >= 50 ? this.calculateEMA(prices, 50) : [];
    const ema200 = prices.length >= 200 ? this.calculateEMA(prices, 200) : [];
    
    // Analyse de volume
    let volumeAnalysis = null;
    if (volumes && volumes.length === prices.length && volumes.length > 0) {
      const volSMA = this.calculateSMA(volumes, 10);
      const relativeVolume = volumes[volumes.length - 1] / (volSMA[volSMA.length - 1] || 1);
      
      volumeAnalysis = {
        currentVolume: volumes[volumes.length - 1],
        averageVolume: volSMA[volSMA.length - 1],
        relativeVolume,
        increasing: volumes.length > 1 && volumes[volumes.length - 1] > volumes[volumes.length - 2]
      };
    }
    
    // Croisements
    const crossovers = this.detectCrossovers(prices);
    
    return {
      ...indicators,
      ema50: ema50.length > 0 ? ema50[ema50.length - 1] : null,
      ema200: ema200.length > 0 ? ema200[ema200.length - 1] : null,
      volumeAnalysis,
      crossovers,
      priceAction: {
        currentPrice: prices[prices.length - 1],
        previousPrice: prices[prices.length - 2] || null,
        percentChange: prices.length > 1 
          ? ((prices[prices.length - 1] - prices[prices.length - 2]) / prices[prices.length - 2]) * 100 
          : 0
      }
    };
  },
  
  // Détecte les croisements
  detectCrossovers(prices) {
    if (!prices || prices.length < 200) return { ema50_200: 'NONE' };
    
    const ema50 = this.calculateEMA(prices, 50);
    const ema200 = this.calculateEMA(prices, 200);
    
    // Vérifier croisement EMA 50/200
    let ema50_200 = 'NONE';
    
    if (ema50.length > 1 && ema200.length > 1) {
      const current50 = ema50[ema50.length - 1];
      const previous50 = ema50[ema50.length - 2];
      const current200 = ema200[ema200.length - 1];
      const previous200 = ema200[ema200.length - 2];
      
      if (previous50 <= previous200 && current50 > current200) {
        ema50_200 = 'GOLDEN_CROSS';
      } else if (previous50 >= previous200 && current50 < current200) {
        ema50_200 = 'DEATH_CROSS';
      }
    }
    
    return { ema50_200 };
  }
};

export default technicalAnalysis;