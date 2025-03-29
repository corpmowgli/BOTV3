// utils/cache.js - Système de cache LRU optimisé

/**
 * Implémentation légère et performante d'un cache LRU (Least Recently Used)
 */
export class LRUCache {
  /**
   * Crée une nouvelle instance de cache LRU
   * @param {number} capacity - Nombre maximum d'éléments dans le cache
   */
  constructor(capacity = 100) {
    this.capacity = capacity;
    this.cache = new Map();
    this.expiryTimes = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      clears: 0,
      expirations: 0
    };
  }

  /**
   * Récupère une valeur du cache
   * @param {string} key - Clé à rechercher
   * @returns {*} Valeur associée ou undefined si absente/expirée
   */
  get(key) {
    // Vérifier si la clé existe
    if (!this.cache.has(key)) {
      this.stats.misses++;
      return undefined;
    }

    // Vérifier si l'élément est expiré
    const expiryTime = this.expiryTimes.get(key);
    if (expiryTime && Date.now() > expiryTime) {
      this.delete(key);
      this.stats.misses++;
      this.stats.expirations++;
      return undefined;
    }

    // Récupérer la valeur et la remettre en tête (LRU)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    this.stats.hits++;
    return value;
  }

  /**
   * Ajoute ou met à jour une valeur dans le cache
   * @param {string} key - Clé à définir
   * @param {*} value - Valeur à stocker
   * @param {number} [ttl] - Durée de vie en millisecondes (0 = pas d'expiration)
   * @returns {LRUCache} This pour chaînage
   */
  set(key, value, ttl = 0) {
    // Si la clé existe déjà, la supprimer d'abord
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.expiryTimes.delete(key);
    } 
    // Si le cache est plein, supprimer l'élément le moins récemment utilisé
    else if (this.cache.size >= this.capacity) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.expiryTimes.delete(oldestKey);
    }

    // Ajouter le nouvel élément
    this.cache.set(key, value);
    
    // Définir l'expiration si nécessaire
    if (ttl > 0) {
      this.expiryTimes.set(key, Date.now() + ttl);
    }

    this.stats.sets++;
    return this;
  }

  /**
   * Supprime une valeur du cache
   * @param {string} key - Clé à supprimer
   * @returns {boolean} true si la clé était présente
   */
  delete(key) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.expiryTimes.delete(key);
      this.stats.deletes++;
      return true;
    }
    return false;
  }

  /**
   * Vérifie si une clé existe dans le cache
   * @param {string} key - Clé à rechercher
   * @returns {boolean} true si la clé existe et n'est pas expirée
   */
  has(key) {
    if (!this.cache.has(key)) return false;

    const expiryTime = this.expiryTimes.get(key);
    if (expiryTime && Date.now() > expiryTime) {
      this.delete(key);
      this.stats.expirations++;
      return false;
    }

    return true;
  }

  /**
   * Supprime toutes les entrées du cache
   */
  clear() {
    this.cache.clear();
    this.expiryTimes.clear();
    this.stats.clears++;
  }

  /**
   * Nettoie les entrées expirées
   * @returns {number} Nombre d'entrées supprimées
   */
  cleanupExpired() {
    const now = Date.now();
    let count = 0;

    for (const [key, expiryTime] of this.expiryTimes.entries()) {
      if (expiryTime && now > expiryTime) {
        this.delete(key);
        count++;
      }
    }

    this.stats.expirations += count;
    return count;
  }

  /**
   * Récupère la taille actuelle du cache
   * @returns {number} Nombre d'éléments dans le cache
   */
  size() {
    return this.cache.size;
  }

  /**
   * Récupère les statistiques du cache
   * @returns {Object} Statistiques d'utilisation
   */
  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      capacity: this.capacity,
      hitRate: this.stats.hits + this.stats.misses > 0 
        ? (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100 
        : 0
    };
  }
}

export default LRUCache;