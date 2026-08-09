(() => {
  const DB_NAME = 'TabScrollerRAG';
  const DB_VERSION = 3;
  const STORE_NAME = 'pages';

  const TabDB = {
    _db: null,

    async init() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this._db = request.result;
          resolve();
        };
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('category', 'category', { unique: false });
          } else {
            const store = event.target.transaction.objectStore(STORE_NAME);
            if (!store.indexNames.contains('category')) {
              store.createIndex('category', 'category', { unique: false });
            }
          }
          if (!db.objectStoreNames.contains('tabCards')) {
            const cardStore = db.createObjectStore('tabCards', { keyPath: 'tabId' });
            cardStore.createIndex('urlHash', 'urlHash', { unique: false });
          }
        };
      });
    },

    async store(doc) {
      const tx = this._db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(doc);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async findByUrl(url) {
      const tx = this._db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(url);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    },

    async search({ categories, since, queryEmbedding, topK } = {}) {
      const tx = this._db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let results = [];

      if (categories && categories.length > 0) {
        for (const cat of categories) {
          const index = store.index('category');
          const request = index.getAll(cat);
          const items = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
          });
          results.push(...items);
        }
      } else {
        const request = store.getAll();
        results = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });
      }

      if (since) {
        results = results.filter(doc => doc.lastVisited >= since);
      }

      if (queryEmbedding) {
        const query = new Float32Array(queryEmbedding);
        const scored = results.map(doc => {
          const emb = new Float32Array(doc.embedding);
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < query.length; i++) {
            dot += query[i] * emb[i];
            normA += query[i] * query[i];
            normB += emb[i] * emb[i];
          }
          const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
          return { ...doc, similarity };
        });
        scored.sort((a, b) => b.similarity - a.similarity);
        results = topK ? scored.slice(0, topK) : scored;
      }

      return results;
    },

    async storeTabCard(card) {
      const tx = this._db.transaction('tabCards', 'readwrite');
      const store = tx.objectStore('tabCards');
      store.put(card);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getTabCard(tabId) {
      const tx = this._db.transaction('tabCards', 'readonly');
      const store = tx.objectStore('tabCards');
      const request = store.get(tabId);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    },

    async deleteTabCard(tabId) {
      const tx = this._db.transaction('tabCards', 'readwrite');
      const store = tx.objectStore('tabCards');
      store.delete(tabId);
      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async getAllTabCards() {
      const tx = this._db.transaction('tabCards', 'readonly');
      const store = tx.objectStore('tabCards');
      const request = store.getAll();
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TabDB };
  }
  if (typeof self !== 'undefined') {
    self.TabDB = TabDB;
  }
})();
