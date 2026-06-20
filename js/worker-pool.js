// ============================================================
// worker-pool.js — round-robin metadata workers.
// ============================================================

const POOL_SIZE = Math.min(4, (navigator.hardwareConcurrency || 2));

class MetadataPool {
  constructor() {
    this.workers = [];
    this.next = 0;
    this.callbacks = new Map();
    this.id = 0;
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker(new URL('./metadata-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const cb = this.callbacks.get(e.data.id);
        if (cb) {
          this.callbacks.delete(e.data.id);
          cb(e.data);
        }
      };
      w.onerror = (err) => console.error('[worker]', err);
      this.workers.push(w);
    }
  }

  parse(file) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.callbacks.set(id, resolve);
      const w = this.workers[this.next];
      this.next = (this.next + 1) % this.workers.length;
      w.postMessage({ id, file });
    });
  }
}

export const metadataPool = new MetadataPool();
