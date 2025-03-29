// strategies/enhancedMomentumStrategy.js - Stratégie optimisée pour Solana
import { BaseStrategy } from './baseStrategy.js';
import { technicalAnalysis } from '../utils/indicators.js';

export class EnhancedMomentumStrategy extends BaseStrategy {
  constructor(config) {
    super(config);
    
    // Configuration spécifique à la stratégie de momentum améliorée
    this.momentumConfig = {
      rsiThresholds: {
        oversold: config.indicators?.rsi?.oversold || 30,
        overbought: config.indicators?.rsi?.overbought || 70,
        neutral: {
          lower: 40,
          upper: 60
        }
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
        // Paramètres spécifiques au réseau Solana
        minLiquidityUSD: config.trading?.minLiquidity || 100000,  // Liquidité minimale en USD
        minVolume24h: config.trading?.minVolume24h || 50000,      // Volume minimal sur 24h
        preferHighTVL: true,                                      // Préférence pour les tokens avec TVL élevée
        avoidNewTokens: true,                                    // Éviter les tokens trop récents
        trackDeveloperActivity: true,                             // Suivre l'activité des développeurs
        considerSolanaEcosystem: true                            // Prendre en compte l'écosystème Solana dans son ensemble
      },
      timeframes: {
        shortTerm: 5,  // en minutes
        mediumTerm: 60, // en minutes
        longTerm: 240  // en minutes
      },
      marketRegimes: {
        bullish: {
          rsiWeight: 0.7,
          volumeWeight: 1.2,
          trendWeight: 1.3,
          supportResistanceWeight: 0.8
        },
        bearish: {
          rsiWeight: 1.2,
          volumeWeight: 0.9,
          trendWeight: 1.1,
          supportResistanceWeight: 1.3
        },
        neutral: {
          rsiWeight: 1.0,
          volumeWeight: 1.0,
          trendWeight: 1.0,
          supportResistanceWeight: 1.0
        },
        volatile: {
          rsiWeight: 1.3,
          volumeWeight: 1.4,
          trendWeight: 0.8,
          supportResistanceWeight: 1.2
        }
      }
    };
    
    // État pour suivre les contextes de marché
    this.marketContexts = new Map();
  }

  async analyze(token, prices, volumes, marketData = {}) {
    // Vérifier les données en entrée
    if (!this.validateInputData(token, prices, volumes)) {
      return this.createSignal('NONE', 0, ['DONNÉES_INSUFFISANTES']);
    }
    
    try {
      // Calculer tous les indicateurs techniques
      const indicators = await this.calculateAllIndicators(prices, volumes);
      
      // Analyser le contexte du marché et déterminer le régime de marché
      const marketContext = this.analyzeMarketContext(token, prices, volumes, marketData, indicators);
      this.marketContexts.set(token, marketContext);
      
      // Générer les signaux basés sur tous les indicateurs et le contexte de marché
      const signal = await this.generateSignal(token, prices, volumes, marketData, indicators, marketContext);
      
      // Appliquer le filtre de persistance du signal et autres filtres
      const filteredSignal = this.applySignalFilters(token, signal, marketContext);
      
      // Suivre le signal pour les métriques de performance
      this.trackSignal(token, filteredSignal);
      
      return filteredSignal;
    } catch (error) {
      console.error(`Erreur lors de l'analyse pour ${token}:`, error);
      return this.createSignal('NONE', 0, ['ERREUR_ANALYSE']);
    }
  }

  async calculateAllIndicators(prices, volumes) {
    // Données de base
    const { rsi, macd, bb } = await technicalAnalysis.calculateIndicators(prices, {
      rsiPeriod: this.indicatorConfig.rsi.period,
      fastPeriod: this.indicatorConfig.macd.fastPeriod,
      slowPeriod: this.indicatorConfig.macd.slowPeriod,
      signalPeriod: this.indicatorConfig.macd.signalPeriod,
      bbPeriod: this.indicatorConfig.bollingerBands.period,
      bbStdDev: this.indicatorConfig.bollingerBands.stdDev
    });
    
    // Moyennes mobiles
    const ema9 = await technicalAnalysis.calculateEMA(prices, 9);
    const ema21 = await technicalAnalysis.calculateEMA(prices, 21);
    const ema50 = await technicalAnalysis.calculateEMA(prices, 50);
    const ema200 = prices.length >= 200 ? await technicalAnalysis.calculateEMA(prices, 200) : [];
    
    // Autres indicateurs avancés
    const atr = prices.length >= 15 ? this.calculateATR(prices) : 0;
    const supportResistance = this.calculateSupportResistance(prices);
    const volumeProfile = this.analyzeVolumeProfile(volumes, prices);
    const trend = this.analyzeTrend(prices);
    const pricePatterns = this.detectPricePatterns(prices);
    
    // Signaux de divergence
    const divergences = this.checkDivergences(prices, rsi.values, macd);
    
    return {
      rsi,
      macd,
      bb,
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
    // Récupérer le contexte précédent si disponible
    const previousContext = this.marketContexts.get(token) || {
      regime: 'neutral',
      volatility: 'normal',
      trend: 'neutral',
      strength: 0.5,
      timestamp: Date.now() - 86400000 // Hier par défaut
    };
    
    // Calculer la volatilité actuelle
    const recentPrices = prices.slice(-20);
    const volatility = technicalAnalysis.standardDeviation(recentPrices) / (recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length) * 100;
    
    // Déterminer la force du marché basée sur volume et price action
    let marketStrength = 0.5; // Valeur par défaut neutre
    
    // Ajuster en fonction du volume
    if (indicators.volumeProfile.volumeRatio > this.momentumConfig.volumeThresholds.veryHigh) {
      marketStrength += 0.2;
    } else if (indicators.volumeProfile.volumeRatio > this.momentumConfig.volumeThresholds.significant) {
      marketStrength += 0.1;
    }
    
    // Ajuster en fonction de la tendance
    if (indicators.trend.direction === 'UP' && indicators.trend.strength > 0.6) {
      marketStrength += 0.2;
    } else if (indicators.trend.direction === 'DOWN' && indicators.trend.strength > 0.6) {
      marketStrength -= 0.2;
    }
    
    // Déterminer le régime de marché
    let regime = 'neutral';
    if (marketStrength > 0.7 && indicators.trend.direction === 'UP') {
      regime = 'bullish';
    } else if (marketStrength < 0.3 && indicators.trend.direction === 'DOWN') {
      regime = 'bearish';
    } else if (volatility > 5) { // 5% considéré comme volatil
      regime = 'volatile';
    }
    
    // Intégrer les données spécifiques de Solana, si disponibles
    if (marketData.ecosystem === 'solana' && this.momentumConfig.solanaSpecific.considerSolanaEcosystem) {
      // Ajuster en fonction de la santé générale de l'écosystème Solana
      if (marketData.solanaHealth === 'strong') {
        marketStrength += 0.1;
      } else if (marketData.solanaHealth === 'weak') {
        marketStrength -= 0.1;
      }
      
      // Ajuster en fonction de la TVL (Total Value Locked)
      if (marketData.tvl && this.momentumConfig.solanaSpecific.preferHighTVL) {
        if (marketData.tvl > 10000000) { // > 10M
          marketStrength += 0.1;
        }
      }
      
      // Éviter les nouveaux tokens si configuré
      if (this.momentumConfig.solanaSpecific.avoidNewTokens && marketData.tokenAge && marketData.tokenAge < 30) {
        marketStrength -= 0.2;
      }
    }
    
    // Intégrer l'historique du contexte (éviter les changements drastiques)
    const contextAge = Date.now() - previousContext.timestamp;
    const isRecent = contextAge < 3600000; // moins d'une heure
    
    if (isRecent) {
      // Lisser les transitions de régime
      if (regime !== previousContext.regime) {
        // Garder le régime précédent si le nouveau n'est pas drastiquement différent
        const drasticChange = (regime === 'bullish' && previousContext.regime === 'bearish') || 
                             (regime === 'bearish' && previousContext.regime === 'bullish');
        
        if (!drasticChange) {
          regime = previousContext.regime;
        }
      }
      
      // Lisser la force du marché
      marketStrength = (marketStrength * 0.7) + (previousContext.strength * 0.3);
    }
    
    // Contexte de marché final
    return {
      regime,
      volatility: volatility > 8 ? 'high' : volatility > 3 ? 'moderate' : 'low',
      trend: indicators.trend.direction,
      strength: marketStrength,
      timestamp: Date.now()
    };
  }

  async generateSignal(token, prices, volumes, marketData, indicators, marketContext) {
    // Points de base pour la confiance du signal
    let buyConfidence = 0;
    let sellConfidence = 0;
    const reasons = [];
    
    // Poids des indicateurs basés sur le régime de marché
    const weights = this.momentumConfig.marketRegimes[marketContext.regime] || this.momentumConfig.marketRegimes.neutral;
    
    // Analyse RSI
    if (indicators.rsi.last < this.momentumConfig.rsiThresholds.oversold) {
      buyConfidence += 0.4 * weights.rsiWeight;
      reasons.push('RSI_SURVENTE');
    } else if (indicators.rsi.last > this.momentumConfig.rsiThresholds.overbought) {
      sellConfidence += 0.4 * weights.rsiWeight;
      reasons.push('RSI_SURACHAT');
    } else if (indicators.rsi.last < this.momentumConfig.rsiThresholds.neutral.lower) {
      buyConfidence += 0.2 * weights.rsiWeight;
      reasons.push('RSI_ZONE_BASSE');
    } else if (indicators.rsi.last > this.momentumConfig.rsiThresholds.neutral.upper) {
      sellConfidence += 0.2 * weights.rsiWeight;
      reasons.push('RSI_ZONE_HAUTE');
    }
    
    // Analyse MACD
    if (indicators.macd.histogram > 0 && indicators.macd.histogram > indicators.macd.previousHistogram) {
      buyConfidence += 0.3;
      reasons.push('MACD_BULLISH');
    } else if (indicators.macd.histogram < 0 && indicators.macd.histogram < indicators.macd.previousHistogram) {
      sellConfidence += 0.3;
      reasons.push('MACD_BEARISH');
    }
    
    // Analyse des Bandes de Bollinger
    const bbPercentB = (indicators.currentPrice - indicators.bb.lower) / (indicators.bb.upper - indicators.bb.lower);
    
    if (indicators.currentPrice < indicators.bb.lower) {
      buyConfidence += 0.4;
      reasons.push('PRIX_SOUS_BB_INFÉRIEURE');
    } else if (indicators.currentPrice > indicators.bb.upper) {
      sellConfidence += 0.4;
      reasons.push('PRIX_AU_DESSUS_BB_SUPÉRIEURE');
    } else if (bbPercentB < 0.2) {
      buyConfidence += 0.25;
      reasons.push('PRIX_PROCHE_BB_INFÉRIEURE');
    } else if (bbPercentB > 0.8) {
      sellConfidence += 0.25;
      reasons.push('PRIX_PROCHE_BB_SUPÉRIEURE');
    }
    
    // Analyse du volume
    if (indicators.volumeProfile.volumeRatio > this.momentumConfig.volumeThresholds.significant) {
      if (indicators.priceChange > 0) {
        buyConfidence += 0.25 * weights.volumeWeight;
        reasons.push('VOLUME_ELEVÉ_PRIX_HAUSSE');
      } else if (indicators.priceChange < 0) {
        sellConfidence += 0.25 * weights.volumeWeight;
        reasons.push('VOLUME_ELEVÉ_PRIX_BAISSE');
      }
    }
    
    // Analyse des tendances avec poids du régime
    if (indicators.trend.direction === 'UP' && indicators.trend.strength > 0.5) {
      buyConfidence += 0.3 * weights.trendWeight;
      reasons.push('TENDANCE_HAUSSIÈRE');
    } else if (indicators.trend.direction === 'DOWN' && indicators.trend.strength > 0.5) {
      sellConfidence += 0.3 * weights.trendWeight;
      reasons.push('TENDANCE_BAISSIÈRE');
    }
    
    // Analyse des moyennes mobiles
    if (indicators.ema9 && indicators.ema21 && indicators.ema50) {
      const priceAboveEMA9 = indicators.currentPrice > indicators.ema9;
      const priceAboveEMA21 = indicators.currentPrice > indicators.ema21;
      const priceAboveEMA50 = indicators.currentPrice > indicators.ema50;
      
      // Configuration haussière: EMA9 > EMA21 > EMA50
      if (indicators.ema9 > indicators.ema21 && indicators.ema21 > indicators.ema50) {
        buyConfidence += 0.25;
        reasons.push('EMA_ALIGNMENT_BULLISH');
      } 
      // Configuration baissière: EMA9 < EMA21 < EMA50
      else if (indicators.ema9 < indicators.ema21 && indicators.ema21 < indicators.ema50) {
        sellConfidence += 0.25;
        reasons.push('EMA_ALIGNMENT_BEARISH');
      }
      
      // Golden Cross (EMA50 croise au-dessus de EMA200)
      if (indicators.ema200 && indicators.ema50 > indicators.ema200) {
        const prevEMA50 = indicators.ema50 * 0.99; // estimation approximative
        const prevEMA200 = indicators.ema200 * 0.995;
        
        if (prevEMA50 < prevEMA200) {
          buyConfidence += 0.5;
          reasons.push('GOLDEN_CROSS');
        }
      } 
      // Death Cross (EMA50 croise en-dessous de EMA200)
      else if (indicators.ema200 && indicators.ema50 < indicators.ema200) {
        const prevEMA50 = indicators.ema50 * 1.01; // estimation approximative
        const prevEMA200 = indicators.ema200 * 1.005;
        
        if (prevEMA50 > prevEMA200) {
          sellConfidence += 0.5;
          reasons.push('DEATH_CROSS');
        }
      }
    }
    
    // Analyser les divergences
    if (indicators.divergences.hasBullishDivergence) {
      buyConfidence += 0.4;
      reasons.push('DIVERGENCE_HAUSSIÈRE');
    }
    
    if (indicators.divergences.hasBearishDivergence) {
      sellConfidence += 0.4;
      reasons.push('DIVERGENCE_BAISSIÈRE');
    }
    
    // Analyser les niveaux de support et résistance
    if (indicators.supportResistance.closestSupport && 
        indicators.currentPrice < indicators.supportResistance.closestSupport.price * 1.02) {
      buyConfidence += 0.3 * weights.supportResistanceWeight;
      reasons.push('PROCHE_SUPPORT');
    }
    
    if (indicators.supportResistance.closestResistance && 
        indicators.currentPrice > indicators.supportResistance.closestResistance.price * 0.98) {
      sellConfidence += 0.3 * weights.supportResistanceWeight;
      reasons.push('PROCHE_RÉSISTANCE');
    }
    
    // Analyser les modèles de prix (price patterns)
    if (this.momentumConfig.pricePatterns.enabled && indicators.pricePatterns.length > 0) {
      for (const pattern of indicators.pricePatterns) {
        if (pattern.type === 'reversal' && pattern.direction === 'bullish') {
          buyConfidence += this.momentumConfig.pricePatterns.reversalStrength;
          reasons.push(`PATTERN_RENVERSEMENT_HAUSSIER_${pattern.name}`);
        } else if (pattern.type === 'reversal' && pattern.direction === 'bearish') {
          sellConfidence += this.momentumConfig.pricePatterns.reversalStrength;
          reasons.push(`PATTERN_RENVERSEMENT_BAISSIER_${pattern.name}`);
        } else if (pattern.type === 'continuation' && pattern.direction === 'bullish') {
          buyConfidence += this.momentumConfig.pricePatterns.continuationStrength;
          reasons.push(`PATTERN_CONTINUATION_HAUSSIER_${pattern.name}`);
        } else if (pattern.type === 'continuation' && pattern.direction === 'bearish') {
          sellConfidence += this.momentumConfig.pricePatterns.continuationStrength;
          reasons.push(`PATTERN_CONTINUATION_BAISSIER_${pattern.name}`);
        }
      }
    }
    
    // Analyser les données spécifiques de Solana
    if (marketData.ecosystem === 'solana') {
      // Vérifier la liquidité
      if (marketData.liquidity && marketData.liquidity < this.momentumConfig.solanaSpecific.minLiquidityUSD) {
        buyConfidence *= 0.5; // Réduire la confiance si faible liquidité
        sellConfidence *= 0.7; // Impacte moins la vente
        reasons.push('LIQUIDITÉ_INSUFFISANTE');
      }
      
      // Vérifier le volume 24h
      if (marketData.volume24h && marketData.volume24h < this.momentumConfig.solanaSpecific.minVolume24h) {
        buyConfidence *= 0.6;
        reasons.push('VOLUME_24H_FAIBLE');
      }
      
      // Tokens trop récents
      if (this.momentumConfig.solanaSpecific.avoidNewTokens && marketData.tokenAge && marketData.tokenAge < 14) {
        buyConfidence *= 0.4; // Fortement réduire pour les nouveaux tokens
        reasons.push('TOKEN_TROP_RÉCENT');
      }
      
      // Activité des développeurs (si disponible)
      if (this.momentumConfig.solanaSpecific.trackDeveloperActivity && 
          marketData.developerActivity && marketData.developerActivity === 'high') {
        buyConfidence *= 1.2; // Augmenter si activité dev élevée
        reasons.push('ACTIVITÉ_DEV_ÉLEVÉE');
      }
    }
    
    // Facteur de momentum du marché global
    const marketMomentum = marketContext.strength - 0.5; // -0.5 à +0.5
    buyConfidence += marketMomentum * 0.3;
    sellConfidence -= marketMomentum * 0.3;
    
    // Déterminer le type de signal final
    let signalType = 'NONE';
    let confidence = 0;
    
    if (buyConfidence > sellConfidence && buyConfidence > 0.4) {
      signalType = 'BUY';
      confidence = Math.min(1, buyConfidence);
      reasons.unshift('SIGNAL_ACHAT');
    } else if (sellConfidence > buyConfidence && sellConfidence > 0.4) {
      signalType = 'SELL';
      confidence = Math.min(1, sellConfidence);
      reasons.unshift('SIGNAL_VENTE');
    } else {
      signalType = 'NONE';
      confidence = 0;
      reasons.push('PAS_DE_SIGNAL_CLAIR');
    }
    
    return this.createSignal(signalType, confidence, reasons, {
      buyConfidence,
      sellConfidence,
      marketContext,
      ...indicators
    });
  }

  applySignalFilters(token, signal, marketContext) {
    // Appliquer le filtre de persistance du signal
    const filteredSignal = this.applySignalPersistenceFilter(token, signal);
    
    // Filtres supplémentaires basés sur le contexte du marché
    if (marketContext.volatility === 'high' && filteredSignal.confidence < 0.8) {
      filteredSignal.confidence *= 0.9; // Réduire légèrement la confiance en période volatile
      filteredSignal.reasons.push('CONFIANCE_RÉDUITE_VOLATILITÉ_ÉLEVÉE');
    }
    
    // Renforcement des signaux contraires en cas de régime extrême
    if (marketContext.regime === 'bullish' && filteredSignal.type === 'SELL' && filteredSignal.confidence > 0.7) {
      filteredSignal.confidence *= 1.1; // Renforcer un signal de vente contraire en marché haussier
      filteredSignal.reasons.push('SIGNAL_CONTRAIRE_RENFORCÉ');
    } else if (marketContext.regime === 'bearish' && filteredSignal.type === 'BUY' && filteredSignal.confidence > 0.7) {
      filteredSignal.confidence *= 1.1; // Renforcer un signal d'achat contraire en marché baissier
      filteredSignal.reasons.push('SIGNAL_CONTRAIRE_RENFORCÉ');
    }
    
    // Appliquer le seuil de confiance minimal
    if (filteredSignal.confidence < this.config.trading.minConfidenceThreshold) {
      filteredSignal.type = 'NONE';
      filteredSignal.confidence = 0;
      filteredSignal.reasons.push('SOUS_SEUIL_CONFIANCE_MINIMUM');
    }
    
    return filteredSignal;
  }

  calculateATR(prices, period = 14) {
    if (prices.length < period + 1) return 0;
    
    const highs = [...prices];
    const lows = [...prices];
    const closes = [...prices];
    
    // Créer un tableau de True Range
    const tr = new Array(prices.length - 1);
    tr[0] = highs[0] - lows[0]; // Premier jour, simple High-Low
    
    for (let i = 1; i < prices.length; i++) {
      const trueHigh = Math.max(highs[i], closes[i-1]);
      const trueLow = Math.min(lows[i], closes[i-1]);
      tr[i-1] = trueHigh - trueLow;
    }
    
    // Calculer l'ATR initial (moyenne simple pour la première période)
    let atr = tr.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    
    // Calculer l'ATR lissé pour les périodes suivantes (Wilder's smoothing)
    for (let i = period; i < tr.length; i++) {
      atr = ((atr * (period - 1)) + tr[i]) / period;
    }
    
    return atr;
  }

  checkDivergences(prices, rsiValues, macd) {
    if (!prices || !rsiValues || !macd || prices.length < 10 || !rsiValues.length) {
      return { hasBullishDivergence: false, hasBearishDivergence: false };
    }
    
    // Trouver les sommets et creux des prix
    const pricePeaks = this.findPeaksAndTroughs(prices);
    
    // Trouver les sommets et creux du RSI
    const rsiPeaks = this.findPeaksAndTroughs(rsiValues);
    
    // Vérifier la divergence haussière (prix baisse mais RSI monte)
    // Prix: creux plus bas, RSI: creux plus haut
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
    
    // Vérifier la divergence baissière (prix monte mais RSI baisse)
    // Prix: sommet plus haut, RSI: sommet plus bas
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
    
    // Vérifier aussi la divergence avec MACD
    const macdHistogram = macd.histogram;
    let macdDivergence = false;
    
    if (macdHistogram && macdHistogram.length > 5) {
      // Logique pour détecter la divergence MACD
      // (simplifié ici, peut être développé davantage)
    }
    
    return {
      hasBullishDivergence,
      hasBearishDivergence,
      macdDivergence
    };
  }

  findPeaksAndTroughs(data) {
    const peaks = [];
    const troughs = [];
    
    // Besoin d'au moins 3 points pour détecter un pic ou un creux
    if (data.length < 3) return { peaks, troughs };
    
    for (let i = 1; i < data.length - 1; i++) {
      // Un pic est plus élevé que ses voisins
      if (data[i] > data[i-1] && data[i] > data[i+1]) {
        peaks.push({ index: i, value: data[i] });
      }
      // Un creux est plus bas que ses voisins
      else if (data[i] < data[i-1] && data[i] < data[i+1]) {
        troughs.push({ index: i, value: data[i] });
      }
    }
    
    return { peaks, troughs };
  }

  detectPricePatterns(prices) {
    const patterns = [];
    
    if (prices.length < 10) return patterns;
    
    // Détecter le pattern Doji (indécision)
    const recentPrices = prices.slice(-5);
    if (Math.abs(recentPrices[4] - recentPrices[3]) < (recentPrices[3] * 0.003)) {
      patterns.push({
        name: 'DOJI',
        type: 'reversal',
        direction: 'neutral',
        confidence: 0.5
      });
    }
    
    // Détecter un double bottom (pattern de renversement haussier)
    if (prices.length >= 20) {
      const segment = prices.slice(-20);
      const peaks = this.findPeaksAndTroughs(segment);
      
      // Vérifier si on a au moins 2 creux similaires
      if (peaks.troughs.length >= 2) {
        const lastTrough = peaks.troughs[peaks.troughs.length - 1];
        const prevTrough = peaks.troughs[peaks.troughs.length - 2];
        
        // Si les deux creux sont à peu près au même niveau (± 3%)
        if (Math.abs(lastTrough.value - prevTrough.value) < (prevTrough.value * 0.03) &&
            // Et qu'ils sont séparés par au moins quelques barres
            Math.abs(lastTrough.index - prevTrough.index) > 5) {
          patterns.push({
            name: 'DOUBLE_BOTTOM',
            type: 'reversal',
            direction: 'bullish',
            confidence: 0.7
          });
        }
      }
    }
    
    // Détecter un flag (pattern de continuation)
    if (prices.length >= 15) {
      const segment = prices.slice(-15);
      // Calcul de la tendance sur les 10 premières barres
      const trend = this.calculateTrendStrength(segment.slice(0, 10));
      
      // Vérifier si on a une consolidation sur les 5 dernières barres
      const recentPrices = segment.slice(-5);
      const recentHigh = Math.max(...recentPrices);
      const recentLow = Math.min(...recentPrices);
      const recentRange = (recentHigh - recentLow) / recentLow;
      
      // Si la consolidation est étroite après une tendance forte
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

  updateConfig(newConfig) {
    super.updateConfig(newConfig);
    
    // Mettre à jour la configuration spécifique à la stratégie de momentum
    if (newConfig.indicators) {
      if (newConfig.indicators.rsi) {
        this.momentumConfig.rsiThresholds.oversold = newConfig.indicators.rsi.oversold || this.momentumConfig.rsiThresholds.oversold;
        this.momentumConfig.rsiThresholds.overbought = newConfig.indicators.rsi.overbought || this.momentumConfig.rsiThresholds.overbought;
      }
      
      if (newConfig.indicators.volumeProfile) {
        this.momentumConfig.volumeThresholds.significant = newConfig.indicators.volumeProfile.threshold || this.momentumConfig.volumeThresholds.significant;
      }
    }
    
    if (newConfig.trading) {
      if (newConfig.trading.minLiquidity) {
        this.momentumConfig.solanaSpecific.minLiquidityUSD = newConfig.trading.minLiquidity;
      }
      
      if (newConfig.trading.minVolume24h) {
        this.momentumConfig.solanaSpecific.minVolume24h = newConfig.trading.minVolume24h;
      }
    }
    
    // Autres mises à jour de configuration personnalisées
    if (newConfig.solanaSpecific) {
      this.momentumConfig.solanaSpecific = {
        ...this.momentumConfig.solanaSpecific,
        ...newConfig.solanaSpecific
      };
    }
    
    if (newConfig.marketRegimes) {
      this.momentumConfig.marketRegimes = {
        ...this.momentumConfig.marketRegimes,
        ...newConfig.marketRegimes
      };
    }
  }
}