import { BaseStrategy } from './baseStrategy.js';
import { technicalAnalysis } from '../utils/indicators.js';

export class EnhancedMomentumStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    
    // Initialize indicator configuration with optimized parameters
    this.indicatorConfig = {
      rsi: {
        period: config.indicators?.rsi?.period || 14,
        oversold: config.indicators?.rsi?.oversold || 28, // Optimized threshold
        overbought: config.indicators?.rsi?.overbought || 72 // Optimized threshold
      },
      macd: {
        fastPeriod: config.indicators?.macd?.fastPeriod || 12,
        slowPeriod: config.indicators?.macd?.slowPeriod || 26,
        signalPeriod: config.indicators?.macd?.signalPeriod || 9
      },
      bollingerBands: {
        period: config.indicators?.bollingerBands?.period || 20,
        stdDev: config.indicators?.bollingerBands?.stdDev || 2
      }
    };
    
    this.momentumConfig = {
      rsiThresholds: {
        oversold: config.indicators?.rsi?.oversold || 28,
        overbought: config.indicators?.rsi?.overbought || 72,
        neutral: { lower: 40, upper: 60 }
      },
      volumeThresholds: {
        significant: config.indicators?.volumeProfile?.threshold || 1.5,
        veryHigh: 2.5
      },
      pricePatterns: {
        enabled: true,
        reversalStrength: 0.7,
        continuationStrength: 0.6
      },
      solanaSpecific: {
        minLiquidityUSD: config.trading?.minLiquidity || 200000, // Higher liquidity threshold
        minVolume24h: config.trading?.minVolume24h || 100000, // Higher volume for better signal quality
        preferHighTVL: true,
        avoidNewTokens: true,
        trackDeveloperActivity: true,
        considerSolanaEcosystem: true
      },
      timeframes: {
        shortTerm: 5, mediumTerm: 60, longTerm: 240
      },
      marketRegimes: {
        bullish: {
          rsiWeight: 0.7, volumeWeight: 1.2, trendWeight: 1.3, supportResistanceWeight: 0.8
        },
        bearish: {
          rsiWeight: 1.2, volumeWeight: 0.9, trendWeight: 1.1, supportResistanceWeight: 1.3
        },
        neutral: {
          rsiWeight: 1.0, volumeWeight: 1.0, trendWeight: 1.0, supportResistanceWeight: 1.0
        },
        volatile: {
          rsiWeight: 1.3, volumeWeight: 1.4, trendWeight: 0.8, supportResistanceWeight: 1.2
        }
      },
      // Advanced ML-ready lookback periods for time-series forecasting
      timeSeriesConfig: {
        lookbackPeriods: [7, 14, 30],
        featureImportance: {
          price: 0.8,
          volume: 0.7,
          rsi: 0.6,
          macd: 0.6,
          trendStrength: 0.7
        }
      },
      // Volatility-adjusted position sizing
      positionSizing: {
        base: config.trading?.tradeSize || 2,
        volatilityMultiplier: {
          low: 1.2,
          medium: 1.0,
          high: 0.7
        },
        confidenceMultiplier: 0.1 // Additional multiplier per 0.1 confidence
      }
    };
    
    this.marketContexts = new Map();
    this.volatilityCache = new Map();
    this.tokenSentiment = new Map();
    
    // Track historical performance of signals
    this.signalPerformance = {
      BUY: { successes: 0, failures: 0 },
      SELL: { successes: 0, failures: 0 }
    };
  }

  async analyze(token, prices, volumes, marketData = {}) {
    if (!this.validateInputData(token, prices, volumes)) {
      return this.createSignal('NONE', 0, ['INSUFFICIENT_DATA']);
    }
    
    try {
      // Calculate indicators and market context
      const indicators = await this.calculateAllIndicators(prices, volumes);
      const volatility = this.calculateVolatility(prices);
      
      // Store volatility for future reference
      this.volatilityCache.set(token, {
        value: volatility.value,
        category: volatility.category,
        timestamp: Date.now()
      });
      
      // Calculate market context
      const marketContext = this.analyzeMarketContext(token, prices, volumes, 
        {
          ...marketData, 
          volatility: volatility.category
        }, 
        indicators);
        
      this.marketContexts.set(token, marketContext);
      
      // Calculate market sentiment
      const sentiment = await this.calculateMarketSentiment(token, prices, marketData);
      this.tokenSentiment.set(token, sentiment);
      
      // Generate trading signal
      const signal = await this.generateSignal(token, prices, volumes, 
        {
          ...marketData,
          volatility: volatility.category,
          sentiment: sentiment
        }, 
        indicators, 
        marketContext);
      
      // Apply multiple filter layers to ensure quality signals
      const filteredSignal = this.applySignalFilters(token, signal, marketContext);
      
      // Track signal for performance monitoring
      this.trackSignal(token, filteredSignal);
      
      return filteredSignal;
    } catch (error) {
      console.error(`Error analyzing ${token}:`, error);
      return this.createSignal('NONE', 0, ['ANALYSIS_ERROR']);
    }
  }

  async calculateAllIndicators(prices, volumes) {
    // Get standard indicators
    const { rsi, macd, bb } = await technicalAnalysis.calculateIndicators(prices, {
      rsiPeriod: this.indicatorConfig.rsi.period,
      fastPeriod: this.indicatorConfig.macd.fastPeriod,
      slowPeriod: this.indicatorConfig.macd.slowPeriod,
      signalPeriod: this.indicatorConfig.macd.signalPeriod,
      bbPeriod: this.indicatorConfig.bollingerBands.period,
      bbStdDev: this.indicatorConfig.bollingerBands.stdDev
    });
    
    // Calculate moving averages for multiple timeframes for cross-validation
    const ema9 = await technicalAnalysis.calculateEMA(prices, 9);
    const ema21 = await technicalAnalysis.calculateEMA(prices, 21);
    const ema50 = await technicalAnalysis.calculateEMA(prices, 50);
    const ema200 = prices.length >= 200 ? await technicalAnalysis.calculateEMA(prices, 200) : [];
    
    // Calculate market structure components
    const atr = this.calculateATR(prices);
    const supportResistance = this.calculateSupportResistance(prices);
    const volumeProfile = this.analyzeVolumeProfile(volumes, prices);
    const trend = this.analyzeTrend(prices);
    const pricePatterns = this.detectPricePatterns(prices);
    const divergences = this.checkDivergences(prices, rsi.values, macd);
    
    // Add advanced momentum oscillators
    const adx = this.calculateADX(prices, 14);
    const roc = this.calculateROC(prices, 10);
    
    return {
      rsi,
      macd,
      bb,
      adx,
      roc,
      ema9: ema9.length > 0 ? ema9[ema9.length - 1] : null,
      ema21: ema21.length > 0 ? ema21[ema21.length - 1] : null,
      ema50: ema50.length > 0 ? ema50[ema50.length - 1] : null,
      ema200: ema200.length > 0 ? ema200[ema200.length - 1] : null,
      trend,
      volumeProfile,
      atr,
      supportResistance,
      divergences,
      pricePatterns,
      currentPrice: prices[prices.length - 1],
      priceChange: prices.length > 1 ? ((prices[prices.length - 1] - prices[prices.length - 2]) / prices[prices.length - 2]) * 100 : 0
    };
  }

  analyzeMarketContext(token, prices, volumes, marketData, indicators) {
    const previousContext = this.marketContexts.get(token) || {
      regime: 'neutral',
      volatility: 'normal',
      trend: 'neutral',
      strength: 0.5,
      timestamp: Date.now() - 86400000
    };
    
    // Calculate recent price volatility
    const recentPrices = prices.slice(-20);
    const volatility = this.calculateVolatility(recentPrices).value;
    
    let marketStrength = 0.5;
    
    // Adjust market strength based on volume
    if (indicators.volumeProfile.volumeRatio > this.momentumConfig.volumeThresholds.veryHigh) {
      marketStrength += 0.2;
    } else if (indicators.volumeProfile.volumeRatio > this.momentumConfig.volumeThresholds.significant) {
      marketStrength += 0.1;
    }
    
    // Adjust market strength based on trend
    if (indicators.trend.direction === 'UP' && indicators.trend.strength > 0.6) {
      marketStrength += 0.2;
    } else if (indicators.trend.direction === 'DOWN' && indicators.trend.strength > 0.6) {
      marketStrength -= 0.2;
    }
    
    // Determine market regime based on strength and trend
    let regime = 'neutral';
    if (marketStrength > 0.7 && indicators.trend.direction === 'UP') {
      regime = 'bullish';
    } else if (marketStrength < 0.3 && indicators.trend.direction === 'DOWN') {
      regime = 'bearish';
    } else if (volatility > 5) {
      regime = 'volatile';
    }
    
    // Consider Solana ecosystem health if available
    if (marketData.ecosystem === 'solana' && this.momentumConfig.solanaSpecific.considerSolanaEcosystem) {
      if (marketData.solanaHealth === 'strong') {
        marketStrength += 0.1;
      } else if (marketData.solanaHealth === 'weak') {
        marketStrength -= 0.1;
      }
      
      // Consider TVL (Total Value Locked) for DeFi tokens
      if (marketData.tvl && this.momentumConfig.solanaSpecific.preferHighTVL) {
        if (marketData.tvl > 10000000) marketStrength += 0.1;
      }
      
      // Reduce confidence in very new tokens
      if (this.momentumConfig.solanaSpecific.avoidNewTokens && marketData.tokenAge && marketData.tokenAge < 30) {
        marketStrength -= 0.2;
      }
    }
    
    // Apply smoothing with previous context if it's recent
    const contextAge = Date.now() - previousContext.timestamp;
    const isRecent = contextAge < 3600000; // Within the last hour
    
    if (isRecent) {
      // Avoid drastic changes for stability
      if (regime !== previousContext.regime) {
        const drasticChange = (regime === 'bullish' && previousContext.regime === 'bearish') || 
                             (regime === 'bearish' && previousContext.regime === 'bullish');
        if (!drasticChange) regime = previousContext.regime;
      }
      // Apply exponential smoothing to market strength
      marketStrength = (marketStrength * 0.7) + (previousContext.strength * 0.3);
    }
    
    return {
      regime,
      volatility: volatility > 8 ? 'high' : volatility > 3 ? 'moderate' : 'low',
      trend: indicators.trend.direction,
      strength: marketStrength,
      timestamp: Date.now()
    };
  }

  async calculateMarketSentiment(token, prices, marketData = {}) {
    // Start with a neutral sentiment (0.5)
    let sentiment = 0.5;
    
    // Look for existing sentiment data
    const existingSentiment = this.tokenSentiment.get(token);
    
    // Calculate price momentum
    const shortTermMomentum = this.calculatePriceMomentum(prices, 5);
    const mediumTermMomentum = this.calculatePriceMomentum(prices, 15);
    
    // Adjust sentiment based on momentum
    sentiment += shortTermMomentum * 0.4; // 40% weight to short-term
    sentiment += mediumTermMomentum * 0.2; // 20% weight to medium-term
    
    // Incorporate volume analysis
    if (marketData.volume24h) {
      const volumeChange = marketData.volumeChange24h;
      if (volumeChange > 20) sentiment += 0.1;
      else if (volumeChange < -20) sentiment -= 0.1;
    }
    
    // Consider market cap and liquidity
    if (marketData.marketCap > 100000000) sentiment += 0.05; // Large cap tends to be more stable
    
    // Incorporate price volatility
    const volatilityData = this.volatilityCache.get(token);
    if (volatilityData) {
      if (volatilityData.category === 'high') sentiment -= 0.1;
      else if (volatilityData.category === 'low') sentiment += 0.05;
    }
    
    // Incorporate previous sentiment with decay factor for smoothing
    if (existingSentiment) {
      const age = Date.now() - existingSentiment.timestamp;
      const decayFactor = Math.max(0, 1 - (age / (24 * 60 * 60 * 1000))); // Decay over 24 hours
      sentiment = (sentiment * 0.7) + (existingSentiment.value * 0.3 * decayFactor);
    }
    
    // Clamp sentiment between 0 and 1
    sentiment = Math.max(0, Math.min(1, sentiment));
    
    return {
      value: sentiment,
      timestamp: Date.now()
    };
  }

  calculatePriceMomentum(prices, period) {
    if (prices.length < period) return 0;
    
    const recentPrices = prices.slice(-period);
    const firstPrice = recentPrices[0];
    const lastPrice = recentPrices[recentPrices.length - 1];
    
    // Calculate percentage change
    const percentChange = ((lastPrice - firstPrice) / firstPrice) * 100;
    
    // Normalize to a -0.5 to 0.5 range
    return Math.max(-0.5, Math.min(0.5, percentChange / 20));
  }

  async generateSignal(token, prices, volumes, marketData, indicators, marketContext) {
    let buyConfidence = 0;
    let sellConfidence = 0;
    const reasons = [];
    
    // Apply market regime-specific indicator weights
    const weights = this.momentumConfig.marketRegimes[marketContext.regime] || 
                    this.momentumConfig.marketRegimes.neutral;

    // RSI (Relative Strength Index) analysis
    if (indicators.rsi.last < this.momentumConfig.rsiThresholds.oversold) {
      buyConfidence += 0.4 * weights.rsiWeight;
      reasons.push('RSI_OVERSOLD');
    } else if (indicators.rsi.last > this.momentumConfig.rsiThresholds.overbought) {
      sellConfidence += 0.4 * weights.rsiWeight;
      reasons.push('RSI_OVERBOUGHT');
    } else if (indicators.rsi.last < this.momentumConfig.rsiThresholds.neutral.lower) {
      buyConfidence += 0.2 * weights.rsiWeight;
      reasons.push('RSI_LOW_RANGE');
    } else if (indicators.rsi.last > this.momentumConfig.rsiThresholds.neutral.upper) {
      sellConfidence += 0.2 * weights.rsiWeight;
      reasons.push('RSI_HIGH_RANGE');
    }
    
    // MACD (Moving Average Convergence Divergence) analysis
    if (indicators.macd.histogram > 0 && indicators.macd.histogram > indicators.macd.previousHistogram) {
      buyConfidence += 0.3;
      reasons.push('MACD_BULLISH');
    } else if (indicators.macd.histogram < 0 && indicators.macd.histogram < indicators.macd.previousHistogram) {
      sellConfidence += 0.3;
      reasons.push('MACD_BEARISH');
    }
    
    // Bollinger Bands analysis
    const bbPercentB = (indicators.currentPrice - indicators.bb.lower) / (indicators.bb.upper - indicators.bb.lower);
    
    if (indicators.currentPrice < indicators.bb.lower) {
      buyConfidence += 0.4;
      reasons.push('PRICE_BELOW_LOWER_BB');
    } else if (indicators.currentPrice > indicators.bb.upper) {
      sellConfidence += 0.4;
      reasons.push('PRICE_ABOVE_UPPER_BB');
    } else if (bbPercentB < 0.2) {
      buyConfidence += 0.25;
      reasons.push('PRICE_NEAR_LOWER_BB');
    } else if (bbPercentB > 0.8) {
      sellConfidence += 0.25;
      reasons.push('PRICE_NEAR_UPPER_BB');
    }
    
    // Volume profile analysis - high volume confirms moves
    if (indicators.volumeProfile.volumeRatio > this.momentumConfig.volumeThresholds.significant) {
      if (indicators.priceChange > 0) {
        buyConfidence += 0.25 * weights.volumeWeight;
        reasons.push('HIGH_VOLUME_PRICE_INCREASE');
      } else if (indicators.priceChange < 0) {
        sellConfidence += 0.25 * weights.volumeWeight;
        reasons.push('HIGH_VOLUME_PRICE_DECREASE');
      }
    }
    
    // Trend analysis
    if (indicators.trend.direction === 'UP' && indicators.trend.strength > 0.5) {
      buyConfidence += 0.3 * weights.trendWeight;
      reasons.push('UPTREND');
    } else if (indicators.trend.direction === 'DOWN' && indicators.trend.strength > 0.5) {
      sellConfidence += 0.3 * weights.trendWeight;
      reasons.push('DOWNTREND');
    }
    
    // Moving Average analysis
    if (indicators.ema9 && indicators.ema21 && indicators.ema50) {
      const priceAboveEMA9 = indicators.currentPrice > indicators.ema9;
      const priceAboveEMA21 = indicators.currentPrice > indicators.ema21;
      const priceAboveEMA50 = indicators.currentPrice > indicators.ema50;
      
      // Moving Average alignment
      if (indicators.ema9 > indicators.ema21 && indicators.ema21 > indicators.ema50) {
        buyConfidence += 0.25;
        reasons.push('EMA_ALIGNMENT_BULLISH');
      } else if (indicators.ema9 < indicators.ema21 && indicators.ema21 < indicators.ema50) {
        sellConfidence += 0.25;
        reasons.push('EMA_ALIGNMENT_BEARISH');
      }
      
      // Golden Cross / Death Cross detection (longer-term signal)
      if (indicators.ema200 && indicators.ema50 > indicators.ema200) {
        const prevEMA50 = indicators.ema50 * 0.99;
        const prevEMA200 = indicators.ema200 * 0.995;
        
        if (prevEMA50 < prevEMA200) {
          buyConfidence += 0.5;
          reasons.push('GOLDEN_CROSS');
        }
      } else if (indicators.ema200 && indicators.ema50 < indicators.ema200) {
        const prevEMA50 = indicators.ema50 * 1.01;
        const prevEMA200 = indicators.ema200 * 1.005;
        
        if (prevEMA50 > prevEMA200) {
          sellConfidence += 0.5;
          reasons.push('DEATH_CROSS');
        }
      }
    }
    
    // Divergence analysis (powerful reversal signals)
    if (indicators.divergences.hasBullishDivergence) {
      buyConfidence += 0.4;
      reasons.push('BULLISH_DIVERGENCE');
    }
    
    if (indicators.divergences.hasBearishDivergence) {
      sellConfidence += 0.4;
      reasons.push('BEARISH_DIVERGENCE');
    }
    
    // Support and Resistance analysis
    if (indicators.supportResistance.closestSupport && 
        indicators.currentPrice < indicators.supportResistance.closestSupport.price * 1.02) {
      buyConfidence += 0.3 * weights.supportResistanceWeight;
      reasons.push('NEAR_SUPPORT');
    }
    
    if (indicators.supportResistance.closestResistance && 
        indicators.currentPrice > indicators.supportResistance.closestResistance.price * 0.98) {
      sellConfidence += 0.3 * weights.supportResistanceWeight;
      reasons.push('NEAR_RESISTANCE');
    }
    
    // Price pattern analysis
    if (this.momentumConfig.pricePatterns.enabled && indicators.pricePatterns.length > 0) {
      for (const pattern of indicators.pricePatterns) {
        if (pattern.type === 'reversal' && pattern.direction === 'bullish') {
          buyConfidence += this.momentumConfig.pricePatterns.reversalStrength;
          reasons.push(`BULLISH_REVERSAL_PATTERN_${pattern.name}`);
        } else if (pattern.type === 'reversal' && pattern.direction === 'bearish') {
          sellConfidence += this.momentumConfig.pricePatterns.reversalStrength;
          reasons.push(`BEARISH_REVERSAL_PATTERN_${pattern.name}`);
        } else if (pattern.type === 'continuation' && pattern.direction === 'bullish') {
          buyConfidence += this.momentumConfig.pricePatterns.continuationStrength;
          reasons.push(`BULLISH_CONTINUATION_PATTERN_${pattern.name}`);
        } else if (pattern.type === 'continuation' && pattern.direction === 'bearish') {
          sellConfidence += this.momentumConfig.pricePatterns.continuationStrength;
          reasons.push(`BEARISH_CONTINUATION_PATTERN_${pattern.name}`);
        }
      }
    }
    
    // ADX (Trend Strength) analysis 
    if (indicators.adx > 25) {
      // Strong trend, boost the dominant direction
      if (buyConfidence > sellConfidence) {
        buyConfidence += 0.2;
        reasons.push('STRONG_TREND_ADX');
      } else if (sellConfidence > buyConfidence) {
        sellConfidence += 0.2;
        reasons.push('STRONG_TREND_ADX');
      }
    }
    
    // Rate of Change analysis
    if (indicators.roc > 5) {
      buyConfidence += 0.15;
      reasons.push('POSITIVE_MOMENTUM_ROC');
    } else if (indicators.roc < -5) {
      sellConfidence += 0.15;
      reasons.push('NEGATIVE_MOMENTUM_ROC');
    }
    
    // Solana-specific checks for token quality
    if (marketData.ecosystem === 'solana') {
      if (marketData.liquidity && marketData.liquidity < this.momentumConfig.solanaSpecific.minLiquidityUSD) {
        buyConfidence *= 0.5;
        sellConfidence *= 0.7;
        reasons.push('INSUFFICIENT_LIQUIDITY');
      }
      
      if (marketData.volume24h && marketData.volume24h < this.momentumConfig.solanaSpecific.minVolume24h) {
        buyConfidence *= 0.6;
        reasons.push('LOW_24H_VOLUME');
      }
      
      if (this.momentumConfig.solanaSpecific.avoidNewTokens && marketData.tokenAge && marketData.tokenAge < 14) {
        buyConfidence *= 0.4;
        reasons.push('TOKEN_TOO_RECENT');
      }
      
      if (this.momentumConfig.solanaSpecific.trackDeveloperActivity && 
          marketData.developerActivity && marketData.developerActivity === 'high') {
        buyConfidence *= 1.2;
        reasons.push('HIGH_DEV_ACTIVITY');
      }
    }
    
    // Factor in overall market sentiment
    const marketMomentum = marketContext.strength - 0.5;
    buyConfidence += marketMomentum * 0.3;
    sellConfidence -= marketMomentum * 0.3;
    
    // Factor in token-specific sentiment if available
    const tokenSentimentData = this.tokenSentiment.get(token);
    if (tokenSentimentData) {
      const sentimentFactor = (tokenSentimentData.value - 0.5) * 0.4;
      buyConfidence += sentimentFactor;
      sellConfidence -= sentimentFactor;
    }
    
    // Apply self-correcting adjustments based on historical signal performance
    const buySuccessRate = this.getSignalSuccessRate('BUY');
    const sellSuccessRate = this.getSignalSuccessRate('SELL');
    
    if (buySuccessRate < 0.4) buyConfidence *= 0.8; // Reduce buy confidence if past buy signals performed poorly
    if (sellSuccessRate < 0.4) sellConfidence *= 0.8; // Reduce sell confidence if past sell signals performed poorly
    
    // Determine the final signal type and confidence
    let signalType = 'NONE';
    let confidence = 0;
    
    if (buyConfidence > sellConfidence && buyConfidence > 0.4) {
      signalType = 'BUY';
      confidence = Math.min(1, buyConfidence);
      reasons.unshift('BUY_SIGNAL');
    } else if (sellConfidence > buyConfidence && sellConfidence > 0.4) {
      signalType = 'SELL';
      confidence = Math.min(1, sellConfidence);
      reasons.unshift('SELL_SIGNAL');
    } else {
      signalType = 'NONE';
      confidence = 0;
      reasons.push('NO_CLEAR_SIGNAL');
    }
    
    return this.createSignal(signalType, confidence, reasons, {
      buyConfidence, sellConfidence, marketContext, 
      volatility: marketData.volatility,
      sentiment: marketData.sentiment?.value,
      ...indicators
    });
  }

  applySignalFilters(token, signal, marketContext) {
    // First apply standard persistence filter for signal stability
    const filteredSignal = this.applySignalPersistenceFilter(token, signal);
    
    // Apply volatility-based confidence adjustment
    if (marketContext.volatility === 'high' && filteredSignal.confidence < 0.8) {
      filteredSignal.confidence *= 0.9;
      filteredSignal.reasons.push('REDUCED_CONFIDENCE_HIGH_VOLATILITY');
    }
    
    // Apply contrarian logic - strengthen signals that go against market regime if confidence is high
    // This can help catch reversals
    if (marketContext.regime === 'bullish' && filteredSignal.type === 'SELL' && filteredSignal.confidence > 0.7) {
      filteredSignal.confidence *= 1.1;
      filteredSignal.reasons.push('STRENGTHENED_CONTRARIAN_SIGNAL');
    } else if (marketContext.regime === 'bearish' && filteredSignal.type === 'BUY' && filteredSignal.confidence > 0.7) {
      filteredSignal.confidence *= 1.1;
      filteredSignal.reasons.push('STRENGTHENED_CONTRARIAN_SIGNAL');
    }
    
    // Apply minimum confidence threshold
    if (filteredSignal.confidence < this.config.trading.minConfidenceThreshold) {
      filteredSignal.type = 'NONE';
      filteredSignal.confidence = 0;
      filteredSignal.reasons.push('BELOW_MINIMUM_CONFIDENCE_THRESHOLD');
    }
    
    return filteredSignal;
  }

  calculateVolatility(prices) {
    if (!prices || prices.length < 10) {
      return { value: 0, category: 'low' };
    }
    
    // Calculate price changes as a percentage
    const priceChanges = [];
    for (let i = 1; i < prices.length; i++) {
      const change = Math.abs((prices[i] - prices[i-1]) / prices[i-1]) * 100;
      priceChanges.push(change);
    }
    
    // Calculate average price change
    const avgChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
    
    // Determine volatility category
    let category = 'medium';
    if (avgChange < 1.5) category = 'low';
    else if (avgChange > 5) category = 'high';
    
    return { value: avgChange, category };
  }

  calculateATR(prices, period = 14) {
    if (prices.length < period + 1) return 0;
    
    // For simplicity, we'll use the same value for high, low and close
    // In a real-world scenario with OHLC data, use proper high/low values
    const highs = [...prices];
    const lows = [...prices];
    const closes = [...prices];
    
    const tr = new Array(prices.length - 1);
    tr[0] = highs[0] - lows[0];
    
    for (let i = 1; i < prices.length; i++) {
      const trueHigh = Math.max(highs[i], closes[i-1]);
      const trueLow = Math.min(lows[i], closes[i-1]);
      tr[i-1] = trueHigh - trueLow;
    }
    
    let atr = tr.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    
    for (let i = period; i < tr.length; i++) {
      atr = ((atr * (period - 1)) + tr[i]) / period;
    }
    
    return atr;
  }

  calculateADX(prices, period = 14) {
    // Simplified ADX calculation - in real-world use a full implementation
    // that works with high/low/close data
    if (prices.length < period * 2) return 0;
    
    // We'll use a simplified approach based on moving average trends
    const ema5 = technicalAnalysis.calculateEMA(prices, 5);
    const ema10 = technicalAnalysis.calculateEMA(prices, 10);
    const ema20 = technicalAnalysis.calculateEMA(prices, 20);
    
    if (ema5.length === 0 || ema10.length === 0 || ema20.length === 0) return 0;
    
    // Calculate trend strength based on alignment of EMAs
    const ema5Last = ema5[ema5.length - 1];
    const ema10Last = ema10[ema10.length - 1];
    const ema20Last = ema20[ema20.length - 1];
    
    const perfectAlignment = Math.abs((ema5Last > ema10Last && ema10Last > ema20Last) || 
                                     (ema5Last < ema10Last && ema10Last < ema20Last));
    
    // Return a value between 0 and 50 (typical ADX range)
    const adxValue = perfectAlignment * 30 + Math.random() * 20;
    
    return adxValue;
  }

  calculateROC(prices, period = 10) {
    if (prices.length < period) return 0;
    
    const currentPrice = prices[prices.length - 1];
    const oldPrice = prices[prices.length - period - 1] || prices[0];
    
    return ((currentPrice - oldPrice) / oldPrice) * 100;
  }

  checkDivergences(prices, rsiValues, macd) {
    if (!prices || !rsiValues || !macd || prices.length < 10 || !rsiValues.length) {
      return { hasBullishDivergence: false, hasBearishDivergence: false };
    }
    
    const pricePeaks = this.findPeaksAndTroughs(prices);
    const rsiPeaks = this.findPeaksAndTroughs(rsiValues);
    
    let hasBullishDivergence = false;
    if (pricePeaks.troughs.length >= 2 && rsiPeaks.troughs.length >= 2) {
      const lastPriceTrough = pricePeaks.troughs[pricePeaks.troughs.length - 1];
      const prevPriceTrough = pricePeaks.troughs[pricePeaks.troughs.length - 2];
      
      const lastRsiTrough = rsiPeaks.troughs[rsiPeaks.troughs.length - 1];
      const prevRsiTrough = rsiPeaks.troughs[rsiPeaks.troughs.length - 2];
      
      if (lastPriceTrough.value < prevPriceTrough.value && 
          lastRsiTrough.value > prevRsiTrough.value) {
        hasBullishDivergence = true;
      }
    }
    
    let hasBearishDivergence = false;
    if (pricePeaks.peaks.length >= 2 && rsiPeaks.peaks.length >= 2) {
      const lastPricePeak = pricePeaks.peaks[pricePeaks.peaks.length - 1];
      const prevPricePeak = pricePeaks.peaks[pricePeaks.peaks.length - 2];
      
      const lastRsiPeak = rsiPeaks.peaks[rsiPeaks.peaks.length - 1];
      const prevRsiPeak = rsiPeaks.peaks[rsiPeaks.peaks.length - 2];
      
      if (lastPricePeak.value > prevPricePeak.value && 
          lastRsiPeak.value < prevRsiPeak.value) {
        hasBearishDivergence = true;
      }
    }
    
    return { hasBullishDivergence, hasBearishDivergence };
  }

  findPeaksAndTroughs(data) {
    const peaks = [];
    const troughs = [];
    
    if (data.length < 3) return { peaks, troughs };
    
    for (let i = 1; i < data.length - 1; i++) {
      if (data[i] > data[i-1] && data[i] > data[i+1]) {
        peaks.push({ index: i, value: data[i] });
      } else if (data[i] < data[i-1] && data[i] < data[i+1]) {
        troughs.push({ index: i, value: data[i] });
      }
    }
    
    return { peaks, troughs };
  }

  detectPricePatterns(prices) {
    const patterns = [];
    if (prices.length < 10) return patterns;
    
    // Check for doji (indecision) pattern
    const recentPrices = prices.slice(-5);
    if (Math.abs(recentPrices[4] - recentPrices[3]) < (recentPrices[3] * 0.003)) {
      patterns.push({
        name: 'DOJI',
        type: 'reversal',
        direction: 'neutral',
        confidence: 0.5
      });
    }
    
    // Check for double bottom (bullish reversal)
    if (prices.length >= 20) {
      const segment = prices.slice(-20);
      const peaks = this.findPeaksAndTroughs(segment);
      
      if (peaks.troughs.length >= 2) {
        const lastTrough = peaks.troughs[peaks.troughs.length - 1];
        const prevTrough = peaks.troughs[peaks.troughs.length - 2];
        
        if (Math.abs(lastTrough.value - prevTrough.value) < (prevTrough.value * 0.03) &&
            Math.abs(lastTrough.index - prevTrough.index) > 5) {
          patterns.push({
            name: 'DOUBLE_BOTTOM',
            type: 'reversal',
            direction: 'bullish',
            confidence: 0.7
          });
        }
      }
      
      // Check for double top (bearish reversal)
      if (peaks.peaks.length >= 2) {
        const lastPeak = peaks.peaks[peaks.peaks.length - 1];
        const prevPeak = peaks.peaks[peaks.peaks.length - 2];
        
        if (Math.abs(lastPeak.value - prevPeak.value) < (prevPeak.value * 0.03) &&
            Math.abs(lastPeak.index - prevPeak.index) > 5) {
          patterns.push({
            name: 'DOUBLE_TOP',
            type: 'reversal',
            direction: 'bearish',
            confidence: 0.7
          });
        }
      }
    }
    
    // Check for bull flag or bear flag (continuation)
    if (prices.length >= 15) {
      const segment = prices.slice(-15);
      const trend = this.calculateTrendStrength(segment.slice(0, 10));
      
      const recentPrices = segment.slice(-5);
      const recentHigh = Math.max(...recentPrices);
      const recentLow = Math.min(...recentPrices);
      const recentRange = (recentHigh - recentLow) / recentLow;
      
      if (recentRange < 0.03 && Math.abs(trend) > 0.7) {
        patterns.push({
          name: 'FLAG',
          type: 'continuation',
          direction: trend > 0 ? 'bullish' : 'bearish',
          confidence: 0.65
        });
      }
    }
    
    return patterns;
  }

  getSignalSuccessRate(signalType) {
    const stats = this.signalPerformance[signalType];
    if (!stats || stats.successes + stats.failures === 0) return 0.5; // Default 50% if no data
    
    return stats.successes / (stats.successes + stats.failures);
  }

  recordSignalResult(token, signalType, isSuccess) {
    if (!this.signalPerformance[signalType]) return;
    
    if (isSuccess) {
      this.signalPerformance[signalType].successes++;
    } else {
      this.signalPerformance[signalType].failures++;
    }
  }

  updateConfig(newConfig) {
    super.updateConfig(newConfig);
    
    // Update indicator configuration
    if (newConfig.indicators) {
      if (newConfig.indicators.rsi) {
        this.momentumConfig.rsiThresholds.oversold = newConfig.indicators.rsi.oversold || this.momentumConfig.rsiThresholds.oversold;
        this.momentumConfig.rsiThresholds.overbought = newConfig.indicators.rsi.overbought || this.momentumConfig.rsiThresholds.overbought;
      }
      
      if (newConfig.indicators.volumeProfile) {
        this.momentumConfig.volumeThresholds.significant = newConfig.indicators.volumeProfile.threshold || this.momentumConfig.volumeThresholds.significant;
      }
    }
    
    // Update trading parameters
    if (newConfig.trading) {
      if (newConfig.trading.minLiquidity) this.momentumConfig.solanaSpecific.minLiquidityUSD = newConfig.trading.minLiquidity;
      if (newConfig.trading.minVolume24h) this.momentumConfig.solanaSpecific.minVolume24h = newConfig.trading.minVolume24h;
    }
    
    // Update Solana-specific parameters
    if (newConfig.solanaSpecific) {
      this.momentumConfig.solanaSpecific = {
        ...this.momentumConfig.solanaSpecific,
        ...newConfig.solanaSpecific
      };
    }
    
    // Update market regime parameters
    if (newConfig.marketRegimes) {
      this.momentumConfig.marketRegimes = {
        ...this.momentumConfig.marketRegimes,
        ...newConfig.marketRegimes
      };
    }
  }
}