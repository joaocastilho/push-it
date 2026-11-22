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

  const [keyB64, setKeyB64] = createSignal<string>('');
  const [roomId, setRoomId] = createSignal<string>('');
  const [deviceId, setDeviceId] = createSignal<string>('');
  const [deviceName, setDeviceName] = createSignal<string>(defaultDeviceName(localOs));
  const [editingName, setEditingName] = createSignal<boolean>(false);
  const [nameDraft, setNameDraft] = createSignal<string>('');

  const [messages, setMessages] = createSignal<StoredMessage[]>([]);
  const [draft, setDraft] = createSignal<string>('');
  const [sending, setSending] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [autoOpen, setAutoOpen] = createSignal<boolean>(true);
  const [pushEnabled, setPushEnabled] = createSignal<boolean>(false);
  const [pushBusy, setPushBusy] = createSignal<boolean>(false);
  const [showDrawer, setShowDrawer] = createSignal<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string>('');
  const [importInput, setImportInput] = createSignal<string>('');
  const [toast, setToast] = createSignal<string>('');
  const [popupWarning, setPopupWarning] = createSignal<string>('');

  let chatEndEl: HTMLDivElement | undefined;
  let toastTimer: number | undefined;

  function notify(msg: string) {
    setToast(msg);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(''), 3000);
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
          notify('Paired with shared E2EE key');
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
        setKeyB64(activeKey);
        setRoomId(rid);
        setMessages(existingMsgs);
        setPushEnabled(Boolean(currentSub));
        scrollToBottom();

        // Fallback Share Target handler if Service Worker wasn't controlling yet
        if (window.location.pathname === '/share' || window.location.search.includes('url=') || window.location.search.includes('text=')) {
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

  // 2. Generate QR code when drawer opens
  createEffect(
    () => [showDrawer(), pairUrl()] as const,
    ([visible, url]) => {
      if (!visible || !url) return;
      QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: '#0b0f19', light: '#ffffff' },
      })
        .then(setQrDataUrl)
        .catch(() => {});
    },
  );

  // 3. Live WebSocket connection
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
            // Ignore malformed or wrong-key frames
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
          setPopupWarning(
            'Browser blocked auto-open. Allow Pop-ups & redirects for this site or use the Helium extension.',
          );
          notify(`Link from ${from} (pop-up blocked)`);
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
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Send failed (${res.status})`);
      }

      const result = (await res.json()) as { wsDelivered: number; pushSent: number };
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
      notify(`Sent (${result.wsDelivered} live, ${result.pushSent} push)`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  async function saveDeviceName() {
    const trimmed = nameDraft().trim() || defaultDeviceName(localOs);
    setDeviceName(trimmed);
    setEditingName(false);
    await kvSet('deviceName', trimmed);
    notify(`Device named "${trimmed}"`);
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
        notify('Background push disabled');
      } else {
        await subscribePush(rid, did);
        setPushEnabled(true);
        notify('Background push enabled');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Push setup failed');
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
      notify('Invalid E2EE key');
      return;
    }
    await kvSet('keyB64', raw);
    const rid = await deriveRoomId(raw);
    setKeyB64(raw);
    setRoomId(rid);
    setImportInput('');
    notify('Key imported! Re-enable Push to bind this room.');
  }

  async function handleRotateKey() {
    const fresh = generateRawKeyB64();
    await kvSet('keyB64', fresh);
    const rid = await deriveRoomId(fresh);
    setKeyB64(fresh);
    setRoomId(rid);
    notify('Generated new E2EE key — pair your other device');
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
      notify('Clipboard read denied — paste manually');
    }
  }

  async function copyToClipboard(text: string, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      notify(label);
    } catch {
      notify('Copy failed');
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
              <span class="status-text">
                {wsStatus() === 'connected' ? 'Live E2EE' : wsStatus()}
              </span>
              <span class="room-pill" title="Derived room hash">
                #{roomId().slice(0, 6)}
              </span>
            </div>
          </div>
        </div>

        <div class="topbar-actions">
          <Show
            when={!editingName()}
            fallback={
              <form
                class="name-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveDeviceName();
                }}
              >
                <input
                  type="text"
                  maxlength={24}
                  value={nameDraft()}
                  onInput={(e) => setNameDraft(e.currentTarget.value)}
                  onBlur={saveDeviceName}
                  autofocus
                />
              </form>
            }
          >
            <button
              class="device-pill"
              title="Click to rename this device"
              onClick={() => {
                setNameDraft(deviceName());
                setEditingName(true);
              }}
            >
              <OsIcon os={localOs} size={14} />
              <span>{deviceName()}</span>
            </button>
          </Show>

          <button class="btn secondary small" onClick={() => setShowDrawer((v) => !v)}>
            {showDrawer() ? 'Close' : 'Pair / Settings'}
          </button>
        </div>
      </header>

      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>

      <Show when={popupWarning()}>
        <div class="banner warning">{popupWarning()}</div>
      </Show>

      <Show when={showDrawer()}>
        <div class="drawer">
          <section class="card">
            <label class="toggle">
              <div>
                <strong>Auto-open links</strong>
                <span class="muted">Opens incoming URLs when this tab is open</span>
              </div>
              <input type="checkbox" checked={autoOpen()} onChange={handleToggleAutoOpen} />
            </label>

            <div class="divider" />

            <div class="toggle">
              <div>
                <strong>Background Push Notifications</strong>
                <span class="muted">
                  {isPushSupported()
                    ? 'Decrypts in Service Worker when app is closed'
                    : 'Not supported in this browser'}
                </span>
              </div>
              <button
                class={`btn small ${pushEnabled() ? 'success' : 'secondary'}`}
                disabled={!isPushSupported() || pushBusy()}
                onClick={handleTogglePush}
              >
                {pushBusy() ? '...' : pushEnabled() ? 'Enabled' : 'Enable'}
              </button>
            </div>
          </section>

          <section class="card">
            <div class="row between">
              <h2>Pair Device</h2>
              <Show when={messages().length > 0}>
                <button
                  class="link-btn"
                  onClick={async () => {
                    await clearMessages();
                    setMessages([]);
                    notify('Cleared local chat history');
                  }}
                >
                  Clear Chat
                </button>
              </Show>
            </div>
            <p class="muted">
              Scan this QR code or copy the pair link into another device or the Helium extension.
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
                New Key
              </button>
            </div>
            <div class="import-row">
              <input
                type="text"
                placeholder="Paste pair link or raw key..."
                value={importInput()}
                onInput={(e) => setImportInput(e.currentTarget.value)}
              />
              <button class="btn secondary" onClick={handleImportKey}>
                Import
              </button>
            </div>
          </section>
        </div>
      </Show>

      <main class="chat-stream">
        <For
          each={messages()}
          fallback={
            <div class="empty">
              <p>No messages yet.</p>
              <p class="muted">
                Send a link or note below, or share directly from Android’s Share menu.
              </p>
            </div>
          }
        >
          {(msg) => {
            const os = msg.senderOs ?? (msg.direction === 'out' ? localOs : 'other');
            const label = msg.senderName || (msg.direction === 'out' ? deviceName() : 'Other device');
            const isLink = msg.type === 'link' && isSafeHttpUrl(msg.content);

            return (
              <div class={`bubble-row ${msg.direction}`}>
                <article class={`bubble ${msg.direction}`}>
                  <div class="bubble-head">
                    <span class="sender-tag">
                      <OsIcon os={os} size={13} />
                      <span>{label}</span>
                    </span>
                    <time>{new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
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
          title="Paste clipboard & send"
          disabled={sending()}
          onClick={handlePasteAndSend}
        >
          Paste
        </button>
        <textarea
          rows={1}
          placeholder="Send a link or encrypted message..."
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
          {sending() ? '...' : 'Send'}
        </button>
      </footer>
    </div>
  );
}
