import {
  decryptEnvelope,
  decryptJson,
  defaultDeviceName,
  deriveRoomId,
  detectOs,
  detectPayloadType,
  encryptJson,
  encryptPayload,
  isSafeHttpUrl,
  normalizeOs,
} from './crypto.js';

const KEEPALIVE_ALARM = 'push-it-keepalive';
const MAX_HISTORY = 40;
const LOCAL_OS = detectOs();

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let wsStatus = 'disconnected';
let cachedDevices = [];
const notifUrls = new Map();

async function getConfig() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'keyB64',
    'deviceId',
    'deviceName',
    'autoOpen',
    'history',
    'lastSeenTs',
    'unreadCount',
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
  return {
    serverUrl: data.serverUrl || '',
    keyB64: data.keyB64 || '',
    deviceId,
    deviceName,
    deviceOs: LOCAL_OS,
    autoOpen: typeof data.autoOpen === 'boolean' ? data.autoOpen : true,
    history: Array.isArray(data.history) ? data.history : [],
    lastSeenTs: typeof data.lastSeenTs === 'number' ? data.lastSeenTs : 0,
    unreadCount: typeof data.unreadCount === 'number' ? data.unreadCount : 0,
  };
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

async function registerDeviceRecord(devId, name, os) {
  const { serverUrl, keyB64 } = await getConfig();
  if (!serverUrl || !keyB64 || !devId) return;
  const roomId = await deriveRoomId(keyB64);
  const base = new URL(serverUrl);
  const enc = await encryptJson(keyB64, { name, os });
  await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: devId, iv: enc.iv, ciphertext: enc.ciphertext }),
  }).catch(() => {});
}

async function refreshDevices() {
  const { serverUrl, keyB64, deviceId, deviceName } = await getConfig();
  if (!serverUrl || !keyB64) {
    cachedDevices = [];
    return [];
  }
  try {
    const roomId = await deriveRoomId(keyB64);
    const base = new URL(serverUrl);
    const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`);
    if (!res.ok) return cachedDevices;
    const data = await res.json();
    const list = [];
    for (const d of data.devices || []) {
      try {
        const meta = await decryptJson(keyB64, d.iv, d.ciphertext);
        const os = normalizeOs(meta.os);
        const name = meta.name ? String(meta.name) : defaultDeviceName(os);
        list.push({
          deviceId: d.deviceId,
          name,
          os,
          online: Boolean(d.online),
          updatedAt: d.updatedAt,
        });
        if (d.deviceId === deviceId && name !== deviceName) {
          await chrome.storage.local.set({ deviceName: name });
        }
      } catch {
        // ignore other-key devices
      }
    }
    cachedDevices = list;
    return list;
  } catch {
    return cachedDevices;
  }
}

async function syncPending() {
  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.keyB64) return;
  try {
    const roomId = await deriveRoomId(cfg.keyB64);
    const base = new URL(cfg.serverUrl);
    const res = await fetch(
      `${base.origin}/api/room/${encodeURIComponent(roomId)}/pending?deviceId=${encodeURIComponent(cfg.deviceId)}&since=${cfg.lastSeenTs}`,
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.messages?.length) return;

    let maxTs = cfg.lastSeenTs;
    for (const env of data.messages) {
      try {
        const decrypted = await decryptEnvelope(cfg.keyB64, env);
        const item = {
          id: env.id,
          senderId: env.senderId,
          senderName: decrypted.senderName,
          senderOs: decrypted.senderOs,
          targetNames: decrypted.targetNames,
          ts: env.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          direction: 'in',
        };
        if (item.ts > maxTs) maxTs = item.ts;
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

async function connect() {
  const { serverUrl, keyB64, deviceId, deviceName, deviceOs } = await getConfig();
  if (!serverUrl || !keyB64) {
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
    const roomId = await deriveRoomId(keyB64);
    const base = new URL(serverUrl);
    const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${base.host}/api/room/${encodeURIComponent(roomId)}/ws?deviceId=${encodeURIComponent(deviceId)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      setStatus('connected');
      await registerDeviceRecord(deviceId, deviceName, deviceOs);
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
        if (parsed.type !== 'message' || !parsed.envelope) return;

        const cfg = await getConfig();
        if (!cfg.keyB64 || parsed.envelope.senderId === cfg.deviceId) return;

        const decrypted = await decryptEnvelope(cfg.keyB64, parsed.envelope);
        const item = {
          id: parsed.envelope.id,
          senderId: parsed.envelope.senderId,
          senderName: decrypted.senderName,
          senderOs: decrypted.senderOs,
          targetNames: decrypted.targetNames,
          ts: parsed.envelope.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          direction: 'in',
        };

        const added = await appendHistory(item);
        if (item.ts > cfg.lastSeenTs) {
          await chrome.storage.local.set({ lastSeenTs: item.ts });
        }
        if (added) {
          await handleIncoming(item, cfg.autoOpen);
        }
      } catch {
        // Ignore malformed or wrong-key payloads
      }
    };

    ws.onclose = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      ws = null;
      setStatus('disconnected');
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    setStatus('disconnected');
    reconnectTimer = setTimeout(connect, 5000);
  }
}

async function handleIncoming(item, autoOpen) {
  const isLink = item.type === 'link' && isSafeHttpUrl(item.content);

  if (isLink && autoOpen) {
    await chrome.tabs.create({ url: item.content, active: true });
    return;
  }

  // Increment unread counter for red badge on toolbar icon
  const { unreadCount } = await getConfig();
  await chrome.storage.local.set({ unreadCount: unreadCount + 1 });
  await updateBadge();

  const notifId = `push-it-${item.id}`;
  if (isLink) {
    notifUrls.set(notifId, item.content);
  }

  const fromPrefix = item.senderName ? `${item.senderName} · ` : '';
  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: isLink
      ? `${fromPrefix}${item.title || 'New Link — Click to Open'}`
      : `${fromPrefix}${item.title || 'New Message'}`,
    message: item.content.slice(0, 200),
    priority: 2,
  });
}

async function sendContent(rawContent, title, targetIds, targetNames) {
  const content = String(rawContent || '').trim();
  const { serverUrl, keyB64, deviceId, deviceName, deviceOs } = await getConfig();
  if (!content) throw new Error('Nothing to send');
  if (!serverUrl || !keyB64) throw new Error('Pair this device first');

  const roomId = await deriveRoomId(keyB64);
  const type = detectPayloadType(content);
  const envelope = await encryptPayload(
    keyB64,
    deviceId,
    {
      type,
      content,
      title,
      senderName: deviceName,
      senderOs: deviceOs,
      targetNames: targetNames && targetNames.length > 0 ? targetNames : undefined,
    },
    targetIds && targetIds.length > 0 ? targetIds : undefined,
  );

  const base = new URL(serverUrl);
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    throw new Error('Could not send right now');
  }

  const result = await res.json();
  await appendHistory({
    id: envelope.id,
    senderId: deviceId,
    senderName: deviceName,
    senderOs: deviceOs,
    targetNames: targetNames && targetNames.length > 0 ? targetNames : undefined,
    ts: envelope.ts,
    type,
    content,
    title,
    direction: 'out',
  });
  return result;
}

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'push-it-send',
      title: 'Push It',
      contexts: ['page', 'link', 'selection'],
    });
  });
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
  if (info.menuItemId !== 'push-it-send') return;
  const content = info.linkUrl || info.selectionText || info.pageUrl || tab?.url;
  if (!content) return;
  try {
    await sendContent(content, tab?.title);
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
      const devices = await refreshDevices();
      sendResponse({
        status: wsStatus,
        paired: Boolean(cfg.serverUrl && cfg.keyB64),
        serverUrl: cfg.serverUrl,
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        deviceOs: cfg.deviceOs,
        autoOpen: cfg.autoOpen,
        history: cfg.history,
        devices,
      });
      return;
    }

    if (msg.type === 'MARK_READ') {
      await chrome.storage.local.set({ unreadCount: 0 });
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RENAME_DEVICE') {
      const cfg = await getConfig();
      if (msg.deviceId === cfg.deviceId) {
        await chrome.storage.local.set({ deviceName: msg.name });
      }
      await registerDeviceRecord(msg.deviceId, msg.name, msg.os);
      const devices = await refreshDevices();
      sendResponse({ ok: true, devices });
      return;
    }

    if (msg.type === 'REMOVE_DEVICE') {
      const cfg = await getConfig();
      if (cfg.serverUrl && cfg.keyB64) {
        const roomId = await deriveRoomId(cfg.keyB64);
        const base = new URL(cfg.serverUrl);
        await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/devices`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
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
      const res = await sendContent(msg.content, msg.title, msg.targetIds, msg.targetNames);
      sendResponse({ ok: true, result: res });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message' });
  })().catch((err) => {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });
  return true;
});

connect();
