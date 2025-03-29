// public/js/components/MarketAnalysis.jsx
import React, { useState, useEffect } from 'react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from 'recharts';
import axios from 'axios';

const MarketAnalysis = ({ token = null }) => {
  // États
  const [marketData, setMarketData] = useState(null);
  const [priceHistory, setPriceHistory] = useState([]);
  const [indicators, setIndicators] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedToken, setSelectedToken] = useState(token || '');
  const [availableTokens, setAvailableTokens] = useState([]);
  const [timeframe, setTimeframe] = useState('1h');
  const [showIndicators, setShowIndicators] = useState({
    ema9: true,
    ema21: true,
    ema50: true,
    bb: true
  });

  // Couleurs pour les graphiques
  const colors = {
    price: '#1E88E5',
    ema9: '#4CAF50',
    ema21: '#FFC107',
    ema50: '#FF5722',
    bbUpper: 'rgba(76, 175, 80, 0.3)',
    bbLower: 'rgba(76, 175, 80, 0.3)',
    bbMiddle: '#4CAF50',
    volume: '#3949AB'
  };

  // Charger les données au montage et lors des changements
  useEffect(() => {
    if (!selectedToken) {
      fetchAvailableTokens();
    } else {
      fetchTokenData();
    }
  }, [selectedToken, timeframe]);

  // Récupérer la liste des tokens disponibles
  const fetchAvailableTokens = async () => {
    try {
      setLoading(true);
      const response = await axios.get('/api/tokens/top');
      
      if (response.data && Array.isArray(response.data)) {
        setAvailableTokens(response.data);
        
        // Sélectionner le premier token si aucun n'est sélectionné
        if (!selectedToken && response.data.length > 0) {
          setSelectedToken(response.data[0].token_mint);
        }
      }
      
      setLoading(false);
    } catch (err) {
      console.error('Erreur lors du chargement des tokens:', err);
      setError('Impossible de charger la liste des tokens');
      setLoading(false);
    }
  };

  // Récupérer les données d'un token spécifique
  const fetchTokenData = async () => {
    if (!selectedToken) return;
    
    try {
      setLoading(true);
      
      // Requêtes parallèles pour les données du token
      const [marketInfoRes, priceHistoryRes, indicatorsRes] = await Promise.all([
        axios.get(`/api/tokens/${selectedToken}`),
        axios.get(`/api/tokens/${selectedToken}/history?timeframe=${timeframe}`),
        axios.get(`/api/tokens/${selectedToken}/indicators?timeframe=${timeframe}`)
      ]);
      
      // Traiter les données
      if (marketInfoRes.data) {
        setMarketData(marketInfoRes.data);
      }
      
      if (priceHistoryRes.data && priceHistoryRes.data.length > 0) {
        // Formater pour les graphiques
        const formattedData = priceHistoryRes.data.map(candle => ({
          date: new Date(candle.time).toLocaleString(),
          timestamp: candle.time,
          price: parseFloat(candle.close),
          open: parseFloat(candle.open),
          high: parseFloat(candle.high),
          low: parseFloat(candle.low),
          volume: parseFloat(candle.volume)
        }));
        
        setPriceHistory(formattedData);
      }
      
      if (indicatorsRes.data) {
        setIndicators(indicatorsRes.data);
      }
      
      setLoading(false);
    } catch (err) {
      console.error('Erreur lors du chargement des données du token:', err);
      setError('Impossible de charger les données du token');
      setLoading(false);
    }
  };

  // Combiner les données de prix avec les indicateurs
  const combinedChartData = () => {
    if (!priceHistory.length || !indicators) return priceHistory;
    
    // Extraire les indicateurs
    const { ema9, ema21, ema50, bb } = indicators;
    
    // Mapper sur l'historique des prix
    return priceHistory.map((item, index) => {
      // Pour les EMA, nous prenons les dernières valeurs disponibles
      const ema9Value = ema9?.values ? ema9.values[ema9.values.length - priceHistory.length + index] : null;
      const ema21Value = ema21?.values ? ema21.values[ema21.values.length - priceHistory.length + index] : null;
      const ema50Value = ema50?.values ? ema50.values[ema50.values.length - priceHistory.length + index] : null;
      
      // Pour les bandes de Bollinger
      const bbUpper = bb?.upper ? bb.upper[index % bb.upper.length] : null;
      const bbLower = bb?.lower ? bb.lower[index % bb.lower.length] : null;
      const bbMiddle = bb?.middle ? bb.middle[index % bb.middle.length] : null;
      
      return {
        ...item,
        ema9: ema9Value,
        ema21: ema21Value,
        ema50: ema50Value,
        bbUpper,
        bbLower,
        bbMiddle
      };
    });
  };

  // Formater la variation de prix
  const formatPriceChange = (change) => {
    if (change === undefined || change === null) return 'N/A';
    const formattedChange = parseFloat(change).toFixed(2);
    return `${formattedChange > 0 ? '+' : ''}${formattedChange}%`;
  };

  // Formater le prix
  const formatPrice = (price) => {
    if (price === undefined || price === null) return 'N/A';
    return parseFloat(price).toFixed(6);
  };

  // Formater le volume
  const formatVolume = (volume) => {
    if (volume === undefined || volume === null) return 'N/A';
    
    if (volume >= 1000000) {
      return `${(volume / 1000000).toFixed(2)}M`;
    } else if (volume >= 1000) {
      return `${(volume / 1000).toFixed(2)}K`;
    } else {
      return volume.toFixed(2);
    }
  };

  // Formater la liquidité
  const formatLiquidity = (liquidity) => {
    if (liquidity === undefined || liquidity === null) return 'N/A';
    
    if (liquidity >= 1000000) {
      return `$${(liquidity / 1000000).toFixed(2)}M`;
    } else if (liquidity >= 1000) {
      return `$${(liquidity / 1000).toFixed(2)}K`;
    } else {
      return `$${liquidity.toFixed(2)}`;
    }
  };

  // Vue de chargement
  if (loading && !priceHistory.length) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Chargement des données de marché...</p>
      </div>
    );
  }

  // Vue d'erreur
  if (error) {
    return (
      <div className="error-container">
        <p className="error-message">{error}</p>
        <button onClick={fetchTokenData} className="retry-button">Réessayer</button>
      </div>
    );
  }

  // Si aucun token n'est sélectionné et que nous avons des tokens disponibles
  if (!selectedToken && availableTokens.length > 0) {
    return (
      <div className="token-selection">
        <h2>Sélectionner un token</h2>
        <div className="token-grid">
          {availableTokens.map(token => (
            <div 
              key={token.token_mint}
              className="token-card"
              onClick={() => setSelectedToken(token.token_mint)}
            >
              <h3>{token.symbol}</h3>
              <div className="token-details">
                <p>Prix: ${formatPrice(token.price)}</p>
                <p className={parseFloat(token.priceChange24h) >= 0 ? 'positive' : 'negative'}>
                  {formatPriceChange(token.priceChange24h)}
                </p>
                <p>Vol. 24h: {formatVolume(token.volume24h)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="market-analysis-container">
      <div className="header-section">
        <div className="token-selector">
          <select 
            value={selectedToken} 
            onChange={(e) => setSelectedToken(e.target.value)}
            className="token-select"
          >
            {availableTokens.map(token => (
              <option key={token.token_mint} value={token.token_mint}>
                {token.symbol}
              </option>
            ))}
          </select>
        </div>
        
        <div className="timeframe-selector">
          <button 
            className={timeframe === '5m' ? 'active' : ''} 
            onClick={() => setTimeframe('5m')}
          >
            5m
          </button>
          <button 
            className={timeframe === '15m' ? 'active' : ''} 
            onClick={() => setTimeframe('15m')}
          >
            15m
          </button>
          <button 
            className={timeframe === '1h' ? 'active' : ''} 
            onClick={() => setTimeframe('1h')}
          >
            1h
          </button>
          <button 
            className={timeframe === '4h' ? 'active' : ''} 
            onClick={() => setTimeframe('4h')}
          >
            4h
          </button>
          <button 
            className={timeframe === '1d' ? 'active' : ''} 
            onClick={() => setTimeframe('1d')}
          >
            1j
          </button>
        </div>
        
        <div className="indicator-toggles">
          <label>
            <input 
              type="checkbox" 
              checked={showIndicators.ema9} 
              onChange={() => setShowIndicators({...showIndicators, ema9: !showIndicators.ema9})}
            />
            EMA9
          </label>
          <label>
            <input 
              type="checkbox" 
              checked={showIndicators.ema21} 
              onChange={() => setShowIndicators({...showIndicators, ema21: !showIndicators.ema21})}
            />
            EMA21
          </label>
          <label>
            <input 
              type="checkbox" 
              checked={showIndicators.ema50} 
              onChange={() => setShowIndicators({...showIndicators, ema50: !showIndicators.ema50})}
            />
            EMA50
          </label>
          <label>
            <input 
              type="checkbox" 
              checked={showIndicators.bb} 
              onChange={() => setShowIndicators({...showIndicators, bb: !showIndicators.bb})}
            />
            Bollinger
          </label>
        </div>
      </div>
      
      {marketData && (
        <div className="token-info-cards">
          <div className="info-card">
            <h3>Prix</h3>
            <div className="info-value">${formatPrice(marketData.price)}</div>
            <div className={`change ${parseFloat(marketData.priceChange24h) >= 0 ? 'positive' : 'negative'}`}>
              {formatPriceChange(marketData.priceChange24h)}
            </div>
          </div>
          
          <div className="info-card">
            <h3>Volume 24h</h3>
            <div className="info-value">${formatVolume(marketData.volume24h)}</div>
          </div>
          
          <div className="info-card">
            <h3>Liquidité</h3>
            <div className="info-value">{formatLiquidity(marketData.liquidity)}</div>
          </div>
          
          <div className="info-card">
            <h3>Market Cap</h3>
            <div className="info-value">{formatLiquidity(marketData.marketCap)}</div>
          </div>
        </div>
      )}
      
      {/* Graphique de prix avec indicateurs */}
      <div className="chart-container">
        <h3>Graphique des prix</h3>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart
            data={combinedChartData()}
            margin={{ top: 10, right: 30, left: 10, bottom: 30 }}
          >
            <defs>
              <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.price} stopOpacity={0.8} />
                <stop offset="95%" stopColor={colors.price} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Legend />
            
            {/* Bandes de Bollinger */}
            {showIndicators.bb && indicators?.bb && (
              <>
                <Area
                  type="monotone"
                  dataKey="bbUpper"
                  stroke="none"
                  fillOpacity={0.1}
                  fill={colors.bbUpper}
                  name="BB Upper"
                />
                <Area
                  type="monotone"
                  dataKey="bbLower"
                  stroke="none"
                  fillOpacity={0.1}
                  fill={colors.bbLower}
                  name="BB Lower"
                />
                <Line
                  type="monotone"
                  dataKey="bbMiddle"
                  stroke={colors.bbMiddle}
                  dot={false}
                  name="BB Middle"
                />
              </>
            )}
            
            {/* Prix */}
            <Area
              type="monotone"
              dataKey="price"
              stroke={colors.price}
              fillOpacity={1}
              fill="url(#colorPrice)"
              name="Prix"
            />
            
            {/* EMAs */}
            {showIndicators.ema9 && (
              <Line
                type="monotone"
                dataKey="ema9"
                stroke={colors.ema9}
                dot={false}
                name="EMA9"
              />
            )}
            
            {showIndicators.ema21 && (
              <Line
                type="monotone"
                dataKey="ema21"
                stroke={colors.ema21}
                dot={false}
                name="EMA21"
              />
            )}
            
            {showIndicators.ema50 && (
              <Line
                type="monotone"
                dataKey="ema50"
                stroke={colors.ema50}
                dot={false}
                name="EMA50"
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      
      {/* Graphique de volume */}
      <div className="chart-container">
        <h3>Volume</h3>
        <ResponsiveContainer width="100%" height={150}>
          <AreaChart
            data={priceHistory}
            margin={{ top: 10, right: 30, left: 10, bottom: 0 }}
          >
            <defs>
              <linearGradient id="colorVolume" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colors.volume} stopOpacity={0.8} />
                <stop offset="95%" stopColor={colors.volume} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis domain={[0, 'auto']} tick={{ fontSize: 10 }} />
            <Tooltip />
            <Area
              type="monotone"
              dataKey="volume"
              stroke={colors.volume}
              fillOpacity={1}
              fill="url(#colorVolume)"
              name="Volume"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      
      {/* Indicateurs techniques */}
      {indicators && (
        <div className="indicators-section">
          <h3>Indicateurs Techniques</h3>
          
          <div className="indicators-grid">
            <div className="indicator-card">
              <h4>RSI (14)</h4>
              <div className={`indicator-value ${
                indicators.rsi?.last < 30 ? 'oversold' : 
                indicators.rsi?.last > 70 ? 'overbought' : ''
              }`}>
                {indicators.rsi?.last ? indicators.rsi.last.toFixed(2) : 'N/A'}
              </div>
              <div className="indicator-range">
                <span>0</span>
                <div className="indicator-bar">
                  <div 
                    className="indicator-fill" 
                    style={{ 
                      width: `${indicators.rsi?.last || 0}%`,
                      backgroundColor: indicators.rsi?.last < 30 ? '#4CAF50' :
                                      indicators.rsi?.last > 70 ? '#FF5722' : '#1E88E5'
                    }}
                  ></div>
                </div>
                <span>100</span>
              </div>
            </div>
            
            <div className="indicator-card">
              <h4>MACD</h4>
              <div className={`indicator-value ${
                indicators.macd?.histogram > 0 ? 'positive' : 'negative'
              }`}>
                {indicators.macd?.histogram ? indicators.macd.histogram.toFixed(6) : 'N/A'}
              </div>
              <div className="sub-values">
                <span>Signal: {indicators.macd?.signalLine ? 
                  indicators.macd.signalLine[indicators.macd.signalLine.length - 1].toFixed(6) : 'N/A'}</span>
                <span>Line: {indicators.macd?.macdLine ? 
                  indicators.macd.macdLine[indicators.macd.macdLine.length - 1].toFixed(6) : 'N/A'}</span>
              </div>
            </div>
            
            <div className="indicator-card">
              <h4>Bollinger Bands</h4>
              <div className="indicator-value">
                Width: {indicators.bb && indicators.bb.upper && indicators.bb.lower ?
                  ((indicators.bb.upper[indicators.bb.upper.length - 1] - 
                    indicators.bb.lower[indicators.bb.lower.length - 1]) / 
                    indicators.bb.middle[indicators.bb.middle.length - 1] * 100).toFixed(2) : 'N/A'}%
              </div>
              <div className="sub-values">
                <span>Upper: {indicators.bb?.upper ? 
                  indicators.bb.upper[indicators.bb.upper.length - 1].toFixed(6) : 'N/A'}</span>
                <span>Lower: {indicators.bb?.lower ? 
                  indicators.bb.lower[indicators.bb.lower.length - 1].toFixed(6) : 'N/A'}</span>
              </div>
            </div>
            
            <div className="indicator-card">
              <h4>Tendance</h4>
              <div className={`indicator-value ${
                indicators.trend?.direction === 'UP' ? 'positive' : 
                indicators.trend?.direction === 'DOWN' ? 'negative' : ''
              }`}>
                {indicators.trend?.direction || 'N/A'}
              </div>
              <div className="sub-values">
                <span>Force: {indicators.trend?.strength ? 
                  (indicators.trend.strength * 100).toFixed(0) : 'N/A'}%</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarketAnalysis;