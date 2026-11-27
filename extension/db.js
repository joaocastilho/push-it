const DB_NAME = 'push-it-ext-blobs';
const DB_VERSION = 1;

let cachedBlobDbPromise = null;

function openBlobDb() {
  if (cachedBlobDbPromise) return cachedBlobDbPromise;
  cachedBlobDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        cachedBlobDbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        cachedBlobDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      cachedBlobDbPromise = null;
      reject(req.error);
    };
  });
  return cachedBlobDbPromise;
}

export async function saveExtBlob(blob) {
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getExtBlob(id) {
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteExtBlob(id) {
  if (!id) return;
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearExtBlobs() {
  const db = await openBlobDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
