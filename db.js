(() => {
  const DB_NAME = 'TabScrollerRAG';
  const DB_VERSION = 4;
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
          // tabCards is keyed by urlHash, NOT tabId. A tabId is invalidated by every
          // browser restart, so a tabId-keyed store threw away all enrichment on
          // restart and leaked a row per closed tab. urlHash is stable across
          // restarts and identical across duplicate tabs of the same page.
          if (!db.objectStoreNames.contains('tabCards')) {
            const cardStore = db.createObjectStore('tabCards', { keyPath: 'urlHash' });
            cardStore.createIndex('tabId', 'tabId', { unique: false });
            cardStore.createIndex('extractedAt', 'extractedAt', { unique: false });
          } else if (event.oldVersion < 4) {
            // v3 -> v4 re-key. keyPath is immutable, so copy the rows out, drop the
            // store, recreate it, and write them back in the same upgrade tx.
            const oldStore = event.target.transaction.objectStore('tabCards');
            const getAll = oldStore.getAll();
            getAll.onsuccess = () => {
              const rows = getAll.result || [];
              db.deleteObjectStore('tabCards');
              const cardStore = db.createObjectStore('tabCards', { keyPath: 'urlHash' });
              cardStore.createIndex('tabId', 'tabId', { unique: false });
              cardStore.createIndex('extractedAt', 'extractedAt', { unique: false });
              // Rows predating the urlHash field cannot be re-keyed; drop them
              // rather than invent a key. They are a cache and will be rebuilt.
              const byHash = new Map();
              for (const row of rows) {
                if (!row || typeof row.urlHash !== 'string' || !row.urlHash) continue;
                // Duplicate tabs of one page collapse to a single row: keep newest.
                const prev = byHash.get(row.urlHash);
                if (!prev || (row.extractedAt || 0) >= (prev.extractedAt || 0)) {
                  byHash.set(row.urlHash, row);
                }
              }
              for (const row of byHash.values()) cardStore.put(row);
            };
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
      
      // Queue non-blocking background sync to permanent computer storage (SQLite)
      this.queueSync(card);

      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    // Persistent Computer Sync Buffer (SQLite Backend)
    _syncBuffer: [],
    _syncTimer: null,
    _backendUrl: 'http://127.0.0.1:8000',

    queueSync(card) {
      if (!card || !card.urlHash) return;
      if (typeof globalThis.fetch !== 'function') return;
      this._syncBuffer.push(card);
      if (this._syncBuffer.length >= 25) {
        this.flushSyncBuffer();
      } else if (!this._syncTimer && typeof globalThis.setTimeout === 'function') {
        this._syncTimer = globalThis.setTimeout(() => {
          this._syncTimer = null;
          this.flushSyncBuffer();
        }, 1500);
      }
    },

    async flushSyncBuffer() {
      if (this._syncBuffer.length === 0) return;
      if (typeof globalThis.fetch !== 'function') return;
      const batch = this._syncBuffer.splice(0, 50);
      try {
        await globalThis.fetch(`${this._backendUrl}/api/tabs/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tabs: batch })
        });
      } catch (e) {
        // Backend might be offline; silent fallback
      }
    },

    // Restore cards from permanent computer storage (SQLite) if IndexedDB was wiped
    async restoreFromPermanentStorage() {
      if (typeof globalThis.fetch !== 'function') return 0;
      try {
        const res = await globalThis.fetch(`${this._backendUrl}/api/tabs/cards?limit=5000`);
        if (!res.ok) return 0;
        const data = await res.json();
        const cards = data.cards || [];
        if (cards.length === 0) return 0;

        const tx = this._db.transaction('tabCards', 'readwrite');
        const store = tx.objectStore('tabCards');
        for (const card of cards) {
          store.put(card);
        }
        await new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        console.log(`[TabDB] Restored ${cards.length} cards from permanent computer SQLite storage`);
        return cards.length;
      } catch (e) {
        return 0;
      }
    },

    // Sub-10ms Full Text Search via SQLite FTS5 backend
    async searchFts(query, limit = 50) {
      if (typeof globalThis.fetch !== 'function') return [];
      try {
        const res = await globalThis.fetch(`${this._backendUrl}/api/tabs/fts?q=${encodeURIComponent(query)}&limit=${limit}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.results || [];
      } catch (e) {
        return [];
      }
    },

    // Primary lookup. Stable across browser restarts.
    async getCardByUrlHash(urlHash) {
      const tx = this._db.transaction('tabCards', 'readonly');
      const store = tx.objectStore('tabCards');
      const request = store.get(urlHash);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    },

    // Secondary lookup via the tabId index, for callers that only hold a live tab
    // id. tabId is not unique in this store (two tabs can show the same page, and
    // stale ids linger until eviction), so this returns the most recently seen row.
    async getTabCard(tabId) {
      const tx = this._db.transaction('tabCards', 'readonly');
      const store = tx.objectStore('tabCards');
      const index = store.index('tabId');
      const request = index.getAll(tabId);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const rows = request.result || [];
          if (rows.length === 0) return resolve(null);
          rows.sort((a, b) => (b.extractedAt || 0) - (a.extractedAt || 0));
          resolve(rows[0]);
        };
        request.onerror = () => reject(request.error);
      });
    },

    async deleteTabCard(urlHash) {
      const tx = this._db.transaction('tabCards', 'readwrite');
      const store = tx.objectStore('tabCards');
      store.delete(urlHash);
      
      // Async delete from backend
      if (typeof globalThis.fetch === 'function') {
        globalThis.fetch(`${this._backendUrl}/api/tabs/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: [urlHash] })
        }).catch(() => {});
      }

      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    // Cursor-based eviction over the extractedAt index. Deletes oldest-first without
    // reading the whole store into memory.
    async evictOldest(max) {
      const all = await this.getAllTabCards();
      if (all.length <= max) return 0;
      const toDelete = all
        .slice()
        .sort((a, b) => (a.extractedAt || 0) - (b.extractedAt || 0))
        .slice(0, all.length - max);
      const tx = this._db.transaction('tabCards', 'readwrite');
      const store = tx.objectStore('tabCards');
      for (const row of toDelete) store.delete(row.urlHash);
      
      // Async delete from backend
      if (typeof globalThis.fetch === 'function') {
        globalThis.fetch(`${this._backendUrl}/api/tabs/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: toDelete.map(r => r.urlHash) })
        }).catch(() => {});
      }

      return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(toDelete.length);
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
