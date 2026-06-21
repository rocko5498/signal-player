// ============================================================
// metadata-worker.js — runs metadata parsing off main thread.
// Receives {id, file, wantArt}, posts back {id, meta, artBlob?}
// ============================================================

import { sniffMetadata } from './metadata-core.js';

self.onmessage = async (e) => {
  const { id, file, wantArt } = e.data;
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    const meta = await sniffMetadata(file, ext, { wantArt: !!wantArt });
    let artBlob = null;
    if (meta.picture && meta.picture.data) {
      artBlob = new Blob([meta.picture.data], { type: meta.picture.mime });
      delete meta.picture;
      meta.hasArt = true;
    } else if (meta.picture === null) {
      delete meta.picture;
    }
    self.postMessage({ id, meta, artBlob });
  } catch (err) {
    self.postMessage({ id, meta: { error: String(err) }, artBlob: null });
  }
};
