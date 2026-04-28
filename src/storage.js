// Tiny IndexedDB wrapper for the EPUB reader's per-book state. Promise-
// based; opens lazily and reuses one connection. Falls back to no-ops
// when IndexedDB is unavailable (e.g. some private-mode browsers) so
// the reader never crashes on storage errors — saved state simply
// doesn't persist for that session.

const DB_NAME = 'epub-reader';
const DB_VERSION = 3;
const STORES = /** @type {const} */ (['positions', 'bookmarks', 'library', 'highlights']);

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // If the open fails, clear the cache so subsequent calls can retry
  // (e.g. user grants storage permission later).
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * @template T
 * @param {string} store
 * @param {string} key
 * @returns {Promise<T | null>}
 */
export async function dbGet(store, key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(/** @type {T | null} */ (req.result || null));
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

/**
 * @param {string} store
 * @param {object} value  Must include the store's keyPath.
 * @returns {Promise<void>}
 */
export async function dbPut(store, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* swallow — non-essential persistence */ }
}

/**
 * @param {string} store
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function dbDelete(store, key) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* swallow */ }
}

/**
 * @template T
 * @param {string} store
 * @returns {Promise<T[]>}
 */
export async function dbGetAll(store) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(/** @type {T[]} */ (req.result || []));
      req.onerror = () => reject(req.error);
    });
  } catch { return []; }
}

/**
 * @param {string} store
 * @returns {Promise<void>}
 */
export async function dbClear(store) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* swallow */ }
}

/**
 * SHA-256 hex digest of a Blob. Used as a per-book identifier when the
 * EPUB has no usable dc:identifier.
 *
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
