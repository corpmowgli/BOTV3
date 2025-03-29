import EventEmitter from 'events';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { formatCurrency, formatPercentage, formatTimestamp } from '../utils/helpers.js';
import { LRUCache } from '../utils/cache.js';

export class EnhancedNotificationService extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    
    this.channels = {
      console: {
        enabled: true,
        priority: ['high', 'medium', 'low']
      },
      telegram: {
        enabled: options.telegram?.enabled || false,
        token: process.env.TELEGRAM_BOT_TOKEN || options.telegram?.token,
        chatId: process.env.TELEGRAM_CHAT_ID || options.telegram?.chatId,
        priority: options.telegram?.priority || ['high', 'medium']
      },
      discord: {
        enabled: options.discord?.enabled || false,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL || options.discord?.webhookUrl,
        priority: options.discord?.priority || ['high', 'medium']
      },
      email: {
        enabled: options.email?.enabled || false,
        from: process.env.EMAIL_FROM || options.email?.from || 'bot@solanatrader.com',
        to: process.env.EMAIL_TO || options.email?.to,
        transport: options.email?.transport || {
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT || '587'),
          secure: process.env.EMAIL_SECURE === 'true',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
          }
        },
        priority: options.email?.priority || ['high']
      }
    };
    
    this.options = {
      enabled: options.enabled !== false,
      batchingEnabled: options.batchingEnabled !== false,
      batchInterval: options.batchInterval || 300000,
      throttle: {
        enabled: options.throttle?.enabled !== false,
        period: options.throttle?.period || 60000,
        maxPerPeriod: {
          high: options.throttle?.maxPerPeriod?.high || 10,
          medium: options.throttle?.maxPerPeriod?.medium || 5,
          low: options.throttle?.maxPerPeriod?.low || 2
        }
      },
      templates: options.templates || this._getDefaultTemplates()
    };
    
    this.state = {
      totalSent: 0,
      byType: {},
      byChannel: {},
      lastSent: Date.now(),
      history: [],
      batches: {
        trades: [],
        alerts: [],
        errors: [],
        system: []
      },
      lastBatchSent: Date.now()
    };
    
    this.deduplicationCache = new LRUCache(100);
    this._initializeServices();
    
    if (this.options.batchingEnabled) {
      this._initializeBatching();
    }
  }

  _getDefaultTemplates() {
    return {
      trade: {
        title: 'Transaction exécutée',
        template: 'Transaction {{direction}} {{token}} - Prix: {{price}} - Profit: {{profit}} ({{profitPercentage}})',
        telegramTemplate: '🤖 *Transaction {{direction}} {{token}}*\n💰 Profit: {{profit}} ({{profitPercentage}})\n⏱ {{timestamp}}',
        discordTemplate: '**Transaction {{direction}} {{token}}**\nProfit: {{profit}} ({{profitPercentage}})\nHeure: {{timestamp}}',
        emailSubject: 'SolanaTrader - Nouvelle transaction {{token}}',
        emailTemplate: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>{{direction}} {{token}}</h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">Prix d'entrée</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">{{entryPrice}}</td>
              </tr>
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">Prix de sortie</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">{{exitPrice}}</td>
              </tr>
              <tr>
                <td style="padding: 8px; border-bottom: 1px solid #ddd;">Profit</td>
                <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right; {{profitColor}}">{{profit}} ({{profitPercentage}})</td>
              </tr>
              <tr>
                <td style="padding: 8px;">Date</td>
                <td style="padding: 8px; text-align: right;">{{timestamp}}</td>
              </tr>
            </table>
          </div>
        `
      },
      alert: {
        title: 'Alerte de trading',
        template: 'Alerte: {{message}}',
        telegramTemplate: '⚠️ *ALERTE*\n{{message}}\n⏱ {{timestamp}}',
        discordTemplate: '**ALERTE**\n{{message}}\nHeure: {{timestamp}}',
        emailSubject: 'SolanaTrader - Alerte',
        emailTemplate: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #FFA500;">⚠️ Alerte</h2>
            <p>{{message}}</p>
            <p style="color: #888;">{{timestamp}}</p>
          </div>
        `
      },
      error: {
        title: 'Erreur système',
        template: 'Erreur: {{message}}',
        telegramTemplate: '🔴 *ERREUR*\n{{message}}\n⏱ {{timestamp}}',
        discordTemplate: '**ERREUR**\n{{message}}\nHeure: {{timestamp}}',
        emailSubject: 'SolanaTrader - Erreur système',
        emailTemplate: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #FF0000;">🔴 Erreur système</h2>
            <p>{{message}}</p>
            <p style="color: #888;">{{timestamp}}</p>
          </div>
        `
      },
      system: {
        title: 'Notification système',
        template: '{{message}}',
        telegramTemplate: '🔵 *SYSTÈME*\n{{message}}\n⏱ {{timestamp}}',
        discordTemplate: '**SYSTÈME**\n{{message}}\nHeure: {{timestamp}}',
        emailSubject: 'SolanaTrader - Notification système',
        emailTemplate: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #0066CC;">🔵 Notification système</h2>
            <p>{{message}}</p>
            <p style="color: #888;">{{timestamp}}</p>
          </div>
        `
      },
      batchSummary: {
        telegramTemplate: `🤖 *SolanaTrader - Résumé de la période*
        
🟢 *Trades*
{{tradesSummary}}

⚠️ *Alertes*
{{alertsSummary}}

🔴 *Erreurs*
{{errorsSummary}}

🔵 *Système*
{{systemSummary}}

⏱ Généré: {{timestamp}}
        `,
        discordTemplate: `**SolanaTrader - Résumé de la période**
        
:green_circle: **Trades**
{{tradesSummary}}

:warning: **Alertes**
{{alertsSummary}}

:red_circle: **Erreurs**
{{errorsSummary}}

:blue_circle: **Système**
{{systemSummary}}

Généré: {{timestamp}}
        `,
        emailSubject: 'SolanaTrader - Résumé de la période',
        emailTemplate: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>SolanaTrader - Résumé de la période</h2>
            
            <h3 style="color: #43A047;">Trades</h3>
            <div>{{tradesSummary}}</div>
            
            <h3 style="color: #FFA500;">Alertes</h3>
            <div>{{alertsSummary}}</div>
            
            <h3 style="color: #E53935;">Erreurs</h3>
            <div>{{errorsSummary}}</div>
            
            <h3 style="color: #0066CC;">Système</h3>
            <div>{{systemSummary}}</div>
            
            <p style="color: #888; margin-top: 20px;">Généré: {{timestamp}}</p>
          </div>
        `
      }
    };
  }

  _initializeServices() {
    if (this.channels.email.enabled && this.channels.email.transport) {
      try {
        this.emailTransporter = nodemailer.createTransport(this.channels.email.transport);
        
        this.emailTransporter.verify((error) => {
          if (error) {
            console.error('Erreur de configuration email:', error);
            this.channels.email.enabled = false;
          } else {
            console.log('Connexion au serveur email réussie');
          }
        });
      } catch (error) {
        console.error('Erreur lors de l\'initialisation du service email:', error);
        this.channels.email.enabled = false;
      }
    }
  }

  _initializeBatching() {
    setInterval(() => {
      this._sendBatchNotifications();
    }, this.options.batchInterval);
  }

  async notifyTrade(trade, options = {}) {
    if (!this.options.enabled || !trade) return false;
    
    const profit = trade.profit !== undefined ? trade.profit : 0;
    const profitPercentage = trade.profitPercentage !== undefined ? trade.profitPercentage : 0;
    
    const direction = (trade.direction === 'BUY') 
      ? profit >= 0 ? 'ACHAT ➚' : 'ACHAT ➘' 
      : profit >= 0 ? 'VENTE ➘' : 'VENTE ➚';
    
    let priority = 'medium';
    if (Math.abs(profitPercentage) > 10 || Math.abs(profit) > 100) {
      priority = 'high';
    } else if (Math.abs(profitPercentage) < 2 || Math.abs(profit) < 20) {
      priority = 'low';
    }
    
    const data = {
      type: 'trade',
      token: trade.token,
      direction,
      entryPrice: formatCurrency(trade.entryPrice),
      exitPrice: formatCurrency(trade.exitPrice),
      profit: formatCurrency(profit),
      profitPercentage: formatPercentage(profitPercentage),
      timestamp: formatTimestamp(trade.exitTime),
      profitColor: profit >= 0 ? 'color: green;' : 'color: red;',
      priority,
      raw: trade
    };
    
    if (this.options.batchingEnabled) {
      this.state.batches.trades.push(data);
      
      if (this.state.batches.trades.length >= 5) {
        this._sendBatchNotifications(['trades']);
      }
    }
    
    return this.notify({
      type: 'trade',
      title: this.options.templates.trade.title,
      message: this.formatMessage(this.options.templates.trade.template, data),
      priority,
      data
    });
  }

  async notifyAlert(message, priority = 'medium', data = {}) {
    if (!this.options.enabled || !message) return false;
    
    const notificationData = {
      message,
      timestamp: formatTimestamp(Date.now()),
      priority,
      ...data
    };
    
    if (this.options.batchingEnabled) {
      this.state.batches.alerts.push(notificationData);
    }
    
    return this.notify({
      type: 'alert',
      title: this.options.templates.alert.title,
      message: this.formatMessage(this.options.templates.alert.template, { message }),
      priority,
      data: notificationData
    });
  }

  async notifyError(error, priority = 'high', data = {}) {
    if (!this.options.enabled) return false;
    
    let errorMessage = error;
    let errorData = { ...data };
    
    if (error instanceof Error) {
      errorMessage = error.message;
      errorData = {
        ...errorData,
        name: error.name,
        stack: error.stack,
        code: error.code
      };
    }
    
    const dedupeKey = `error_${errorMessage}`;
    if (this.deduplicationCache.has(dedupeKey)) {
      return false;
    }
    
    this.deduplicationCache.set(dedupeKey, Date.now(), 900000);
    
    const notificationData = {
      message: errorMessage,
      timestamp: formatTimestamp(Date.now()),
      priority,
      ...errorData
    };
    
    if (this.options.batchingEnabled) {
      this.state.batches.errors.push(notificationData);
    }
    
    return this.notify({
      type: 'error',
      title: this.options.templates.error.title,
      message: this.formatMessage(this.options.templates.error.template, { message: errorMessage }),
      priority,
      data: notificationData
    });
  }

  async notifySystem(message, priority = 'medium', data = {}) {
    if (!this.options.enabled || !message) return false;
    
    const notificationData = {
      message,
      timestamp: formatTimestamp(Date.now()),
      priority,
      ...data
    };
    
    if (this.options.batchingEnabled) {
      this.state.batches.system.push(notificationData);
    }
    
    return this.notify({
      type: 'system',
      title: this.options.templates.system.title,
      message,
      priority,
      data: notificationData
    });
  }

  async notify(notification) {
    if (!this.options.enabled) return false;
    
    if (!notification.message) {
      console.error('Notification sans message');
      return false;
    }
    
    const priority = notification.priority || 'medium';
    
    if (this.options.throttle.enabled && !this._canSendNotification(priority)) {
      return false;
    }
    
    const completeNotification = {
      id: this._generateNotificationId(),
      timestamp: Date.now(),
      ...notification
    };
    
    this._updateStats(completeNotification);
    this.emit('notification', completeNotification);
    
    const results = await Promise.allSettled(
      Object.entries(this.channels)
        .filter(([channel, config]) => 
          config.enabled && config.priority.includes(priority)
        )
        .map(([channel]) => this._sendToChannel(channel, completeNotification))
    );
    
    return results.some(result => result.status === 'fulfilled' && result.value);
  }

  _canSendNotification(priority) {
    const now = Date.now();
    const throttle = this.options.throttle;
    const MAX_HISTORY = 100;
    
    this.state.history = this.state.history.filter(item => 
      (now - item.timestamp) < throttle.period
    );
    
    const countByPriority = {
      high: 0,
      medium: 0,
      low: 0
    };
    
    this.state.history.forEach(item => {
      countByPriority[item.priority]++;
    });
    
    if (countByPriority[priority] >= throttle.maxPerPeriod[priority]) {
      return false;
    }
    
    this.state.history.push({
      timestamp: now,
      priority
    });
    
    if (this.state.history.length > MAX_HISTORY) {
      this.state.history = this.state.history.slice(-MAX_HISTORY);
    }
    
    return true;
  }

  async _sendToChannel(channel, notification) {
    try {
      switch (channel) {
        case 'console': return this._sendToConsole(notification);
        case 'telegram': return await this._sendToTelegram(notification);
        case 'discord': return await this._sendToDiscord(notification);
        case 'email': return await this._sendToEmail(notification);
        default:
          console.warn(`Canal de notification non supporté: ${channel}`);
          return false;
      }
    } catch (error) {
      console.error(`Erreur lors de l'envoi de notification sur ${channel}:`, error);
      return false;
    }
  }

  _sendToConsole(notification) {
    const { type, title, message, priority } = notification;
    
    let coloredMessage;
    switch (priority) {
      case 'high': coloredMessage = `\x1b[31m${message}\x1b[0m`; break;
      case 'medium': coloredMessage = `\x1b[33m${message}\x1b[0m`; break;
      default: coloredMessage = `\x1b[36m${message}\x1b[0m`;
    }
    
    console.log(`[${new Date().toISOString()}] [${type.toUpperCase()}] ${title}: ${coloredMessage}`);
    return true;
  }

  async _sendToTelegram(notification) {
    if (!this.channels.telegram.token || !this.channels.telegram.chatId) {
      return false;
    }
    
    try {
      const { type, data } = notification;
      let message;
      
      switch (type) {
        case 'trade': message = this.formatMessage(this.options.templates.trade.telegramTemplate, data); break;
        case 'alert': message = this.formatMessage(this.options.templates.alert.telegramTemplate, data); break;
        case 'error': message = this.formatMessage(this.options.templates.error.telegramTemplate, data); break;
        case 'system': message = this.formatMessage(this.options.templates.system.telegramTemplate, data); break;
        default: message = notification.message;
      }
      
      const response = await axios.post(
        `https://api.telegram.org/bot${this.channels.telegram.token}/sendMessage`,
        {
          chat_id: this.channels.telegram.chatId,
          text: message,
          parse_mode: 'Markdown'
        }
      );
      
      return response.status === 200;
    } catch (error) {
      console.error('Erreur lors de l\'envoi sur Telegram:', error);
      return false;
    }
  }

  async _sendToDiscord(notification) {
    if (!this.channels.discord.webhookUrl) return false;
    
    try {
      const { type, data } = notification;
      let content;
      
      switch (type) {
        case 'trade': content = this.formatMessage(this.options.templates.trade.discordTemplate, data); break;
        case 'alert': content = this.formatMessage(this.options.templates.alert.discordTemplate, data); break;
        case 'error': content = this.formatMessage(this.options.templates.error.discordTemplate, data); break;
        case 'system': content = this.formatMessage(this.options.templates.system.discordTemplate, data); break;
        default: content = notification.message;
      }
      
      let color;
      switch (notification.priority) {
        case 'high':
          color = type === 'trade' && data.profit >= 0 ? 0x43A047 : 0xE53935;
          break;
        case 'medium': color = 0xFFB300; break;
        default: color = 0x039BE5;
      }
      
      const payload = {
        embeds: [{
          title: notification.title,
          description: content,
          color: color,
          timestamp: new Date().toISOString()
        }]
      };
      
      const response = await axios.post(this.channels.discord.webhookUrl, payload);
      return response.status === 204;
    } catch (error) {
      console.error('Erreur lors de l\'envoi sur Discord:', error);
      return false;
    }
  }

  async _sendToEmail(notification) {
    if (!this.emailTransporter || !this.channels.email.to) return false;
    
    try {
      const { type, data } = notification;
      let subject, html;
      
      switch (type) {
        case 'trade':
          subject = this.formatMessage(this.options.templates.trade.emailSubject, data);
          html = this.formatMessage(this.options.templates.trade.emailTemplate, data);
          break;
        case 'alert':
          subject = this.formatMessage(this.options.templates.alert.emailSubject, data);
          html = this.formatMessage(this.options.templates.alert.emailTemplate, data);
          break;
        case 'error':
          subject = this.formatMessage(this.options.templates.error.emailSubject, data);
          html = this.formatMessage(this.options.templates.error.emailTemplate, data);
          break;
        case 'system':
          subject = this.formatMessage(this.options.templates.system.emailSubject, data);
          html = this.formatMessage(this.options.templates.system.emailTemplate, data);
          break;
        default:
          subject = notification.title;
          html = `<p>${notification.message}</p>`;
      }
      
      const result = await this.emailTransporter.sendMail({
        from: this.channels.email.from,
        to: this.channels.email.to,
        subject,
        html
      });
      
      return !!result.messageId;
    } catch (error) {
      console.error('Erreur lors de l\'envoi d\'email:', error);
      return false;
    }
  }

  async _sendBatchNotifications(types = ['trades', 'alerts', 'errors', 'system']) {
    const hasBatches = types.some(type => this.state.batches[type].length > 0);
    if (!hasBatches) return;
    
    const tradeSummaries = this._prepareTradeSummary();
    const alertSummaries = this._prepareAlertsSummary();
    const errorSummaries = this._prepareErrorsSummary();
    const systemSummaries = this._prepareSystemSummary();
    
    const data = {
      tradesSummary: tradeSummaries.text || "_Aucune transaction_",
      alertsSummary: alertSummaries.text || "_Aucune alerte_",
      errorsSummary: errorSummaries.text || "_Aucune erreur_",
      systemSummary: systemSummaries.text || "_Aucune notification système_",
      timestamp: formatTimestamp(Date.now()),
      tradeCount: this.state.batches.trades.length,
      alertCount: this.state.batches.alerts.length,
      errorCount: this.state.batches.errors.length,
      systemCount: this.state.batches.system.length
    };
    
    if (this.channels.telegram.enabled) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.channels.telegram.token}/sendMessage`,
          {
            chat_id: this.channels.telegram.chatId,
            text: this.formatMessage(this.options.templates.batchSummary.telegramTemplate, data),
            parse_mode: 'Markdown'
          }
        );
      } catch (error) {
        console.error('Erreur lors de l\'envoi du résumé sur Telegram:', error);
      }
    }
    
    if (this.channels.discord.enabled) {
      try {
        const payload = {
          embeds: [{
            title: "SolanaTrader - Résumé de la période",
            description: this.formatMessage(this.options.templates.batchSummary.discordTemplate, data),
            color: 0x3949AB,
            timestamp: new Date().toISOString()
          }]
        };
        
        await axios.post(this.channels.discord.webhookUrl, payload);
      } catch (error) {
        console.error('Erreur lors de l\'envoi du résumé sur Discord:', error);
      }
    }
    
    if (this.channels.email.enabled && this.emailTransporter) {
      try {
        await this.emailTransporter.sendMail({
          from: this.channels.email.from,
          to: this.channels.email.to,
          subject: this.formatMessage(this.options.templates.batchSummary.emailSubject, data),
          html: this.formatMessage(this.options.templates.batchSummary.emailTemplate, data)
        });
      } catch (error) {
        console.error('Erreur lors de l\'envoi du résumé par email:', error);
      }
    }
    
    if (types.includes('trades')) this.state.batches.trades = [];
    if (types.includes('alerts')) this.state.batches.alerts = [];
    if (types.includes('errors')) this.state.batches.errors = [];
    if (types.includes('system')) this.state.batches.system = [];
    
    this.state.lastBatchSent = Date.now();
  }

  _prepareTradeSummary() {
    const trades = this.state.batches.trades;
    
    if (trades.length === 0) {
      return { text: '', html: '' };
    }
    
    const totalProfit = trades.reduce((sum, t) => {
      const profitValue = typeof t.raw.profit === 'number' 
        ? t.raw.profit 
        : parseFloat((t.raw.profit || '0').replace(/[^0-9.-]+/g, ''));
      return sum + profitValue;
    }, 0);
    
    const winningTrades = trades.filter(t => 
      (typeof t.raw.profit === 'number' ? t.raw.profit : parseFloat((t.raw.profit || '0').replace(/[^0-9.-]+/g, ''))) > 0
    );
    
    let text = `${trades.length} transactions, ${winningTrades.length} gagnantes (${((winningTrades.length / trades.length) * 100).toFixed(0)}%)\n`;
    text += `Profit total: ${formatCurrency(totalProfit)}\n\n`;
    
    const sortedTrades = [...trades].sort((a, b) => {
      const profitA = typeof a.raw.profit === 'number' ? a.raw.profit : parseFloat((a.raw.profit || '0').replace(/[^0-9.-]+/g, ''));
      const profitB = typeof b.raw.profit === 'number' ? b.raw.profit : parseFloat((b.raw.profit || '0').replace(/[^0-9.-]+/g, ''));
      return profitB - profitA;
    });
    
    if (sortedTrades.length > 0) {
      text += 'Meilleures transactions:\n';
      sortedTrades.slice(0, 3).forEach((t, i) => {
        text += `${i+1}. ${t.token}: ${t.profit} (${t.profitPercentage})\n`;
      });
    }
    
    let html = `
      <p><strong>${trades.length} transactions, ${winningTrades.length} gagnantes (${((winningTrades.length / trades.length) * 100).toFixed(0)}%)</strong></p>
      <p>Profit total: ${formatCurrency(totalProfit)}</p>
    `;
    
    if (sortedTrades.length > 0) {
      html += '<p><strong>Meilleures transactions:</strong></p><ul>';
      sortedTrades.slice(0, 3).forEach(t => {
        const profitStyle = t.raw.profit >= 0 ? 'color: green;' : 'color: red;';
        html += `<li>${t.token}: <span style="${profitStyle}">${t.profit} (${t.profitPercentage})</span></li>`;
      });
      html += '</ul>';
    }
    
    return { text, html };
  }

  _prepareAlertsSummary() {
    const alerts = this.state.batches.alerts;
    
    if (alerts.length === 0) {
      return { text: '', html: '' };
    }
    
    let text = `${alerts.length} alertes\n\n`;
    alerts.slice(0, 5).forEach((alert, i) => {
      text += `${i+1}. ${alert.message}\n`;
    });
    
    if (alerts.length > 5) {
      text += `... et ${alerts.length - 5} autres\n`;
    }
    
    let html = `<p><strong>${alerts.length} alertes</strong></p><ul>`;
    alerts.slice(0, 5).forEach(alert => {
      html += `<li>${alert.message}</li>`;
    });
    
    if (alerts.length > 5) {
      html += `<li>... et ${alerts.length - 5} autres</li>`;
    }
    
    html += '</ul>';
    
    return { text, html };
  }

  _prepareErrorsSummary() {
    const errors = this.state.batches.errors;
    
    if (errors.length === 0) {
      return { text: '', html: '' };
    }
    
    let text = `${errors.length} erreurs\n\n`;
    errors.slice(0, 5).forEach((error, i) => {
      text += `${i+1}. ${error.message}\n`;
    });
    
    if (errors.length > 5) {
      text += `... et ${errors.length - 5} autres\n`;
    }
    
    let html = `<p><strong>${errors.length} erreurs</strong></p><ul>`;
    errors.slice(0, 5).forEach(error => {
      html += `<li>${error.message}</li>`;
    });
    
    if (errors.length > 5) {
      html += `<li>... et ${errors.length - 5} autres</li>`;
    }
    
    html += '</ul>';
    
    return { text, html };
  }

  _prepareSystemSummary() {
    const systemNotifs = this.state.batches.system;
    
    if (systemNotifs.length === 0) {
      return { text: '', html: '' };
    }
    
    let text = `${systemNotifs.length} notifications\n\n`;
    systemNotifs.slice(0, 5).forEach((notif, i) => {
      text += `${i+1}. ${notif.message}\n`;
    });
    
    if (systemNotifs.length > 5) {
      text += `... et ${systemNotifs.length - 5} autres\n`;
    }
    
    let html = `<p><strong>${systemNotifs.length} notifications</strong></p><ul>`;
    systemNotifs.slice(0, 5).forEach(notif => {
      html += `<li>${notif.message}</li>`;
    });
    
    if (systemNotifs.length > 5) {
      html += `<li>... et ${systemNotifs.length - 5} autres</li>`;
    }
    
    html += '</ul>';
    
    return { text, html };
  }

  _updateStats(notification) {
    this.state.totalSent++;
    this.state.lastSent = notification.timestamp;
    this.state.byType[notification.type] = (this.state.byType[notification.type] || 0) + 1;
    
    if (this.state.history.length > 100) {
      this.state.history.shift();
    }
  }

  formatMessage(template, data) {
    if (!template) return '';
    
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] !== undefined ? data[key] : match;
    });
  }

  _generateNotificationId() {
    return 'notif_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  }

  getStats() {
    return { 
      ...this.state,
      channels: Object.fromEntries(
        Object.entries(this.channels).map(([name, config]) => [name, { enabled: config.enabled }])
      ),
      batches: {
        trades: this.state.batches.trades.length,
        alerts: this.state.batches.alerts.length,
        errors: this.state.batches.errors.length,
        system: this.state.batches.system.length,
        lastSent: this.state.lastBatchSent
      }
    };
  }

  setEnabled(enabled) {
    this.options.enabled = !!enabled;
  }

  updateConfig(channelName, config) {
    if (this.channels[channelName]) {
      this.channels[channelName] = {
        ...this.channels[channelName],
        ...config
      };
      return true;
    }
    return false;
  }
}