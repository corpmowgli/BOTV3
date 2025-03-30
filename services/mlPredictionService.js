import * as tf from '@tensorflow/tfjs-node';
import { LRUCache } from '../utils/cache.js';

export class MLPredictionService {
  constructor(config) {
    this.config = config;
    this.models = new Map();
    this.predictionCache = new LRUCache(100);
    this.modelPath = config.mlModels?.path || './models';
    this.initialized = false;
    this.initialize();
  }
  
  async initialize() {
    try {
      this.initialized = true;
      // Try to load default models for popular tokens
      const mainTokens = ['SOL', 'RAY', 'SRM', 'FIDA', 'MNGO'];
      for (const token of mainTokens) {
        try {
          const modelPath = `file://${this.modelPath}/${token}_model/model.json`;
          const model = await tf.loadLayersModel(modelPath).catch(() => null);
          if (model) {
            this.models.set(token, model);
            console.log(`Loaded prediction model for ${token}`);
          }
        } catch (error) {
          console.warn(`Could not load model for ${token}: ${error.message}`);
        }
      }
    } catch (error) {
      console.error('Error initializing ML prediction service:', error);
      this.initialized = false;
    }
  }
  
  async predictPrice(token, timeframe, historicalData) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const cacheKey = `prediction_${token}_${timeframe}_${Date.now()}`;
    const cachedPrediction = this.predictionCache.get(cacheKey);
    if (cachedPrediction) return cachedPrediction;
    
    try {
      // Prepare input features from historical data
      const features = this._prepareFeatures(historicalData);
      
      // Get or create model for this token
      let model = this.models.get(token);
      if (!model) {
        if (historicalData && historicalData.prices && historicalData.prices.length > 50) {
          model = await this._trainModel(token, historicalData);
          this.models.set(token, model);
        } else {
          return { price: null, confidence: 0, error: 'Insufficient data for prediction' };
        }
      }
      
      // Make prediction
      const tensorData = tf.tensor2d([features]);
      const prediction = model.predict(tensorData);
      const predictedValues = await prediction.data();
      tensorData.dispose();
      prediction.dispose();
      
      // Process prediction results
      const predictedPrice = predictedValues[0];
      const confidence = this._calculateConfidence(predictedPrice, historicalData.prices);
      
      const result = {
        price: predictedPrice,
        confidence,
        timestamp: Date.now()
      };
      
      this.predictionCache.set(cacheKey, result, 60000); // Cache for 1 minute
      return result;
    } catch (error) {
      console.error(`Error predicting price for ${token}:`, error);
      return { price: null, confidence: 0, error: error.message };
    }
  }
  
  async _trainModel(token, historicalData) {
    console.log(`Training new model for ${token}...`);
    
    try {
      // Prepare training data
      const { trainingData, labels } = this._prepareTrainingData(historicalData);
      
      // Define model architecture
      const model = tf.sequential();
      
      // Add layers
      model.add(tf.layers.dense({ units: 64, activation: 'relu', inputShape: [trainingData[0].length] }));
      model.add(tf.layers.dropout({ rate: 0.2 }));
      model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
      model.add(tf.layers.dense({ units: 1 }));
      
      // Compile model
      model.compile({ optimizer: 'adam', loss: 'meanSquaredError' });
      
      // Train model
      const xs = tf.tensor2d(trainingData);
      const ys = tf.tensor2d(labels.map(l => [l]));
      
      await model.fit(xs, ys, {
        epochs: 50,
        batchSize: 32,
        validationSplit: 0.2,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            if (epoch % 10 === 0) {
              console.log(`Training model for ${token} - Epoch ${epoch}: loss = ${logs.loss}`);
            }
          }
        }
      });
      
      xs.dispose();
      ys.dispose();
      
      // Save model if a save path is configured
      if (this.config.mlModels?.saveModels) {
        const savePath = `file://${this.modelPath}/${token}_model`;
        await model.save(savePath);
        console.log(`Model for ${token} saved to ${savePath}`);
      }
      
      return model;
    } catch (error) {
      console.error(`Error training model for ${token}:`, error);
      throw error;
    }
  }
  
  _prepareFeatures(historicalData) {
    if (!historicalData || !historicalData.prices || historicalData.prices.length < 20) {
      throw new Error('Insufficient historical data for feature preparation');
    }
    
    const { prices, volumes } = historicalData;
    
    // Use the last 20 price points
    const recentPrices = prices.slice(-20);
    
    // Calculate price changes
    const priceChanges = [];
    for (let i = 1; i < recentPrices.length; i++) {
      priceChanges.push((recentPrices[i] - recentPrices[i-1]) / recentPrices[i-1]);
    }
    
    // Calculate moving averages
    const ma5 = this._calculateMovingAverage(prices, 5);
    const ma10 = this._calculateMovingAverage(prices, 10);
    const ma20 = this._calculateMovingAverage(prices, 20);
    
    // Calculate volume features if available
    let volumeFeatures = [];
    if (volumes && volumes.length === prices.length) {
      const recentVolumes = volumes.slice(-20);
      const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;
      const volumeRatio = recentVolumes[recentVolumes.length - 1] / avgVolume;
      volumeFeatures = [volumeRatio];
    } else {
      volumeFeatures = [1.0]; // Default if no volume data
    }
    
    // Create feature vector: recent price changes, moving average ratios, and volume ratio
    const features = [
      ...priceChanges,
      ma5 / prices[prices.length - 1],
      ma10 / prices[prices.length - 1],
      ma20 / prices[prices.length - 1],
      ...volumeFeatures
    ];
    
    return features;
  }
  
  _prepareTrainingData(historicalData) {
    const { prices, volumes } = historicalData;
    const windowSize = 20; // Use 20 data points to predict the next
    
    const trainingData = [];
    const labels = [];
    
    for (let i = windowSize; i < prices.length - 1; i++) {
      const windowPrices = prices.slice(i - windowSize, i);
      const features = [];
      
      // Add price changes as features
      for (let j = 1; j < windowPrices.length; j++) {
        features.push((windowPrices[j] - windowPrices[j-1]) / windowPrices[j-1]);
      }
      
      // Add moving averages
      const ma5 = this._calculateMovingAverage(prices.slice(0, i), 5);
      const ma10 = this._calculateMovingAverage(prices.slice(0, i), 10);
      const ma20 = this._calculateMovingAverage(prices.slice(0, i), 20);
      
      features.push(ma5 / prices[i-1]);
      features.push(ma10 / prices[i-1]);
      features.push(ma20 / prices[i-1]);
      
      // Add volume feature if available
      if (volumes && volumes.length === prices.length) {
        const windowVolumes = volumes.slice(i - windowSize, i);
        const avgVolume = windowVolumes.reduce((sum, vol) => sum + vol, 0) / windowVolumes.length;
        const volumeRatio = windowVolumes[windowVolumes.length - 1] / avgVolume;
        features.push(volumeRatio);
      } else {
        features.push(1.0); // Default value
      }
      
      trainingData.push(features);
      labels.push(prices[i+1]); // Next price as label
    }
    
    return { trainingData, labels };
  }
  
  _calculateMovingAverage(values, period) {
    if (values.length < period) return values[values.length - 1];
    
    const slice = values.slice(-period);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  }
  
  _calculateConfidence(predictedPrice, actualPrices) {
    // Simple confidence metric based on recent prediction accuracy
    // In a real implementation, this would be more sophisticated
    const lastPrice = actualPrices[actualPrices.length - 1];
    const priceChange = Math.abs((predictedPrice - lastPrice) / lastPrice);
    
    // Lower price change = higher confidence (inverse relationship)
    let confidence = 1.0 - Math.min(priceChange, 0.5);
    
    // Limit confidence to range [0.1, 0.95]
    confidence = Math.max(0.1, Math.min(0.95, confidence));
    
    return confidence;
  }
  
  async getModelInfo(token) {
    const model = this.models.get(token);
    if (!model) return { exists: false };
    
    return {
      exists: true,
      summary: model.summary(),
      inputShape: model.inputs[0].shape,
      outputShape: model.outputs[0].shape
    };
  }
  
  clearCache() {
    this.predictionCache.clear();
  }
}

export default MLPredictionService;