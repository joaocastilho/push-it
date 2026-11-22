export function detectOs() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
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

export async function deriveRoomId(keyB64) {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

export async function importAesKey(keyB64) {
  const raw = fromBase64Url(keyB64);
  if (raw.length !== 32) throw new Error('Key must be 256 bits');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(keyB64, plainBytes) {
  const key = await importAesKey(keyB64);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  return {
    iv: toBase64Url(iv),
    ciphertext: new Uint8Array(cipherBuf),
  };
}

export async function decryptBytes(keyB64, ivB64, cipherBytes) {
  const key = await importAesKey(keyB64);
  const iv = fromBase64Url(ivB64);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
  return new Uint8Array(plainBuf);
}

export async function encryptJson(keyB64, value) {
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const { iv, ciphertext } = await encryptBytes(keyB64, plain);
  return { iv, ciphertext: toBase64Url(ciphertext) };
}

export async function decryptJson(keyB64, ivB64, ciphertextB64) {
  const plain = await decryptBytes(keyB64, ivB64, fromBase64Url(ciphertextB64));
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function encryptPayload(keyB64, senderId, payload, targetIds) {
  const { iv, ciphertext } = await encryptJson(keyB64, payload);
  return {
    id: crypto.randomUUID(),
    senderId,
    targetIds: targetIds && targetIds.length > 0 ? targetIds : undefined,
    iv,
    ciphertext,
    ts: Date.now(),
  };
}

export async function decryptEnvelope(keyB64, envelope) {
  const parsed = await decryptJson(keyB64, envelope.iv, envelope.ciphertext);
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
