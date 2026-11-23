const TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;

export function detectOs() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Macintosh|Mac OS X/i.test(ua) && touchPoints > 1) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

export function defaultDeviceName(os) {
  switch (os) {
    case 'android':
      return 'Android';
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'macOS';
    case 'ios':
      return 'iOS';
    case 'linux':
      return 'Linux';
    default:
      return 'Device';
  }
}

export function normalizeOs(value) {
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

export const DEVICE_COLOR_COUNT = 8;

export function deviceColorIndex(deviceId) {
  const s = String(deviceId || 'default');
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % DEVICE_COLOR_COUNT;
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function isValidKeyB64(keyB64) {
  try {
    return fromBase64Url(keyB64.trim()).length === 32;
  } catch {
    return false;
  }
}

export function generateRawKeyB64() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function isValidInviteToken(token) {
  return TOKEN_RE.test(String(token || '').trim());
}

export function isSafeServerOrigin(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'https:') return true;
    if (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function makeAuthHeader(deviceId, deviceToken) {
  return `Bearer ${deviceId}.${deviceToken}`;
}

export function messageAad(roomId, envelopeId, senderId) {
  return `push-it-msg-v2:${roomId}:${envelopeId}:${senderId}`;
}

export function deviceAad(roomId, deviceId) {
  return `push-it-dev-v2:${roomId}:${deviceId}`;
}

export function blobAad(roomId, blobId) {
  return `push-it-blob-v2:${roomId}:${blobId}`;
}

export async function deriveRoomId(keyB64) {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

export async function deriveRoomAuth(keyB64) {
  const data = new TextEncoder().encode(`push-it-auth-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash);
}

export async function importAesKey(keyB64) {
  const raw = fromBase64Url(keyB64);
  if (raw.length !== 32) throw new Error('Key must be 256 bits');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(keyB64, plainBytes, aad) {
  const key = await importAesKey(keyB64);
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

export async function decryptBytes(keyB64, ivB64, cipherBytes, aad) {
  const key = await importAesKey(keyB64);
  const iv = fromBase64Url(ivB64);
  const algo = aad
    ? { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }
    : { name: 'AES-GCM', iv };
  const plainBuf = await crypto.subtle.decrypt(algo, key, cipherBytes);
  return new Uint8Array(plainBuf);
}

export async function encryptJson(keyB64, value, aad) {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const { iv, ciphertext } = await encryptBytes(keyB64, plain, aad);
  return { iv, ciphertext: toBase64Url(ciphertext) };
}

export async function decryptJson(keyB64, ivB64, ciphertextB64, aad) {
  const plain = await decryptBytes(keyB64, ivB64, fromBase64Url(ciphertextB64), aad);
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function encryptPayload(keyB64, roomId, senderId, payload, targetIds) {
  const id = crypto.randomUUID();
  const { iv, ciphertext } = await encryptJson(
    keyB64,
    payload,
    messageAad(roomId, id, senderId),
  );
  return {
    id,
    senderId,
    targetIds: targetIds && targetIds.length > 0 ? targetIds : undefined,
    iv,
    ciphertext,
    ts: Date.now(),
    expiresAt: payload.expiresAt,
  };
}

export async function decryptEnvelope(keyB64, roomId, envelope) {
  const parsed = await decryptJson(
    keyB64,
    envelope.iv,
    envelope.ciphertext,
    messageAad(roomId, envelope.id, envelope.senderId),
  );
  const type =
    parsed.type === 'link' || parsed.type === 'file' || parsed.type === 'longtext'
      ? parsed.type
      : 'text';
  return {
    type,
    content: String(parsed.content ?? ''),
    title: parsed.title ? String(parsed.title) : undefined,
    senderName: parsed.senderName ? String(parsed.senderName) : undefined,
    senderOs: parsed.senderOs ? normalizeOs(parsed.senderOs) : undefined,
    targetNames: Array.isArray(parsed.targetNames)
      ? parsed.targetNames.map((n) => String(n))
      : undefined,
    blobId: parsed.blobId ? String(parsed.blobId) : undefined,
    blobIv: parsed.blobIv ? String(parsed.blobIv) : undefined,
    fileName: parsed.fileName ? String(parsed.fileName) : undefined,
    mimeType: parsed.mimeType ? String(parsed.mimeType) : undefined,
    fileSize: typeof parsed.fileSize === 'number' ? parsed.fileSize : undefined,
    expiresAt:
      typeof parsed.expiresAt === 'number'
        ? parsed.expiresAt
        : typeof envelope.expiresAt === 'number'
          ? envelope.expiresAt
          : undefined,
  };
}

export function isSafeHttpUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function detectPayloadType(input) {
  const trimmed = String(input).trim();
  if (!trimmed.includes('\n') && !trimmed.includes(' ') && isSafeHttpUrl(trimmed)) {
    return 'link';
  }
  return 'text';
}

export function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(ts) {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Active just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Active ${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Active ${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `Active ${diffDay}d ago`;
}

export function formatRemainingTime(expiresAt) {
  if (!expiresAt) return '';
  const remSec = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  if (remSec <= 0) return 'Expired';
  if (remSec < 60) return `${remSec}s`;
  const remMin = Math.ceil(remSec / 60);
  if (remMin < 60) return `${remMin}m`;
  const remHr = Math.ceil(remMin / 60);
  return `${remHr}h`;
}

export function isValidSixDigitCode(code) {
  return /^\d{6}$/.test(String(code || '').trim());
}

export function generateSixDigitCode() {
  const maxValid = 4294000000;
  const arr = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(arr);
    if (arr[0] < maxValid) {
      return String(arr[0] % 1_000_000).padStart(6, '0');
    }
  }
}

export async function hashPairCode(code) {
  const data = new TextEncoder().encode(`pair-code:${String(code).trim()}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash);
}

async function derivePairWrappingKey(code, saltBytes) {
  const rawCode = new TextEncoder().encode(String(code).trim());
  const baseKey = await crypto.subtle.importKey('raw', rawCode, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptPairingBundle(pairCode, keyB64) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const ivBytes = new Uint8Array(12);
  crypto.getRandomValues(ivBytes);
  const [codeHash, wrapKey] = await Promise.all([
    hashPairCode(pairCode),
    derivePairWrappingKey(pairCode, saltBytes),
  ]);
  const plain = new TextEncoder().encode(JSON.stringify({ keyB64 }));
  const aad = new TextEncoder().encode('push-it-pair-bundle-v1');
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: aad },
    wrapKey,
    plain,
  );
  return {
    codeHash,
    salt: toBase64Url(saltBytes),
    bundleIv: toBase64Url(ivBytes),
    bundleCiphertext: toBase64Url(new Uint8Array(cipherBuf)),
  };
}

export async function decryptPairingBundle(pairCode, saltB64, bundleIvB64, bundleCiphertextB64) {
  const saltBytes = fromBase64Url(saltB64);
  const ivBytes = fromBase64Url(bundleIvB64);
  const cipherBytes = fromBase64Url(bundleCiphertextB64);
  const wrapKey = await derivePairWrappingKey(pairCode, saltBytes);
  const aad = new TextEncoder().encode('push-it-pair-bundle-v1');
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, additionalData: aad },
    wrapKey,
    cipherBytes,
  );
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
  if (!parsed.keyB64 || !isValidKeyB64(parsed.keyB64)) {
    throw new Error('Invalid pairing bundle');
  }
  return parsed.keyB64;
}
