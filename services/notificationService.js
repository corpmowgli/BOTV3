import EventEmitter from 'events';
import { formatCurrency, formatPercentage } from '../utils/helpers.js';

export class NotificationService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.enabled = true;
    this.notifications = [];
    this.maxHistory = 100;
    this.debug = config.logging?.level === 'debug';
  }

  /**
   * Send a general notification
   */
  async notify(notification) {
    if (!this.enabled) return false;
    
    const completeNotification = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      timestamp: Date.now(),
      ...notification
    };
    
    this.storeNotification(completeNotification);
    this.emit('notification', completeNotification);
    
    if (this.debug) {
      console.log(`[Notification] ${notification.title || ''}: ${notification.message}`);
    }
    
    return true;
  }

  /**
   * Notify about a trade
   */
  async notifyTrade(trade) {
    if (!this.enabled || !trade) return false;
    
    const direction = trade.direction || 'TRADE';
    const profit = trade.profit || 0;
    const profitPercentage = trade.profitPercentage || 0;
    
    let priority = 'medium';
    if (Math.abs(profitPercentage) > 5) {
      priority = 'high';
    } else if (Math.abs(profitPercentage) < 1) {
      priority = 'low';
    }
    
    const formatPrice = (price) => price ? formatCurrency(price) : 'N/A';
    
    return this.notify({
      type: 'trade',
      title: `${direction} ${trade.token} ${profit >= 0 ? 'Profit' : 'Loss'}`,
      message: `${trade.token}: ${formatCurrency(profit)} (${formatPercentage(profitPercentage)})`,
      priority,
      data: {
        token: trade.token,
        entryPrice: formatPrice(trade.entryPrice),
        exitPrice: formatPrice(trade.exitPrice),
        profit: formatCurrency(profit),
        profitPercentage: formatPercentage(profitPercentage)
      }
    });
  }

  /**
   * Notify about an error
   */
  async notifyError(error, additionalInfo = {}) {
    if (!this.enabled) return false;
    
    let errorMessage = error;
    let errorData = {};
    
    if (error instanceof Error) {
      errorMessage = error.message;
      errorData = {
        name: error.name,
        stack: error.stack
      };
    }
    
    return this.notify({
      type: 'error',
      title: 'Error',
      message: errorMessage,
      priority: 'high',
      data: { ...errorData, ...additionalInfo }
    });
  }

  /**
   * Notify about a system alert or warning
   */
  async notifyAlert(message, priority = 'medium', data = {}) {
    if (!this.enabled) return false;
    
    return this.notify({
      type: 'alert',
      title: 'Alert',
      message,
      priority,
      data
    });
  }

  /**
   * Store notifications in history
   */
  storeNotification(notification) {
    this.notifications.unshift(notification);
    
    if (this.notifications.length > this.maxHistory) {
      this.notifications = this.notifications.slice(0, this.maxHistory);
    }
  }

  /**
   * Enable or disable notifications
   */
  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  /**
   * Get recent notifications
   */
  getNotifications(limit = 10) {
    return this.notifications.slice(0, limit);
  }
}

export default NotificationService;