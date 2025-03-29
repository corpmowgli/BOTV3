import * as tf from '@tensorflow/tfjs-node';
import { LRUCache } from '../utils/cache.js';

export class MLPredictionService {
  constructor(config) {
    this.config = config;
    this.models = new LRUCache(20);
    this.predictionCache = new LRUCache(100);
    this.initialize();
  }
  
  async initialize() {
    try {
      const mainTokens = ['SOL', 'RAY', 'SRM', 'FIDA'];
      for (const token of mainTokens) {
        const model = await tf.loadLayersModel(`file://${this.config.modelPath}/${token}_model/model.json`);
        this.models.set(token, model);
      }
    } catch (error) {
      console.error('Erreur lors du chargement des modèles:', error);
    }
  }
  
  async predictPrice(token, timeframe, historicalData) {
    const cacheKey = `prediction_${token}_${timeframe}_${Date.now()}`;
    const cachedPrediction = this.predictionCache.get(cacheKey);
    if (cachedPrediction) return cachedPrediction;
    
    try {
      const features = this._prepareFeatures(historicalData);
      let model = this.models.get(token);
      if (!model) {
        model = await this._trainModel(token, historicalData);
        this.models.set(token, model);
      }
    } catch (error) {
      console.error(`Erreur de prédiction pour ${token}:`, error);
      return null;
    }
  }
}