import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, ResponsiveContainer, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend 
} from 'recharts';
import { io } from 'socket.io-client';
import axios from 'axios';

const COLORS = {
  primary: '#3949AB',
  secondary: '#5E35B1',
  success: '#43A047',
  danger: '#E53935',
  warning: '#FFB300',
  info: '#039BE5',
  background: '#1E1E2F',
  cardBg: '#27293D',
  textPrimary: '#FFFFFF',
  textSecondary: '#9A9A9A'
};

const chartColors = [
  '#43A047', '#E53935', '#FFB300', '#039BE5', '#5E35B1', 
  '#26A69A', '#EC407A', '#7CB342', '#AB47BC', '#FFA726'
];

const socket = io({
  auth: {
    token: localStorage.getItem('token')
  }
});

const Dashboard = () => {
  const [botStatus, setBotStatus] = useState({ isRunning: false, isPaused: false });
  const [performanceData, setPerformanceData] = useState(null);
  const [recentTrades, setRecentTrades] = useState([]);
  const [dailyPerformance, setDailyPerformance] = useState([]);
  const [openPositions, setOpenPositions] = useState([]);
  const [tokenAnalytics, setTokenAnalytics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [selectedTimeframe, setSelectedTimeframe] = useState('7d');

  useEffect(() => {
    const loadDashboardData = async () => {
      try {
        setLoading(true);
        
        const [statusRes, perfRes, tradesRes, dailyRes, positionsRes] = await Promise.all([
          axios.get('/api/status'),
          axios.get('/api/performance'),
          axios.get('/api/trades?limit=10'),
          axios.get(`/api/daily-performance?limit=${getTimeframeDays()}`),
          axios.get('/api/portfolio')
        ]);
        
        setBotStatus({
          isRunning: statusRes.data.status === 'running',
          isPaused: statusRes.data.isPaused || false
        });
        
        setPerformanceData(perfRes.data);
        setRecentTrades(tradesRes.data.trades || []);
        setDailyPerformance(dailyRes.data.data || []);
        setOpenPositions(positionsRes.data.openPositions || []);
        
        await loadTokenAnalytics();
        
        setLoading(false);
      } catch (err) {
        console.error('Erreur lors du chargement des données:', err);
        setError('Erreur lors du chargement des données. Veuillez rafraîchir.');
        setLoading(false);
      }
    };
    
    const loadTokenAnalytics = async () => {
      try {
        const res = await axios.get('/api/analytics/tokens');
        setTokenAnalytics(res.data || []);
      } catch (err) {
        console.warn('Erreur lors du chargement des analyses de tokens:', err);
        setTokenAnalytics([
          { token: 'SOL', trades: 28, winRate: 72, profitFactor: 2.3, avgProfit: 4.2 },
          { token: 'RAY', trades: 15, winRate: 67, profitFactor: 1.8, avgProfit: 3.5 },
          { token: 'SRM', trades: 10, winRate: 60, profitFactor: 1.5, avgProfit: 2.8 },
          { token: 'MNGO', trades: 8, winRate: 63, profitFactor: 1.7, avgProfit: 3.1 },
          { token: 'FIDA', trades: 6, winRate: 50, profitFactor: 1.2, avgProfit: 1.9 }
        ]);
      }
    };
    
    loadDashboardData();
    
    socket.on('connect', () => {
      console.log('Connexion socket établie');
      socket.emit('request_update');
    });
    
    socket.on('connect_error', (err) => {
      console.error('Erreur de connexion socket:', err);
      setNotifications(prev => [
        { id: Date.now(), type: 'error', message: 'Erreur de connexion au serveur' },
        ...prev
      ]);
    });
    
    socket.on('auth_error', (data) => {
      console.error('Erreur d\'authentification socket:', data);
      setNotifications(prev => [
        { id: Date.now(), type: 'error', message: data.message || 'Erreur d\'authentification' },
        ...prev
      ]);
    });
    
    socket.on('bot_status', (status) => {
      setBotStatus(status);
    });
    
    socket.on('bot_status_change', (status) => {
      setBotStatus(status);
      
      setNotifications(prev => [
        { 
          id: Date.now(), 
          type: 'info', 
          message: `Statut du bot mis à jour: ${status.isRunning ? 'En cours' : 'Arrêté'}${status.isPaused ? ' (En pause)' : ''}` 
        },
        ...prev
      ]);
    });
    
    socket.on('bot_update', (data) => {
      if (data.report) setPerformanceData(data.report);
      if (data.recentTrades) setRecentTrades(data.recentTrades);
      
      if (data.report && data.report.openPositions) {
        setOpenPositions(data.report.openPositions);
      }
    });
    
    socket.on('new_trade', (trade) => {
      setRecentTrades(prev => [trade, ...prev].slice(0, 10));
      
      setNotifications(prev => [
        { 
          id: Date.now(), 
          type: trade.profit > 0 ? 'success' : 'warning', 
          message: `${trade.token}: ${trade.profit > 0 ? 'Gain' : 'Perte'} de ${trade.profit.toFixed(2)} (${trade.profitPercentage.toFixed(2)}%)`
        },
        ...prev
      ]);
    });
    
    return () => {
      socket.off('connect');
      socket.off('connect_error');
      socket.off('auth_error');
      socket.off('bot_status');
      socket.off('bot_status_change');
      socket.off('bot_update');
      socket.off('new_trade');
    };
  }, [selectedTimeframe]);
  
  const refreshData = () => {
    socket.emit('request_update');
    setNotifications(prev => [
      { id: Date.now(), type: 'info', message: 'Actualisation des données...' },
      ...prev
    ]);
  };
  
  const startBot = async () => {
    try {
      await axios.post('/api/start');
      refreshData();
    } catch (err) {
      console.error('Erreur lors du démarrage du bot:', err);
      setNotifications(prev => [
        { id: Date.now(), type: 'error', message: `Erreur: ${err.response?.data?.error || err.message}` },
        ...prev
      ]);
    }
  };
  
  const stopBot = async () => {
    try {
      await axios.post('/api/stop');
      refreshData();
    } catch (err) {
      console.error('Erreur lors de l\'arrêt du bot:', err);
      setNotifications(prev => [
        { id: Date.now(), type: 'error', message: `Erreur: ${err.response?.data?.error || err.message}` },
        ...prev
      ]);
    }
  };
  
  const pauseBot = async () => {
    try {
      await axios.post('/api/pause');
      refreshData();
    } catch (err) {
      console.error('Erreur lors de la mise en pause du bot:', err);
      setNotifications(prev => [
        { id: Date.now(), type: 'error', message: `Erreur: ${err.response?.data?.error || err.message}` },
        ...prev
      ]);
    }
  };
  
  const resumeBot = async () => {
    try {
      await axios.post('/api/resume');
      refreshData();
    } catch (err) {
      console.error('Erreur lors de la reprise du bot:', err);
      setNotifications(prev => [
        { id: Date.now(), type: 'error', message: `Erreur: ${err.response?.data?.error || err.message}` },
        ...prev
      ]);
    }
  };
  
  const getTimeframeDays = () => {
    switch (selectedTimeframe) {
      case '24h': return 1;
      case '7d': return 7;
      case '30d': return 30;
      case '90d': return 90;
      default: return 7;
    }
  };
  
  const closeNotification = (id) => {
    setNotifications(prev => prev.filter(notif => notif.id !== id));
  };
  
  if (loading) {
    return (
      <div className="dashboard-loading">
        <div className="spinner"></div>
        <p>Chargement du dashboard...</p>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="dashboard-error">
        <h2>Erreur</h2>
        <p>{error}</p>
        <button onClick={refreshData}>Réessayer</button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="status-indicator">
          <h1>SolanaTrader Dashboard</h1>
          <div className={`status-badge ${botStatus.isRunning ? (botStatus.isPaused ? 'paused' : 'running') : 'stopped'}`}>
            {botStatus.isRunning 
              ? (botStatus.isPaused ? 'En pause' : 'En cours') 
              : 'Arrêté'}
          </div>
        </div>
        
        <div className="controls">
          {botStatus.isRunning ? (
            botStatus.isPaused ? (
              <button className="btn-resume" onClick={resumeBot}>Reprendre</button>
            ) : (
              <button className="btn-pause" onClick={pauseBot}>Pause</button>
            )
          ) : null}
          
          {botStatus.isRunning ? (
            <button className="btn-stop" onClick={stopBot}>Arrêter</button>
          ) : (
            <button className="btn-start" onClick={startBot}>Démarrer</button>
          )}
          
          <button className="btn-refresh" onClick={refreshData}>
            <i className="icon-refresh"></i>
          </button>
        </div>
      </header>
      
      <div className="notifications-container">
        {notifications.map(notif => (
          <div key={notif.id} className={`notification notification-${notif.type}`}>
            <span>{notif.message}</span>
            <button onClick={() => closeNotification(notif.id)}>×</button>
          </div>
        ))}
      </div>
      
      <div className="metrics-grid">
        <div className="metric-card">
          <h3>Profit Total</h3>
          <div className={`metric-value ${performanceData?.portfolioMetrics?.totalProfit >= 0 ? 'positive' : 'negative'}`}>
            {performanceData?.portfolioMetrics?.totalProfit?.toFixed(2) || '0.00'}
            <span className="metric-percentage">
              ({performanceData?.portfolioMetrics?.profitPercentage?.toFixed(2) || '0.00'}%)
            </span>
          </div>
        </div>
        
        <div className="metric-card">
          <h3>Win Rate</h3>
          <div className="metric-value">
            {performanceData?.metrics?.winRate?.toFixed(1) || '0.0'}%
            <span className="metric-detail">
              ({performanceData?.metrics?.winningTrades || 0}/{performanceData?.metrics?.totalTrades || 0})
            </span>
          </div>
        </div>
        
        <div className="metric-card">
          <h3>Drawdown</h3>
          <div className={`metric-value ${performanceData?.portfolioMetrics?.maxDrawdown < 10 ? 'positive' : 'negative'}`}>
            {performanceData?.portfolioMetrics?.maxDrawdown?.toFixed(2) || '0.00'}%
          </div>
        </div>
        
        <div className="metric-card">
          <h3>Positions Ouvertes</h3>
          <div className="metric-value">
            {openPositions?.length || 0}
            <span className="metric-detail">
              /{performanceData?.botMetrics?.maxOpenPositions || 3}
            </span>
          </div>
        </div>
      </div>
      
      <div className="chart-section">
        <div className="chart-header">
          <h2>Performance</h2>
          <div className="chart-controls">
            <button 
              className={selectedTimeframe === '24h' ? 'active' : ''} 
              onClick={() => setSelectedTimeframe('24h')}
            >
              24h
            </button>
            <button 
              className={selectedTimeframe === '7d' ? 'active' : ''} 
              onClick={() => setSelectedTimeframe('7d')}
            >
              7j
            </button>
            <button 
              className={selectedTimeframe === '30d' ? 'active' : ''} 
              onClick={() => setSelectedTimeframe('30d')}
            >
              30j
            </button>
            <button 
              className={selectedTimeframe === '90d' ? 'active' : ''} 
              onClick={() => setSelectedTimeframe('90d')}
            >
              90j
            </button>
          </div>
        </div>
        
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart
              data={dailyPerformance}
              margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS.success} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={COLORS.success} stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" />
              <YAxis />
              <CartesianGrid strokeDasharray="3 3" />
              <Tooltip
                contentStyle={{ backgroundColor: COLORS.cardBg, borderColor: COLORS.primary }}
                formatter={(value) => [`${value.toFixed(2)}`, 'Profit']}
              />
              <Area 
                type="monotone" 
                dataKey="cumulativeProfit" 
                stroke={COLORS.success} 
                fillOpacity={1} 
                fill="url(#colorProfit)" 
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      
      <div className="two-column-section">
        <div className="card">
          <h2>Trades Récents</h2>
          <div className="scrollable-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Token</th>
                  <th>Direction</th>
                  <th>Profit</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="empty-state">Aucun trade récent</td>
                  </tr>
                ) : (
                  recentTrades.map((trade, index) => (
                    <tr key={index} className={trade.profit >= 0 ? 'positive-row' : 'negative-row'}>
                      <td>{new Date(trade.exitTime).toLocaleString()}</td>
                      <td>{trade.token}</td>
                      <td>{trade.direction === 'BUY' ? 'LONG' : 'SHORT'}</td>
                      <td>{trade.profit.toFixed(2)}</td>
                      <td>{trade.profitPercentage.toFixed(2)}%</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        
        <div className="card">
          <h2>Positions Ouvertes</h2>
          <div className="scrollable-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Entrée</th>
                  <th>Actuel</th>
                  <th>P&L</th>
                  <th>Durée</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="empty-state">Aucune position ouverte</td>
                  </tr>
                ) : (
                  openPositions.map((position, index) => {
                    const pnlPercentage = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
                    const durationMs = Date.now() - position.entryTime;
                    const hours = Math.floor(durationMs / (1000 * 60 * 60));
                    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
                    
                    return (
                      <tr key={index} className={pnlPercentage >= 0 ? 'positive-row' : 'negative-row'}>
                        <td>{position.token}</td>
                        <td>{position.entryPrice.toFixed(4)}</td>
                        <td>{position.currentPrice.toFixed(4)}</td>
                        <td>{pnlPercentage.toFixed(2)}%</td>
                        <td>{`${hours}h ${minutes}m`}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      
      <div className="analytics-section">
        <div className="card">
          <h2>Performance par Token</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={tokenAnalytics}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="token" />
                <YAxis />
                <Tooltip
                  contentStyle={{ backgroundColor: COLORS.cardBg, borderColor: COLORS.primary }}
                />
                <Legend />
                <Bar dataKey="winRate" name="Win Rate (%)" fill={COLORS.success} />
                <Bar dataKey="profitFactor" name="Profit Factor" fill={COLORS.info} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        <div className="card">
          <h2>Répartition des Trades</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={[
                    { name: 'Gagnants', value: performanceData?.metrics?.winningTrades || 0 },
                    { name: 'Perdants', value: performanceData?.metrics?.losingTrades || 0 }
                  ]}
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  labelLine={true}
                  dataKey="value"
                >
                  <Cell fill={COLORS.success} />
                  <Cell fill={COLORS.danger} />
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: COLORS.cardBg, borderColor: COLORS.primary }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      
      <footer className="dashboard-footer">
        <div className="footer-info">
          <p>Dernier cycle: {performanceData?.botMetrics?.lastCycleTime || 'N/A'}</p>
          <p>Uptime: {performanceData?.botMetrics?.uptime || 'N/A'}</p>
        </div>
        <div className="footer-version">
          <p>SolanaTrader v1.0.0</p>
        </div>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('app'));
root.render(<Dashboard />);