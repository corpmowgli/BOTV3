#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { TradingBot } from './bot/tradingBot.js';
import { tradingConfig } from './config/tradingConfig.js';
import { apiConfig } from './config/apiConfig.js';
import { securityConfig } from './config/securityConfig.js';

// Load environment variables
dotenv.config();

// Set up path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create necessary directories
const createRequiredDirectories = () => {
  const dirs = [
    path.join(__dirname, 'logs'),
    path.join(__dirname, 'logs/trades'),
    path.join(__dirname, 'models')
  ];
  
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  }
};

// Parse command line arguments
const parseArgs = () => {
  const args = {
    mode: 'normal', // normal, sim, optimize
    simDays: 30,
    logLevel: process.env.LOG_LEVEL || 'info',
    autostart: false,
    configOverrides: {}
  };
  
  process.argv.forEach((arg, index) => {
    if (arg === '--sim' || arg === '--simulation') {
      args.mode = 'sim';
      if (process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
        args.simDays = parseInt(process.argv[index + 1], 10);
      }
    } else if (arg === '--optimize') {
      args.mode = 'optimize';
    } else if (arg === '--autostart') {
      args.autostart = true;
    } else if (arg.startsWith('--log=')) {
      args.logLevel = arg.split('=')[1];
    }
  });
  
  return args;
};

// Banner
const showBanner = () => {
  console.log(`
  ███████╗ ██████╗ ██╗      █████╗ ███╗   ██╗ █████╗     ████████╗██████╗  █████╗ ██████╗ ███████╗██████╗ 
  ██╔════╝██╔═══██╗██║     ██╔══██╗████╗  ██║██╔══██╗    ╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗
  ███████╗██║   ██║██║     ███████║██╔██╗ ██║███████║       ██║   ██████╔╝███████║██║  ██║█████╗  ██████╔╝
  ╚════██║██║   ██║██║     ██╔══██║██║╚██╗██║██╔══██║       ██║   ██╔══██╗██╔══██║██║  ██║██╔══╝  ██╔══██╗
  ███████║╚██████╔╝███████╗██║  ██║██║ ╚████║██║  ██║       ██║   ██║  ██║██║  ██║██████╔╝███████╗██║  ██║
  ╚══════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝       ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝
                                                                                                        
  `);
  console.log(`Version: 1.0.0`);
  console.log(`Node.js: ${process.version}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`---------------------------------------------------------------------------`);
};

// Main function
async function main() {
  showBanner();
  createRequiredDirectories();
  
  const args = parseArgs();
  console.log(`Starting in ${args.mode} mode with log level ${args.logLevel}`);
  
  // Create bot with merged config
  const config = {
    ...tradingConfig,
    api: apiConfig,
    security: securityConfig,
    logging: {
      ...tradingConfig.logging,
      level: args.logLevel
    },
    ...args.configOverrides
  };
  
  const bot = new TradingBot(config);
  
  // Handle different modes
  if (args.mode === 'sim') {
    console.log(`Running simulation for ${args.simDays} days...`);
    
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - args.simDays);
    
    try {
      const results = await bot.runSimulation(startDate, endDate);
      console.log(`\nSimulation Results:`);
      console.log(`Trades: ${results.totalTrades} (${results.winningTrades} winning, ${results.losingTrades} losing)`);
      console.log(`Profit: ${results.totalProfit.toFixed(2)} (${results.profitPercentage.toFixed(2)}%)`);
      console.log(`Win Rate: ${results.winRate.toFixed(2)}%`);
      console.log(`Max Drawdown: ${results.maxDrawdown.toFixed(2)}%`);
      
      // Display top 5 tokens by performance
      if (results.tokenPerformance && results.tokenPerformance.length > 0) {
        console.log(`\nTop Token Performance:`);
        results.tokenPerformance
          .sort((a, b) => b.profit - a.profit)
          .slice(0, 5)
          .forEach((token, i) => {
            console.log(`${i+1}. ${token.token}: Profit ${token.profit.toFixed(2)}, Win Rate ${token.winRate.toFixed(2)}%`);
          });
      }
    } catch (error) {
      console.error(`Simulation error: ${error.message}`);
      process.exit(1);
    }
  } else if (args.mode === 'optimize') {
    console.log(`Running strategy optimization...`);
    
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30); // 30 days for optimization
    
    const parametersToOptimize = {
      'indicators.rsi.oversold': { min: 20, max: 40, step: 5 },
      'indicators.rsi.overbought': { min: 60, max: 80, step: 5 },
      'trading.stopLoss': { min: 3, max: 10, step: 1 },
      'trading.takeProfit': { min: 5, max: 25, step: 5 }
    };
    
    try {
      const results = await bot.optimizeStrategy(startDate, endDate, parametersToOptimize);
      
      console.log(`\nOptimization Results:`);
      console.log(`Combinations tested: ${results.combinationsTested}`);
      
      if (results.bestParameters) {
        console.log(`\nBest Parameters:`);
        Object.entries(results.bestParameters).forEach(([param, value]) => {
          console.log(`${param}: ${value}`);
        });
        
        console.log(`\nBest Performance:`);
        console.log(`Profit: ${results.bestPerformance.totalProfit.toFixed(2)}`);
        console.log(`Win Rate: ${results.bestPerformance.winRate.toFixed(2)}%`);
        console.log(`Sharpe Ratio: ${results.bestPerformance.sharpeRatio.toFixed(2)}`);
      } else {
        console.log(`No optimal parameters found.`);
      }
    } catch (error) {
      console.error(`Optimization error: ${error.message}`);
      process.exit(1);
    }
  } else {
    // Normal mode - start the bot and server
    console.log(`Starting Solana Trading Bot...`);
    
    try {
      // Import server dynamically to avoid circular dependencies
      const { default: startServer } = await import('./server.js');
      
      // Start server
      await startServer();
      
      // Start bot if autostart enabled
      if (args.autostart) {
        console.log(`Auto-starting trading bot...`);
        await bot.start();
        console.log(`Bot started successfully`);
      } else {
        console.log(`Bot ready - use API or dashboard to start trading`);
      }
      
      // Handle process termination
      process.on('SIGINT', async () => {
        console.log('\nShutting down gracefully...');
        if (bot.isRunning) {
          await bot.stop();
        }
        process.exit(0);
      });
      
      process.on('SIGTERM', async () => {
        console.log('\nShutting down gracefully...');
        if (bot.isRunning) {
          await bot.stop();
        }
        process.exit(0);
      });
      
    } catch (error) {
      console.error(`Failed to start: ${error.message}`);
      process.exit(1);
    }
  }
}

// Run main function
main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});