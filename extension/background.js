import {
  decryptEnvelope,
  deriveRoomId,
  detectPayloadType,
  encryptPayload,
  isSafeHttpUrl,
} from './crypto.js';

const KEEPALIVE_ALARM = 'push-it-keepalive';
const MAX_HISTORY = 30;

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let wsStatus = 'disconnected';
const notifUrls = new Map();

async function getConfig() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'keyB64',
    'deviceId',
    'autoOpen',
    'history',
  ]);
  let deviceId = data.deviceId;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  return {
    serverUrl: data.serverUrl || '',
    keyB64: data.keyB64 || '',
    deviceId,
    autoOpen: typeof data.autoOpen === 'boolean' ? data.autoOpen : true,
    history: Array.isArray(data.history) ? data.history : [],
  };
}

function setStatus(status) {
  wsStatus = status;
  chrome.action.setBadgeText({ text: status === 'connected' ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({
    color: status === 'connecting' ? '#f59e0b' : '#ef4444',
  });
}

async function appendHistory(item) {
  const { history } = await getConfig();
  if (history.some((m) => m.id === item.id)) return;
  const next = [item, ...history].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ history: next });
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
  const { serverUrl, keyB64, deviceId } = await getConfig();
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

    ws.onopen = () => {
      setStatus('connected');
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
        if (parsed.type !== 'message' || !parsed.envelope) return;

        const cfg = await getConfig();
        if (!cfg.keyB64 || parsed.envelope.senderId === cfg.deviceId) return;

        const decrypted = await decryptEnvelope(cfg.keyB64, parsed.envelope);
        const item = {
          id: parsed.envelope.id,
          senderId: parsed.envelope.senderId,
          ts: parsed.envelope.ts || Date.now(),
          type: decrypted.type,
          content: decrypted.content,
          title: decrypted.title,
          direction: 'in',
        };

        await appendHistory(item);
        await handleIncoming(item, cfg.autoOpen);
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

  const notifId = `push-it-${item.id}`;
  if (isLink) {
    notifUrls.set(notifId, item.content);
  }

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: isLink ? item.title || 'New Link — Click to Open' : item.title || 'New Encrypted Text',
    message: item.content.slice(0, 200),
    priority: 2,
  });
}

async function sendContent(rawContent, title) {
  const content = String(rawContent || '').trim();
  const { serverUrl, keyB64, deviceId } = await getConfig();
  if (!content) throw new Error('Nothing to send');
  if (!serverUrl || !keyB64) throw new Error('Pair the extension first');

  const roomId = await deriveRoomId(keyB64);
  const type = detectPayloadType(content);
  const envelope = await encryptPayload(keyB64, deviceId, { type, content, title });

  const base = new URL(serverUrl);
  const res = await fetch(`${base.origin}/api/room/${encodeURIComponent(roomId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Send failed (${res.status})`);
  }

  const result = await res.json();
  await appendHistory({
    id: envelope.id,
    senderId: deviceId,
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
      title: 'Send to Push It (E2EE)',
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
      title: 'Push It — Send Failed',
      message: err instanceof Error ? err.message : 'Could not send',
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_STATUS') {
      const cfg = await getConfig();
      sendResponse({
        status: wsStatus,
        paired: Boolean(cfg.serverUrl && cfg.keyB64),
        serverUrl: cfg.serverUrl,
        autoOpen: cfg.autoOpen,
        history: cfg.history,
      });
      return;
    }

    if (msg.type === 'RECONNECT') {
      stopSocket();
      await connect();
      sendResponse({ ok: true, status: wsStatus });
      return;
    }

    if (msg.type === 'SEND') {
      const res = await sendContent(msg.content, msg.title);
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
