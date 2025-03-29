// services/mlPredictionService.js
import * as tf from '@tensorflow/tfjs-node';
import { LRUCache } from '../utils/cache.js';

export class MLPredictionService {
  constructor(config) {
    this.config = config;
    this.models = new LRUCache(20); // Cache pour les modèles par token
    this.predictionCache = new LRUCache(100);
    
    // Initialiser les modèles pré-entraînés ou les charger
    this.initialize();
  }
  
  async initialize() {
    // Charger les modèles de base pour les tokens principaux
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
      // Préparer les données d'entrée
      const features = this._prepareFeatures(historicalData);
      
      // Obtenir ou entraîner le modèle approprié
      let model = this.models.get(token);
      if (!model) {
        model = await this._trainModel(token, historicalData);
        this.models.set