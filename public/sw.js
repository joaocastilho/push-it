// Push It Service Worker — E2EE Web Push decrypt + Android/iOS Share Target (links, text, photos & files)

const DB_NAME = 'push-it-db';
const DB_VERSION = 2;
const LONG_TEXT_THRESHOLD = 1800;
const MAX_FILE_BYTES = 7.5 * 1024 * 1024;

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
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
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

async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function kvDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

async function saveBlob(blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(blob);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteBlob(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function makeAuthHeader(deviceId, deviceToken) {
  return `Bearer ${deviceId}.${deviceToken}`;
}

function messageAad(roomId, envelopeId, senderId) {
  return `push-it-msg-v2:${roomId}:${envelopeId}:${senderId}`;
}

function deviceAad(roomId, deviceId) {
  return `push-it-dev-v2:${roomId}:${deviceId}`;
}

function blobAad(roomId, blobId) {
  return `push-it-blob-v2:${roomId}:${blobId}`;
}

async function deriveRoomId(keyB64) {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

async function encryptBytes(keyB64, plainBytes, aad) {
  const rawKey = fromBase64Url(keyB64);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const algo = aad
    ? { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }
    : { name: 'AES-GCM', iv };
  const cipherBuf = await crypto.subtle.encrypt(algo, key, plainBytes);
  return {
    iv: toBase64Url(iv),
    ciphertext: new Uint8Array(cipherBuf),
  };
}

async function decryptJson(keyB64, ivB64, ciphertextB64, aad) {
  const rawKey = fromBase64Url(keyB64);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = fromBase64Url(ivB64);
  const ciphertext = fromBase64Url(ciphertextB64);
  const algo = aad
    ? { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }
    : { name: 'AES-GCM', iv };
  const plainBuf = await crypto.subtle.decrypt(algo, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

async function encryptPayload(keyB64, roomId, senderId, payload, targetIds) {
  const id = crypto.randomUUID();
  const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
  const { iv, ciphertext } = await encryptBytes(
    keyB64,
    plainBytes,
    messageAad(roomId, id, senderId),
  );
  return {
    id,
    senderId,
    targetIds: Array.isArray(targetIds) && targetIds.length > 0 ? targetIds : undefined,
    iv,
    ciphertext: toBase64Url(ciphertext),
    ts: Date.now(),
    expiresAt: payload.expiresAt,
  };
}

async function decryptEnvelope(keyB64, roomId, envelope) {
  return decryptJson(
    keyB64,
    envelope.iv,
    envelope.ciphertext,
    messageAad(roomId, envelope.id, envelope.senderId),
  );
}

function isSafeHttpUrl(str) {
  try {
    const u = new URL(String(str).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function detectPayloadType(input) {
  const trimmed = String(input).trim();
  if (!trimmed.includes('\n') && !trimmed.includes(' ') && isSafeHttpUrl(trimmed)) {
    return 'link';
  }
  return 'text';
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeOs(value) {
  if (
    value === 'android' ||
    value === 'windows' ||
    value === 'macos' ||
    value === 'ios' ||
    value === 'linux'
  ) {
    return value;
  }
  return 'other';
}

function defaultDeviceName(os) {
  switch (os) {
    case 'android':
      return 'Android';
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'Mac';
    case 'ios':
      return 'iOS';
    case 'linux':
      return 'Linux';
    default:
      return 'Device';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const OS_SVG_PATHS = {
  windows:
    'M3 5.5L10.8 4.4V11.5H3V5.5ZM11.8 4.25L21 3V11.5H11.8V4.25ZM3 12.5H10.8V19.6L3 18.5V12.5ZM11.8 12.5H21V21L11.8 19.75V12.5Z',
  android:
    'M17.6 9.48l1.84-3.18a.48.48 0 0 0-.18-.65.48.48 0 0 0-.65.18l-1.86 3.22a11.35 11.35 0 0 0-9.5 0L5.39 5.83a.48.48 0 0 0-.65-.18.48.48 0 0 0-.18.65L6.4 9.48A10.7 10.7 0 0 0 1 18.5h22a10.7 10.7 0 0 0-5.4-9.02zM7.5 15a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm9 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z',
  macos:
    'M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z',
  ios: 'M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83zM13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z',
  linux:
    'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 5l3 3-3 3 1.4 1.4L12.8 12 8.4 7.6 7 9zm5 6h5v-2h-5v2z',
  other: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4z',
};

function renderOsIcon(os, size = 18) {
  const path = OS_SVG_PATHS[os] || OS_SVG_PATHS.other;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
}

async function fetchRoomDevices(roomId, keyB64, deviceId, deviceToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/devices`, {
      headers: { authorization: makeAuthHeader(deviceId, deviceToken) },
      signal: controller.signal,
    });
    if (res.status === 401) {
      await kvDelete('deviceToken');
      return { revoked: true, devices: [] };
    }
    if (!res.ok) {
      const cached = (await kvGet('cachedDevices')) || [];
      return { revoked: false, devices: Array.isArray(cached) ? cached : [] };
    }
    const data = await res.json();
    const list = [];
    for (const d of data.devices || []) {
      try {
        const meta = await decryptJson(keyB64, d.iv, d.ciphertext, deviceAad(roomId, d.deviceId));
        const os = normalizeOs(meta.os);
        const name = meta.name ? String(meta.name) : defaultDeviceName(os);
        list.push({
          deviceId: d.deviceId,
          name,
          os,
          online: Boolean(d.online),
          updatedAt: d.updatedAt,
          lastSeenAt: d.lastSeenAt || d.updatedAt,
        });
      } catch {
        // ignore unreadable device record
      }
    }
    await kvSet('cachedDevices', list).catch(() => {});
    return { revoked: false, devices: list };
  } catch {
    const cached = (await kvGet('cachedDevices')) || [];
    return { revoked: false, devices: Array.isArray(cached) ? cached : [] };
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchShareFile({ fileBuf, fileName, mimeType, targetIds, targetNames }) {
  const [keyB64, deviceId, deviceToken, deviceName, deviceOs] = await Promise.all([
    kvGet('keyB64'),
    kvGet('deviceId'),
    kvGet('deviceToken'),
    kvGet('deviceName'),
    kvGet('deviceOs'),
  ]);

  if (!keyB64 || !deviceId || !deviceToken) {
    return { ok: false, revoked: true, error: 'Device not paired' };
  }

  if (!fileBuf || fileBuf.byteLength === 0) {
    return { ok: false, error: 'Empty file' };
  }
  if (fileBuf.byteLength > MAX_FILE_BYTES) {
    return { ok: false, error: 'File is too large (max 7.5 MB)' };
  }

  const roomId = await deriveRoomId(keyB64);
  const authHeader = makeAuthHeader(deviceId, deviceToken);
  const senderName = deviceName || 'Android';
  const senderOs = deviceOs || 'android';
  const cleanTargetIds =
    Array.isArray(targetIds) && targetIds.length > 0
      ? targetIds.map((id) => String(id))
      : undefined;
  const cleanTargetNames =
    Array.isArray(targetNames) && targetNames.length > 0
      ? targetNames.map((n) => String(n))
      : undefined;

  const blobId = crypto.randomUUID().replace(/-/g, '');
  const { iv: blobIv, ciphertext } = await encryptBytes(
    keyB64,
    new Uint8Array(fileBuf),
    blobAad(roomId, blobId),
  );
  const params = new URLSearchParams();
  if (cleanTargetIds && cleanTargetIds.length > 0) {
    params.set('targetIds', cleanTargetIds.join(','));
  }
  const qs = params.toString();

  const uploadRes = await fetch(
    `/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(blobId)}${qs ? `?${qs}` : ''}`,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: authHeader,
      },
      body: ciphertext,
    },
  );
  if (uploadRes.status === 401) {
    await kvDelete('deviceToken');
    return { ok: false, revoked: true, error: 'This device was removed from the room' };
  }
  if (!uploadRes.ok) {
    return { ok: false, error: 'Could not upload file (max 7.5 MB)' };
  }

  const safeMime = mimeType || 'application/octet-stream';
  const safeName = fileName || (safeMime.startsWith('image/') ? 'photo.png' : 'file');

  const envelope = await encryptPayload(
    keyB64,
    roomId,
    deviceId,
    {
      type: 'file',
      content: safeName,
      senderName,
      senderOs,
      targetNames: cleanTargetNames,
      blobId,
      blobIv,
      fileName: safeName,
      mimeType: safeMime,
      fileSize: fileBuf.byteLength,
    },
    cleanTargetIds,
  );

  const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
    },
    body: JSON.stringify(envelope),
  });

  if (res.status === 401) {
    await kvDelete('deviceToken');
    return { ok: false, revoked: true, error: 'This device was removed from the room' };
  }
  if (!res.ok) {
    return { ok: false, error: `Could not send (${res.status})` };
  }

  const result = await res.json().catch(() => ({}));
  await saveBlob({ id: blobId, data: fileBuf, mimeType: safeMime, fileName: safeName });
  const item = {
    id: envelope.id,
    senderId: deviceId,
    senderName,
    senderOs,
    targetNames: cleanTargetNames,
    ts: envelope.ts,
    type: 'file',
    content: safeName,
    blobId,
    blobIv,
    fileName: safeName,
    mimeType: safeMime,
    fileSize: fileBuf.byteLength,
    direction: 'out',
    status: result.delivered ? 'delivered' : 'queued',
  };
  await saveMessage(item);

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) {
    c.postMessage({ type: 'PUSH_RECEIVED', item });
  }

  return { ok: true, delivered: Boolean(result.delivered) };
}

async function dispatchShareMessage({ content, title, targetIds, targetNames }) {
  const [keyB64, deviceId, deviceToken, deviceName, deviceOs] = await Promise.all([
    kvGet('keyB64'),
    kvGet('deviceId'),
    kvGet('deviceToken'),
    kvGet('deviceName'),
    kvGet('deviceOs'),
  ]);

  if (!keyB64 || !deviceId || !deviceToken) {
    return { ok: false, revoked: true, error: 'Device not paired' };
  }

  const cleanContent = String(content || '').trim();
  if (!cleanContent) {
    return { ok: false, error: 'Nothing to send' };
  }

  const roomId = await deriveRoomId(keyB64);
  const authHeader = makeAuthHeader(deviceId, deviceToken);
  const senderName = deviceName || 'Android';
  const senderOs = deviceOs || 'android';
  const cleanTargetIds =
    Array.isArray(targetIds) && targetIds.length > 0
      ? targetIds.map((id) => String(id))
      : undefined;
  const cleanTargetNames =
    Array.isArray(targetNames) && targetNames.length > 0
      ? targetNames.map((n) => String(n))
      : undefined;

  const isLong = cleanContent.length > LONG_TEXT_THRESHOLD;
  let envelope;

  if (isLong) {
    const blobId = crypto.randomUUID().replace(/-/g, '');
    const plainBytes = new TextEncoder().encode(cleanContent);
    const { iv: blobIv, ciphertext } = await encryptBytes(
      keyB64,
      plainBytes,
      blobAad(roomId, blobId),
    );
    const params = new URLSearchParams();
    if (cleanTargetIds && cleanTargetIds.length > 0) {
      params.set('targetIds', cleanTargetIds.join(','));
    }
    const qs = params.toString();
    const uploadRes = await fetch(
      `/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(blobId)}${qs ? `?${qs}` : ''}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          authorization: authHeader,
        },
        body: ciphertext,
      },
    );
    if (uploadRes.status === 401) {
      await kvDelete('deviceToken');
      return { ok: false, revoked: true, error: 'This device was removed from the room' };
    }
    if (!uploadRes.ok) {
      return { ok: false, error: 'Content is too large to send' };
    }
    envelope = await encryptPayload(
      keyB64,
      roomId,
      deviceId,
      {
        type: 'longtext',
        content: cleanContent.slice(0, 140) + '…',
        title: title || undefined,
        senderName,
        senderOs,
        targetNames: cleanTargetNames,
        blobId,
        blobIv,
        fileSize: plainBytes.byteLength,
      },
      cleanTargetIds,
    );
  } else {
    const type = detectPayloadType(cleanContent);
    envelope = await encryptPayload(
      keyB64,
      roomId,
      deviceId,
      {
        type,
        content: cleanContent,
        title: title || undefined,
        senderName,
        senderOs,
        targetNames: cleanTargetNames,
      },
      cleanTargetIds,
    );
  }

  const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
    },
    body: JSON.stringify(envelope),
  });

  if (res.status === 401) {
    await kvDelete('deviceToken');
    return { ok: false, revoked: true, error: 'This device was removed from the room' };
  }

  if (!res.ok) {
    return { ok: false, error: `Could not send (${res.status})` };
  }

  const result = await res.json().catch(() => ({}));
  const item = {
    id: envelope.id,
    senderId: deviceId,
    senderName,
    senderOs,
    targetNames: cleanTargetNames,
    ts: envelope.ts,
    type: isLong ? 'text' : detectPayloadType(cleanContent),
    content: cleanContent,
    title: title || undefined,
    direction: 'out',
    status: result.delivered ? 'delivered' : 'queued',
  };
  await saveMessage(item);

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) {
    c.postMessage({ type: 'PUSH_RECEIVED', item });
  }

  return {
    ok: true,
    delivered: Boolean(result.delivered),
  };
}

function renderToastHtml({ ok, title, subtitle, preview, revoked }) {
  const accent = ok ? '#10b981' : '#f59e0b';
  const icon = ok ? '✓' : '!';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#0b0f19" />
<title>Push It</title>
<style>
  *{box-sizing:border-box}
  body{
    margin:0;min-height:100dvh;
    background:rgba(11,15,25,0.92);
    color:#eef2ff;
    font:500 15px/1.4 system-ui,-apple-system,sans-serif;
    display:flex;flex-direction:column;justify-content:flex-end;align-items:center;
    padding:20px 16px calc(28px + env(safe-area-inset-bottom));
  }
  .toast{
    width:min(100%, 420px);
    background:#131a2a;
    border:1px solid ${accent};
    border-radius:16px;
    padding:14px 16px;
    box-shadow:0 14px 40px rgba(0,0,0,0.55);
    display:flex;align-items:flex-start;gap:12px;
    animation:pop .2s ease-out;
  }
  @keyframes pop{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  .badge{
    width:28px;height:28px;border-radius:50%;flex-shrink:0;
    display:grid;place-items:center;font-weight:700;font-size:15px;
    background:${ok ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'};
    color:${accent};
  }
  .body{min-width:0;flex:1}
  .title{font-weight:700;font-size:15px;color:#eef2ff}
  .sub{font-size:12.5px;color:#94a3b8;margin-top:2px}
  .preview{
    font-size:12px;color:#cbd5e1;margin-top:6px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .actions{display:flex;gap:8px;margin-top:12px}
  .btn{
    border:none;border-radius:10px;padding:8px 14px;font:600 13px system-ui,sans-serif;
    cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;
  }
  .btn.primary{background:#6366f1;color:#fff}
  .btn.secondary{background:#1b253b;color:#eef2ff;border:1px solid #26334d}
</style>
</head>
<body>
  <div class="toast" id="toast" role="status" aria-live="polite">
    <div class="badge">${icon}</div>
    <div class="body">
      <div class="title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}
      ${preview ? `<div class="preview">${escapeHtml(preview)}</div>` : ''}
      ${
        !ok
          ? `<div class="actions">
              ${revoked ? `<a class="btn primary" href="/">Open Push It</a>` : ''}
              <button class="btn secondary" id="closeBtn">Close</button>
            </div>`
          : ''
      }
    </div>
  </div>
  <script>
    function closeShare() {
      window.close();
      setTimeout(function() {
        if (history.length > 1) history.back();
        else window.location.replace('/');
      }, 220);
    }
    var closeBtn = document.getElementById('closeBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeShare);
    ${
      ok
        ? `document.getElementById('toast').addEventListener('click', closeShare);
           setTimeout(closeShare, 1400);`
        : ''
    }
  </script>
</body>
</html>`;
}

function renderPickerHtml({ content, title, pendingFileId, fileLabel, otherDevices }) {
  const sorted = [...otherDevices].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.lastSeenAt || b.updatedAt || 0) - (a.lastSeenAt || a.updatedAt || 0);
  });

  const payloadJson = JSON.stringify({
    content: content || '',
    title: title || '',
    pendingFileId: pendingFileId || '',
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const deviceButtons = sorted
    .map(
      (d) => `
      <button type="button" class="dest-btn" data-id="${escapeHtml(d.deviceId)}" data-name="${escapeHtml(d.name)}">
        <span class="dest-left">
          <span class="icon-wrap">${renderOsIcon(d.os, 18)}</span>
          <span class="dest-text">
            <span class="dest-name">${escapeHtml(d.name)}</span>
            <span class="dest-meta">
              <span class="dot ${d.online ? 'online' : ''}"></span>
              ${d.online ? 'Online' : 'Offline · queues up to 28d'}
            </span>
          </span>
        </span>
        <span class="check-box" aria-hidden="true">✓</span>
      </button>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#070a12" />
<title>Push It — Choose Device</title>
<style>
  *{box-sizing:border-box}
  body{
    margin:0;min-height:100dvh;
    background:radial-gradient(600px 360px at 50% 0%,rgba(99,102,241,0.18),transparent 65%),#070a12;
    color:#f1f5f9;
    font:500 15px/1.4 system-ui,-apple-system,sans-serif;
    display:flex;flex-direction:column;justify-content:flex-end;align-items:center;
    padding:16px 12px calc(18px + env(safe-area-inset-bottom));
  }
  .sheet{
    width:min(100%, 440px);
    background:rgba(17,24,39,0.94);
    border:1px solid rgba(148,163,184,0.22);
    border-radius:22px;
    padding:16px;
    box-shadow:0 24px 64px rgba(0,0,0,0.65);
    display:flex;flex-direction:column;gap:12px;
    animation:slideUp .18s cubic-bezier(0.16,1,0.3,1);
  }
  @keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  .head{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .brand{display:flex;align-items:center;gap:10px}
  .brand img{width:30px;height:30px;border-radius:9px}
  .brand h1{margin:0;font-size:16px;font-weight:700}
  .brand p{margin:1px 0 0;font-size:12.5px;color:#8b9bb4}
  .preview{
    background:rgba(7,10,18,0.85);border:1px solid rgba(148,163,184,0.16);border-radius:12px;
    padding:10px 12px;font-size:13px;
  }
  .preview-title{font-weight:600;color:#f1f5f9;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .preview-content{
    color:#7dd3fc;overflow-wrap:anywhere;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  }
  .list{display:flex;flex-direction:column;gap:8px;max-height:48dvh;overflow-y:auto}
  .dest-btn{
    width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
    background:#172033;border:1px solid rgba(148,163,184,0.16);border-radius:13px;
    padding:11px 13px;color:#f1f5f9;font:inherit;text-align:left;cursor:pointer;
    transition:border-color .14s,background .14s;
  }
  .dest-btn.selected{
    background:rgba(99,102,241,0.18);
    border-color:rgba(129,140,248,0.65);
  }
  .dest-btn:disabled{opacity:0.55;cursor:not-allowed}
  .dest-left{display:flex;align-items:center;gap:11px;min-width:0}
  .icon-wrap{
    width:34px;height:34px;border-radius:10px;background:rgba(7,10,18,0.85);
    display:grid;place-items:center;flex-shrink:0;color:#c7d2fe;
  }
  .all-btn .icon-wrap{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff}
  .dest-text{display:flex;flex-direction:column;min-width:0}
  .dest-name{font-weight:700;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dest-meta{display:flex;align-items:center;gap:6px;font-size:12px;color:#8b9bb4;margin-top:1px}
  .dot{width:7px;height:7px;border-radius:50%;background:#64748b;flex-shrink:0}
  .dot.online{background:#10b981;box-shadow:0 0 6px #10b981}
  .check-box{
    width:22px;height:22px;border-radius:999px;flex-shrink:0;
    border:1.5px solid rgba(148,163,184,0.35);
    display:grid;place-items:center;font-size:13px;font-weight:800;color:transparent;
    transition:background .14s,border-color .14s,color .14s;
  }
  .dest-btn.selected .check-box{
    background:#6366f1;border-color:#818cf8;color:#fff;
  }
  .footer-actions{display:flex;gap:8px;margin-top:2px}
  .send-btn{
    flex:1;border:none;border-radius:12px;padding:11px 14px;
    background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;
    font:700 14px system-ui,sans-serif;cursor:pointer;
    box-shadow:0 4px 16px rgba(99,102,241,0.35);
  }
  .send-btn:disabled{opacity:0.5;cursor:not-allowed}
  .cancel-btn{
    background:rgba(255,255,255,0.06);border:1px solid rgba(148,163,184,0.2);color:#cbd5e1;
    border-radius:12px;padding:11px 14px;font:600 14px system-ui,sans-serif;cursor:pointer;
  }
  .toast{
    display:none;
    width:min(100%, 420px);
    background:#111827;
    border:1px solid #10b981;
    border-radius:16px;
    padding:14px 16px;
    box-shadow:0 14px 40px rgba(0,0,0,0.55);
    align-items:flex-start;gap:12px;
    animation:slideUp .18s ease-out;
  }
  .toast.show{display:flex}
  .toast.error{border-color:#f59e0b}
  .badge{
    width:28px;height:28px;border-radius:50%;flex-shrink:0;
    display:grid;place-items:center;font-weight:700;font-size:15px;
    background:rgba(16,185,129,0.2);color:#10b981;
  }
  .toast.error .badge{background:rgba(245,158,11,0.2);color:#f59e0b}
  .toast-title{font-weight:700;font-size:15px}
  .toast-sub{font-size:12.5px;color:#8b9bb4;margin-top:2px}
  .hidden{display:none!important}
</style>
</head>
<body>
  <div class="sheet" id="sheet">
    <div class="head">
      <div class="brand">
        <img src="/icon.svg" alt="" />
        <div>
          <h1>Send with Push It</h1>
          <p>Select all devices or pick specific devices</p>
        </div>
      </div>
    </div>

    <div class="preview">
      ${title ? `<div class="preview-title">${escapeHtml(title)}</div>` : ''}
      <div class="preview-content">${escapeHtml(fileLabel || (content || '').slice(0, 240))}</div>
    </div>

    <div class="list" id="destList">
      <button type="button" class="dest-btn all-btn selected" id="allBtn" data-all="1">
        <span class="dest-left">
          <span class="icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </span>
          <span class="dest-text">
            <span class="dest-name">All Devices (Room)</span>
            <span class="dest-meta">${sorted.length} devices in this room</span>
          </span>
        </span>
        <span class="check-box" aria-hidden="true">✓</span>
      </button>
      ${deviceButtons}
    </div>

    <div class="footer-actions">
      <button type="button" class="send-btn" id="sendBtn">Push to All Devices (${sorted.length})</button>
      <button type="button" class="cancel-btn" id="cancelBtn">Cancel</button>
    </div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite">
    <div class="badge" id="toastBadge">✓</div>
    <div>
      <div class="toast-title" id="toastTitle">Sent</div>
      <div class="toast-sub" id="toastSub"></div>
    </div>
  </div>

  <script>
    var SHARE_PAYLOAD = ${payloadJson};
    var sheet = document.getElementById('sheet');
    var toast = document.getElementById('toast');
    var toastBadge = document.getElementById('toastBadge');
    var toastTitle = document.getElementById('toastTitle');
    var toastSub = document.getElementById('toastSub');
    var allBtn = document.getElementById('allBtn');
    var sendBtn = document.getElementById('sendBtn');
    var devButtons = Array.prototype.slice.call(document.querySelectorAll('.dest-btn[data-id]'));
    var selectedMap = {};

    function getSelected() {
      return devButtons.filter(function(b) { return Boolean(selectedMap[b.getAttribute('data-id')]); });
    }

    function updateUi() {
      var sel = getSelected();
      var isAll = sel.length === 0;
      allBtn.classList.toggle('selected', isAll);
      devButtons.forEach(function(b) {
        b.classList.toggle('selected', Boolean(selectedMap[b.getAttribute('data-id')]));
      });
      if (isAll) {
        sendBtn.textContent = 'Push to All Devices (' + devButtons.length + ')';
      } else if (sel.length === 1) {
        sendBtn.textContent = 'Push to ' + sel[0].getAttribute('data-name');
      } else {
        sendBtn.textContent = 'Push to ' + sel.length + ' devices';
      }
    }

    function closeShare() {
      window.close();
      setTimeout(function() {
        if (history.length > 1) history.back();
        else window.location.replace('/');
      }, 220);
    }

    function showToast(ok, title, sub) {
      toast.className = 'toast show' + (ok ? '' : ' error');
      toastBadge.textContent = ok ? '✓' : '!';
      toastTitle.textContent = title;
      toastSub.textContent = sub || '';
    }

    allBtn.addEventListener('click', function() {
      selectedMap = {};
      updateUi();
    });

    devButtons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-id');
        if (selectedMap[id]) delete selectedMap[id];
        else selectedMap[id] = true;
        updateUi();
      });
    });

    document.getElementById('cancelBtn').addEventListener('click', function() {
      if (SHARE_PAYLOAD.pendingFileId) {
        fetch('/share-cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-push-it-share': '1' },
          body: JSON.stringify({ pendingFileId: SHARE_PAYLOAD.pendingFileId }),
        }).catch(function() {});
      }
      closeShare();
    });
    toast.addEventListener('click', closeShare);

    sendBtn.addEventListener('click', function() {
      var sel = getSelected();
      var isAll = sel.length === 0;
      var targetIds = isAll ? undefined : sel.map(function(b) { return b.getAttribute('data-id'); });
      var targetNames = isAll ? undefined : sel.map(function(b) { return b.getAttribute('data-name'); });
      sendBtn.disabled = true;
      allBtn.disabled = true;
      devButtons.forEach(function(b) { b.disabled = true; });
      sendBtn.textContent = 'Sending…';

      var body = {
        content: SHARE_PAYLOAD.content || undefined,
        title: SHARE_PAYLOAD.title || undefined,
        pendingFileId: SHARE_PAYLOAD.pendingFileId || undefined,
        targetIds: targetIds,
        targetNames: targetNames,
      };

      fetch('/share-dispatch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-push-it-share': '1',
        },
        body: JSON.stringify(body),
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.ok) {
            sheet.classList.add('hidden');
            var targetLabel = isAll
              ? 'All Devices'
              : targetNames.length === 1
                ? targetNames[0]
                : targetNames.length + ' devices';
            showToast(
              true,
              'Sent to ' + targetLabel,
              data.delivered ? 'Delivered now' : 'Queued for delivery'
            );
            setTimeout(closeShare, 1400);
          } else {
            sendBtn.disabled = false;
            allBtn.disabled = false;
            devButtons.forEach(function(b) { b.disabled = false; });
            updateUi();
            showToast(false, (data && data.error) || 'Could not send', data && data.revoked ? 'Open Push It to re-pair' : 'Tap Push to retry');
          }
        })
        .catch(function() {
          sendBtn.disabled = false;
          allBtn.disabled = false;
          devButtons.forEach(function(b) { b.disabled = false; });
          updateUi();
          showToast(false, 'Network error', 'Check your connection and try again');
        });
    });
  </script>
</body>
</html>`;
}

// Intercept Share Target (POST /share for photos/files/text, GET /share for iOS Shortcut/links)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/share' && (event.request.method === 'GET' || event.request.method === 'POST')) {
    event.respondWith(handleSharePage(event.request, url));
    return;
  }

  if (event.request.method === 'POST' && url.pathname === '/share-dispatch') {
    event.respondWith(handleShareDispatch(event.request));
    return;
  }

  if (event.request.method === 'POST' && url.pathname === '/share-cancel') {
    event.respondWith(handleShareCancel(event.request));
  }
});

async function handleShareCancel(request) {
  if (request.headers.get('x-push-it-share') !== '1') {
    return Response.json({ ok: false }, { status: 403 });
  }
  try {
    const body = await request.json();
    if (body.pendingFileId && String(body.pendingFileId).startsWith('pending-share:')) {
      await deleteBlob(String(body.pendingFileId));
    }
  } catch {
    // ignore
  }
  return Response.json({ ok: true });
}

async function handleShareDispatch(request) {
  if (request.headers.get('x-push-it-share') !== '1') {
    return Response.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }
  try {
    const body = await request.json();
    let result;
    if (body.pendingFileId && String(body.pendingFileId).startsWith('pending-share:')) {
      const staged = await getBlob(String(body.pendingFileId));
      if (!staged) {
        return Response.json({ ok: false, error: 'Shared file expired, please share again' }, { status: 410 });
      }
      result = await dispatchShareFile({
        fileBuf: staged.data,
        fileName: staged.fileName,
        mimeType: staged.mimeType,
        targetIds: body.targetIds,
        targetNames: body.targetNames,
      });
      if (result.ok) {
        await deleteBlob(String(body.pendingFileId)).catch(() => {});
      }
    } else {
      result = await dispatchShareMessage({
        content: body.content,
        title: body.title,
        targetIds: body.targetIds,
        targetNames: body.targetNames,
      });
    }
    return Response.json(result, {
      status: result.ok ? 200 : result.revoked ? 401 : 500,
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return Response.json({ ok: false, error: 'Send failed' }, { status: 500 });
  }
}

async function handleSharePage(request, url) {
  let sharedUrl = '';
  let sharedText = '';
  let sharedTitle;
  let sharedFile = null;

  if (request.method === 'POST') {
    try {
      const form = await request.formData();
      sharedUrl = String(form.get('url') || '').trim();
      sharedText = String(form.get('text') || '').trim();
      sharedTitle = String(form.get('title') || '').trim() || undefined;
      const maybeFile = form.get('files');
      if (maybeFile && typeof maybeFile !== 'string' && maybeFile.size > 0) {
        sharedFile = maybeFile;
      }
    } catch {
      // fall through
    }
  } else {
    sharedUrl = (url.searchParams.get('url') || '').trim();
    sharedText = (url.searchParams.get('text') || '').trim();
    sharedTitle = (url.searchParams.get('title') || '').trim() || undefined;
  }

  const content = sharedUrl || sharedText;

  const [keyB64, deviceId, deviceToken] = await Promise.all([
    kvGet('keyB64'),
    kvGet('deviceId'),
    kvGet('deviceToken'),
  ]);

  if (!keyB64 || !deviceId || !deviceToken) {
    return Response.redirect('/', 302);
  }

  if (!sharedFile && !content) {
    return Response.redirect('/', 302);
  }

  if (sharedFile && sharedFile.size > MAX_FILE_BYTES) {
    return new Response(
      renderToastHtml({
        ok: false,
        title: 'File is too large',
        subtitle: 'Maximum file size is 7.5 MB.',
        preview: `${sharedFile.name || 'File'} (${formatFileSize(sharedFile.size)})`,
      }),
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const roomId = await deriveRoomId(keyB64);
  const { revoked, devices } = await fetchRoomDevices(roomId, keyB64, deviceId, deviceToken);

  if (revoked) {
    return new Response(
      renderToastHtml({
        ok: false,
        revoked: true,
        title: 'Device removed from room',
        subtitle: 'Pair this device again with a new 6-digit code to share.',
      }),
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const otherDevices = devices.filter((d) => d.deviceId !== deviceId);

  // Multiple other devices: ask which device or All Devices (Room)
  if (otherDevices.length > 1) {
    if (sharedFile) {
      const pendingFileId = `pending-share:${crypto.randomUUID()}`;
      const fileBuf = await sharedFile.arrayBuffer();
      const mimeType = sharedFile.type || 'application/octet-stream';
      const fileName = sharedFile.name || (mimeType.startsWith('image/') ? 'photo.png' : 'file');
      await saveBlob({ id: pendingFileId, data: fileBuf, mimeType, fileName });
      const kind = mimeType.startsWith('image/') ? 'Photo' : 'File';
      return new Response(
        renderPickerHtml({
          pendingFileId,
          title: `${kind} · ${formatFileSize(fileBuf.byteLength)}`,
          fileLabel: fileName,
          otherDevices,
        }),
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
      );
    }

    return new Response(
      renderPickerHtml({
        content,
        title: sharedTitle,
        otherDevices,
      }),
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  // 0 or 1 other device: send immediately and show confirmation Toast
  const singleTarget = otherDevices.length === 1 ? otherDevices[0] : null;
  let result;
  let previewText = '';

  if (sharedFile) {
    const fileBuf = await sharedFile.arrayBuffer();
    const mimeType = sharedFile.type || 'application/octet-stream';
    const fileName = sharedFile.name || (mimeType.startsWith('image/') ? 'photo.png' : 'file');
    previewText = `${fileName} (${formatFileSize(fileBuf.byteLength)})`;
    result = await dispatchShareFile({ fileBuf, fileName, mimeType });
  } else {
    previewText = sharedTitle || content.slice(0, 120);
    result = await dispatchShareMessage({ content, title: sharedTitle });
  }

  const html = result.ok
    ? renderToastHtml({
        ok: true,
        title: singleTarget ? `Sent to ${singleTarget.name}` : 'Pushed to room',
        subtitle: result.delivered ? 'Delivered now' : 'Queued for delivery',
        preview: previewText,
      })
    : renderToastHtml({
        ok: false,
        revoked: result.revoked,
        title: result.error || 'Could not send',
        subtitle: result.revoked
          ? 'Open Push It to pair this device again.'
          : 'Check your connection and try again.',
      });

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
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

  const [keyB64, myDeviceId, deviceToken] = await Promise.all([
    kvGet('keyB64'),
    kvGet('deviceId'),
    kvGet('deviceToken'),
  ]);

  if (!keyB64 || !myDeviceId || !deviceToken) {
    await self.registration.showNotification('Push It', {
      body: 'Open Push It to pair this device',
      icon: '/icon-192.png',
      data: { type: 'app' },
    });
    return;
  }

  const rid = await deriveRoomId(keyB64);

  let payload;
  try {
    payload = await decryptEnvelope(keyB64, rid, envelope);
  } catch {
    await self.registration.showNotification('Push It', {
      body: 'Re-pair this device to read this message',
      icon: '/icon-192.png',
      data: { type: 'app' },
    });
    return;
  }

  const expiresAt =
    typeof payload.expiresAt === 'number'
      ? payload.expiresAt
      : typeof envelope.expiresAt === 'number'
        ? envelope.expiresAt
        : undefined;

  if (expiresAt && expiresAt <= Date.now()) {
    return;
  }

  const pType =
    payload.type === 'link' || payload.type === 'file' || payload.type === 'longtext'
      ? payload.type
      : 'text';

  const item = {
    id: envelope.id,
    senderId: envelope.senderId,
    senderName: payload.senderName ? String(payload.senderName) : undefined,
    senderOs: payload.senderOs ? String(payload.senderOs) : undefined,
    targetNames: Array.isArray(payload.targetNames)
      ? payload.targetNames.map((n) => String(n))
      : undefined,
    ts: envelope.ts || Date.now(),
    type: pType,
    content: String(payload.content || ''),
    title: payload.title ? String(payload.title) : undefined,
    blobId: payload.blobId ? String(payload.blobId) : undefined,
    blobIv: payload.blobIv ? String(payload.blobIv) : undefined,
    fileName: payload.fileName ? String(payload.fileName) : undefined,
    mimeType: payload.mimeType ? String(payload.mimeType) : undefined,
    fileSize: typeof payload.fileSize === 'number' ? payload.fileSize : undefined,
    expiresAt,
    direction: 'in',
  };

  await saveMessage(item);
  const prevLastSeen = (await kvGet('lastSeenTs')) || 0;
  if (item.ts > prevLastSeen) {
    await kvSet('lastSeenTs', item.ts);
  }

  fetch(`/api/room/${encodeURIComponent(rid)}/ack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: makeAuthHeader(myDeviceId, deviceToken),
    },
    body: JSON.stringify({ messageId: item.id }),
  }).catch(() => {});

  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of windowClients) {
    client.postMessage({ type: 'PUSH_RECEIVED', item });
  }

  const hasVisibleClient = windowClients.some((c) => c.visibilityState === 'visible');
  if (hasVisibleClient) return;

  const nextUnread = ((await kvGet('unreadCount')) || 0) + 1;
  await kvSet('unreadCount', nextUnread);
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    await self.navigator.setAppBadge(nextUnread).catch(() => {});
  }

  const isLink = item.type === 'link' && isSafeHttpUrl(item.content);
  const isPhoto = item.type === 'file' && item.mimeType && item.mimeType.startsWith('image/');
  const fromPrefix = item.senderName ? `${item.senderName} · ` : '';
  const notifTitle = isLink
    ? `${fromPrefix}${item.title || 'New Link — Tap to Open'}`
    : item.type === 'file'
      ? `${fromPrefix}${isPhoto ? 'New Photo' : 'New File'}`
      : `${fromPrefix}${item.title || 'New Message'}`;

  const notifBody =
    item.type === 'file'
      ? item.fileName || 'Open Push It to view'
      : item.content.slice(0, 180);

  await self.registration.showNotification(notifTitle, {
    body: notifBody,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
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
