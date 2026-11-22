import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import QRCode from 'qrcode';
import { OsIcon } from './components/OsIcon';
import {
  decryptEnvelope,
  deriveRoomId,
  detectPayloadType,
  encryptPayload,
  generateRawKeyB64,
  isSafeHttpUrl,
  isValidKeyB64,
  type EncryptedEnvelope,
} from './lib/crypto';
import {
  clearMessages,
  kvGet,
  kvSet,
  listMessages,
  saveMessage,
  type StoredMessage,
} from './lib/db';
import { defaultDeviceName, detectOs, type DeviceOs } from './lib/device';
import {
  getCurrentPushSubscription,
  isPushSupported,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './lib/push';

export default function App() {
  const localOs: DeviceOs = detectOs();

  const [view, setView] = createSignal<'chat' | 'settings'>('chat');
  const [keyB64, setKeyB64] = createSignal<string>('');
  const [roomId, setRoomId] = createSignal<string>('');
  const [deviceId, setDeviceId] = createSignal<string>('');
  const [deviceName, setDeviceName] = createSignal<string>(defaultDeviceName(localOs));
  const [nameInput, setNameInput] = createSignal<string>(defaultDeviceName(localOs));

  const [messages, setMessages] = createSignal<StoredMessage[]>([]);
  const [draft, setDraft] = createSignal<string>('');
  const [sending, setSending] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [autoOpen, setAutoOpen] = createSignal<boolean>(true);
  const [pushEnabled, setPushEnabled] = createSignal<boolean>(false);
  const [pushBusy, setPushBusy] = createSignal<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string>('');
  const [importInput, setImportInput] = createSignal<string>('');
  const [toast, setToast] = createSignal<string>('');
  const [popupWarning, setPopupWarning] = createSignal<string>('');

  let chatEndEl: HTMLDivElement | undefined;
  let toastTimer: number | undefined;

  function notify(msg: string) {
    setToast(msg);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(''), 2800);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatEndEl?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  const pairUrl = createMemo(() => {
    const k = keyB64();
    if (!k) return '';
    return `${window.location.origin}/#key=${encodeURIComponent(k)}`;
  });

  const statusLabel = createMemo(() => {
    if (wsStatus() === 'connected') return 'Connected';
    if (wsStatus() === 'connecting') return 'Connecting...';
    return 'Offline';
  });

  // 1. Bootstrap key, device identity, preferences, SW, and URL hash/share target
  createEffect(
    () => true,
    () => {
      let cancelled = false;

      const onSwMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; item?: StoredMessage } | undefined;
        if (data?.type === 'PUSH_RECEIVED' && data.item) {
          addOrUpdateMessage(data.item);
        }
      };

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', onSwMessage);
      }

      (async () => {
        await registerServiceWorker().catch(() => {});

        let devId = await kvGet<string>('deviceId');
        if (!devId) {
          devId = crypto.randomUUID();
          await kvSet('deviceId', devId);
        }

        let devName = await kvGet<string>('deviceName');
        if (!devName) {
          devName = defaultDeviceName(localOs);
          await kvSet('deviceName', devName);
        }
        await kvSet('deviceOs', localOs);

        const savedAutoOpen = await kvGet<boolean>('autoOpen');
        if (typeof savedAutoOpen === 'boolean') {
          setAutoOpen(savedAutoOpen);
        }

        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const hashKey = hashParams.get('key');
        let activeKey = await kvGet<string>('keyB64');

        if (hashKey && isValidKeyB64(hashKey)) {
          activeKey = hashKey.trim();
          await kvSet('keyB64', activeKey);
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          notify('Devices paired!');
        } else if (!activeKey) {
          activeKey = generateRawKeyB64();
          await kvSet('keyB64', activeKey);
        }

        const rid = await deriveRoomId(activeKey);
        const existingMsgs = await listMessages();
        const currentSub = await getCurrentPushSubscription().catch(() => null);

        if (cancelled) return;

        setDeviceId(devId);
        setDeviceName(devName);
        setNameInput(devName);
        setKeyB64(activeKey);
        setRoomId(rid);
        setMessages(existingMsgs);
        setPushEnabled(Boolean(currentSub));
        scrollToBottom();

        // Fallback Share Target handler if Service Worker wasn't controlling yet
        if (
          window.location.pathname === '/share' ||
          window.location.search.includes('url=') ||
          window.location.search.includes('text=')
        ) {
          const sp = new URLSearchParams(window.location.search);
          const sharedUrl = sp.get('url')?.trim() || '';
          const sharedText = sp.get('text')?.trim() || '';
          const sharedTitle = sp.get('title')?.trim() || undefined;
          const payloadText = sharedUrl || sharedText;

          window.history.replaceState(null, '', '/');

          if (payloadText) {
            await sendText(payloadText, sharedTitle, activeKey, rid, devId, devName);
            window.close();
          }
        }
      })();

      return () => {
        cancelled = true;
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.removeEventListener('message', onSwMessage);
        }
      };
    },
  );

  // 2. Generate QR code when Settings view is open
  createEffect(
    () => [view(), pairUrl()] as const,
    ([activeView, url]) => {
      if (activeView !== 'settings' || !url) return;
      QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: '#0b0f19', light: '#ffffff' },
      })
        .then(setQrDataUrl)
        .catch(() => {});
    },
  );

  // 3. Live connection
  createEffect(
    () => [roomId(), deviceId(), keyB64()] as const,
    ([rid, did, k]) => {
      if (!rid || !did || !k) return;

      let ws: WebSocket | null = null;
      let reconnectTimer: number | undefined;
      let pingTimer: number | undefined;
      let closed = false;

      const connect = () => {
        if (closed) return;
        setWsStatus('connecting');
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/room/${encodeURIComponent(rid)}/ws?deviceId=${encodeURIComponent(did)}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setWsStatus('connected');
          pingTimer = window.setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
          }, 25000);
        };

        ws.onmessage = async (event) => {
          if (typeof event.data !== 'string' || event.data === 'pong') return;
          try {
            const parsed = JSON.parse(event.data) as {
              type?: string;
              envelope?: EncryptedEnvelope;
            };
            if (parsed.type !== 'message' || !parsed.envelope) return;
            if (parsed.envelope.senderId === did) return;

            const decrypted = await decryptEnvelope(k, parsed.envelope);
            const item: StoredMessage = {
              id: parsed.envelope.id,
              senderId: parsed.envelope.senderId,
              senderName: decrypted.senderName,
              senderOs: decrypted.senderOs,
              ts: parsed.envelope.ts || Date.now(),
              type: decrypted.type,
              content: decrypted.content,
              title: decrypted.title,
              direction: 'in',
            };

            await saveMessage(item);
            addOrUpdateMessage(item);
            handleIncomingAction(item);
          } catch {
            // Ignore unreadable messages
          }
        };

        ws.onclose = () => {
          if (pingTimer) window.clearInterval(pingTimer);
          setWsStatus('disconnected');
          if (!closed) {
            reconnectTimer = window.setTimeout(connect, 2500);
          }
        };

        ws.onerror = () => {
          ws?.close();
        };
      };

      connect();

      return () => {
        closed = true;
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        if (pingTimer) window.clearInterval(pingTimer);
        ws?.close();
      };
    },
  );

  function addOrUpdateMessage(item: StoredMessage) {
    setMessages((prev) => {
      if (prev.some((m) => m.id === item.id)) return prev;
      return [...prev, item].slice(-60);
    });
    scrollToBottom();
  }

  function handleIncomingAction(item: StoredMessage) {
    const from = item.senderName || 'Other device';
    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      if (autoOpen()) {
        const win = window.open(item.content, '_blank', 'noopener,noreferrer');
        if (!win) {
          setPopupWarning('Allow pop-ups for this site to open incoming links automatically.');
          notify(`Link from ${from}`);
        } else {
          setPopupWarning('');
          notify(`Opened link from ${from}`);
        }
      } else {
        notify(`Link from ${from}`);
      }
    } else {
      notify(`Message from ${from}`);
    }
  }

  async function sendText(
    rawText: string,
    title?: string,
    overrideKey?: string,
    overrideRoom?: string,
    overrideDev?: string,
    overrideName?: string,
  ) {
    const content = rawText.trim();
    const k = overrideKey || keyB64();
    const rid = overrideRoom || roomId();
    const did = overrideDev || deviceId();
    const dName = overrideName || deviceName();
    if (!content || !k || !rid || !did) return;

    setSending(true);
    try {
      const type = detectPayloadType(content);
      const envelope = await encryptPayload(k, did, {
        type,
        content,
        title,
        senderName: dName,
        senderOs: localOs,
      });

      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        throw new Error('Could not send right now');
      }

      const item: StoredMessage = {
        id: envelope.id,
        senderId: did,
        senderName: dName,
        senderOs: localOs,
        ts: envelope.ts,
        type,
        content,
        title,
        direction: 'out',
      };

      await saveMessage(item);
      addOrUpdateMessage(item);
      setDraft('');
      notify('Pushed!');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setSending(false);
    }
  }

  async function saveDeviceName() {
    const trimmed = nameInput().trim() || defaultDeviceName(localOs);
    setDeviceName(trimmed);
    setNameInput(trimmed);
    await kvSet('deviceName', trimmed);
    notify(`Saved as "${trimmed}"`);
  }

  async function handleToggleAutoOpen() {
    const next = !autoOpen();
    setAutoOpen(next);
    setPopupWarning('');
    await kvSet('autoOpen', next);
  }

  async function handleTogglePush() {
    const rid = roomId();
    const did = deviceId();
    if (!rid || !did) return;

    setPushBusy(true);
    try {
      if (pushEnabled()) {
        await unsubscribePush(rid, did);
        setPushEnabled(false);
        notify('Notifications turned off');
      } else {
        await subscribePush(rid, did);
        setPushEnabled(true);
        notify('Notifications turned on');
      }
    } catch {
      notify('Notifications are not supported in this browser');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleImportKey() {
    let raw = importInput().trim();
    if (!raw) return;
    if (raw.includes('#key=')) {
      raw = decodeURIComponent(raw.split('#key=')[1].split('&')[0]);
    }
    if (!isValidKeyB64(raw)) {
      notify('That pair link is not valid');
      return;
    }
    await kvSet('keyB64', raw);
    const rid = await deriveRoomId(raw);
    setKeyB64(raw);
    setRoomId(rid);
    setImportInput('');
    notify('Devices paired!');
  }

  async function handleRotateKey() {
    const fresh = generateRawKeyB64();
    await kvSet('keyB64', fresh);
    const rid = await deriveRoomId(fresh);
    setKeyB64(fresh);
    setRoomId(rid);
    notify('Created a new pairing code');
  }

  async function handlePasteAndSend() {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        notify('Clipboard is empty');
        return;
      }
      await sendText(clip);
    } catch {
      notify('Paste into the box to send');
    }
  }

  async function copyToClipboard(text: string, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      notify(label);
    } catch {
      notify('Could not copy');
    }
  }

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <img src="/icon.svg" alt="" class="logo" />
          <div>
            <h1>Push It</h1>
            <div class="status-row">
              <span class={`dot ${wsStatus()}`} />
              <span>{statusLabel()}</span>
            </div>
          </div>
        </div>

        <div class="topbar-actions">
          <Show
            when={view() === 'chat'}
            fallback={
              <button
                class="btn secondary small"
                onClick={() => {
                  setView('chat');
                  scrollToBottom();
                }}
              >
                ← Back
              </button>
            }
          >
            <button
              class="device-pill"
              title="Device settings"
              onClick={() => setView('settings')}
            >
              <OsIcon os={localOs} size={14} />
              <span>{deviceName()}</span>
            </button>
            <button
              class="btn secondary small"
              aria-label="Settings"
              onClick={() => setView('settings')}
            >
              Settings
            </button>
          </Show>
        </div>
      </header>

      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>

      <Show when={popupWarning() && view() === 'chat'}>
        <div class="banner warning">{popupWarning()}</div>
      </Show>

      <Show
        when={view() === 'chat'}
        fallback={
          <main class="settings-page">
            <section class="card">
              <h2>This Device</h2>
              <div class="import-row">
                <input
                  type="text"
                  maxlength={24}
                  placeholder={defaultDeviceName(localOs)}
                  value={nameInput()}
                  onInput={(e) => setNameInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      saveDeviceName();
                    }
                  }}
                />
                <button class="btn primary small" onClick={saveDeviceName}>
                  Save
                </button>
              </div>
            </section>

            <section class="card">
              <h2>Preferences</h2>
              <label class="toggle">
                <div>
                  <strong>Auto-open links</strong>
                  <span class="muted">Open incoming links automatically while this tab is open</span>
                </div>
                <input type="checkbox" checked={autoOpen()} onChange={handleToggleAutoOpen} />
              </label>

              <div class="divider" />

              <div class="toggle">
                <div>
                  <strong>Notifications</strong>
                  <span class="muted">
                    {isPushSupported()
                      ? 'Notify me when the app is closed'
                      : 'Not available in this browser'}
                  </span>
                </div>
                <button
                  class={`btn small ${pushEnabled() ? 'success' : 'secondary'}`}
                  disabled={!isPushSupported() || pushBusy()}
                  onClick={handleTogglePush}
                >
                  {pushBusy() ? '...' : pushEnabled() ? 'On' : 'Turn On'}
                </button>
              </div>
            </section>

            <section class="card">
              <h2>Pair Another Device</h2>
              <p class="muted">
                Scan this code on your phone or copy the link into another device.
              </p>
              <Show when={qrDataUrl()}>
                <div class="qr-wrap">
                  <img src={qrDataUrl()} alt="Pairing QR Code" class="qr-img" />
                </div>
              </Show>
              <div class="row gap">
                <button
                  class="btn primary"
                  onClick={() => copyToClipboard(pairUrl(), 'Pair link copied')}
                >
                  Copy Pair Link
                </button>
                <button class="btn secondary" onClick={handleRotateKey}>
                  New Code
                </button>
              </div>
              <div class="import-row">
                <input
                  type="text"
                  placeholder="Paste pair link from another device..."
                  value={importInput()}
                  onInput={(e) => setImportInput(e.currentTarget.value)}
                />
                <button class="btn secondary" onClick={handleImportKey}>
                  Pair
                </button>
              </div>
            </section>

            <section class="card">
              <div class="row between">
                <div>
                  <strong>Chat History</strong>
                  <span class="muted">Stored only on this device</span>
                </div>
                <button
                  class="btn secondary small"
                  disabled={messages().length === 0}
                  onClick={async () => {
                    await clearMessages();
                    setMessages([]);
                    notify('History cleared');
                  }}
                >
                  Clear
                </button>
              </div>
            </section>
          </main>
        }
      >
        <main class="chat-stream">
          <For
            each={messages()}
            fallback={
              <div class="empty">
                <p>Nothing pushed yet.</p>
                <p class="muted">
                  Send a link or note below, or share straight from Android’s Share menu.
                </p>
              </div>
            }
          >
            {(msg) => {
              const os = msg.senderOs ?? (msg.direction === 'out' ? localOs : 'other');
              const label =
                msg.senderName || (msg.direction === 'out' ? deviceName() : 'Other device');
              const isLink = msg.type === 'link' && isSafeHttpUrl(msg.content);

              return (
                <div class={`bubble-row ${msg.direction}`}>
                  <article class={`bubble ${msg.direction}`}>
                    <div class="bubble-head">
                      <span class="sender-tag">
                        <OsIcon os={os} size={13} />
                        <span>{label}</span>
                      </span>
                      <time>
                        {new Date(msg.ts).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <Show when={msg.title}>
                      <div class="bubble-title">{msg.title}</div>
                    </Show>
                    <div class="bubble-body">
                      {isLink ? (
                        <a href={msg.content} target="_blank" rel="noopener noreferrer">
                          {msg.content}
                        </a>
                      ) : (
                        <pre>{msg.content}</pre>
                      )}
                    </div>
                    <div class="bubble-actions">
                      <Show when={isLink}>
                        <a
                          class="chip primary"
                          href={msg.content}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </a>
                      </Show>
                      <button
                        class="chip"
                        onClick={() => copyToClipboard(msg.content, 'Copied')}
                      >
                        Copy
                      </button>
                    </div>
                  </article>
                </div>
              );
            }}
          </For>
          <div ref={chatEndEl} />
        </main>

        <footer class="composer-bar">
          <button
            class="btn secondary icon-btn"
            title="Paste clipboard and push"
            disabled={sending()}
            onClick={handlePasteAndSend}
          >
            Paste
          </button>
          <textarea
            rows={1}
            placeholder="Paste a link or note..."
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendText(draft());
              }
            }}
          />
          <button
            class="btn primary"
            disabled={sending() || !draft().trim()}
            onClick={() => sendText(draft())}
          >
            {sending() ? '...' : 'Push It'}
          </button>
        </footer>
      </Show>
    </div>
  );
}
