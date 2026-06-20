// ============================================================
// metadata-worker.js — runs metadata parsing off main thread.
// Receives {id, file} messages, posts back {id, meta, art:Blob?}
// ============================================================

import { sniffMetadata } from './metadata-core.js';

self.onmessage = async (e) => {
  const { id, file } = e.data;
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    const meta = await sniffMetadata(file, ext);
    let artBlob = null;
    if (meta.picture && meta.picture.data) {
      artBlob = new Blob([meta.picture.data], { type: meta.picture.mime });
      delete meta.picture; // don't ship raw bytes back
      meta.hasArt = true;
    }
    self.postMessage({ id, meta, artBlob }, artBlob ? [] : []);
  } catch (err) {
    self.postMessage({ id, meta: { error: String(err) }, artBlob: null });
  }
};
