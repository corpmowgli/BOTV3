// public/js/components/TradeHistory.jsx
import React, { useState, useEffect } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, 
  ResponsiveContainer, Cell 
} from 'recharts';
import axios from 'axios';

const TradeHistory = () => {
  // États
  const [tradeData, setTradeData] = useState([]);
  const [dailyPerformance, setDailyPerformance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [timeframe, setTimeframe] = useState('7d');
  const [view, setView] = useState('list'); // 'list' ou 'chart'
  const [tokenFilter, setTokenFilter] = useState('all');
  const [pagination, setPagination] = useState({
    currentPage: 1,
    totalPages: 1,
    limit: 50
  });

  // Couleurs
  const profitColor = '#43A047';
  const lossColor = '#E53935';

  // Charger les données au montage et lors des changements de filtre
  useEffect(() => {
    fetchTradeHistory();
    fetchDailyPerformance();
  }, [timeframe, tokenFilter, pagination.currentPage]);

  // Charger l'historique des trades
  const fetchTradeHistory = async () => {
    try {
      setLoading(true);

      // Calculer l'offset basé sur la pagination
      const offset = (pagination.currentPage - 1) * pagination.limit;
      
      // Construire l'URL avec les filtres
      let url = `/api/trades?limit=${pagination.limit}&offset=${offset}`;
      
      if (tokenFilter !== 'all') {
        url += `&token=${tokenFilter}`;
      }

      const response = await axios.get(url);
      
      if (response.data && response.data.trades) {
        setTradeData(response.data.trades);
        setPagination(prev => ({
          ...prev,
          totalPages: Math.ceil(response.data.pagination.total / pagination.limit)
        }));
      }
      
      setLoading(false);
    } catch (err) {
      console.error('Erreur lors du chargement de l\'historique des trades:', err);
      setError('Impossible de charger l\'historique des trades');
      setLoading(false);
    }
  };

  // Charger les performances quotidiennes
  const fetchDailyPerformance = async () => {
    try {
      // Déterminer le nombre de jours
      let days = 7;
      if (timeframe === '30d') days = 30;
      else if (timeframe === '90d') days = 90;
      else if (timeframe === '24h') days = 1;
      
      const response = await axios.get(`/api/daily-performance?limit=${days}`);
      
      if (response.data && response.data.data) {
        // Formater pour le graphique
        const formattedData = response.data.data.map(day => ({
          date: new Date(day.date).toLocaleDateString(),
          profit: parseFloat(day.profit),
          trades: day.trades
        }));
        
        setDailyPerformance(formattedData);
      }
    } catch (err) {
      console.error('Erreur lors du chargement des performances quotidiennes:', err);
    }
  };

  // Formater la date
  const formatDate = (timestamp) => {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleString();
  };

  // Charger la page précédente
  const goToPreviousPage = () => {
    if (pagination.currentPage > 1) {
      setPagination({
        ...pagination,
        currentPage: pagination.currentPage - 1
      });
    }
  };

  // Charger la page suivante
  const goToNextPage = () => {
    if (pagination.currentPage < pagination.totalPages) {
      setPagination({
        ...pagination,
        currentPage: pagination.currentPage + 1
      });
    }
  };

  // Calculer les statistiques pour la période
  const calculateStats = () => {
    if (!tradeData || tradeData.length === 0) {
      return { winRate: 0, avgProfit: 0, avgLoss: 0, totalProfit: 0 };
    }
    
    const wins = tradeData.filter(trade => trade.profit > 0);
    const losses = tradeData.filter(trade => trade.profit < 0);
    
    const winRate = (wins.length / tradeData.length) * 100;
    
    const avgProfit = wins.length > 0 
      ? wins.reduce((sum, trade) => sum + trade.profit, 0) / wins.length 
      : 0;
      
    const avgLoss = losses.length > 0 
      ? losses.reduce((sum, trade) => sum + trade.profit, 0) / losses.length 
      : 0;
      
    const totalProfit = tradeData.reduce((sum, trade) => sum + trade.profit, 0);
    
    return {
      winRate: winRate.toFixed(1),
      avgProfit: avgProfit.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      totalProfit: totalProfit.toFixed(2)
    };
  };

  // Extraire la liste des tokens uniques
  const getUniqueTokens = () => {
    if (!tradeData || tradeData.length === 0) return [];
    
    const tokens = new Set();
    tradeData.forEach(trade => tokens.add(trade.token));
    
    return Array.from(tokens);
  };

  // Statistiques pour affichage
  const stats = calculateStats();
  const uniqueTokens = getUniqueTokens();

  // Vue de chargement
  if (loading && tradeData.length === 0) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Chargement de l'historique des trades...</p>
      </div>
    );
  }

  // Vue d'erreur
  if (error) {
    return (
      <div className="error-container">
        <p className="error-message">{error}</p>
        <button onClick={fetchTradeHistory} className="retry-button">Réessayer</button>
      </div>
    );
  }

  return (
    <div className="trade-history-container">
      <div className="header-section">
        <h2>Historique des Transactions</h2>
        
        <div className="controls">
          <div className="view-selector">
            <button 
              className={view === 'list' ? 'active' : ''} 
              onClick={() => setView('list')}
            >
              Liste
            </button>
            <button 
              className={view === 'chart' ? 'active' : ''} 
              onClick={() => setView('chart')}
            >
              Graphique
            </button>
          </div>
          
          <div className="timeframe-selector">
            <button 
              className={timeframe === '24h' ? 'active' : ''} 
              onClick={() => setTimeframe('24h')}
            >
              24h
            </button>
            <button 
              className={timeframe === '7d' ? 'active' : ''} 
              onClick={() => setTimeframe('7d')}
            >
              7j
            </button>
            <button 
              className={timeframe === '30d' ? 'active' : ''} 
              onClick={() => setTimeframe('30d')}
            >
              30j
            </button>
            <button 
              className={timeframe === '90d' ? 'active' : ''} 
              onClick={() => setTimeframe('90d')}
            >
              90j
            </button>
          </div>
          
          <select 
            value={tokenFilter} 
            onChange={(e) => setTokenFilter(e.target.value)}
            className="token-filter"
          >
            <option value="all">Tous les tokens</option>
            {uniqueTokens.map(token => (
              <option key={token} value={token}>{token}</option>
            ))}
          </select>
        </div>
      </div>
      
      <div className="stats-cards">
        <div className="stat-card">
          <h3>Win Rate</h3>
          <div className="stat-value">{stats.winRate}%</div>
        </div>
        <div className="stat-card">
          <h3>Profit Total</h3>
          <div className={`stat-value ${parseFloat(stats.totalProfit) >= 0 ? 'positive' : 'negative'}`}>
            {stats.totalProfit}
          </div>
        </div>
        <div className="stat-card">
          <h3>Gain Moyen</h3>
          <div className="stat-value positive">{stats.avgProfit}</div>
        </div>
        <div className="stat-card">
          <h3>Perte Moyenne</h3>
          <div className="stat-value negative">{stats.avgLoss}</div>
        </div>
      </div>
      
      {/* Vue graphique */}
      {view === 'chart' && (
        <div className="chart-container">
          <h3>Performance sur la période</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={dailyPerformance}
              margin={{ top: 20, right: 30, left: 20, bottom: 30 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip 
                formatter={(value) => [value.toFixed(2), 'Profit']}
                labelFormatter={(value) => `Date: ${value}`}
              />
              <Legend />
              <Bar dataKey="profit" name="Profit quotidien">
                {dailyPerformance.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.profit >= 0 ? profitColor : lossColor} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      
      {/* Vue liste */}
      {view === 'list' && (
        <>
          <div className="table-container">
            <table className="trade-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Token</th>
                  <th>Direction</th>
                  <th>Prix d'entrée</th>
                  <th>Prix de sortie</th>
                  <th>Profit</th>
                  <th>%</th>
                  <th>Durée</th>
                </tr>
              </thead>
              <tbody>
                {tradeData.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="no-trades">Aucune transaction trouvée</td>
                  </tr>
                ) : (
                  tradeData.map((trade, index) => {
                    // Calculer la durée en heures:minutes
                    const durationMs = trade.exitTime - trade.entryTime;
                    const hours = Math.floor(durationMs / (1000 * 60 * 60));
                    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
                    
                    return (
                      <tr 
                        key={index} 
                        className={trade.profit >= 0 ? 'profit-row' : 'loss-row'}
                      >
                        <td>{formatDate(trade.exitTime)}</td>
                        <td>{trade.token}</td>
                        <td>{trade.direction}</td>
                        <td>{parseFloat(trade.entryPrice).toFixed(4)}</td>
                        <td>{parseFloat(trade.exitPrice).toFixed(4)}</td>
                        <td className={trade.profit >= 0 ? 'profit' : 'loss'}>
                          {parseFloat(trade.profit).toFixed(2)}
                        </td>
                        <td className={trade.profitPercentage >= 0 ? 'profit' : 'loss'}>
                          {parseFloat(trade.profitPercentage).toFixed(2)}%
                        </td>
                        <td>{`${hours}h ${minutes}m`}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          
          {/* Pagination */}
          <div className="pagination">
            <button 
              onClick={goToPreviousPage} 
              disabled={pagination.currentPage === 1}
              className="pagination-button"
            >
              &laquo; Précédent
            </button>
            
            <span className="pagination-info">
              Page {pagination.currentPage} sur {pagination.totalPages}
            </span>
            
            <button 
              onClick={goToNextPage} 
              disabled={pagination.currentPage === pagination.totalPages}
              className="pagination-button"
            >
              Suivant &raquo;
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default TradeHistory;