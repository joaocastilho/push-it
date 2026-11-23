import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { Check, Copy, Download, ExternalLink, Trash2 } from 'lucide';
import QRCode from 'qrcode';
import { DigitCodeInput } from './components/DigitCodeInput';
import { LucideIcon } from './components/LucideIcon';
import { OsIcon } from './components/OsIcon';
import {
  blobAad,
  decryptBytes,
  decryptEnvelope,
  decryptJson,
  decryptPairingBundle,
  deriveRoomAuth,
  deriveRoomId,
  detectPayloadType,
  deviceAad,
  encryptBytes,
  encryptJson,
  encryptPairingBundle,
  encryptPayload,
  formatFileSize,
  formatRelativeTime,
  formatRemainingTime,
  generateRawKeyB64,
  generateSixDigitCode,
  hashPairCode,
  isSafeHttpUrl,
  isValidSixDigitCode,
  makeAuthHeader,
  parsePairLink,
  type DeviceMeta,
  type EncryptedEnvelope,
} from './lib/crypto';
import {
  clearMessages,
  deleteMessage,
  getBlob,
  kvDelete,
  kvGet,
  kvSet,
  listMessages,
  markMessagesDelivered,
  pruneExpiredMessages,
  saveBlob,
  saveMessage,
  type StoredMessage,
} from './lib/db';
import {
  defaultDeviceName,
  detectOs,
  DEVICE_COLOR_OPTIONS,
  deviceColorIndex,
  isIosDevice,
  isStandalonePwa,
  normalizeDeviceColor,
  normalizeOs,
  type DeviceOs,
} from './lib/device';
import {
  getCurrentPushSubscription,
  isPushSupported,
  registerServiceWorker,
  subscribePush,
  unsubscribePush,
} from './lib/push';

interface PairedDevice {
  deviceId: string;
  name: string;
  os: DeviceOs;
  color?: number;
  online: boolean;
  updatedAt: number;
  lastSeenAt?: number;
}

interface PendingSharePayload {
  content: string;
  title?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const MAX_FILE_BYTES = 7.5 * 1024 * 1024;
const LONG_TEXT_THRESHOLD = 1800;
const BURN_OPTIONS = [
  { ms: 0, label: 'Keep' },
  { ms: 30 * 1000, label: '30 sec' },
  { ms: 60 * 1000, label: '1 min' },
  { ms: 5 * 60 * 1000, label: '5 min' },
  { ms: 10 * 60 * 1000, label: '10 min' },
] as const;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isNewerVersion(candidate: string | null | undefined, current: string): boolean {
  if (!candidate) return false;
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

export default function App() {
  const localOs: DeviceOs = detectOs();
  const isIos = isIosDevice();
  const canWebShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const [booting, setBooting] = createSignal<boolean>(true);
  const [standalone, setStandalone] = createSignal<boolean>(isStandalonePwa());
  const [installPrompt, setInstallPrompt] = createSignal<BeforeInstallPromptEvent | null>(null);
  const [view, setView] = createSignal<'chat' | 'settings'>('chat');
  const [showAddDevice, setShowAddDevice] = createSignal<boolean>(false);
  const [keyB64, setKeyB64] = createSignal<string>('');
  const [roomId, setRoomId] = createSignal<string>('');
  const [deviceId, setDeviceId] = createSignal<string>('');
  const [deviceToken, setDeviceToken] = createSignal<string>('');
  const [deviceName, setDeviceName] = createSignal<string>(defaultDeviceName(localOs));

  const [accessKeyRequired, setAccessKeyRequired] = createSignal<boolean>(false);
  const [accessKeyInput, setAccessKeyInput] = createSignal<string>('');
  const [setupBusy, setSetupBusy] = createSignal<boolean>(false);
  const [setupNotice, setSetupNotice] = createSignal<string>('');
  const [confirmLeave, setConfirmLeave] = createSignal<boolean>(false);

  const [pairCodeInput, setPairCodeInput] = createSignal<string>('');
  const [showLinkImport, setShowLinkImport] = createSignal<boolean>(false);
  const [pendingJoin, setPendingJoin] = createSignal<{ keyB64: string; inviteToken: string } | null>(null);
  const [joinPinInput, setJoinPinInput] = createSignal<string>('');
  const [createWithPin, setCreateWithPin] = createSignal<boolean>(false);
  const [createPinInput, setCreatePinInput] = createSignal<string>('');

  const [roomPinEnabled, setRoomPinEnabled] = createSignal<boolean>(false);
  const [editingRoomPin, setEditingRoomPin] = createSignal<boolean>(false);
  const [roomPinDraft, setRoomPinDraft] = createSignal<string>('');
  const [pinBusy, setPinBusy] = createSignal<boolean>(false);

  const [inviteCode, setInviteCode] = createSignal<string>('');
  const [inviteToken, setInviteToken] = createSignal<string>('');
  const [inviteExpiresAt, setInviteExpiresAt] = createSignal<number>(0);
  const [inviteSecondsLeft, setInviteSecondsLeft] = createSignal<number>(0);
  const [inviteBusy, setInviteBusy] = createSignal<boolean>(false);

  const [devices, setDevices] = createSignal<PairedDevice[]>([]);
  const [selectedTargets, setSelectedTargets] = createSignal<string[]>([]);
  const [editingDeviceId, setEditingDeviceId] = createSignal<string | null>(null);
  const [editDeviceDraft, setEditDeviceDraft] = createSignal<string>('');

  const [pendingShare, setPendingShare] = createSignal<PendingSharePayload | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<StoredMessage | null>(null);
  const [searchOpen, setSearchOpen] = createSignal<boolean>(false);
  const [searchQuery, setSearchQuery] = createSignal<string>('');
  const [copiedId, setCopiedId] = createSignal<string | null>(null);
  const [swipeState, setSwipeState] = createSignal<{
    id: string;
    offset: number;
    armed: boolean;
    snapping: boolean;
  } | null>(null);

  const [messages, setMessages] = createSignal<StoredMessage[]>([]);
  const [blobUrls, setBlobUrls] = createSignal<Record<string, string>>({});
  const [draft, setDraft] = createSignal<string>('');
  const [burnMs, setBurnMs] = createSignal<number>(0);
  const [nowTick, setNowTick] = createSignal<number>(Date.now());
  const [sending, setSending] = createSignal(false);
  const [wsStatus, setWsStatus] = createSignal<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [autoOpen, setAutoOpen] = createSignal<boolean>(true);
  const [pushEnabled, setPushEnabled] = createSignal<boolean>(false);
  const [pushBusy, setPushBusy] = createSignal<boolean>(false);
  const [qrDataUrl, setQrDataUrl] = createSignal<string>('');
  const [importInput, setImportInput] = createSignal<string>('');
  const [toast, setToast] = createSignal<string>('');
  const [popupWarning, setPopupWarning] = createSignal<string>('');
  const [unreadCount, setUnreadCount] = createSignal<number>(0);
  const [serverVersion, setServerVersion] = createSignal<string | null>(null);
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0';

  let chatEndEl: HTMLDivElement | undefined;
  let fileInputEl: HTMLInputElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;
  let toastTimer: number | undefined;
  let copiedTimer: number | undefined;
  let activeTouch: {
    id: string;
    startX: number;
    startY: number;
    startTime: number;
    swiping: boolean;
    moved: boolean;
  } | null = null;
  let lastSwipeEndTs = 0;
  let lastTouchDuration = 0;

  const isPaired = createMemo(() =>
    Boolean(keyB64() && roomId() && deviceId() && deviceToken()),
  );

  function notify(msg: string, durationMs = 2800) {
    setToast(msg);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(''), durationMs);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatEndEl?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }

  const otherDevices = createMemo(() =>
    devices().filter((d) => d.deviceId !== deviceId()),
  );

  const pairUrl = createMemo(() => {
    const k = keyB64();
    const inv = inviteToken();
    if (!k || !inv) return '';
    return `${window.location.origin}/#key=${encodeURIComponent(k)}&invite=${encodeURIComponent(inv)}`;
  });

  const statusLabel = createMemo(() => {
    if (!isPaired()) return 'Not paired';
    if (wsStatus() === 'connected') return 'Connected';
    if (wsStatus() === 'connecting') return 'Connecting...';
    return 'Offline';
  });

  function authHeaders(did = deviceId(), tok = deviceToken(), extra?: Record<string, string>) {
    return {
      authorization: makeAuthHeader(did, tok),
      ...extra,
    };
  }

  async function handleRevoked(reason: string) {
    setDeviceToken('');
    setKeyB64('');
    setRoomId('');
    setDevices([]);
    setSelectedTargets([]);
    setShowAddDevice(false);
    setInviteToken('');
    setInviteExpiresAt(0);
    setWsStatus('disconnected');
    setSetupNotice(reason);
    await Promise.all([
      kvDelete('deviceToken'),
      kvDelete('keyB64'),
      kvDelete('cachedDevices'),
    ]);
  }

  async function updateBadge(count: number) {
    setUnreadCount(count);
    document.title = count > 0 ? `(${count}) Push It` : 'Push It';
    await kvSet('unreadCount', count);
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (count > 0) {
      await nav.setAppBadge?.(count).catch(() => {});
    } else {
      await nav.clearAppBadge?.().catch(() => {});
    }
  }

  async function ensureBlobHydrated(
    item: StoredMessage,
    rid = roomId(),
    k = keyB64(),
    myId = deviceId(),
    tok = deviceToken(),
  ): Promise<StoredMessage> {
    if (!item.blobId || !item.blobIv || !rid || !k || !myId || !tok) return item;

    let cached = await getBlob(item.blobId);
    if (!cached) {
      try {
        const res = await fetch(
          `/api/room/${encodeURIComponent(rid)}/blob/${encodeURIComponent(item.blobId)}`,
          { headers: authHeaders(myId, tok) },
        );
        if (res.status === 401) {
          await handleRevoked('This device was removed from the room.');
          return item;
        }
        if (!res.ok) return item;
        const cipherBuf = await res.arrayBuffer();
        const plainBytes = await decryptBytes(
          k,
          item.blobIv,
          new Uint8Array(cipherBuf),
          blobAad(rid, item.blobId),
        );
        const copyBuf = new ArrayBuffer(plainBytes.byteLength);
        new Uint8Array(copyBuf).set(plainBytes);
        cached = {
          id: item.blobId,
          data: copyBuf,
          mimeType: item.mimeType || 'application/octet-stream',
          fileName: item.fileName || 'file',
        };
        await saveBlob(cached);
      } catch {
        return item;
      }
    }

    if (item.type === 'longtext') {
      const fullText = new TextDecoder().decode(new Uint8Array(cached.data));
      const updated: StoredMessage = { ...item, type: 'text', content: fullText };
      await saveMessage(updated);
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      return updated;
    }

    if (item.type === 'file' && !blobUrls()[item.blobId]) {
      const url = URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType }));
      setBlobUrls((prev) => ({ ...prev, [item.blobId!]: url }));
    }

    return item;
  }

  async function hydrateExistingBlobs(
    list: StoredMessage[],
    rid: string,
    k: string,
    myId: string,
    tok: string,
  ) {
    for (const m of list) {
      if (m.blobId && m.blobIv) {
        await ensureBlobHydrated(m, rid, k, myId, tok);
      }
    }
  }

  async function updateDeviceRecord(
    rid: string,
    k: string,
    targetDevId: string,
    name: string,
    os: DeviceOs,
    color?: number,
    myId = deviceId(),
    tok = deviceToken(),
  ) {
    if (!rid || !k || !targetDevId || !myId || !tok) return;
    const meta: DeviceMeta = color !== undefined ? { name, os, color } : { name, os };
    const enc = await encryptJson(k, meta, deviceAad(rid, targetDevId));
    const res = await fetch(`/api/room/${encodeURIComponent(rid)}/devices`, {
      method: 'POST',
      headers: authHeaders(myId, tok, { 'content-type': 'application/json' }),
      body: JSON.stringify({ deviceId: targetDevId, iv: enc.iv, ciphertext: enc.ciphertext }),
    }).catch(() => null);
    if (res?.status === 401) {
      await handleRevoked('This device was removed from the room.');
    }
  }

  async function refreshDevices(
    rid = roomId(),
    k = keyB64(),
    myId = deviceId(),
    tok = deviceToken(),
  ): Promise<PairedDevice[]> {
    if (!rid || !k || !myId || !tok) return [];
    try {
      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/devices`, {
        headers: authHeaders(myId, tok),
      });
      if (res.status === 401) {
        await handleRevoked('This device was removed from the room.');
        return [];
      }
      if (!res.ok) return devices();
      const data = (await res.json()) as {
        pinEnabled?: boolean;
        devices: Array<{
          deviceId: string;
          iv: string;
          ciphertext: string;
          updatedAt: number;
          lastSeenAt?: number;
          online: boolean;
        }>;
      };
      if (typeof data.pinEnabled === 'boolean') {
        setRoomPinEnabled(data.pinEnabled);
      }

      const decrypted: PairedDevice[] = [];
      for (const d of data.devices) {
        try {
          const meta = await decryptJson<Partial<DeviceMeta>>(
            k,
            d.iv,
            d.ciphertext,
            deviceAad(rid, d.deviceId),
          );
          const os = normalizeOs(meta.os);
          const name = meta.name ? String(meta.name) : defaultDeviceName(os);
          const color = normalizeDeviceColor(meta.color);
          decrypted.push({
            deviceId: d.deviceId,
            name,
            os,
            color,
            online: d.online,
            updatedAt: d.updatedAt,
            lastSeenAt: d.lastSeenAt || d.updatedAt,
          });
          if (d.deviceId === myId && name !== deviceName()) {
            setDeviceName(name);
            await kvSet('deviceName', name);
          }
        } catch {
          // Ignore devices with another key
        }
      }

      setDevices(decrypted);
      await kvSet('cachedDevices', decrypted).catch(() => {});
      const validIds = new Set(decrypted.map((d) => d.deviceId));
      setSelectedTargets((prev) => prev.filter((id) => validIds.has(id) && id !== myId));
      return decrypted;
    } catch {
      return devices();
    }
  }

  async function syncPending(
    rid = roomId(),
    k = keyB64(),
    myId = deviceId(),
    tok = deviceToken(),
  ) {
    if (!rid || !k || !myId || !tok) return;
    try {
      const since = (await kvGet<number>('lastSeenTs')) || 0;
      const res = await fetch(
        `/api/room/${encodeURIComponent(rid)}/pending?since=${since}`,
        { headers: authHeaders(myId, tok) },
      );
      if (res.status === 401) {
        await handleRevoked('This device was removed from the room.');
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { messages: EncryptedEnvelope[] };
      if (!data.messages?.length) return;

      let maxTs = since;
      for (const env of data.messages) {
        try {
          const decrypted = await decryptEnvelope(k, rid, env);
          let item: StoredMessage = {
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
          const existed = messages().some((m) => m.id === item.id);
          await saveMessage(item);
          addOrUpdateMessage(item);
          item = await ensureBlobHydrated(item, rid, k, myId, tok);
          if (!existed) {
            handleIncomingAction(item);
          }
        } catch {
          // ignore
        }
      }

      if (maxTs > since) {
        await kvSet('lastSeenTs', maxTs);
      }
    } catch {
      // ignore
    }
  }

  async function createNewRoom(devId = deviceId(), devName = deviceName()): Promise<boolean> {
    if (!devId) return false;
    const cleanName = devName.trim() || defaultDeviceName(localOs);
    setDeviceName(cleanName);
    await kvSet('deviceName', cleanName);

    const pin = createWithPin() ? createPinInput().trim() : '';
    if (createWithPin() && !isValidSixDigitCode(pin)) {
      setSetupNotice('Enter a 6-digit PIN or turn off Room PIN protection.');
      return false;
    }

    setSetupBusy(true);
    setSetupNotice('');
    try {
      const freshKey = generateRawKeyB64();
      const [rid, roomAuth] = await Promise.all([
        deriveRoomId(freshKey),
        deriveRoomAuth(freshKey),
      ]);
      const enc = await encryptJson(
        freshKey,
        { name: cleanName, os: localOs } satisfies DeviceMeta,
        deviceAad(rid, devId),
      );
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const pass = accessKeyInput().trim();
      if (pass) headers['x-access-key'] = pass;

      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/init`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deviceId: devId,
          roomAuth,
          roomPin: pin || undefined,
          iv: enc.iv,
          ciphertext: enc.ciphertext,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        deviceToken?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.deviceToken) {
        if (data.code === 'ACCESS_KEY_REQUIRED' || data.code === 'ACCESS_KEY_INVALID') {
          setAccessKeyRequired(true);
        }
        setSetupNotice(data.error || 'Could not create room');
        return false;
      }

      await Promise.all([
        kvSet('keyB64', freshKey),
        kvSet('deviceToken', data.deviceToken),
        clearMessages(),
      ]);
      setMessages([]);
      setBlobUrls({});
      setKeyB64(freshKey);
      setRoomId(rid);
      setDeviceToken(data.deviceToken);
      setRoomPinEnabled(Boolean(pin));
      setCreateWithPin(false);
      setCreatePinInput('');
      setAccessKeyInput('');
      setSetupNotice('');
      setView('chat');
      await refreshDevices(rid, freshKey, devId, data.deviceToken);
      notify(pin ? 'PIN-protected room created!' : 'New private room created!');
      return true;
    } catch {
      setSetupNotice('Could not reach server');
      return false;
    } finally {
      setSetupBusy(false);
    }
  }

  async function joinRoomWithInvite(
    targetKeyB64: string,
    targetInviteToken: string,
    devId = deviceId(),
    devName = deviceName(),
    roomPin?: string,
  ): Promise<boolean> {
    if (!devId) return false;
    const cleanName = devName.trim() || defaultDeviceName(localOs);
    setDeviceName(cleanName);
    await kvSet('deviceName', cleanName);
    setSetupBusy(true);
    setSetupNotice('');
    try {
      const [rid, roomAuth] = await Promise.all([
        deriveRoomId(targetKeyB64),
        deriveRoomAuth(targetKeyB64),
      ]);
      const enc = await encryptJson(
        targetKeyB64,
        { name: cleanName, os: localOs } satisfies DeviceMeta,
        deviceAad(rid, devId),
      );
      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: devId,
          roomAuth,
          inviteToken: targetInviteToken,
          roomPin: roomPin?.trim() || undefined,
          iv: enc.iv,
          ciphertext: enc.ciphertext,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        deviceToken?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.deviceToken) {
        if (data.code === 'ROOM_PIN_REQUIRED' || data.code === 'ROOM_PIN_INVALID') {
          setPendingJoin({ keyB64: targetKeyB64, inviteToken: targetInviteToken });
          setJoinPinInput('');
        }
        const msg = data.error || 'Invite is invalid or expired';
        setSetupNotice(msg);
        notify(msg);
        return false;
      }

      await Promise.all([
        kvSet('keyB64', targetKeyB64),
        kvSet('deviceToken', data.deviceToken),
      ]);
      setKeyB64(targetKeyB64);
      setRoomId(rid);
      setDeviceToken(data.deviceToken);
      setImportInput('');
      setPairCodeInput('');
      setPendingJoin(null);
      setJoinPinInput('');
      setSetupNotice('');
      setShowAddDevice(false);
      setInviteCode('');
      setInviteToken('');
      setInviteExpiresAt(0);
      setView('chat');
      await refreshDevices(rid, targetKeyB64, devId, data.deviceToken);
      await syncPending(rid, targetKeyB64, devId, data.deviceToken);
      notify('Devices paired!');
      return true;
    } catch {
      setSetupNotice('Could not reach server');
      notify('Could not reach server');
      return false;
    } finally {
      setSetupBusy(false);
    }
  }

  async function joinWithSixDigitCode(rawCode: string): Promise<boolean> {
    const code = rawCode.replace(/\D/g, '');
    if (!isValidSixDigitCode(code)) {
      setSetupNotice('Enter all 6 digits of the pairing code');
      return false;
    }
    setSetupBusy(true);
    setSetupNotice('');
    try {
      const codeHash = await hashPairCode(code);
      const res = await fetch('/api/pair/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codeHash }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        roomId?: string;
        inviteToken?: string;
        salt?: string;
        bundleIv?: string;
        bundleCiphertext?: string;
        pinRequired?: boolean;
        error?: string;
      };
      if (
        !res.ok ||
        !data.roomId ||
        !data.inviteToken ||
        !data.salt ||
        !data.bundleIv ||
        !data.bundleCiphertext
      ) {
        const msg = data.error || 'Invalid or expired 6-digit code';
        setSetupNotice(msg);
        setPairCodeInput('');
        return false;
      }

      const decryptedKey = await decryptPairingBundle(
        code,
        data.salt,
        data.bundleIv,
        data.bundleCiphertext,
      );
      const derivedRid = await deriveRoomId(decryptedKey);
      if (derivedRid !== data.roomId) {
        setSetupNotice('Pairing bundle verification failed');
        setPairCodeInput('');
        return false;
      }

      if (data.pinRequired) {
        setPendingJoin({ keyB64: decryptedKey, inviteToken: data.inviteToken });
        setJoinPinInput('');
        setSetupNotice('This room is protected by a 6-digit PIN. Enter it below to pair.');
        return false;
      }

      setSetupBusy(false);
      return await joinRoomWithInvite(decryptedKey, data.inviteToken);
    } catch {
      setSetupNotice('Invalid or expired 6-digit code');
      setPairCodeInput('');
      return false;
    } finally {
      setSetupBusy(false);
    }
  }

  async function createPairingInvite() {
    const rid = roomId();
    const did = deviceId();
    const tok = deviceToken();
    const k = keyB64();
    if (!rid || !did || !tok || !k) return;
    setInviteBusy(true);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = generateSixDigitCode();
        const bundle = await encryptPairingBundle(code, k);
        const res = await fetch(`/api/room/${encodeURIComponent(rid)}/invites`, {
          method: 'POST',
          headers: authHeaders(did, tok, { 'content-type': 'application/json' }),
          body: JSON.stringify(bundle),
        });
        if (res.status === 401) {
          await handleRevoked('This device was removed from the room.');
          return;
        }
        if (res.status === 409) {
          continue; // rare 6-digit collision; retry with a fresh code
        }
        if (!res.ok) {
          notify('Could not create invite');
          return;
        }
        const data = (await res.json()) as { inviteToken: string; expiresAt: number };
        setInviteCode(code);
        setInviteToken(data.inviteToken);
        setInviteExpiresAt(data.expiresAt);
        setInviteSecondsLeft(Math.max(0, Math.ceil((data.expiresAt - Date.now()) / 1000)));
        return;
      }
      notify('Could not create invite');
    } catch {
      notify('Could not create invite');
    } finally {
      setInviteBusy(false);
    }
  }

  async function cancelPairingInvite() {
    const rid = roomId();
    const did = deviceId();
    const tok = deviceToken();
    setShowAddDevice(false);
    setInviteCode('');
    setInviteToken('');
    setInviteExpiresAt(0);
    setInviteSecondsLeft(0);
    setQrDataUrl('');
    if (!rid || !did || !tok) return;
    await fetch(`/api/room/${encodeURIComponent(rid)}/invites`, {
      method: 'DELETE',
      headers: authHeaders(did, tok),
    }).catch(() => {});
  }

  async function saveRoomPin(nextPin: string | null) {
    const rid = roomId();
    const did = deviceId();
    const tok = deviceToken();
    if (!rid || !did || !tok) return;
    if (nextPin !== null && !isValidSixDigitCode(nextPin)) {
      notify('Enter a 6-digit PIN');
      return;
    }
    setPinBusy(true);
    try {
      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/pin`, {
        method: 'POST',
        headers: authHeaders(did, tok, { 'content-type': 'application/json' }),
        body: JSON.stringify({ roomPin: nextPin }),
      });
      if (res.status === 401) {
        await handleRevoked('This device was removed from the room.');
        return;
      }
      if (!res.ok) {
        notify('Could not update room PIN');
        return;
      }
      setRoomPinEnabled(Boolean(nextPin));
      setEditingRoomPin(false);
      setRoomPinDraft('');
      notify(nextPin ? '6-digit Room PIN enabled' : 'Room PIN removed');
    } catch {
      notify('Could not update room PIN');
    } finally {
      setPinBusy(false);
    }
  }

  async function leaveCurrentRoom() {
    const rid = roomId();
    const did = deviceId();
    const tok = deviceToken();
    setConfirmLeave(false);
    if (rid && did && tok) {
      if (pushEnabled()) {
        await unsubscribePush(rid, did, tok).catch(() => {});
        setPushEnabled(false);
      }
      await fetch(`/api/room/${encodeURIComponent(rid)}/devices`, {
        method: 'DELETE',
        headers: authHeaders(did, tok, { 'content-type': 'application/json' }),
        body: JSON.stringify({ deviceId: did }),
      }).catch(() => {});
    }
    await handleRevoked('');
    setView('chat');
    notify('Left room');
  }

  // 1. Bootstrap identity, preferences, SW, and URL hash/share target
  createEffect(
    () => true,
    () => {
      let cancelled = false;

      const onSwMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; item?: StoredMessage } | undefined;
        if (data?.type === 'PUSH_RECEIVED' && data.item) {
          addOrUpdateMessage(data.item);
          ensureBlobHydrated(data.item);
        }
      };

      const onVisibility = () => {
        if (document.visibilityState === 'visible' && isPaired()) {
          updateBadge(0);
          syncPending();
        }
      };

      const onBeforeInstall = (e: Event) => {
        e.preventDefault();
        setInstallPrompt(e as BeforeInstallPromptEvent);
      };

      const onAppInstalled = () => {
        setInstallPrompt(null);
        setStandalone(true);
        notify('Push It installed!');
      };

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', onSwMessage);
      }
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('beforeinstallprompt', onBeforeInstall);
      window.addEventListener('appinstalled', onAppInstalled);

      const expiryTimer = window.setInterval(async () => {
        const now = Date.now();
        setNowTick(now);
        const removed = await pruneExpiredMessages().catch(() => [] as string[]);
        if (removed.length > 0) {
          const removedSet = new Set(removed);
          setMessages((prev) => prev.filter((m) => !removedSet.has(m.id)));
        }
      }, 5000);

      (async () => {
        await registerServiceWorker().catch(() => {});

        fetch('/api/version', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { version?: string; accessKeyRequired?: boolean } | null) => {
            if (d?.version) setServerVersion(d.version);
            if (typeof d?.accessKeyRequired === 'boolean') {
              setAccessKeyRequired(d.accessKeyRequired);
            }
          })
          .catch(() => {});

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

        const existingMsgs = await listMessages();
        const currentSub = await getCurrentPushSubscription().catch(() => null);

        if (cancelled) return;

        setDeviceId(devId);
        setDeviceName(devName);
        setMessages(existingMsgs);
        setPushEnabled(Boolean(currentSub));
        await updateBadge(0);

        const rawHash = window.location.hash;
        if (rawHash && rawHash.includes('key=')) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          const parsedLink = parsePairLink(rawHash);
          if (parsedLink) {
            await joinRoomWithInvite(parsedLink.keyB64, parsedLink.inviteToken, devId, devName);
            setBooting(false);
            scrollToBottom();
            return;
          } else {
            setSetupNotice(
              'That pair link is outdated or incomplete. Ask your other device to generate a new single-use invite link.',
            );
          }
        }

        const storedKey = await kvGet<string>('keyB64');
        const storedToken = await kvGet<string>('deviceToken');

        if (storedKey && storedToken) {
          const rid = await deriveRoomId(storedKey);
          setKeyB64(storedKey);
          setRoomId(rid);
          setDeviceToken(storedToken);
          setBooting(false);
          scrollToBottom();

          const currentDevices = await refreshDevices(rid, storedKey, devId, storedToken);
          if (!deviceToken()) return; // revoked during refreshDevices
          await hydrateExistingBlobs(existingMsgs, rid, storedKey, devId, storedToken);
          await syncPending(rid, storedKey, devId, storedToken);

          // Fallback Android Share Target handler (if SW wasn't controlling yet)
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
              const others = currentDevices.filter((d) => d.deviceId !== devId);
              if (others.length > 1) {
                setPendingShare({ content: payloadText, title: sharedTitle });
              } else {
                const ok = await sendText(payloadText, sharedTitle, {
                  key: storedKey,
                  room: rid,
                  dev: devId,
                  name: devName,
                  token: storedToken,
                  targetIds: undefined,
                  targetNames: undefined,
                  toastOverride:
                    others.length === 1 ? `✓ Sent to ${others[0].name}` : '✓ Pushed to room',
                });
                if (ok) {
                  window.setTimeout(() => window.close(), 1400);
                }
              }
            }
          }
        } else {
          if (storedKey && !storedToken) {
            await kvDelete('keyB64');
            setSetupNotice(
              'Security upgraded: rooms now use per-device credentials and single-use invites. Create a new room or pair with an invite link from another device.',
            );
          }
          setBooting(false);
        }
      })();

      return () => {
        cancelled = true;
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.removeEventListener('message', onSwMessage);
        }
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('beforeinstallprompt', onBeforeInstall);
        window.removeEventListener('appinstalled', onAppInstalled);
        window.clearInterval(expiryTimer);
      };
    },
  );

  // 2. Invite countdown timer + QR code generation
  createEffect(
    () => [view(), showAddDevice(), pairUrl(), inviteExpiresAt()] as const,
    ([activeView, adding, url, expiresAt]) => {
      if (activeView === 'settings') {
        fetch('/api/version', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { version?: string; accessKeyRequired?: boolean } | null) => {
            if (d?.version) setServerVersion(d.version);
            if (typeof d?.accessKeyRequired === 'boolean') {
              setAccessKeyRequired(d.accessKeyRequired);
            }
          })
          .catch(() => {});
      }

      if (activeView !== 'settings' || !adding || !url) {
        setQrDataUrl('');
        return;
      }

      QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: '#0b0f19', light: '#ffffff' },
      })
        .then(setQrDataUrl)
        .catch(() => {});

      const tick = () => {
        const secs = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        setInviteSecondsLeft(secs);
        if (secs <= 0) {
          setInviteToken('');
          setQrDataUrl('');
        }
      };
      tick();
      const timer = window.setInterval(tick, 1000);
      return () => window.clearInterval(timer);
    },
  );

  // 3. Authenticated live WebSocket connection using single-use WS ticket
  createEffect(
    () => [roomId(), deviceId(), keyB64(), deviceToken()] as const,
    ([rid, did, k, tok]) => {
      if (!rid || !did || !k || !tok) {
        setWsStatus('disconnected');
        return;
      }

      let ws: WebSocket | null = null;
      let reconnectTimer: number | undefined;
      let pingTimer: number | undefined;
      let closed = false;

      const connect = async () => {
        if (closed) return;
        setWsStatus('connecting');

        let ticket = '';
        try {
          const ticketRes = await fetch(`/api/room/${encodeURIComponent(rid)}/ws-ticket`, {
            method: 'POST',
            headers: authHeaders(did, tok),
          });
          if (ticketRes.status === 401) {
            await handleRevoked('This device was removed from the room.');
            return;
          }
          if (!ticketRes.ok) {
            throw new Error('Ticket failed');
          }
          const data = (await ticketRes.json()) as { ticket?: string };
          ticket = data.ticket || '';
          if (!ticket) throw new Error('Missing ticket');
        } catch {
          setWsStatus('disconnected');
          if (!closed) {
            reconnectTimer = window.setTimeout(connect, 3000);
          }
          return;
        }

        if (closed) return;

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/room/${encodeURIComponent(rid)}/ws?ticket=${encodeURIComponent(ticket)}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setWsStatus('connected');
          refreshDevices(rid, k, did, tok);
          syncPending(rid, k, did, tok);
          pingTimer = window.setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
          }, 25000);
        };

        ws.onmessage = async (event) => {
          if (typeof event.data !== 'string' || event.data === 'pong') return;
          try {
            const parsed = JSON.parse(event.data) as {
              type?: string;
              ids?: string[];
              joinedDeviceId?: string;
              envelope?: EncryptedEnvelope;
            };
            if (parsed.type === 'devices_updated') {
              await refreshDevices(rid, k, did, tok);
              if (parsed.joinedDeviceId && parsed.joinedDeviceId !== did && showAddDevice()) {
                setShowAddDevice(false);
                setInviteToken('');
                setInviteExpiresAt(0);
                setQrDataUrl('');
                notify('New device paired!');
              }
              return;
            }
            if (parsed.type === 'delivered' && Array.isArray(parsed.ids)) {
              const deliveredSet = new Set(parsed.ids);
              setMessages((prev) =>
                prev.map((m) => (deliveredSet.has(m.id) ? { ...m, status: 'delivered' } : m)),
              );
              await markMessagesDelivered(parsed.ids);
              return;
            }
            if (parsed.type !== 'message' || !parsed.envelope) return;
            if (parsed.envelope.senderId === did) return;

            const decrypted = await decryptEnvelope(k, rid, parsed.envelope);
            let item: StoredMessage = {
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

            await saveMessage(item);
            await kvSet('lastSeenTs', item.ts);
            addOrUpdateMessage(item);
            item = await ensureBlobHydrated(item, rid, k, did, tok);

            if (document.visibilityState !== 'visible') {
              await updateBadge(unreadCount() + 1);
            }

            handleIncomingAction(item);
          } catch {
            // Ignore unreadable messages
          }
        };

        ws.onclose = (ev) => {
          if (pingTimer) window.clearInterval(pingTimer);
          setWsStatus('disconnected');
          if (ev.code === 4001) {
            handleRevoked('This device was removed from the room.');
            return;
          }
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
      return [...prev, item].slice(-500);
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
    } else if (item.type === 'file') {
      notify(`File from ${from}`);
    } else {
      notify(`Message from ${from}`);
    }
  }

  function toggleTarget(id: string) {
    setSelectedTargets((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function getTargetInfo() {
    const chosenIds = selectedTargets();
    const chosenNames =
      chosenIds.length > 0
        ? otherDevices()
            .filter((d) => chosenIds.includes(d.deviceId))
            .map((d) => d.name)
        : undefined;
    return {
      targetIds: chosenIds.length > 0 ? chosenIds : undefined,
      targetNames: chosenNames,
    };
  }

  async function uploadEncryptedBlob(
    rid: string,
    k: string,
    did: string,
    tok: string,
    plainBytes: Uint8Array<ArrayBuffer>,
    targetIds?: string[],
    expiresAt?: number,
  ): Promise<{ blobId: string; blobIv: string }> {
    const blobId = crypto.randomUUID().replace(/-/g, '');
    const { iv: blobIv, ciphertext } = await encryptBytes(
      k,
      plainBytes,
      blobAad(rid, blobId),
    );
    const params = new URLSearchParams();
    if (targetIds && targetIds.length > 0) params.set('targetIds', targetIds.join(','));
    if (expiresAt) params.set('expiresAt', String(expiresAt));
    const qs = params.toString();

    const res = await fetch(
      `/api/room/${encodeURIComponent(rid)}/blob/${encodeURIComponent(blobId)}${qs ? `?${qs}` : ''}`,
      {
        method: 'PUT',
        headers: authHeaders(did, tok, { 'content-type': 'application/octet-stream' }),
        body: ciphertext,
      },
    );

    if (res.status === 401) {
      await handleRevoked('This device was removed from the room.');
      throw new Error('This device was removed from the room');
    }
    if (!res.ok) {
      throw new Error('File too large (max 8 MB)');
    }
    return { blobId, blobIv };
  }

  async function sendText(
    rawText: string,
    title?: string,
    opts?: {
      key?: string;
      room?: string;
      dev?: string;
      name?: string;
      token?: string;
      targetIds?: string[];
      targetNames?: string[];
      toastOverride?: string;
    },
  ): Promise<boolean> {
    const content = rawText.trim();
    const k = opts?.key || keyB64();
    const rid = opts?.room || roomId();
    const did = opts?.dev || deviceId();
    const dName = opts?.name || deviceName();
    const tok = opts?.token || deviceToken();
    if (!content || !k || !rid || !did || !tok) return false;

    const defaults = getTargetInfo();
    const targetIds = opts && 'targetIds' in opts ? opts.targetIds : defaults.targetIds;
    const targetNames = opts && 'targetNames' in opts ? opts.targetNames : defaults.targetNames;
    const expiresAt = burnMs() > 0 ? Date.now() + burnMs() : undefined;

    setSending(true);
    try {
      const isLong = content.length > LONG_TEXT_THRESHOLD;
      let envelope: EncryptedEnvelope;

      if (isLong) {
        const encoded = new TextEncoder().encode(content);
        const buf = new ArrayBuffer(encoded.byteLength);
        new Uint8Array(buf).set(encoded);
        const { blobId, blobIv } = await uploadEncryptedBlob(
          rid,
          k,
          did,
          tok,
          new Uint8Array(buf),
          targetIds,
          expiresAt,
        );
        envelope = await encryptPayload(
          k,
          rid,
          did,
          {
            type: 'longtext',
            content: content.slice(0, 140) + '…',
            title,
            senderName: dName,
            senderOs: localOs,
            targetNames,
            blobId,
            blobIv,
            fileSize: buf.byteLength,
            expiresAt,
          },
          targetIds,
        );
      } else {
        const type = detectPayloadType(content);
        envelope = await encryptPayload(
          k,
          rid,
          did,
          {
            type,
            content,
            title,
            senderName: dName,
            senderOs: localOs,
            targetNames,
            expiresAt,
          },
          targetIds,
        );
      }

      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/send`, {
        method: 'POST',
        headers: authHeaders(did, tok, { 'content-type': 'application/json' }),
        body: JSON.stringify(envelope),
      });

      if (res.status === 401) {
        await handleRevoked('This device was removed from the room.');
        throw new Error('This device was removed from the room');
      }

      if (!res.ok) {
        throw new Error('Could not send right now');
      }

      const result = (await res.json()) as { delivered?: boolean };
      const item: StoredMessage = {
        id: envelope.id,
        senderId: did,
        senderName: dName,
        senderOs: localOs,
        targetNames,
        ts: envelope.ts,
        type: isLong ? 'text' : detectPayloadType(content),
        content,
        title,
        expiresAt,
        direction: 'out',
        status: result.delivered ? 'delivered' : 'queued',
      };

      await saveMessage(item);
      addOrUpdateMessage(item);
      setDraft('');
      notify(opts?.toastOverride || 'Pushed!');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not send');
      return false;
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file: File) {
    const k = keyB64();
    const rid = roomId();
    const did = deviceId();
    const dName = deviceName();
    const tok = deviceToken();
    if (!k || !rid || !did || !tok) return;

    if (file.size > MAX_FILE_BYTES) {
      notify('File is too large (max 7.5 MB)');
      return;
    }

    const { targetIds, targetNames } = getTargetInfo();
    const expiresAt = burnMs() > 0 ? Date.now() + burnMs() : undefined;
    setSending(true);
    try {
      const fileBuf = await file.arrayBuffer();
      const { blobId, blobIv } = await uploadEncryptedBlob(
        rid,
        k,
        did,
        tok,
        new Uint8Array(fileBuf),
        targetIds,
        expiresAt,
      );

      const mimeType = file.type || 'application/octet-stream';
      const fileName = file.name || (mimeType.startsWith('image/') ? 'photo.png' : 'file');

      const envelope = await encryptPayload(
        k,
        rid,
        did,
        {
          type: 'file',
          content: fileName,
          senderName: dName,
          senderOs: localOs,
          targetNames,
          blobId,
          blobIv,
          fileName,
          mimeType,
          fileSize: file.size,
          expiresAt,
        },
        targetIds,
      );

      const res = await fetch(`/api/room/${encodeURIComponent(rid)}/send`, {
        method: 'POST',
        headers: authHeaders(did, tok, { 'content-type': 'application/json' }),
        body: JSON.stringify(envelope),
      });

      if (res.status === 401) {
        await handleRevoked('This device was removed from the room.');
        throw new Error('This device was removed from the room');
      }

      if (!res.ok) {
        throw new Error('Could not send file');
      }

      const result = (await res.json()) as { delivered?: boolean };
      await saveBlob({ id: blobId, data: fileBuf, mimeType, fileName });
      const localUrl = URL.createObjectURL(new Blob([fileBuf], { type: mimeType }));
      setBlobUrls((prev) => ({ ...prev, [blobId]: localUrl }));

      const item: StoredMessage = {
        id: envelope.id,
        senderId: did,
        senderName: dName,
        senderOs: localOs,
        targetNames,
        ts: envelope.ts,
        type: 'file',
        content: fileName,
        blobId,
        blobIv,
        fileName,
        mimeType,
        fileSize: file.size,
        expiresAt,
        direction: 'out',
        status: result.delivered ? 'delivered' : 'queued',
      };

      await saveMessage(item);
      addOrUpdateMessage(item);
      notify('Pushed!');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not send file');
    } finally {
      setSending(false);
    }
  }

  async function handlePendingShareSend(target?: PairedDevice) {
    const share = pendingShare();
    if (!share) return;
    const ok = await sendText(share.content, share.title, {
      targetIds: target ? [target.deviceId] : undefined,
      targetNames: target ? [target.name] : undefined,
      toastOverride: target ? `✓ Sent to ${target.name}` : '✓ Sent to All Devices',
    });
    if (ok) {
      setPendingShare(null);
      window.setTimeout(() => window.close(), 1400);
    }
  }

  function getDeviceColorIndex(senderId?: string, fallback?: string): number {
    if (senderId) {
      const match = devices().find((d) => d.deviceId === senderId);
      if (match?.color !== undefined) return match.color;
    }
    return deviceColorIndex(senderId || fallback);
  }

  async function saveEditedDevice(dev: PairedDevice) {
    const nextName = editDeviceDraft().trim() || defaultDeviceName(dev.os);
    setEditingDeviceId(null);
    if (dev.deviceId === deviceId()) {
      setDeviceName(nextName);
      await kvSet('deviceName', nextName);
    }
    await updateDeviceRecord(roomId(), keyB64(), dev.deviceId, nextName, dev.os, dev.color);
    await refreshDevices();
    notify(`Renamed to "${nextName}"`);
  }

  async function setDeviceColor(dev: PairedDevice, colorIdx: number) {
    setDevices((prev) =>
      prev.map((d) => (d.deviceId === dev.deviceId ? { ...d, color: colorIdx } : d)),
    );
    await updateDeviceRecord(roomId(), keyB64(), dev.deviceId, dev.name, dev.os, colorIdx);
    await refreshDevices();
    const label = DEVICE_COLOR_OPTIONS.find((c) => c.index === colorIdx)?.name || 'Color';
    notify(`${dev.name} color set to ${label}`);
  }

  async function removeDevice(dev: PairedDevice) {
    const res = await fetch(`/api/room/${encodeURIComponent(roomId())}/devices`, {
      method: 'DELETE',
      headers: authHeaders(deviceId(), deviceToken(), { 'content-type': 'application/json' }),
      body: JSON.stringify({ deviceId: dev.deviceId }),
    }).catch(() => null);
    if (res?.status === 401) {
      await handleRevoked('This device was removed from the room.');
      return;
    }
    await refreshDevices();
    notify(`Removed "${dev.name}"`);
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
    const tok = deviceToken();
    if (!rid || !did || !tok) return;

    setPushBusy(true);
    try {
      if (pushEnabled()) {
        await unsubscribePush(rid, did, tok);
        setPushEnabled(false);
        notify('Notifications turned off');
      } else {
        await subscribePush(rid, did, tok);
        setPushEnabled(true);
        notify('Notifications turned on');
      }
    } catch {
      notify('Notifications are not supported in this browser');
    } finally {
      setPushBusy(false);
    }
  }

  async function handleImportInvite() {
    const parsed = parsePairLink(importInput());
    if (!parsed) {
      notify('Paste a valid single-use invite link from another device');
      return;
    }
    await joinRoomWithInvite(parsed.keyB64, parsed.inviteToken);
  }

  async function copyToClipboard(text: string, label = 'Copied', msgId?: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(label);
      if (msgId) {
        setCopiedId(msgId);
        if (copiedTimer) window.clearTimeout(copiedTimer);
        copiedTimer = window.setTimeout(() => setCopiedId(null), 1600);
      }
    } catch {
      notify('Could not copy');
    }
  }

  const filteredMessages = createMemo(() => {
    const q = searchQuery().trim().toLowerCase();
    if (!q) return messages();
    return messages().filter((m) => {
      const haystack = [
        m.content,
        m.title,
        m.fileName,
        m.senderName,
        ...(m.targetNames || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  async function confirmDeleteMessage() {
    const target = pendingDelete();
    if (!target) return;
    setPendingDelete(null);
    await deleteMessage(target.id, target.blobId).catch(() => {});
    if (target.blobId) {
      const existingUrl = blobUrls()[target.blobId];
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
        setBlobUrls((prev) => {
          const next = { ...prev };
          delete next[target.blobId!];
          return next;
        });
      }
    }
    setMessages((prev) => prev.filter((m) => m.id !== target.id));
    notify('Message deleted');
  }

  function handleBubbleTouchStart(msg: StoredMessage, e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    activeTouch = {
      id: msg.id,
      startX: t.clientX,
      startY: t.clientY,
      startTime: Date.now(),
      swiping: false,
      moved: false,
    };
  }

  function handleBubbleTouchMove(msg: StoredMessage, e: TouchEvent) {
    if (!activeTouch || activeTouch.id !== msg.id || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - activeTouch.startX;
    const dy = t.clientY - activeTouch.startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      activeTouch.moved = true;
    }
    // Start horizontal left swipe only if clearly swiping left (never fight vertical scroll or text selection)
    if (!activeTouch.swiping) {
      if (dx < -14 && Math.abs(dx) > Math.abs(dy) * 1.4 && !window.getSelection()?.toString()) {
        activeTouch.swiping = true;
      } else {
        return;
      }
    }
    const clamped = Math.max(-116, Math.min(0, dx));
    setSwipeState({
      id: msg.id,
      offset: clamped,
      armed: clamped <= -72,
      snapping: false,
    });
  }

  function handleBubbleTouchEnd(msg: StoredMessage) {
    if (!activeTouch || activeTouch.id !== msg.id) return;
    lastTouchDuration = Date.now() - activeTouch.startTime;
    const wasSwiping = activeTouch.swiping;
    activeTouch = null;

    if (wasSwiping) {
      lastSwipeEndTs = Date.now();
      const cur = swipeState();
      const shouldAskDelete = Boolean(cur && cur.id === msg.id && cur.armed);
      setSwipeState({ id: msg.id, offset: 0, armed: false, snapping: true });
      window.setTimeout(() => {
        if (swipeState()?.id === msg.id) setSwipeState(null);
      }, 200);
      if (shouldAskDelete) {
        setPendingDelete(msg);
      }
    }
  }

  function handleBubbleClick(msg: StoredMessage, e: MouseEvent) {
    if (msg.type === 'file') return;
    if (Date.now() - lastSwipeEndTs < 350) return;
    // If user held down to select text (>= 320ms) or has text selected, don't override selection
    if (lastTouchDuration >= 320) {
      lastTouchDuration = 0;
      return;
    }
    lastTouchDuration = 0;
    const selection = window.getSelection()?.toString().trim();
    if (selection) return;
    const targetEl = e.target as HTMLElement | null;
    if (targetEl?.closest('a, button, input, textarea')) return;
    copyToClipboard(msg.content, 'Copied to clipboard', msg.id);
  }

  async function triggerInstall() {
    const promptEv = installPrompt();
    if (!promptEv) return;
    await promptEv.prompt();
    const choice = await promptEv.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
    if (choice.outcome === 'accepted') {
      setInstallPrompt(null);
    }
  }

  async function shareInviteLink() {
    const url = pairUrl();
    if (!url || !canWebShare) return;
    try {
      await navigator.share({
        title: 'Push It — Single-Use Invite',
        text: 'Open this single-use link to pair your device with Push It:',
        url,
      });
    } catch {
      // user cancelled share sheet
    }
  }

  return (
    <div
      class="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!isPaired()) return;
        const file = e.dataTransfer?.files?.[0];
        if (file) sendFile(file);
      }}
    >
      <header class="topbar">
        <div class="brand">
          <img src="/icon.svg" alt="" class="logo" />
          <div>
            <h1>Push It</h1>
            <div class="status-row">
              <span class={`dot ${isPaired() ? wsStatus() : 'disconnected'}`} />
              <span>{statusLabel()}</span>
            </div>
          </div>
        </div>

        <Show when={isPaired()}>
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
                class={`icon-toggle-btn ${searchOpen() ? 'active' : ''}`}
                title="Search messages"
                aria-label="Search messages"
                onClick={() => {
                  const next = !searchOpen();
                  setSearchOpen(next);
                  if (!next) {
                    setSearchQuery('');
                  } else {
                    requestAnimationFrame(() => searchInputEl?.focus());
                  }
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              </button>
              <button
                class="device-pill"
                title="Manage devices"
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
        </Show>
      </header>

      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>

      <Show when={popupWarning() && view() === 'chat' && isPaired()}>
        <div class="banner warning">{popupWarning()}</div>
      </Show>

      <Show when={pendingDelete()}>
        {(target) => (
          <div class="modal-backdrop" onClick={() => setPendingDelete(null)}>
            <div class="confirm-modal" onClick={(e) => e.stopPropagation()}>
              <h2>Delete this message?</h2>
              <div class="share-preview">
                <div class="share-preview-body">
                  {target().type === 'file'
                    ? target().fileName || target().content
                    : target().content.slice(0, 160)}
                </div>
              </div>
              <p class="muted">This removes the message from this device.</p>
              <div class="row gap">
                <button class="btn danger" onClick={confirmDeleteMessage}>
                  Delete
                </button>
                <button class="btn secondary" onClick={() => setPendingDelete(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={pendingShare()}>
        {(share) => (
          <div class="modal-backdrop">
            <div class="share-modal">
              <h2>Send with Push It</h2>
              <p class="muted">Choose a device or send to everyone in the room.</p>
              <div class="share-preview">
                <Show when={share().title}>
                  <div class="share-preview-title">{share().title}</div>
                </Show>
                <div class="share-preview-body">{share().content.slice(0, 220)}</div>
              </div>
              <div class="share-dest-list">
                <button
                  class="share-dest-btn all"
                  disabled={sending()}
                  onClick={() => handlePendingShareSend(undefined)}
                >
                  <span class="share-dest-main">
                    <strong>All Devices (Room)</strong>
                    <span class="muted">{otherDevices().length} devices</span>
                  </span>
                  <span>→</span>
                </button>
                <For each={otherDevices()}>
                  {(dev) => (
                    <button
                      class="share-dest-btn"
                      disabled={sending()}
                      onClick={() => handlePendingShareSend(dev)}
                    >
                      <span class="share-dest-main">
                        <span class="device-info">
                          <span class={`dot ${dev.online ? 'connected' : 'disconnected'}`} />
                          <OsIcon os={dev.os} size={15} />
                          <strong>{dev.name}</strong>
                        </span>
                        <span class="muted">{dev.online ? 'Online' : 'Offline'}</span>
                      </span>
                      <span>→</span>
                    </button>
                  )}
                </For>
              </div>
              <button
                class="btn secondary"
                onClick={() => {
                  setPendingShare(null);
                  window.close();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>

      <Show
        when={!booting()}
        fallback={
          <main class="setup-page">
            <div class="empty">Loading…</div>
          </main>
        }
      >
        <Show
          when={isPaired()}
          fallback={
            <main class="setup-page">
              <div class="setup-hero">
                <h2>Private Device Sync</h2>
                <p class="muted">
                  Only devices paired together with a single-use invite can access your room.
                </p>
              </div>

              <Show when={setupNotice()}>
                <div class="banner warning">{setupNotice()}</div>
              </Show>

              <section class="card">
                <h2>This Device</h2>
                <div class="setup-name-row">
                  <span class="setup-name-badge">
                    <OsIcon os={localOs} size={18} />
                  </span>
                  <input
                    class="setup-input"
                    type="text"
                    maxlength={24}
                    placeholder={defaultDeviceName(localOs)}
                    value={deviceName()}
                    onInput={(e) => setDeviceName(e.currentTarget.value)}
                  />
                </div>
              </section>

              <section class="card">
                <h2>Join an Existing Room</h2>
                <Show
                  when={pendingJoin()}
                  fallback={
                    <>
                      <p class="muted">
                        Open Push It on another device → Settings → <strong>+ Add Device</strong>, then enter the 6-digit pairing code (or scan its QR code).
                      </p>
                      <DigitCodeInput
                        value={pairCodeInput()}
                        onChange={setPairCodeInput}
                        onComplete={(code) => joinWithSixDigitCode(code)}
                        disabled={setupBusy()}
                        ariaLabel="6-digit pairing code"
                      />
                      <button
                        class="btn primary"
                        disabled={setupBusy() || pairCodeInput().length !== 6}
                        onClick={() => joinWithSixDigitCode(pairCodeInput())}
                      >
                        {setupBusy() ? 'Pairing...' : 'Join with Code'}
                      </button>

                      <button
                        class="setup-toggle-link"
                        type="button"
                        onClick={() => setShowLinkImport((v) => !v)}
                      >
                        {showLinkImport() ? 'Hide invite link input' : 'Or paste an invite link'}
                      </button>

                      <Show when={showLinkImport()}>
                        <form
                          class="import-row"
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleImportInvite();
                          }}
                        >
                          <input
                            type="text"
                            placeholder="Paste single-use invite link..."
                            value={importInput()}
                            onInput={(e) => setImportInput(e.currentTarget.value)}
                          />
                          <button
                            class="btn secondary"
                            type="submit"
                            disabled={setupBusy() || !importInput().trim()}
                          >
                            {setupBusy() ? '...' : 'Join'}
                          </button>
                        </form>
                      </Show>
                    </>
                  }
                >
                  {(pending) => (
                    <div class="pin-box">
                      <p class="muted">
                        This room is protected by a <strong>6-digit Room PIN</strong>. Enter the PIN to finish pairing.
                      </p>
                      <DigitCodeInput
                        value={joinPinInput()}
                        onChange={setJoinPinInput}
                        onComplete={(pin) =>
                          joinRoomWithInvite(
                            pending().keyB64,
                            pending().inviteToken,
                            deviceId(),
                            deviceName(),
                            pin,
                          )
                        }
                        disabled={setupBusy()}
                        ariaLabel="6-digit room PIN"
                      />
                      <div class="row gap">
                        <button
                          class="btn primary"
                          disabled={setupBusy() || joinPinInput().length !== 6}
                          onClick={() =>
                            joinRoomWithInvite(
                              pending().keyB64,
                              pending().inviteToken,
                              deviceId(),
                              deviceName(),
                              joinPinInput(),
                            )
                          }
                        >
                          {setupBusy() ? 'Verifying...' : 'Verify PIN & Join'}
                        </button>
                        <button
                          class="btn secondary"
                          type="button"
                          onClick={() => {
                            setPendingJoin(null);
                            setJoinPinInput('');
                            setSetupNotice('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
              </section>

              <section class="card">
                <h2>Start a New Room</h2>
                <p class="muted">
                  Setting up your first device? Create a fresh encrypted room and invite your other devices with a 6-digit code or QR.
                </p>

                <label class="toggle">
                  <div>
                    <strong>Protect room with a 6-digit PIN</strong>
                    <span class="muted">Optional extra code required whenever pairing a new device</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={createWithPin()}
                    onChange={(e) => {
                      setCreateWithPin(e.currentTarget.checked);
                      if (!e.currentTarget.checked) setCreatePinInput('');
                    }}
                  />
                </label>

                <Show when={createWithPin()}>
                  <DigitCodeInput
                    value={createPinInput()}
                    onChange={setCreatePinInput}
                    disabled={setupBusy()}
                    ariaLabel="New room 6-digit PIN"
                  />
                </Show>

                <Show when={accessKeyRequired()}>
                  <input
                    class="setup-input"
                    type="text"
                    inputmode="numeric"
                    placeholder="Server access code"
                    value={accessKeyInput()}
                    onInput={(e) => setAccessKeyInput(e.currentTarget.value)}
                  />
                </Show>

                <button
                  class="btn secondary"
                  disabled={
                    setupBusy() ||
                    (accessKeyRequired() && !accessKeyInput().trim()) ||
                    (createWithPin() && createPinInput().length !== 6)
                  }
                  onClick={() => createNewRoom()}
                >
                  {setupBusy() ? 'Creating...' : 'Create New Room'}
                </button>
              </section>

              <div class="version-footer">
                <span>Version v{appVersion}</span>
              </div>
            </main>
          }
        >
          <Show
            when={view() === 'chat'}
            fallback={
              <main class="settings-page">
                <section class="card">
                  <div class="row between">
                    <h2>Devices ({devices().length})</h2>
                    <button
                      class="btn primary small"
                      disabled={inviteBusy()}
                      onClick={() => {
                        if (showAddDevice()) {
                          cancelPairingInvite();
                        } else {
                          setShowAddDevice(true);
                          createPairingInvite();
                        }
                      }}
                    >
                      {showAddDevice() ? 'Cancel Invite' : '+ Add Device'}
                    </button>
                  </div>

                  <div class="device-list">
                    <For each={devices()}>
                      {(dev) => {
                        const isSelf = dev.deviceId === deviceId();
                        return (
                          <div class="device-row">
                            <Show
                              when={editingDeviceId() !== dev.deviceId}
                              fallback={
                                <form
                                  class="import-row full-width"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    saveEditedDevice(dev);
                                  }}
                                >
                                  <input
                                    type="text"
                                    maxlength={24}
                                    value={editDeviceDraft()}
                                    onInput={(e) => setEditDeviceDraft(e.currentTarget.value)}
                                    autofocus
                                  />
                                  <button class="btn primary small" type="submit">
                                    Save
                                  </button>
                                  <button
                                    class="btn secondary small"
                                    type="button"
                                    onClick={() => setEditingDeviceId(null)}
                                  >
                                    Cancel
                                  </button>
                                </form>
                              }
                            >
                              <div class="device-row-main">
                                <div class="device-info">
                                  <span
                                    class={`dot ${dev.online || isSelf ? 'connected' : 'disconnected'}`}
                                  />
                                  <OsIcon os={dev.os} size={15} />
                                  <div class="device-meta-col">
                                    <div class="device-name-line">
                                      <span class="device-name">{dev.name}</span>
                                      <Show when={isSelf}>
                                        <span class="self-tag">This device</span>
                                      </Show>
                                    </div>
                                    <span class="device-activity">
                                      {dev.online || isSelf
                                        ? 'Online'
                                        : formatRelativeTime(dev.lastSeenAt || dev.updatedAt)}
                                    </span>
                                  </div>
                                </div>
                                <div class="row gap">
                                  <button
                                    class="chip"
                                    onClick={() => {
                                      setEditingDeviceId(dev.deviceId);
                                      setEditDeviceDraft(dev.name);
                                    }}
                                  >
                                    Rename
                                  </button>
                                  <Show when={!isSelf}>
                                    <button class="chip danger" onClick={() => removeDevice(dev)}>
                                      Remove
                                    </button>
                                  </Show>
                                </div>
                              </div>
                              <div class="device-color-row" role="group" aria-label={`Chat color for ${dev.name}`}>
                                <span class="device-color-label">Chat color:</span>
                                <div class="color-swatches">
                                  <For each={DEVICE_COLOR_OPTIONS}>
                                    {(opt) => {
                                      const activeColor = () =>
                                        dev.color ?? deviceColorIndex(dev.deviceId);
                                      return (
                                        <button
                                          type="button"
                                          class={`color-swatch ${activeColor() === opt.index ? 'active' : ''}`}
                                          style={{ '--swatch': opt.swatch }}
                                          title={opt.name}
                                          aria-label={`${opt.name} color`}
                                          aria-pressed={activeColor() === opt.index ? 'true' : 'false'}
                                          onClick={() => setDeviceColor(dev, opt.index)}
                                        />
                                      );
                                    }}
                                  </For>
                                </div>
                              </div>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>

                  <Show when={showAddDevice()}>
                    <div class="divider" />
                    <Show
                      when={pairUrl()}
                      fallback={
                        <div class="invite-expired">
                          <p class="muted">
                            {inviteBusy()
                              ? 'Generating single-use invite...'
                              : 'This invite expired. Generate a new one to pair a device.'}
                          </p>
                          <Show when={!inviteBusy()}>
                            <button
                              class="btn primary small"
                              onClick={() => createPairingInvite()}
                            >
                              Generate New Invite
                            </button>
                          </Show>
                        </div>
                      }
                    >
                      <div class="row between">
                        <span class="muted">Enter this 6-digit code or scan the QR on your other device.</span>
                        <span class="invite-timer">
                          Single-use · {formatCountdown(inviteSecondsLeft())}
                        </span>
                      </div>
                      <Show when={inviteCode()}>
                        <div class="pair-code-display">
                          <span class="pair-code-digits">
                            {inviteCode().slice(0, 3)} – {inviteCode().slice(3)}
                          </span>
                          <button
                            class="btn secondary small"
                            onClick={() => copyToClipboard(inviteCode(), '6-digit code copied')}
                          >
                            Copy Code
                          </button>
                        </div>
                      </Show>
                      <Show when={qrDataUrl()}>
                        <div class="qr-wrap">
                          <img src={qrDataUrl()} alt="Pairing QR Code" class="qr-img" />
                        </div>
                      </Show>
                      <div class="row gap">
                        <button
                          class="btn primary"
                          onClick={() => copyToClipboard(pairUrl(), 'Invite link copied')}
                        >
                          Copy Invite Link
                        </button>
                        <Show when={canWebShare}>
                          <button class="btn secondary" onClick={shareInviteLink}>
                            Share
                          </button>
                        </Show>
                        <button
                          class="btn secondary"
                          disabled={inviteBusy()}
                          onClick={() => createPairingInvite()}
                        >
                          Regenerate
                        </button>
                      </div>
                    </Show>
                  </Show>
                </section>

                <Show when={!standalone() && (installPrompt() || isIos)}>
                  <section class="card">
                    <div class="row between">
                      <div>
                        <strong>{isIos ? 'Add to Home Screen' : 'Install Push It App'}</strong>
                        <span class="muted">
                          {isIos
                            ? 'Unlocks background notifications and full-screen app mode on iOS/iPadOS.'
                            : 'Install as an app for instant access and native Share menu integration.'}
                        </span>
                      </div>
                      <Show when={installPrompt()}>
                        <button class="btn primary small" onClick={triggerInstall}>
                          Install
                        </button>
                      </Show>
                    </div>
                    <Show when={isIos}>
                      <ol class="steps-list">
                        <li>
                          Tap Safari’s <strong>Share</strong> icon (square with arrow).
                        </li>
                        <li>
                          Tap <strong>Add to Home Screen</strong>, then open Push It from your Home Screen.
                        </li>
                      </ol>
                    </Show>
                  </section>
                </Show>

                <Show when={isIos}>
                  <section class="card">
                    <div class="row between">
                      <div>
                        <strong>iOS Share Sheet Shortcut</strong>
                        <span class="muted">
                          Share links from any iPhone/iPad app directly into Push It with the same device picker &amp; toast.
                        </span>
                      </div>
                      <button
                        class="btn secondary small"
                        onClick={() =>
                          copyToClipboard(
                            `${window.location.origin}/share?url=`,
                            'Share URL copied',
                          )
                        }
                      >
                        Copy URL
                      </button>
                    </div>
                    <ol class="steps-list">
                      <li>
                        Open Apple <strong>Shortcuts</strong> → <strong>+</strong> → enable <strong>Show in Share Sheet</strong> (URLs &amp; Text).
                      </li>
                      <li>
                        Add <strong>URL Encode</strong> (Shortcut Input), then <strong>Open URLs</strong> with:
                      </li>
                    </ol>
                    <div class="code-chip">
                      {`${window.location.origin}/share?url=`}[URL Encoded Text]
                    </div>
                  </section>
                </Show>

                <section class="card">
                  <h2>Preferences</h2>
                  <label class="toggle">
                    <div>
                      <strong>Auto-open links</strong>
                      <span class="muted">
                        Open incoming links automatically while this tab is open
                      </span>
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
                          : isIos && !standalone()
                            ? 'Add to Home Screen first to enable notifications'
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

                  <div class="divider" />

                  <div class="toggle">
                    <div>
                      <strong>Room PIN</strong>
                      <span class="muted">
                        {roomPinEnabled()
                          ? 'Protected · 6-digit PIN required to pair new devices'
                          : 'Optional extra 6-digit code when pairing new devices'}
                      </span>
                    </div>
                    <button
                      class={`btn small ${roomPinEnabled() ? 'success' : 'secondary'}`}
                      disabled={pinBusy()}
                      onClick={() => {
                        setEditingRoomPin((v) => !v);
                        setRoomPinDraft('');
                      }}
                    >
                      {editingRoomPin() ? 'Close' : roomPinEnabled() ? 'Change' : 'Set PIN'}
                    </button>
                  </div>

                  <Show when={editingRoomPin()}>
                    <div class="pin-box">
                      <DigitCodeInput
                        value={roomPinDraft()}
                        onChange={setRoomPinDraft}
                        disabled={pinBusy()}
                        ariaLabel="Set 6-digit room PIN"
                      />
                      <div class="row gap">
                        <button
                          class="btn primary small"
                          disabled={pinBusy() || roomPinDraft().length !== 6}
                          onClick={() => saveRoomPin(roomPinDraft())}
                        >
                          {pinBusy() ? '...' : 'Save 6-Digit PIN'}
                        </button>
                        <Show when={roomPinEnabled()}>
                          <button
                            class="chip danger"
                            disabled={pinBusy()}
                            onClick={() => saveRoomPin(null)}
                          >
                            Remove PIN
                          </button>
                        </Show>
                      </div>
                    </div>
                  </Show>
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
                        setBlobUrls({});
                        notify('History cleared');
                      }}
                    >
                      Clear
                    </button>
                  </div>

                  <div class="divider" />

                  <div class="row between">
                    <div>
                      <strong>Room Membership</strong>
                      <span class="muted">Revoke this device from the room</span>
                    </div>
                    <Show
                      when={confirmLeave()}
                      fallback={
                        <button
                          class="chip danger"
                          onClick={() => setConfirmLeave(true)}
                        >
                          Leave Room
                        </button>
                      }
                    >
                      <div class="row gap">
                        <button class="chip danger" onClick={leaveCurrentRoom}>
                          Confirm Leave
                        </button>
                        <button class="chip" onClick={() => setConfirmLeave(false)}>
                          Cancel
                        </button>
                      </div>
                    </Show>
                  </div>
                </section>

                <div class="version-footer">
                  <span>Version v{appVersion}</span>
                  <Show when={isNewerVersion(serverVersion(), appVersion)}>
                    <button
                      class="chip primary"
                      onClick={() => window.location.reload()}
                    >
                      v{serverVersion()} available · Refresh
                    </button>
                  </Show>
                </div>
              </main>
            }
          >
            <Show when={devices().length === 1}>
              <div class="solo-banner">
                <span>Only this device is in this room</span>
                <button
                  class="btn primary small"
                  onClick={() => {
                    setView('settings');
                    setShowAddDevice(true);
                    createPairingInvite();
                  }}
                >
                  + Add Device
                </button>
              </div>
            </Show>

            <Show when={searchOpen()}>
              <div class="search-bar">
                <div class="search-input-wrap">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                  <input
                    ref={searchInputEl}
                    type="search"
                    placeholder="Search messages, links, files, or device..."
                    value={searchQuery()}
                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setSearchQuery('');
                        setSearchOpen(false);
                      }
                    }}
                  />
                  <Show when={searchQuery()}>
                    <span class="search-count">
                      {filteredMessages().length}/{messages().length}
                    </span>
                  </Show>
                </div>
                <button
                  class="btn secondary small"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchOpen(false);
                  }}
                >
                  Close
                </button>
              </div>
            </Show>

            <main class="chat-stream">
              <For
                each={filteredMessages()}
                fallback={
                  <div class="empty">
                    <Show
                      when={searchQuery().trim()}
                      fallback={
                        <>
                          <p>Nothing pushed yet.</p>
                          <p class="muted">
                            Send a link, note, or photo below—or share straight from your phone’s Share menu.
                          </p>
                        </>
                      }
                    >
                      <p>No messages matching “{searchQuery().trim()}”.</p>
                    </Show>
                  </div>
                }
              >
                {(msg) => {
                  const os = msg.senderOs ?? (msg.direction === 'out' ? localOs : 'other');
                  const label =
                    msg.senderName || (msg.direction === 'out' ? deviceName() : 'Other device');
                  const targetLabel =
                    msg.targetNames && msg.targetNames.length > 0
                      ? ` → ${msg.targetNames.join(', ')}`
                      : '';
                  const colorIdx = () => getDeviceColorIndex(msg.senderId, label);
                  const isLink = msg.type === 'link' && isSafeHttpUrl(msg.content);
                  const isFile = msg.type === 'file';
                  const isImage = isFile && Boolean(msg.mimeType?.startsWith('image/'));
                  const fileUrl = () => (msg.blobId ? blobUrls()[msg.blobId] : undefined);
                  const swipe = () => {
                    const s = swipeState();
                    return s && s.id === msg.id ? s : null;
                  };

                  return (
                    <div
                      class="swipe-row"
                      onTouchStart={(e) => handleBubbleTouchStart(msg, e)}
                      onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                      onTouchEnd={() => handleBubbleTouchEnd(msg)}
                      onTouchCancel={() => handleBubbleTouchEnd(msg)}
                    >
                      <div
                        class={`swipe-delete-bg ${swipe() && swipe()!.offset < -10 ? 'visible' : ''} ${swipe()?.armed ? 'armed' : ''}`}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        </svg>
                        <span>{swipe()?.armed ? 'Release to delete' : 'Swipe to delete'}</span>
                      </div>
                      <div
                        class={`swipe-content ${msg.direction} ${swipe()?.snapping ? 'snapping' : ''}`}
                        style={{
                          transform: swipe() ? `translateX(${swipe()!.offset}px)` : undefined,
                        }}
                      >
                        <article
                          class={`bubble ${msg.direction} dev-c${colorIdx()} ${!isFile ? 'tappable' : ''}`}
                          onClick={(e) => handleBubbleClick(msg, e)}
                        >
                          <div class="bubble-head">
                            <span class="sender-tag">
                              <OsIcon os={os} size={13} />
                              <span>
                                {label}
                                {targetLabel}
                              </span>
                            </span>
                            <span class="meta-right">
                              <Show when={msg.expiresAt && nowTick() < msg.expiresAt}>
                                <span class="burn-badge" title="Auto-expires">
                                  🔥 {formatRemainingTime(msg.expiresAt)}
                                </span>
                              </Show>
                              <time>
                                {new Date(msg.ts).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </time>
                              <Show when={msg.direction === 'out'}>
                                <span
                                  class={`check ${msg.status === 'delivered' ? 'delivered' : ''}`}
                                  title={msg.status === 'delivered' ? 'Delivered' : 'Queued'}
                                >
                                  {msg.status === 'delivered' ? '✓✓' : '✓'}
                                </span>
                              </Show>
                            </span>
                          </div>

                          <Show when={msg.title}>
                            <div class="bubble-title">{msg.title}</div>
                          </Show>

                          <div class="bubble-body">
                            {isFile ? (
                              <div class="file-card">
                                <Show when={isImage && fileUrl()}>
                                  <a href={fileUrl()} target="_blank" rel="noopener noreferrer">
                                    <img
                                      src={fileUrl()}
                                      alt={msg.fileName || 'Photo'}
                                      class="photo-preview"
                                    />
                                  </a>
                                </Show>
                                <div class="file-meta">
                                  <span class="file-name">{msg.fileName || msg.content}</span>
                                  <Show when={msg.fileSize}>
                                    <span class="muted">{formatFileSize(msg.fileSize)}</span>
                                  </Show>
                                </div>
                              </div>
                            ) : isLink ? (
                              <a href={msg.content} target="_blank" rel="noopener noreferrer">
                                {msg.content}
                              </a>
                            ) : (
                              <pre>{msg.content}</pre>
                            )}
                          </div>

                          <div class="bubble-actions">
                            <div class="bubble-actions-left">
                              <Show when={isLink}>
                                <a
                                  class="icon-chip primary"
                                  href={msg.content}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Open link"
                                  aria-label="Open link"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <LucideIcon icon={ExternalLink} size={15} />
                                </a>
                              </Show>
                              <Show when={isFile && fileUrl()}>
                                <a
                                  class="icon-chip primary"
                                  href={fileUrl()}
                                  download={msg.fileName || 'file'}
                                  title="Download file"
                                  aria-label="Download file"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <LucideIcon icon={Download} size={15} />
                                </a>
                              </Show>
                              <Show when={!isFile}>
                                <button
                                  class="icon-chip"
                                  title={copiedId() === msg.id ? 'Copied' : 'Copy to clipboard'}
                                  aria-label={copiedId() === msg.id ? 'Copied' : 'Copy to clipboard'}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyToClipboard(msg.content, 'Copied to clipboard', msg.id);
                                  }}
                                >
                                  <Show
                                    when={copiedId() === msg.id}
                                    fallback={<LucideIcon icon={Copy} size={15} />}
                                  >
                                    <LucideIcon icon={Check} size={15} />
                                  </Show>
                                </button>
                              </Show>
                            </div>
                            <div class="bubble-actions-right">
                              <button
                                class="icon-chip danger"
                                title="Delete message"
                                aria-label="Delete message"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingDelete(msg);
                                }}
                              >
                                <LucideIcon icon={Trash2} size={15} />
                              </button>
                            </div>
                          </div>
                        </article>
                      </div>
                    </div>
                  );
                }}
              </For>
              <div ref={chatEndEl} />
            </main>

            <Show when={otherDevices().length > 1}>
              <div class="target-bar">
                <span class="target-label">To:</span>
                <button
                  class={`target-pill ${selectedTargets().length === 0 ? 'active' : ''}`}
                  onClick={() => setSelectedTargets([])}
                >
                  All
                </button>
                <For each={otherDevices()}>
                  {(dev) => (
                    <button
                      class={`target-pill ${selectedTargets().includes(dev.deviceId) ? 'active' : ''}`}
                      onClick={() => toggleTarget(dev.deviceId)}
                    >
                      <OsIcon os={dev.os} size={12} />
                      <span>{dev.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <footer class="composer-wrap">
              <div class="composer-meta-row">
                <label class={`burn-control ${burnMs() > 0 ? 'active' : ''}`}>
                  <span>{burnMs() > 0 ? '🔥 Auto-burn next message:' : '⏱ Auto-burn:'}</span>
                  <select
                    class="burn-select"
                    value={String(burnMs())}
                    disabled={sending()}
                    onChange={(e) => setBurnMs(Number(e.currentTarget.value))}
                  >
                    <For each={BURN_OPTIONS}>
                      {(opt) => <option value={String(opt.ms)}>{opt.label}</option>}
                    </For>
                  </select>
                </label>
              </div>
              <div class="composer-bar">
              <input
                ref={fileInputEl}
                type="file"
                class="hidden-file"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) sendFile(file);
                  e.currentTarget.value = '';
                }}
              />
              <button
                class="btn secondary icon-btn"
                title="Attach photo or file"
                disabled={sending()}
                onClick={() => fileInputEl?.click()}
              >
                +
              </button>
              <textarea
                rows={1}
                placeholder="Paste a link, note, or screenshot..."
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onPaste={(e) => {
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  for (const item of items) {
                    if (item.kind === 'file') {
                      const file = item.getAsFile();
                      if (file) {
                        e.preventDefault();
                        sendFile(file);
                        return;
                      }
                    }
                  }
                }}
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
              </div>
            </footer>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
