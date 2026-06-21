// ============================================================
// db.js — IndexedDB cache for parsed metadata, DR values,
// hi-res verdicts, and album art blobs.
//
// Key: `${name}|${size}|${lastModified}` — unique enough that
// changing the file invalidates the cache automatically.
// ============================================================

const DB_NAME = 'signal-cache';
const DB_VERSION = 1;
const STORE_META = 'metadata';
const STORE_ART = 'art';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_ART)) {
        db.createObjectStore(STORE_ART);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txGet(store, key) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const r = t.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  }));
}

function txPut(store, key, value) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  }));
}

export function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified || 0}`;
}

export const cache = {
  async getMeta(file) {
    try { return await txGet(STORE_META, fileKey(file)); } catch { return null; }
  },
  async setMeta(file, meta) {
    try { await txPut(STORE_META, fileKey(file), meta); } catch {}
  },
  // Batch insert: one transaction for many entries. Used during ingest.
  async setMetaBatch(entries) {
    if (!entries.length) return;
    try {
      const db = await open();
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE_META, 'readwrite');
        const s = t.objectStore(STORE_META);
        for (const [key, value] of entries) s.put(value, key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    } catch {}
  },
  async getMetaBatch(keys) {
    if (!keys.length) return new Map();
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE_META, 'readonly');
        const s = t.objectStore(STORE_META);
        const out = new Map();
        let remaining = keys.length;
        for (const k of keys) {
          const r = s.get(k);
          r.onsuccess = () => {
            if (r.result) out.set(k, r.result);
            if (--remaining === 0) resolve(out);
          };
          r.onerror = () => {
            if (--remaining === 0) resolve(out);
          };
        }
      });
    } catch { return new Map(); }
  },
  async getArt(file) {
    try { return await txGet(STORE_ART, fileKey(file)); } catch { return null; }
  },
  async setArt(file, blob) {
    try { await txPut(STORE_ART, fileKey(file), blob); } catch {}
  },
  async clear() {
    const db = await open();
    return new Promise((resolve) => {
      const t = db.transaction([STORE_META, STORE_ART], 'readwrite');
      t.objectStore(STORE_META).clear();
      t.objectStore(STORE_ART).clear();
      t.oncomplete = () => resolve();
    });
  },
};
