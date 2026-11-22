import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import QRCode from 'qrcode';
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
import {
  getCurrentPushSubscription,
  isPushSupported,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './lib/push';

export default function App() {
  const [keyB64, setKeyB64] = createSignal<string>('');
  const [roomId, setRoomId] = createSignal<string>('');
  const [deviceId, setDeviceId] = createSignal<string>('');
  const [messages, setMessages] = createSignal<StoredMessage[]>([]);
  const [draft, setDraft] = createSignal<string>('');
  const [sending, setSending] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [autoOpen, setAutoOpen] = createSignal<boolean>(true);
  const [pushEnabled, setPushEnabled] = createSignal<boolean>(false);
  const [pushBusy, setPushBusy] = createSignal<boolean>(false);
  const [showPair, setShowPair] = createSignal<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string>('');
  const [importInput, setImportInput] = createSignal<string>('');
  const [toast, setToast] = createSignal<string>('');
  const [popupWarning, setPopupWarning] = createSignal<string>('');

  let toastTimer: number | undefined;
  function notify(msg: string) {
    setToast(msg);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(''), 3200);
  }

  const pairUrl = createMemo(() => {
    const k = keyB64();
    if (!k) return '';
    return `${window.location.origin}/#key=${encodeURIComponent(k)}`;
  });

  // 1. Bootstrap key, deviceId, preferences, Service Worker, and URL hash/share target
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

        const savedAutoOpen = await kvGet<boolean>('autoOpen');
        if (typeof savedAutoOpen === 'boolean') {
          setAutoOpen(savedAutoOpen);
        }

        // Check if a pairing key was passed in the URL hash (#key=...)
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
        setKeyB64(activeKey);
        setRoomId(rid);
        setMessages(existingMsgs);
        setPushEnabled(Boolean(currentSub));

        // Handle Android PWA Share Target (/share?title=...&text=...&url=...)
        if (window.location.pathname === '/share' || window.location.search.includes('url=') || window.location.search.includes('text=')) {
          const sp = new URLSearchParams(window.location.search);
          const sharedUrl = sp.get('url')?.trim() || '';
          const sharedText = sp.get('text')?.trim() || '';
          const sharedTitle = sp.get('title')?.trim() || undefined;
          const payloadText = sharedUrl || sharedText;

          window.history.replaceState(null, '', '/');

          if (payloadText) {
            await sendText(payloadText, sharedTitle, activeKey, rid, devId);
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

  // 2. Generate QR code whenever pairing panel is opened or key changes
  createEffect(
    () => [showPair(), pairUrl()] as const,
    ([visible, url]) => {
      if (!visible || !url) return;
      QRCode.toDataURL(url, {
        width: 240,
        margin: 2,
        color: { dark: '#0b0f19', light: '#ffffff' },
      })
        .then(setQrDataUrl)
        .catch(() => {});
    },
  );

  // 3. Maintain live WebSocket connection for instant delivery & Windows auto-open
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
      return [item, ...prev].slice(0, 50);
    });
  }

  function handleIncomingAction(item: StoredMessage) {
    if (item.type === 'link' && isSafeHttpUrl(item.content)) {
      if (autoOpen()) {
        const win = window.open(item.content, '_blank', 'noopener,noreferrer');
        if (!win) {
          setPopupWarning(
            'Browser blocked auto-open. Allow Pop-ups & redirects for this site to auto-open incoming links.',
          );
          notify('Link received (pop-up blocked — click to open)');
        } else {
          setPopupWarning('');
          notify('Opened incoming link');
        }
      } else {
        notify('New link received');
      }
    } else {
      notify('New encrypted text received');
    }
  }

  async function sendText(
    rawText: string,
    title?: string,
    overrideKey?: string,
    overrideRoom?: string,
    overrideDev?: string,
  ) {
    const content = rawText.trim();
    const k = overrideKey || keyB64();
    const rid = overrideRoom || roomId();
    const did = overrideDev || deviceId();
    if (!content || !k || !rid || !did) return;

    setSending(true);
    try {
      const type = detectPayloadType(content);
      const envelope = await encryptPayload(k, did, { type, content, title });

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
        ts: envelope.ts,
        type,
        content,
        title,
        direction: 'out',
      };

      await saveMessage(item);
      addOrUpdateMessage(item);
      setDraft('');
      notify(`Sent E2EE (${result.wsDelivered} live, ${result.pushSent} push)`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
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
      notify('Clipboard read denied — paste into box manually');
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
    <div class="app">
      <header class="header">
        <div class="brand">
          <img src="/icon.svg" alt="" class="logo" />
          <div>
            <h1>Push It</h1>
            <div class="status-row">
              <span class={`dot ${wsStatus()}`} />
              <span class="status-text">
                {wsStatus() === 'connected' ? 'Live E2EE' : wsStatus()}
              </span>
              <span class="room-pill" title="Derived room hash (server never sees your key)">
                #{roomId().slice(0, 6)}
              </span>
            </div>
          </div>
        </div>
        <button class="btn secondary" onClick={() => setShowPair((v) => !v)}>
          {showPair() ? 'Close Pair' : 'Pair Device'}
        </button>
      </header>

      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>

      <Show when={popupWarning()}>
        <div class="banner warning">{popupWarning()}</div>
      </Show>

      <Show when={showPair()}>
        <section class="card pair-card">
          <h2>Pair Android &amp; Windows</h2>
          <p class="muted">
            Scan this QR code or open the pair link on your other device. The AES-256 key lives in
            the URL fragment (<code>#key=...</code>) and is never sent to Cloudflare.
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
      </Show>

      <section class="card controls-card">
        <label class="toggle">
          <div>
            <strong>Auto-open links</strong>
            <span class="muted">Opens incoming URLs when this tab is open (Windows)</span>
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
            class={`btn ${pushEnabled() ? 'success' : 'secondary'}`}
            disabled={!isPushSupported() || pushBusy()}
            onClick={handleTogglePush}
          >
            {pushBusy() ? '...' : pushEnabled() ? 'Enabled' : 'Enable Push'}
          </button>
        </div>
      </section>

      <section class="card composer-card">
        <textarea
          rows={3}
          placeholder="Paste a link (https://...) or encrypted note..."
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              sendText(draft());
            }
          }}
        />
        <div class="row between">
          <button class="btn secondary" disabled={sending()} onClick={handlePasteAndSend}>
            Paste &amp; Send
          </button>
          <button
            class="btn primary"
            disabled={sending() || !draft().trim()}
            onClick={() => sendText(draft())}
          >
            {sending() ? 'Encrypting...' : 'Send E2EE'}
          </button>
        </div>
      </section>

      <section class="feed">
        <div class="feed-header">
          <h2>Recent (Local Only)</h2>
          <Show when={messages().length > 0}>
            <button
              class="link-btn"
              onClick={async () => {
                await clearMessages();
                setMessages([]);
              }}
            >
              Clear
            </button>
          </Show>
        </div>

        <For
          each={messages()}
          fallback={
            <div class="empty">
              No messages yet. Pair your phone and PC, then send a link or use Android’s Share menu.
            </div>
          }
        >
          {(msg) => (
            <article class={`msg-card ${msg.direction}`}>
              <div class="msg-meta">
                <span class="badge">
                  {msg.direction === 'in' ? 'Received' : 'Sent'} · {msg.type}
                </span>
                <time>{new Date(msg.ts).toLocaleTimeString()}</time>
              </div>
              <Show when={msg.title}>
                <div class="msg-title">{msg.title}</div>
              </Show>
              <div class="msg-body">
                {msg.type === 'link' && isSafeHttpUrl(msg.content) ? (
                  <a href={msg.content} target="_blank" rel="noopener noreferrer">
                    {msg.content}
                  </a>
                ) : (
                  <pre>{msg.content}</pre>
                )}
              </div>
              <div class="msg-actions">
                <Show when={msg.type === 'link' && isSafeHttpUrl(msg.content)}>
                  <a
                    class="btn small primary"
                    href={msg.content}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open
                  </a>
                </Show>
                <button
                  class="btn small secondary"
                  onClick={() => copyToClipboard(msg.content, 'Copied to clipboard')}
                >
                  Copy
                </button>
              </div>
            </article>
          )}
        </For>
      </section>
    </div>
  );
}
