// Push It Service Worker — decrypts E2EE Web Push payloads using key stored in IndexedDB

const DB_NAME = 'push-it-db';
const DB_VERSION = 1;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveMessage(msg) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readwrite');
    tx.objectStore('messages').put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function fromBase64Url(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decryptEnvelope(keyB64, envelope) {
  const rawKey = fromBase64Url(keyB64);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = fromBase64Url(envelope.iv);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const text = new TextDecoder().decode(plainBuf);
  return JSON.parse(text);
}

function isSafeHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  if (!event.data) return;

  let envelope;
  try {
    envelope = event.data.json();
  } catch {
    return;
  }

  const keyB64 = await kvGet('keyB64');
  if (!keyB64) {
    await self.registration.showNotification('Push It', {
      body: 'Encrypted message received (open app to pair key)',
      icon: '/icon.svg',
      data: { type: 'app' },
    });
    return;
  }

  let payload;
  try {
    payload = await decryptEnvelope(keyB64, envelope);
  } catch {
    await self.registration.showNotification('Push It', {
      body: 'Could not decrypt message (key mismatch)',
      icon: '/icon.svg',
      data: { type: 'app' },
    });
    return;
  }

  const item = {
    id: envelope.id,
    senderId: envelope.senderId,
    ts: envelope.ts || Date.now(),
    type: payload.type === 'link' ? 'link' : 'text',
    content: String(payload.content || ''),
    title: payload.title ? String(payload.title) : undefined,
    direction: 'in',
  };

  await saveMessage(item);

  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  // Notify any open tabs so their UI updates immediately
  for (const client of windowClients) {
    client.postMessage({ type: 'PUSH_RECEIVED', item });
  }

  // If a tab is already open & visible, skip duplicate OS toast
  const hasVisibleClient = windowClients.some((c) => c.visibilityState === 'visible');
  if (hasVisibleClient) return;

  const isLink = item.type === 'link' && isSafeHttpUrl(item.content);
  const notifTitle = isLink
    ? item.title || 'New Link — Tap to Open'
    : item.title || 'New Encrypted Text';

  await self.registration.showNotification(notifTitle, {
    body: item.content.slice(0, 180),
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: item.id,
    data: {
      id: item.id,
      type: isLink ? 'link' : 'text',
      url: isLink ? item.content : `/?msg=${encodeURIComponent(item.id)}`,
    },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    (async () => {
      if (data.type === 'link' && data.url && isSafeHttpUrl(data.url)) {
        await self.clients.openWindow(data.url);
        return;
      }

      const targetUrl = data.url || '/';
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({ type: 'FOCUS_MESSAGE', id: data.id });
          return;
        }
      }

      await self.clients.openWindow(targetUrl);
    })(),
  );
});
