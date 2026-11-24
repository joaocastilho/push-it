import { clearExtBlobs, deleteExtBlob, saveExtBlob } from './db.js';
import {
  blobAad,
  decryptBytes,
  decryptEnvelope,
  decryptJson,
  decryptPairingBundle,
  defaultDeviceName,
  deriveRoomAuth,
  deriveRoomId,
  detectOs,
  detectPayloadType,
  deviceAad,
  encryptBytes,
  encryptJson,
  encryptPairingBundle,
  encryptPayload,
  generateRawKeyB64,
  generateSixDigitCode,
  hashPairCode,
  isSafeHttpUrl,
  isSafeServerOrigin,
  isValidInviteToken,
  isValidKeyB64,
  isValidSixDigitCode,
  makeAuthHeader,
  normalizeDeviceColor,
  normalizeOs,
} from './crypto.js';

const KEEPALIVE_ALARM = 'push-it-keepalive';
const MAX_HISTORY = 200;
const LONG_TEXT_THRESHOLD = 1800;
const LOCAL_OS = detectOs();

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = 3000;
let wsStatus = 'disconnected';
let cachedDevices = [];
const notifUrls = new Map();

async function getConfig() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'keyB64',
    'deviceId',
    'deviceToken',
    'deviceName',
    'autoOpen',
    'history',
    'lastSeenTs',
    'unreadCount',
    'revokedNotice',
  ]);
  let deviceId = data.deviceId;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  let deviceName = data.deviceName;
  if (!deviceName) {
    deviceName = defaultDeviceName(LOCAL_OS);
    await chrome.storage.local.set({ deviceName });
  }
  let revokedNotice = data.revokedNotice || '';
  // Upgrade notice for legacy v1 installations that had keyB64 without deviceToken
  if (data.keyB64 && !data.deviceToken && !revokedNotice) {
    revokedNotice =
      'Security upgraded: please re-pair using a single-use invite link from Push It.';
    await chrome.storage.local.set({ keyB64: '', revokedNotice });
  }
  return {
    serverUrl: data.serverUrl || '',
    keyB64: data.deviceToken ? data.keyB64 || '' : '',
    deviceId,
    deviceToken: data.deviceToken || '',
    deviceName,
    deviceOs: LOCAL_OS,
    autoOpen: typeof data.autoOpen === 'boolean' ? data.autoOpen : true,
    history: Array.isArray(data.history)
      ? data.history.filter((m) => !m.expiresAt || m.expiresAt > Date.now())
      : [],
    lastSeenTs: typeof data.lastSeenTs === 'number' ? data.lastSeenTs : 0,
    unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
    revokedNotice,
  };
}

function authHeaders(cfg, extra = {}) {
  return {
    authorization: makeAuthHeader(cfg.deviceId, cfg.deviceToken),
    ...extra,
  };
}

async function handleRevoked(reason) {
  stopSocket();
  cachedDevices = [];
  await chrome.storage.local.set({
    keyB64: '',
    deviceToken: '',
    revokedNotice: reason || '',
  });
  setStatus('disconnected');
  setupContextMenus();
}

async function updateBadge(status = wsStatus) {
  const { unreadCount } = await getConfig();
  if (unreadCount > 0) {
    chrome.action.setBadgeText({ text: String(unreadCount > 99 ? '99+' : unreadCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    return;
  }
  if (status === 'connected') {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({
      color: status === 'connecting' ? '#f59e0b' : '#64748b',
    });
  }
}

function setStatus(status) {
  wsStatus = status;
  updateBadge(status);
}

async function appendHistory(item) {
  const { history } = await getConfig();
  if (history.some((m) => m.id === item.id)) return false;
  const next = [...history, item].slice(-MAX_HISTORY);
  await chrome.storage.local.set({ history: next });
  return true;
}

async function markDeliveredInHistory(ids) {
  if (!ids?.length) return;
  const set = new Set(ids);
  const { history } = await getConfig();
  let changed = false;
  const next = history.map((m) => {
    if (set.has(m.id) && m.status !== 'delivered') {
      changed = true;
      return { ...m, status: 'delivered' };
    }
    return m;
  });
  if (changed) {
    await chrome.storage.local.set({ history: next });
  }
}

async function setupContextMenus() {
  const { deviceId } = await getConfig();
  const others = cachedDevices.filter((d) => d.deviceId !== deviceId);

  chrome.contextMenus.removeAll(() => {
    const contexts = ['page', 'link', 'selection'];
    if (others.length < 2) {
      chrome.contextMenus.create({
        id: 'push-it-all',
        title: 'Push It',
        contexts,
      });
      return;
    }

    chrome.contextMenus.create({
      id: 'push-it-root',
      title: 'Push It',
      contexts,
    });
    chrome.contextMenus.create({
      id: 'push-it-all',
      parentId: 'push-it-root',
      title: 'All Devices',
      contexts,
    });
    for (const dev of others) {
      chrome.contextMenus.create({
        id: `push-it-dev:${dev.deviceId}`,
        parentId: 'push-it-root',
        title: dev.name,
        contexts,
      });
    }
  });
}

async function updateDeviceRecord(targetDevId, name, os, color) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken || !targetDevId) return;
  const roomId = await deriveRoomId(cfg.keyB64);
  const base = new URL(cfg.serverUrl);
  const safeColor = normalizeDeviceColor(color);
  const meta = safeColor !== undefined ? { name, os, color: safeColor } : { name, os };
  const enc = await encryptJson(cfg.keyB64, meta, deviceAad(roomId, targetDevId));
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
    method: 'POST',
    headers: authHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify({ deviceId: targetDevId, iv: enc.iv, ciphertext: enc.ciphertext }),
  }).catch(() => null);
  if (res?.status === 401) {
    await handleRevoked('This device was removed from the room.');
  }
}

async function refreshDevices() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken) {
    cachedDevices = [];
    setupContextMenus();
    return [];
  }
  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);
    const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
      headers: authHeaders(cfg),
    });
    if (res.status === 401) {
      await handleRevoked('This device was removed from the room.');
      return [];
    }
    if (!res.ok) return cachedDevices;
    const data = await res.json();
    const list = [];
    for (const d of data.devices || []) {
      try {
        const meta = await decryptJson(
          cfg.keyB64,
          d.iv,
          d.ciphertext,
          deviceAad(roomId, d.deviceId),
        );
        const os = normalizeOs(meta.os);
        const name = meta.name ? String(meta.name) : defaultDeviceName(os);
        const color = normalizeDeviceColor(meta.color);
        list.push({
          deviceId: d.deviceId,
          name,
          os,
          color,
          online: Boolean(d.online),
          updatedAt: d.updatedAt,
          lastSeenAt: d.lastSeenAt || d.updatedAt,
        });
        if (d.deviceId === cfg.deviceId && name !== cfg.deviceName) {
          await chrome.storage.local.set({ deviceName: name });
        }
      } catch {
        // ignore other-key devices
      }
    }
    cachedDevices = list;
    setupContextMenus();
    await chrome.storage.local.set({ devicesUpdatedAt: Date.now() }).catch(() => {});
    return list;
  } catch {
    return cachedDevices;
  }
}

async function hydrateLongTextIfNeeded(item, cfg) {
  if (item.type !== 'longtext' || !item.blobId || !item.blobIv) return item;
  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);
    const res = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(item.blobId)}`,
      { headers: authHeaders(cfg) },
    );
    if (res.status === 401) {
      await handleRevoked('This device was removed from the room.');
      return item;
    }
    if (!res.ok) return item;
    const cipher = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptBytes(
      cfg.keyB64,
      item.blobIv,
      cipher,
      blobAad(roomId, item.blobId),
    );
    return {
      ...item,
      type: 'text',
      content: new TextDecoder().decode(plain),
    };
  } catch {
    return item;
  }
}

async function syncPending() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken) return;
  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);
    const res = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/pending?since=${cfg.lastSeenTs}`,
      { headers: authHeaders(cfg) },
    );
    if (res.status === 401) {
      await handleRevoked('This device was removed from the room.');
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (!data.messages?.length) return;

    let maxTs = cfg.lastSeenTs;
    for (const env of data.messages) {
      try {
        const decrypted = await decryptEnvelope(cfg.keyB64, roomId, env);
        let item = {
          id: env.id,
          senderId: env.senderId,
          senderName: decrypted.senderName,
          senderOs: decrypted.senderOs,
          targetNames: decrypted.targetNames,
          ts: env.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          blobId: decrypted.blobId,
          blobIv: decrypted.blobIv,
          fileName: decrypted.fileName,
          mimeType: decrypted.mimeType,
          fileSize: decrypted.fileSize,
          expiresAt: decrypted.expiresAt,
          direction: 'in',
        };
        if (item.expiresAt && item.expiresAt <= Date.now()) continue;
        if (item.ts > maxTs) maxTs = item.ts;
        item = await hydrateLongTextIfNeeded(item, cfg);
        const added = await appendHistory(item);
        if (added) {
          await handleIncoming(item, cfg.autoOpen);
        }
      } catch {
        // ignore unreadable
      }
    }

    if (maxTs > cfg.lastSeenTs) {
      await chrome.storage.local.set({ lastSeenTs: maxTs });
    }
  } catch {
    // ignore
  }
}

function stopSocket() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

async function connect() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken) {
    stopSocket();
    setStatus('disconnected');
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    stopSocket();
    setStatus('disconnected');
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  stopSocket();
  setStatus('connecting');

  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);

    const ticketRes = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/ws-ticket`,
      {
        method: 'POST',
        headers: authHeaders(cfg),
      },
    );
    if (ticketRes.status === 401) {
      await handleRevoked('This device was removed from the room.');
      return;
    }
    if (!ticketRes.ok) {
      setStatus('disconnected');
      scheduleReconnect();
      return;
    }
    const { ticket } = await ticketRes.json();
    if (!ticket) {
      setStatus('disconnected');
      scheduleReconnect();
      return;
    }

    const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${base.host}/api/room/${encodeURIComponent(roomId)}/ws?ticket=${encodeURIComponent(ticket)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      reconnectDelay = 3000;
      setStatus('connected');
      await refreshDevices();
      await syncPending();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, 20000);
    };

    ws.onmessage = async (event) => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'devices_updated') {
          await refreshDevices();
          return;
        }
        if (parsed.type === 'delivered' && Array.isArray(parsed.ids)) {
          await markDeliveredInHistory(parsed.ids);
          return;
        }
        if (parsed.type !== 'message' || !parsed.envelope) return;

        const latestCfg = await getConfig();
        if (!latestCfg.keyB64 || !latestCfg.deviceToken) return;
        if (parsed.envelope.senderId === latestCfg.deviceId) return;

        const currentRoomId = await deriveRoomId(latestCfg.keyB64);
        const decrypted = await decryptEnvelope(latestCfg.keyB64, currentRoomId, parsed.envelope);
        let item = {
          id: parsed.envelope.id,
          senderId: parsed.envelope.senderId,
          senderName: decrypted.senderName,
          senderOs: decrypted.senderOs,
          targetNames: decrypted.targetNames,
          ts: parsed.envelope.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          blobId: decrypted.blobId,
          blobIv: decrypted.blobIv,
          fileName: decrypted.fileName,
          mimeType: decrypted.mimeType,
          fileSize: decrypted.fileSize,
          expiresAt: decrypted.expiresAt,
          direction: 'in',
        };
        if (item.expiresAt && item.expiresAt <= Date.now()) return;

        item = await hydrateLongTextIfNeeded(item, latestCfg);
        const added = await appendHistory(item);
        if (item.ts > latestCfg.lastSeenTs) {
          await chrome.storage.local.set({ lastSeenTs: item.ts });
        }
        if (added) {
          await handleIncoming(item, latestCfg.autoOpen);
        }
      } catch {
        // Ignore malformed or wrong-key payloads
      }
    };

    ws.onclose = (ev) => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      setStatus('disconnected');
      if (ev.code === 4001) {
        handleRevoked('This device was removed from the room.');
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    setStatus('disconnected');
    scheduleReconnect();
  }
}

async function handleIncoming(item, autoOpen) {
  const isLink = item.type === 'link' && isSafeHttpUrl(item.content);

  if (isLink && autoOpen) {
    await chrome.tabs.create({ url: item.content, active: true });
    return;
  }

  const { unreadCount } = await getConfig();
  await chrome.storage.local.set({ unreadCount: unreadCount + 1 });
  await updateBadge();

  const notifId = `push-it-${item.id}`;
  if (isLink) {
    notifUrls.set(notifId, item.content);
  }

  const fromPrefix = item.senderName ? `${item.senderName} · ` : '';
  const isPhoto = item.type === 'file' && item.mimeType?.startsWith('image/');
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: isLink
      ? `${fromPrefix}${item.title || 'New Link — Click to Open'}`
      : item.type === 'file'
        ? `${fromPrefix}${isPhoto ? 'New Photo' : 'New File'}`
        : `${fromPrefix}${item.title || 'New Message'}`,
    message:
      item.type === 'file'
        ? item.fileName || 'Open Push It to download'
        : item.content.slice(0, 200),
    priority: 2,
  });
}

async function uploadEncryptedBlob(cfg, roomId, plainBytes, targetIds, expiresAt) {
  const blobId = crypto.randomUUID().replace(/-/g, '');
  const { iv: blobIv, ciphertext } = await encryptBytes(
    cfg.keyB64,
    plainBytes,
    blobAad(roomId, blobId),
  );
  const base = new URL(cfg.serverUrl);
  const params = new URLSearchParams();
  if (targetIds && targetIds.length > 0) params.set('targetIds', targetIds.join(','));
  if (expiresAt) params.set('expiresAt', String(expiresAt));
  const qs = params.toString();

  const res = await fetch(
    `${base.origin}/api/room/${encodeURIComponent(roomId)}/blob/${encodeURIComponent(blobId)}${qs ? `?${qs}` : ''}`,
    {
      method: 'PUT',
      headers: authHeaders(cfg, { 'content-type': 'application/octet-stream' }),
      body: ciphertext,
    },
  );
  if (res.status === 401) {
    await handleRevoked('This device was removed from the room.');
    throw new Error('This device was removed from the room');
  }
  if (!res.ok) throw new Error('File too large (max 8 MB)');
  return { blobId, blobIv };
}

async function sendContent(rawContent, title, targetIds, targetNames, expiresInMs) {
  const content = String(rawContent || '').trim();
  const cfg = await getConfig();
  if (!content) throw new Error('Nothing to send');
  if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken) {
    throw new Error('Pair this device first');
  }

  const roomId = await deriveRoomId(cfg.keyB64);
  const isLong = content.length > LONG_TEXT_THRESHOLD;
  const expiresAt = expiresInMs > 0 ? Date.now() + expiresInMs : undefined;
  let envelope;

  if (isLong) {
    const plain = new TextEncoder().encode(content);
    const { blobId, blobIv } = await uploadEncryptedBlob(
      cfg,
      roomId,
      plain,
      targetIds,
      expiresAt,
    );
    envelope = await encryptPayload(
      cfg.keyB64,
      roomId,
      cfg.deviceId,
      {
        type: 'longtext',
        content: content.slice(0, 140) + '…',
        title,
        senderName: cfg.deviceName,
        senderOs: cfg.deviceOs,
        targetNames: targetNames?.length ? targetNames : undefined,
        blobId,
        blobIv,
        fileSize: plain.byteLength,
        expiresAt,
      },
      targetIds?.length ? targetIds : undefined,
    );
  } else {
    const type = detectPayloadType(content);
    envelope = await encryptPayload(
      cfg.keyB64,
      roomId,
      cfg.deviceId,
      {
        type,
        content,
        title,
        senderName: cfg.deviceName,
        senderOs: cfg.deviceOs,
        targetNames: targetNames?.length ? targetNames : undefined,
        expiresAt,
      },
      targetIds?.length ? targetIds : undefined,
    );
  }

  const base = new URL(cfg.serverUrl);
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: authHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify(envelope),
  });

  if (res.status === 401) {
    await handleRevoked('This device was removed from the room.');
    throw new Error('This device was removed from the room');
  }
  if (!res.ok) throw new Error('Could not send right now');

  const result = await res.json();
  await appendHistory({
    id: envelope.id,
    senderId: cfg.deviceId,
    senderName: cfg.deviceName,
    senderOs: cfg.deviceOs,
    targetNames: targetNames?.length ? targetNames : undefined,
    ts: envelope.ts,
    type: isLong ? 'text' : detectPayloadType(content),
    content,
    title,
    expiresAt,
    direction: 'out',
    status: result.delivered ? 'delivered' : 'queued',
  });
  return result;
}

async function sendFileBytes(bytesArray, fileName, mimeType, targetIds, targetNames, expiresInMs) {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken) {
    throw new Error('Pair this device first');
  }

  const plainBytes = new Uint8Array(bytesArray);
  const roomId = await deriveRoomId(cfg.keyB64);
  const expiresAt = expiresInMs > 0 ? Date.now() + expiresInMs : undefined;
  const { blobId, blobIv } = await uploadEncryptedBlob(
    cfg,
    roomId,
    plainBytes,
    targetIds,
    expiresAt,
  );

  const envelope = await encryptPayload(
    cfg.keyB64,
    roomId,
    cfg.deviceId,
    {
      type: 'file',
      content: fileName,
      senderName: cfg.deviceName,
      senderOs: cfg.deviceOs,
      targetNames: targetNames?.length ? targetNames : undefined,
      blobId,
      blobIv,
      fileName,
      mimeType,
      fileSize: plainBytes.byteLength,
      expiresAt,
    },
    targetIds?.length ? targetIds : undefined,
  );

  const base = new URL(cfg.serverUrl);
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: authHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify(envelope),
  });

  if (res.status === 401) {
    await handleRevoked('This device was removed from the room.');
    throw new Error('This device was removed from the room');
  }
  if (!res.ok) throw new Error('Could not send file');

  const result = await res.json();
  await saveExtBlob({
    id: blobId,
    data: plainBytes.buffer.slice(plainBytes.byteOffset, plainBytes.byteOffset + plainBytes.byteLength),
    mimeType: mimeType || 'application/octet-stream',
    fileName: fileName || 'file',
  }).catch(() => {});
  await appendHistory({
    id: envelope.id,
    senderId: cfg.deviceId,
    senderName: cfg.deviceName,
    senderOs: cfg.deviceOs,
    targetNames: targetNames?.length ? targetNames : undefined,
    ts: envelope.ts,
    type: 'file',
    content: fileName,
    blobId,
    blobIv,
    fileName,
    mimeType,
    fileSize: plainBytes.byteLength,
    expiresAt,
    direction: 'out',
    status: result.delivered ? 'delivered' : 'queued',
  });
  return result;
}

async function detectServerUrlFromTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !isSafeServerOrigin(tab.url)) continue;
      if (tab.title && /push it/i.test(tab.title)) {
        return new URL(tab.url).origin;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

async function createNewRoom(rawServerUrl, roomPin, accessKey) {
  const cfg = await getConfig();
  const candidate = String(rawServerUrl || cfg.serverUrl || '').trim();
  if (!candidate) {
    throw new Error('Open your Push It website once or enter its URL');
  }
  const normalizedUrl = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const parsed = new URL(normalizedUrl);
  if (!isSafeServerOrigin(parsed.origin)) {
    throw new Error('Server URL must use HTTPS (or localhost)');
  }

  const cleanPin = roomPin ? String(roomPin).replace(/\D/g, '') : '';
  if (cleanPin && !isValidSixDigitCode(cleanPin)) {
    throw new Error('Room PIN must be 6 digits');
  }

  const freshKey = generateRawKeyB64();
  const [roomId, roomAuth] = await Promise.all([
    deriveRoomId(freshKey),
    deriveRoomAuth(freshKey),
  ]);
  const enc = await encryptJson(
    freshKey,
    { name: cfg.deviceName, os: cfg.deviceOs },
    deviceAad(roomId, cfg.deviceId),
  );

  const headers = { 'content-type': 'application/json' };
  if (accessKey && String(accessKey).trim()) {
    headers['x-access-key'] = String(accessKey).trim();
  }

  const res = await fetch(`${parsed.origin}/api/room/${encodeURIComponent(roomId)}/init`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceId: cfg.deviceId,
      roomAuth,
      roomPin: cleanPin || undefined,
      iv: enc.iv,
      ciphertext: enc.ciphertext,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.deviceToken) {
    if (data.code === 'ACCESS_KEY_REQUIRED' || data.code === 'ACCESS_KEY_INVALID') {
      return {
        ok: false,
        accessKeyRequired: true,
        error: data.error || 'Server access code required',
      };
    }
    throw new Error(data.error || 'Could not create room');
  }

  await clearExtBlobs().catch(() => {});
  await chrome.storage.local.set({
    serverUrl: parsed.origin,
    keyB64: freshKey,
    deviceToken: data.deviceToken,
    history: [],
    unreadCount: 0,
    revokedNotice: '',
  });
  stopSocket();
  await connect();
  return { ok: true };
}

async function completeRoomJoin(origin, keyB64, inviteToken, roomPin) {
  const cfg = await getConfig();
  const [roomId, roomAuth] = await Promise.all([
    deriveRoomId(keyB64),
    deriveRoomAuth(keyB64),
  ]);
  const enc = await encryptJson(
    keyB64,
    { name: cfg.deviceName, os: cfg.deviceOs },
    deviceAad(roomId, cfg.deviceId),
  );

  const res = await fetch(`${origin}/api/room/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: cfg.deviceId,
      roomAuth,
      inviteToken,
      roomPin: roomPin ? String(roomPin).replace(/\D/g, '') : undefined,
      iv: enc.iv,
      ciphertext: enc.ciphertext,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.deviceToken) {
    if (data.code === 'ROOM_PIN_REQUIRED' || data.code === 'ROOM_PIN_INVALID') {
      return {
        ok: false,
        pinRequired: true,
        error: data.error || 'Enter the 6-digit room PIN',
      };
    }
    throw new Error(data.error || 'Invite is invalid or expired');
  }

  await chrome.storage.local.set({
    serverUrl: origin,
    keyB64,
    deviceToken: data.deviceToken,
    revokedNotice: '',
  });
  stopSocket();
  await connect();
  return { ok: true };
}

async function joinRoomWithInvite(rawLink, roomPin) {
  const parsed = new URL(String(rawLink || '').trim());
  if (!isSafeServerOrigin(parsed.origin)) {
    throw new Error('Server URL must use HTTPS (or localhost)');
  }
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const keyB64 = hashParams.get('key')?.trim() || '';
  const inviteToken = hashParams.get('invite')?.trim() || '';
  if (!isValidKeyB64(keyB64) || !isValidInviteToken(inviteToken)) {
    throw new Error('Paste a valid single-use invite link from Push It');
  }
  return completeRoomJoin(parsed.origin, keyB64, inviteToken, roomPin);
}

async function joinRoomWithCode(rawServerUrl, rawCode, roomPin) {
  const trimmedUrl = String(rawServerUrl || '').trim();
  const normalizedUrl = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
  const parsed = new URL(normalizedUrl);
  if (!isSafeServerOrigin(parsed.origin)) {
    throw new Error('Server URL must use HTTPS (or localhost)');
  }
  const code = String(rawCode || '').replace(/\D/g, '');
  if (!isValidSixDigitCode(code)) {
    throw new Error('Enter a 6-digit pairing code');
  }

  const codeHash = await hashPairCode(code);
  const res = await fetch(`${parsed.origin}/api/pair/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeHash }),
  });
  const data = await res.json().catch(() => ({}));
  if (
    !res.ok ||
    !data.roomId ||
    !data.inviteToken ||
    !data.salt ||
    !data.bundleIv ||
    !data.bundleCiphertext
  ) {
    throw new Error(data.error || 'Invalid or expired 6-digit code');
  }

  const keyB64 = await decryptPairingBundle(
    code,
    data.salt,
    data.bundleIv,
    data.bundleCiphertext,
  );
  const derivedRid = await deriveRoomId(keyB64);
  if (derivedRid !== data.roomId) {
    throw new Error('Pairing bundle verification failed');
  }

  if (data.pinRequired && !roomPin) {
    return {
      ok: false,
      pinRequired: true,
      resolved: { origin: parsed.origin, keyB64, inviteToken: data.inviteToken },
      error: 'This room is protected by a 6-digit PIN',
    };
  }

  return completeRoomJoin(parsed.origin, keyB64, data.inviteToken, roomPin);
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    connect();
  }
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  chrome.notifications.clear(notifId);
  const url = notifUrls.get(notifId);
  notifUrls.delete(notifId);
  if (url && isSafeHttpUrl(url)) {
    await chrome.tabs.create({ url, active: true });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = String(info.menuItemId || '');
  if (menuId !== 'push-it-all' && !menuId.startsWith('push-it-dev:')) return;

  const content = info.linkUrl || info.selectionText || info.pageUrl || tab?.url;
  if (!content) return;

  let targetIds;
  let targetNames;
  if (menuId.startsWith('push-it-dev:')) {
    const devId = menuId.slice('push-it-dev:'.length);
    const dev = cachedDevices.find((d) => d.deviceId === devId);
    if (dev) {
      targetIds = [dev.deviceId];
      targetNames = [dev.name];
    }
  }

  try {
    await sendContent(content, tab?.title, targetIds, targetNames);
  } catch (err) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Push It',
      message: err instanceof Error ? err.message : 'Could not send',
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_STATUS') {
      const cfg = await getConfig();
      if (!cfg.serverUrl) {
        const detected = await detectServerUrlFromTabs();
        if (detected) {
          await chrome.storage.local.set({ serverUrl: detected });
        }
      }
      const devices = await refreshDevices();
      const refreshedCfg = await getConfig();
      sendResponse({
        status: wsStatus,
        paired: Boolean(refreshedCfg.serverUrl && refreshedCfg.keyB64 && refreshedCfg.deviceToken),
        serverUrl: refreshedCfg.serverUrl,
        keyB64: refreshedCfg.keyB64,
        deviceId: refreshedCfg.deviceId,
        deviceToken: refreshedCfg.deviceToken,
        deviceName: refreshedCfg.deviceName,
        deviceOs: refreshedCfg.deviceOs,
        autoOpen: refreshedCfg.autoOpen,
        history: refreshedCfg.history,
        revokedNotice: refreshedCfg.revokedNotice,
        devices,
      });
      return;
    }

    if (msg.type === 'CREATE_ROOM') {
      const res = await createNewRoom(msg.serverUrl, msg.roomPin, msg.accessKey);
      sendResponse(res);
      return;
    }

    if (msg.type === 'JOIN_ROOM') {
      const res = await joinRoomWithInvite(msg.rawLink, msg.roomPin);
      sendResponse(res);
      return;
    }

    if (msg.type === 'JOIN_BY_CODE') {
      const res = await joinRoomWithCode(msg.serverUrl, msg.code, msg.roomPin);
      sendResponse(res);
      return;
    }

    if (msg.type === 'JOIN_RESOLVED') {
      const res = await completeRoomJoin(msg.origin, msg.keyB64, msg.inviteToken, msg.roomPin);
      sendResponse(res);
      return;
    }

    if (msg.type === 'CREATE_INVITE') {
      const cfg = await getConfig();
      if (!cfg.serverUrl || !cfg.keyB64 || !cfg.deviceToken) {
        throw new Error('Pair this device first');
      }
      const roomId = await deriveRoomId(cfg.keyB64);
      const base = new URL(cfg.serverUrl);
      for (let attempt = 0; attempt < 3; attempt++) {
        const pairCode = generateSixDigitCode();
        const bundle = await encryptPairingBundle(pairCode, cfg.keyB64);
        const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/invites`, {
          method: 'POST',
          headers: authHeaders(cfg, { 'content-type': 'application/json' }),
          body: JSON.stringify(bundle),
        });
        if (res.status === 401) {
          await handleRevoked('This device was removed from the room.');
          throw new Error('This device was removed from the room');
        }
        if (res.status === 409) continue;
        if (!res.ok) throw new Error('Could not create invite');
        const data = await res.json();
        const inviteUrl = `${base.origin}/#key=${encodeURIComponent(cfg.keyB64)}&invite=${encodeURIComponent(data.inviteToken)}`;
        sendResponse({ ok: true, pairCode, inviteUrl, expiresAt: data.expiresAt });
        return;
      }
      throw new Error('Could not create invite');
    }

    if (msg.type === 'CANCEL_INVITE') {
      const cfg = await getConfig();
      if (cfg.serverUrl && cfg.keyB64 && cfg.deviceToken) {
        const roomId = await deriveRoomId(cfg.keyB64);
        const base = new URL(cfg.serverUrl);
        await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/invites`, {
          method: 'DELETE',
          headers: authHeaders(cfg),
        }).catch(() => {});
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'LEAVE_ROOM') {
      const cfg = await getConfig();
      if (cfg.serverUrl && cfg.keyB64 && cfg.deviceToken) {
        const roomId = await deriveRoomId(cfg.keyB64);
        const base = new URL(cfg.serverUrl);
        await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
          method: 'DELETE',
          headers: authHeaders(cfg, { 'content-type': 'application/json' }),
          body: JSON.stringify({ deviceId: cfg.deviceId }),
        }).catch(() => {});
      }
      await handleRevoked('');
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'MARK_READ') {
      await chrome.storage.local.set({ unreadCount: 0 });
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_MESSAGE') {
      const { history } = await getConfig();
      const target = history.find((m) => m.id === msg.id);
      if (target?.blobId) {
        await deleteExtBlob(target.blobId).catch(() => {});
      }
      const next = history.filter((m) => m.id !== msg.id);
      await chrome.storage.local.set({ history: next });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RENAME_DEVICE') {
      const cfg = await getConfig();
      if (msg.deviceId === cfg.deviceId) {
        await chrome.storage.local.set({ deviceName: msg.name });
      }
      await updateDeviceRecord(msg.deviceId, msg.name, msg.os, msg.color);
      const devices = await refreshDevices();
      sendResponse({ ok: true, devices });
      return;
    }

    if (msg.type === 'SET_DEVICE_COLOR') {
      await updateDeviceRecord(msg.deviceId, msg.name, msg.os, msg.color);
      const devices = await refreshDevices();
      sendResponse({ ok: true, devices });
      return;
    }

    if (msg.type === 'REMOVE_DEVICE') {
      const cfg = await getConfig();
      if (cfg.serverUrl && cfg.keyB64 && cfg.deviceToken) {
        const roomId = await deriveRoomId(cfg.keyB64);
        const base = new URL(cfg.serverUrl);
        await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
          method: 'DELETE',
          headers: authHeaders(cfg, { 'content-type': 'application/json' }),
          body: JSON.stringify({ deviceId: msg.deviceId }),
        }).catch(() => {});
      }
      const devices = await refreshDevices();
      sendResponse({ ok: true, devices });
      return;
    }

    if (msg.type === 'RECONNECT') {
      stopSocket();
      await connect();
      sendResponse({ ok: true, status: wsStatus });
      return;
    }

    if (msg.type === 'SEND') {
      const res = await sendContent(
        msg.content,
        msg.title,
        msg.targetIds,
        msg.targetNames,
        msg.expiresInMs,
      );
      sendResponse({ ok: true, result: res });
      return;
    }

    if (msg.type === 'SEND_FILE') {
      const res = await sendFileBytes(
        msg.bytes,
        msg.fileName,
        msg.mimeType,
        msg.targetIds,
        msg.targetNames,
        msg.expiresInMs,
      );
      sendResponse({ ok: true, result: res });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message' });
  })().catch((err) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

self.addEventListener('online', () => {
  reconnectDelay = 3000;
  connect();
});

self.addEventListener('offline', () => {
  stopSocket();
  setStatus('disconnected');
});

connect();
