import EventEmitter from 'events';
import { generateUUID } from '../utils/helpers.js';

export class PositionManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.positions = new Map();
    this.history = [];
    this.stats = {
      opened: 0,
      closed: 0,
      profitable: 0,
      unprofitable: 0,
      avgHoldingTime: 0,
      totalHoldingTime: 0
    };
  }

  updateConfig(newConfig) {
    if (newConfig.trading) {
      this.config = { ...this.config, trading: { ...this.config.trading, ...newConfig.trading } };
    }
  }

  getOpenPositions() {
    return Array.from(this.positions.values());
  }

  getOpenPositionsByToken(token) {
    return this.getOpenPositions().filter(position => position.token === token);
  }

  hasOpenPosition(token) {
    return Array.from(this.positions.values()).some(position => position.token === token);
  }

  async openPosition(token, amount, price, type, options = {}) {
    if (!token || !amount || !price) throw new Error('Token, montant et prix sont requis pour ouvrir une position');
    if (amount <= 0) throw new Error('Le montant doit être positif');
    if (this.positions.size >= this.config.trading.maxOpenPositions)
      throw new Error(`Nombre maximal de positions atteint (${this.config.trading.maxOpenPositions})`);
    
    const id = generateUUID();
    const direction = (type === 'BUY' || type === 'LONG') ? 'BUY' : 'SELL';
    const stopLossPercent = options.stopLossPercent || this.config.trading.stopLoss;
    const takeProfitPercent = options.takeProfitPercent || this.config.trading.takeProfit;
    const stopLoss = direction === 'BUY' 
      ? price * (1 - (stopLossPercent / 100)) 
      : price * (1 + (stopLossPercent / 100));
    const takeProfit = direction === 'BUY'
      ? price * (1 + (takeProfitPercent / 100))
      : price * (1 - (takeProfitPercent / 100));
    const trailingStop = this.config.trading.trailingStopLoss ? {
      enabled: true,
      distance: options.trailingStopDistance || this.config.trading.trailingStopDistance,
      current: stopLoss,
      initial: stopLoss
    } : { enabled: false };
    
    const position = {
      id, token, amount, entryPrice: price, currentPrice: price, direction,
      entryTime: Date.now(), stopLoss, takeProfit, trailingStop,
      lastUpdate: Date.now(),
      signal: options.signal || { type: direction, confidence: options.confidence || 0.5 },
      strategy: options.strategy || this.config.strategy.type,
      maxDuration: options.maxDuration || null,
      metadata: { ...options.metadata || {} }
    };
    
    this.positions.set(id, position);
    this.stats.opened++;
    this.emit('position_opened', position);
    return position;
  }

  async closePosition(positionId, currentPrice, reason = 'MANUAL') {
    const position = this.positions.get(positionId);
    if (!position) throw new Error(`Position avec ID ${positionId} non trouvée`);
    if (!currentPrice) throw new Error('Prix actuel requis pour fermer une position');
    
    const exitTime = Date.now();
    const holdingTimeMs = exitTime - position.entryTime;
    const holdingTimeHours = holdingTimeMs / (1000 * 60 * 60);
    
    const isLong = position.direction === 'BUY';
    const priceDiff = isLong 
      ? currentPrice - position.entryPrice 
      : position.entryPrice - currentPrice;
    
    const pnlPercent = (priceDiff / position.entryPrice) * 100;
    const pnlAbsolute = (position.amount * priceDiff);
    
    const closedPosition = {
      ...position,
      exitPrice: currentPrice,
      exitTime,
      holdingTime: holdingTimeMs,
      holdingTimeHours,
      profit: pnlAbsolute,
      profitPercentage: pnlPercent,
      closeReason: reason
    };
    
    this.stats.closed++;
    this.stats.totalHoldingTime += holdingTimeMs;
    this.stats.avgHoldingTime = this.stats.totalHoldingTime / this.stats.closed;
    if (pnlAbsolute > 0) this.stats.profitable++;
    else this.stats.unprofitable++;
    
    this.positions.delete(positionId);
    this.history.unshift(closedPosition);
    if (this.history.length > 1000) this.history.pop();
    
    this.emit('position_closed', closedPosition);
    return closedPosition;
  }

  async closeAllPositions(priceMap) {
    if (!priceMap) {
      throw new Error('Une map de prix est requise pour fermer toutes les positions');
    }
    
    // Normalize priceMap to Map if it's not already
    let normalizedPriceMap;
    if (priceMap instanceof Map) {
      normalizedPriceMap = priceMap;
    } else if (typeof priceMap === 'object') {
      normalizedPriceMap = new Map();
      Object.entries(priceMap).forEach(([token, price]) => {
        normalizedPriceMap.set(token, price);
      });
    } else {
      throw new Error('Format de prix invalide');
    }
    
    const results = [];
    for (const position of this.positions.values()) {
      const currentPrice = normalizedPriceMap.get(position.token);
      if (!currentPrice) {
        console.warn(`Prix non disponible pour ${position.token}, impossible de fermer la position`);
        continue;
      }
      try {
        const result = await this.closePosition(position.id, currentPrice, 'BULK_CLOSE');
        results.push(result);
      } catch (error) {
        console.error(`Erreur lors de la fermeture de la position ${position.id}:`, error.message);
      }
    }
    return results;
  }

  async updatePositions(priceMap) {
    // Validate and normalize the price data structure
    let normalizedPriceMap = new Map();
    
    if (priceMap) {
      if (priceMap instanceof Map) {
        normalizedPriceMap = priceMap;
      } else if (typeof priceMap === 'object') {
        // Convert object to Map if needed
        Object.entries(priceMap).forEach(([token, price]) => {
          normalizedPriceMap.set(token, price);
        });
      }
    }
    
    if (normalizedPriceMap.size === 0) return [];
    
    const updates = [];
    const positionsToClose = [];
    
    for (const position of this.positions.values()) {
      if (!position || !position.token) continue;
      
      const currentPrice = normalizedPriceMap.get(position.token);
      if (!currentPrice) continue;
      
      position.currentPrice = currentPrice;
      position.lastUpdate = Date.now();
      
      if (position.trailingStop && position.trailingStop.enabled) {
        const isLong = position.direction === 'BUY';
        if (isLong) {
          const potentialStop = currentPrice * (1 - (position.trailingStop.distance / 100));
          if (potentialStop > position.trailingStop.current) {
            position.trailingStop.current = potentialStop;
            updates.push({ id: position.id, type: 'TRAILING_STOP_UPDATE', newStop: potentialStop });
          }
        } else {
          const potentialStop = currentPrice * (1 + (position.trailingStop.distance / 100));
          if (potentialStop < position.trailingStop.current) {
            position.trailingStop.current = potentialStop;
            updates.push({ id: position.id, type: 'TRAILING_STOP_UPDATE', newStop: potentialStop });
          }
        }
      }
      
      const closeReason = this.checkCloseConditions(position);
      if (closeReason) {
        positionsToClose.push({ id: position.id, price: currentPrice, reason: closeReason });
      }
    }
    
    await this._processPositionsToClose(positionsToClose);
    return updates;
  }

  checkCloseConditions(position) {
    if (!position) return null;
    const { currentPrice, direction, stopLoss, takeProfit, trailingStop, entryTime, maxDuration } = position;
    const effectiveStopLoss = trailingStop && trailingStop.enabled ? trailingStop.current : stopLoss;
    
    if (direction === 'BUY' && currentPrice <= effectiveStopLoss) return 'STOP_LOSS';
    if (direction === 'SELL' && currentPrice >= effectiveStopLoss) return 'STOP_LOSS';
    if (direction === 'BUY' && currentPrice >= takeProfit) return 'TAKE_PROFIT';
    if (direction === 'SELL' && currentPrice <= takeProfit) return 'TAKE_PROFIT';
    if (maxDuration && (Date.now() - entryTime) > maxDuration) return 'MAX_DURATION';
    return null;
  }

  async _processPositionsToClose(positionsToClose) {
    const results = [];
    for (const { id, price, reason } of positionsToClose) {
      try {
        const result = await this.closePosition(id, price, reason);
        results.push(result);
      } catch (error) {
        console.error(`Erreur lors de la fermeture automatique de la position ${id}:`, error.message);
      }
    }
    return results;
  }

  getPositionByToken(token) {
    for (const position of this.positions.values()) {
      if (position.token === token) return position;
    }
    return null;
  }

  getRecentlyClosedPositions(limit = 10) {
    return this.history.slice(0, limit);
  }

  getTotalExposure() {
    let totalExposure = 0;
    for (const position of this.positions.values()) {
      totalExposure += position.amount * position.currentPrice;
    }
    return totalExposure;
  }

  getExposureByToken(token) {
    let exposure = 0;
    for (const position of this.positions.values()) {
      if (position.token === token) exposure += position.amount * position.currentPrice;
    }
    return exposure;
  }

  getPerformanceMetrics() {
    const winRate = this.stats.closed > 0 ? (this.stats.profitable / this.stats.closed) * 100 : 0;
    let totalProfit = 0, totalLoss = 0, maxProfit = 0, maxLoss = 0;
    let avgProfit = 0, avgLoss = 0, profitableCount = 0, unprofitableCount = 0;
    
    this.history.forEach(position => {
      if (position.profit > 0) {
        totalProfit += position.profit;
        maxProfit = Math.max(maxProfit, position.profit);
        profitableCount++;
      } else {
        totalLoss += Math.abs(position.profit);
        maxLoss = Math.max(maxLoss, Math.abs(position.profit));
        unprofitableCount++;
      }
    });
    
    avgProfit = profitableCount > 0 ? totalProfit / profitableCount : 0;
    avgLoss = unprofitableCount > 0 ? totalLoss / unprofitableCount : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;
    
    return {
      winRate,
      profitFactor,
      avgProfit,
      avgLoss,
      maxProfit,
      maxLoss,
      avgHoldingTimeHours: this.stats.avgHoldingTime / (1000 * 60 * 60),
      totalTrades: this.stats.closed,
      openPositions: this.positions.size,
      tokenCount: new Set(Array.from(this.positions.values()).map(p => p.token)).size
    };
  }

  getCurrentOpenRisk() {
    let totalRisk = 0;
    for (const position of this.positions.values()) {
      const { direction, entryPrice, currentPrice, amount, stopLoss } = position;
      let riskPerPosition = direction === 'BUY' 
        ? (entryPrice - stopLoss) * amount
        : (stopLoss - entryPrice) * amount;
      totalRisk += riskPerPosition;
    }
    return totalRisk;
  }
}