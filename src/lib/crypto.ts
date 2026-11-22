export interface DecryptedPayload {
  type: 'link' | 'text';
  content: string;
  title?: string;
}

export interface EncryptedEnvelope {
  id: string;
  senderId: string;
  iv: string;
  ciphertext: string;
  ts: number;
}

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

export async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyB64);
  if (raw.length !== 32) {
    throw new Error('Key must be 256 bits (32 bytes)');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Derives a one-way roomId from the symmetric key so the server can route
 * messages without ever knowing or being able to recover the encryption key.
 */
export async function deriveRoomId(keyB64: string): Promise<string> {
  const data = new TextEncoder().encode(`push-it-room-v1:${keyB64}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash).slice(0, 24);
}

export async function encryptPayload(
  keyB64: string,
  senderId: string,
  payload: DecryptedPayload,
): Promise<EncryptedEnvelope> {
  const key = await importAesKey(keyB64);
  const ivBuf = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuf);
  crypto.getRandomValues(iv);

  const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);

  return {
    id: crypto.randomUUID(),
    senderId,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(cipherBuf)),
    ts: Date.now(),
  };
}

export async function decryptEnvelope(
  keyB64: string,
  envelope: EncryptedEnvelope,
): Promise<DecryptedPayload> {
  const key = await importAesKey(keyB64);
  const iv = fromBase64Url(envelope.iv);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf)) as Partial<DecryptedPayload>;
  return {
    type: parsed.type === 'link' ? 'link' : 'text',
    content: String(parsed.content ?? ''),
    title: parsed.title ? String(parsed.title) : undefined,
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
