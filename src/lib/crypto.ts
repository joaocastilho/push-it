import { normalizeOs, type DeviceOs } from './device';

export type PayloadType = 'link' | 'text' | 'longtext' | 'file';

export interface DecryptedPayload {
  type: PayloadType;
  content: string;
  title?: string;
  senderName?: string;
  senderOs?: DeviceOs;
  targetNames?: string[];
  blobId?: string;
  blobIv?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface EncryptedEnvelope {
  id: string;
  senderId: string;
  targetIds?: string[];
  iv: string;
  ciphertext: string;
  ts: number;
}

export interface DeviceMeta {
  name: string;
  os: DeviceOs;
}

export interface ParsedPairLink {
  origin?: string;
  keyB64: string;
  inviteToken: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const std = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function generateRawKeyB64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function isValidKeyB64(keyB64: string): boolean {
  try {
    return fromBase64Url(keyB64.trim()).length === 32;
  } catch {
    return false;
  }
}

export function isValidInviteToken(token: string): boolean {
  return TOKEN_RE.test(token.trim());
}

export function parsePairLink(rawInput: string): ParsedPairLink | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  let origin: string | undefined;
  let hashStr = '';

  if (trimmed.includes('#')) {
    try {
      const parsed = new URL(trimmed);
      origin = parsed.origin;
      hashStr = parsed.hash.replace(/^#/, '');
    } catch {
      hashStr = trimmed.slice(trimmed.indexOf('#') + 1);
    }
  } else {
    hashStr = trimmed;
  }

  const params = new URLSearchParams(hashStr);
  const keyB64 = params.get('key')?.trim() || '';
  const inviteToken = params.get('invite')?.trim() || '';
  if (!isValidKeyB64(keyB64) || !isValidInviteToken(inviteToken)) {
    return null;
  }
  return { origin, keyB64, inviteToken };
}

export function makeAuthHeader(deviceId: string, deviceToken: string): string {
  return `Bearer ${deviceId}.${deviceToken}`;
}

export function messageAad(roomId: string, envelopeId: string, senderId: string): string {
  return `push-it-msg-v2:${roomId}:${envelopeId}:${senderId}`;
}

export function deviceAad(roomId: string, deviceId: string): string {
  return `push-it-dev-v2:${roomId}:${deviceId}`;
}

export function blobAad(roomId: string, blobId: string): string {
  return `push-it-blob-v2:${roomId}:${blobId}`;
}

export async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyB64);
  if (raw.length !== 32) {
    throw new Error('Key must be 256 bits (32 bytes)');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function deriveRoomId(keyB64: string): Promise<string> {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

export async function deriveRoomAuth(keyB64: string): Promise<string> {
  const data = new TextEncoder().encode(`push-it-auth-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash);
}

function encodeAad(aad?: string): Uint8Array<ArrayBuffer> | undefined {
  if (!aad) return undefined;
  const encoded = new TextEncoder().encode(aad);
  const buf = new ArrayBuffer(encoded.byteLength);
  const out = new Uint8Array(buf);
  out.set(encoded);
  return out;
}

export async function encryptBytes(
  keyB64: string,
  plainBytes: Uint8Array<ArrayBuffer>,
  aad?: string,
): Promise<{ iv: string; ciphertext: Uint8Array<ArrayBuffer> }> {
  const key = await importAesKey(keyB64);
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);
  const additionalData = encodeAad(aad);
  const algo: AesGcmParams = additionalData
    ? { name: 'AES-GCM', iv, additionalData }
    : { name: 'AES-GCM', iv };
  const cipherBuf = await crypto.subtle.encrypt(algo, key, plainBytes);
  return {
    iv: toBase64Url(iv),
    ciphertext: new Uint8Array(cipherBuf),
  };
}

export async function decryptBytes(
  keyB64: string,
  ivB64: string,
  cipherBytes: Uint8Array<ArrayBuffer>,
  aad?: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await importAesKey(keyB64);
  const iv = fromBase64Url(ivB64);
  const additionalData = encodeAad(aad);
  const algo: AesGcmParams = additionalData
    ? { name: 'AES-GCM', iv, additionalData }
    : { name: 'AES-GCM', iv };
  const plainBuf = await crypto.subtle.decrypt(algo, key, cipherBytes);
  return new Uint8Array(plainBuf);
}

export async function encryptJson(
  keyB64: string,
  value: unknown,
  aad?: string,
): Promise<{ iv: string; ciphertext: string }> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  const { iv, ciphertext } = await encryptBytes(keyB64, new Uint8Array(buf), aad);
  return { iv, ciphertext: toBase64Url(ciphertext) };
}

export async function decryptJson<T>(
  keyB64: string,
  ivB64: string,
  ciphertextB64: string,
  aad?: string,
): Promise<T> {
  const plain = await decryptBytes(keyB64, ivB64, fromBase64Url(ciphertextB64), aad);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function encryptPayload(
  keyB64: string,
  roomId: string,
  senderId: string,
  payload: DecryptedPayload,
  targetIds?: string[],
): Promise<EncryptedEnvelope> {
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
  };
}

export async function decryptEnvelope(
  keyB64: string,
  roomId: string,
  envelope: EncryptedEnvelope,
): Promise<DecryptedPayload> {
  const parsed = await decryptJson<Partial<DecryptedPayload>>(
    keyB64,
    envelope.iv,
    envelope.ciphertext,
    messageAad(roomId, envelope.id, envelope.senderId),
  );
  const type: PayloadType =
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

export function isSafeHttpUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function detectPayloadType(input: string): 'link' | 'text' {
  const trimmed = input.trim();
  if (!trimmed.includes('\n') && !trimmed.includes(' ') && isSafeHttpUrl(trimmed)) {
    return 'link';
  }
  return 'text';
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
