import EventEmitter from 'events';

export class BaseStrategy extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.analysisMethods = [];
    this.signals = new Map();
    this.stats = {
      signalsGenerated: 0,
      signalsByType: {
        BUY: 0,
        SELL: 0,
        NONE: 0
      },
      successRate: {
        BUY: { success: 0, total: 0 },
        SELL: { success: 0, total: 0 },
        NONE: { success: 0, total: 0 }
      },
      averageProfit: 0,
      totalProfit: 0
    };
  }

  async analyze(token, prices, volumes, marketData = {}) {
    throw new Error('Method analyze must be implemented by derived class');
  }

  updateConfig(newConfig) {
    if (!newConfig) return;
    this.config = { ...this.config, ...newConfig };
  }

  validateInputData(token, prices, volumes) {
    if (!token) {
      this.emit('warning', 'Token identifier is missing');
      return false;
    }

    if (!prices || !Array.isArray(prices) || prices.length < 10) {
      this.emit('warning', `Insufficient price data for ${token}`);
      return false;
    }

    return true;
  }

  createSignal(type, confidence, reasons = [], details = {}) {
    const signal = {
      type: type.toUpperCase(),
      confidence: parseFloat(confidence.toFixed(4)),
      reasons: Array.isArray(reasons) ? [...reasons] : [reasons],
      timestamp: Date.now(),
      details: { ...details }
    };

    // Update statistics
    this.stats.signalsGenerated++;
    if (this.stats.signalsByType[signal.type] !== undefined) {
      this.stats.signalsByType[signal.type]++;
    }

    return signal;
  }

  applySignalPersistenceFilter(token, newSignal) {
    if (!token || !newSignal) return newSignal;

    const previousSignal = this.signals.get(token);
    if (!previousSignal) {
      this.signals.set(token, newSignal);
      return newSignal;
    }

    // Signal persistence logic
    if (newSignal.type === 'NONE' && previousSignal.type !== 'NONE' && 
        Date.now() - previousSignal.timestamp < 3600000) {
      // Keep previous signal with decreased confidence if it's recent
      const persistedSignal = {
        ...previousSignal,
        confidence: previousSignal.confidence * 0.8,
        reasons: [...previousSignal.reasons, 'PERSISTED_SIGNAL'],
        details: {
          ...previousSignal.details,
          originalConfidence: previousSignal.confidence,
          persistedFrom: previousSignal.timestamp
        }
      };

      // Only persist if confidence is still above minimum threshold
      if (persistedSignal.confidence >= 0.3) {
        this.signals.set(token, persistedSignal);
        return persistedSignal;
      }
    }

    // Update the stored signal
    this.signals.set(token, newSignal);
    return newSignal;
  }

  trackSignal(token, signal) {
    // This will be used to track signal performance
    this.signals.set(token, signal);
  }

  updateTradeResult(token, profit, profitPercentage) {
    const signal = this.signals.get(token);
    if (!signal) return;

    const isSuccess = profit > 0;
    
    // Update success stats
    if (this.stats.successRate[signal.type]) {
      this.stats.successRate[signal.type].total++;
      if (isSuccess) {
        this.stats.successRate[signal.type].success++;
      }
    }

    // Update profit stats
    this.stats.totalProfit += profit;
    const totalTrades = Object.values(this.stats.successRate)
      .reduce((sum, stat) => sum + stat.total, 0);
    
    if (totalTrades > 0) {
      this.stats.averageProfit = this.stats.totalProfit / totalTrades;
    }

    // Remove the signal from tracking
    this.signals.delete(token);
  }

  calculateTrendStrength(prices) {
    if (!prices || prices.length < 2) return 0;
    
    // Linear regression to find trend
    const n = prices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += prices[i];
      sumXY += i * prices[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R-squared to determine trend strength
    let ssRes = 0, ssTot = 0;
    const yMean = sumY / n;
    
    for (let i = 0; i < n; i++) {
      const yPred = slope * i + intercept;
      ssRes += Math.pow(prices[i] - yPred, 2);
      ssTot += Math.pow(prices[i] - yMean, 2);
    }
    
    // R-squared ranges from 0 to 1, we convert to -1 to 1 based on slope
    const r2 = 1 - (ssRes / ssTot);
    return slope > 0 ? r2 : -r2;
  }

  analyzeTrend(prices, periods = [5, 20, 50]) {
    if (!prices || prices.length < Math.max(...periods)) {
      return { direction: 'NEUTRAL', strength: 0 };
    }
    
    const trendStrengths = periods.map(period => {
      const recentPrices = prices.slice(-period);
      return this.calculateTrendStrength(recentPrices);
    });
    
    const avgStrength = trendStrengths.reduce((sum, val) => sum + val, 0) / trendStrengths.length;
    
    let direction = 'NEUTRAL';
    if (avgStrength > 0.3) direction = 'UP';
    else if (avgStrength < -0.3) direction = 'DOWN';
    
    return { 
      direction, 
      strength: Math.abs(avgStrength),
      shortTerm: trendStrengths[0] || 0,
      mediumTerm: trendStrengths[1] || 0,
      longTerm: trendStrengths[2] || 0
    };
  }

  calculateSupportResistance(prices, lookbackPeriods = 3) {
    if (!prices || prices.length < 30) {
      return { supports: [], resistances: [], closestSupport: null, closestResistance: null };
    }
    
    const findLocalExtremes = (data, isPeak) => {
      const extremes = [];
      const compare = isPeak 
        ? (a, b, c) => (b > a && b > c) 
        : (a, b, c) => (b < a && b < c);
        
      for (let i = 5; i < data.length - 5; i++) {
        if (compare(data[i-1], data[i], data[i+1])) {
          extremes.push({
            index: i,
            price: data[i],
            strength: 1
          });
        }
      }
      return extremes;
    };
    
    const periods = [];
    const periodLength = Math.floor(prices.length / lookbackPeriods);
    
    for (let i = 0; i < lookbackPeriods; i++) {
      const start = i * periodLength;
      const end = (i === lookbackPeriods - 1) ? prices.length : (i + 1) * periodLength;
      periods.push(prices.slice(start, end));
    }
    
    let supports = [];
    let resistances = [];
    
    periods.forEach(periodPrices => {
      supports = [...supports, ...findLocalExtremes(periodPrices, false)];
      resistances = [...resistances, ...findLocalExtremes(periodPrices, true)];
    });
    
    // Group similar levels
    const groupLevels = (levels) => {
      const grouped = [];
      const threshold = Math.max(...prices) * 0.01; // 1% threshold
      
      for (const level of levels) {
        let foundGroup = false;
        for (const group of grouped) {
          if (Math.abs(group.price - level.price) < threshold) {
            group.price = (group.price * group.strength + level.price) / (group.strength + 1);
            group.strength += level.strength;
            foundGroup = true;
            break;
          }
        }
        if (!foundGroup) {
          grouped.push({ ...level });
        }
      }
      
      return grouped.sort((a, b) => a.price - b.price);
    };
    
    const groupedSupports = groupLevels(supports);
    const groupedResistances = groupLevels(resistances);
    
    // Find closest levels to current price
    const currentPrice = prices[prices.length - 1];
    let closestSupport = null;
    let closestResistance = null;
    
    for (const support of groupedSupports) {
      if (support.price < currentPrice) {
        if (!closestSupport || (currentPrice - support.price) < (currentPrice - closestSupport.price)) {
          closestSupport = support;
        }
      }
    }
    
    for (const resistance of groupedResistances) {
      if (resistance.price > currentPrice) {
        if (!closestResistance || (resistance.price - currentPrice) < (closestResistance.price - currentPrice)) {
          closestResistance = resistance;
        }
      }
    }
    
    return {
      supports: groupedSupports,
      resistances: groupedResistances,
      closestSupport,
      closestResistance
    };
  }

  analyzeVolumeProfile(volumes, prices) {
    if (!volumes || !prices || volumes.length < 10 || prices.length < 10) {
      return { 
        volumeRatio: 1, 
        volumeTrend: 'NEUTRAL',
        priceVolumeCorrelation: 0
      };
    }
    
    const recentVolumes = volumes.slice(-10);
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeRatio = currentVolume / avgVolume;
    
    let volumeTrend = 'NEUTRAL';
    if (volumeRatio > 1.5) volumeTrend = 'INCREASING';
    else if (volumeRatio < 0.5) volumeTrend = 'DECREASING';
    
    // Calculate price-volume correlation
    const recentPrices = prices.slice(-volumes.length);
    const priceDiffs = [];
    const volumeDiffs = [];
    
    for (let i = 1; i < recentPrices.length; i++) {
      priceDiffs.push(recentPrices[i] - recentPrices[i - 1]);
      volumeDiffs.push(volumes[i] - volumes[i - 1]);
    }
    
    // Calculate correlation coefficient
    let sumProd = 0, sumPriceDiffSq = 0, sumVolumeDiffSq = 0;
    for (let i = 0; i < priceDiffs.length; i++) {
      sumProd += priceDiffs[i] * volumeDiffs[i];
      sumPriceDiffSq += priceDiffs[i] * priceDiffs[i];
      sumVolumeDiffSq += volumeDiffs[i] * volumeDiffs[i];
    }
    
    const correlation = sumProd / (Math.sqrt(sumPriceDiffSq) * Math.sqrt(sumVolumeDiffSq) || 1);
    
    return {
      volumeRatio,
      volumeTrend,
      priceVolumeCorrelation: correlation,
      currentVolume,
      averageVolume: avgVolume
    };
  }

  getPerformanceMetrics() {
    const metrics = { ...this.stats };
    
    // Calculate win rates
    Object.keys(metrics.successRate).forEach(type => {
      const { success, total } = metrics.successRate[type];
      metrics.successRate[type].rate = total > 0 ? (success / total) * 100 : 0;
    });
    
    return metrics;
  }
}

export default BaseStrategy;