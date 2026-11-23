import { DurableObject } from 'cloudflare:workers';
import {
  buildPushPayload,
  type PushSubscription,
  type VapidKeys,
} from '@block65/webcrypto-web-push';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDO>;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ACCESS_KEY?: string;
}

export interface EncryptedEnvelope {
  id: string;
  senderId: string;
  targetIds?: string[];
  iv: string;
  ciphertext: string;
  ts: number;
}

interface RoomMeta {
  version: 2;
  roomAuthHash: string;
  createdAt: number;
}

interface StoredInvite {
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredWsTicket {
  deviceId: string;
  expiresAt: number;
}

interface StoredSubscription {
  deviceId: string;
  subscription: PushSubscription;
  updatedAt: number;
}

interface StoredDevice {
  deviceId: string;
  tokenHash?: string;
  iv: string;
  ciphertext: string;
  createdAt?: number;
  updatedAt: number;
}

interface StoredMessage {
  envelope: EncryptedEnvelope;
  remaining: string[];
}

interface StoredVapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface AuthContext {
  deviceId: string;
  device: StoredDevice;
  meta: RoomMeta;
}

const ROOM_META_KEY = 'room:meta';
const INVITE_KEY = 'invite:active';
const WSTICKET_PREFIX = 'wsticket:';
const SUB_PREFIX = 'sub:';
const DEV_PREFIX = 'dev:';
const MSG_PREFIX = 'msg:';
const VAPID_STORAGE_KEY = 'vapid:keys';

const MAX_TTL_SECONDS = 2419200; // 28 days (Web Push / FCM max)
const MESSAGE_TTL_MS = MAX_TTL_SECONDS * 1000;
const INVITE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const WS_TICKET_TTL_MS = 30 * 1000; // 30 seconds
const MAX_PENDING_MESSAGES = 200;
const MAX_BLOB_BYTES = 8 * 1024 * 1024; // 8 MB encrypted blob limit
const BLOB_CHUNK_SIZE = 512 * 1024; // 512 KB per SQLite row
const JOIN_FAIL_WINDOW_MS = 60 * 1000;
const MAX_JOIN_FAILS_PER_WINDOW = 8;

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;

export const VAPID_DO_NAME = '__vapid__';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(numBytes = 32): string {
  const bytes = new Uint8Array(numBytes);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256B64(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return toBase64Url(hash);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

async function generateVapidKeys(subject: string): Promise<StoredVapidKeys> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const rawPub = new Uint8Array(
    (await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer,
  );
  const jwkPriv = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;

  return {
    publicKey: toBase64Url(rawPub),
    privateKey: jwkPriv.d!,
    subject,
  };
}

function unauthorizedResponse(message = 'Unauthorized'): Response {
  return Response.json({ error: message, code: 'UNAUTHORIZED' }, { status: 401 });
}

export class RoomDO extends DurableObject<Env> {
  private cachedVapid: StoredVapidKeys | null = null;
  private sqlReady = false;
  private joinFailTimestamps: number[] = [];

  private ensureBlobTable(): void {
    if (this.sqlReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        data BLOB NOT NULL,
        ts INTEGER NOT NULL,
        sender_id TEXT NOT NULL DEFAULT '',
        remaining TEXT NOT NULL,
        PRIMARY KEY (id, chunk_index)
      )
    `);
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE blobs ADD COLUMN sender_id TEXT NOT NULL DEFAULT ''",
      );
    } catch {
      // Column already exists
    }
    this.sqlReady = true;
  }

  private async authenticateRequest(request: Request): Promise<AuthContext | null> {
    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    const raw = authHeader.slice('Bearer '.length).trim();
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;

    const deviceId = raw.slice(0, dot);
    const deviceToken = raw.slice(dot + 1);
    if (!DEVICE_ID_RE.test(deviceId) || !TOKEN_RE.test(deviceToken)) return null;

    const [meta, device] = await Promise.all([
      this.ctx.storage.get<RoomMeta>(ROOM_META_KEY),
      this.ctx.storage.get<StoredDevice>(`${DEV_PREFIX}${deviceId}`),
    ]);

    if (!meta || !device || !device.tokenHash) return null;

    const candidateHash = await sha256B64(deviceToken);
    if (!timingSafeEqualStr(candidateHash, device.tokenHash)) return null;

    return { deviceId, device, meta };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/internal/vapid-keys' && request.method === 'GET') {
      const keys = await this.getOrCreateOwnVapidKeys();
      return Response.json(keys);
    }

    if (path.endsWith('/init') && request.method === 'POST') {
      return this.handleInit(request);
    }

    if (path.endsWith('/join') && request.method === 'POST') {
      return this.handleJoin(request);
    }

    if (path.endsWith('/ws')) {
      return this.handleWebSocket(request, url);
    }

    // All remaining endpoints require an authenticated paired device
    const auth = await this.authenticateRequest(request);
    if (!auth) {
      return unauthorizedResponse();
    }

    if (path.endsWith('/invites') && request.method === 'POST') {
      return this.handleCreateInvite(auth);
    }

    if (path.endsWith('/invites') && request.method === 'DELETE') {
      return this.handleDeleteInvite();
    }

    if (path.endsWith('/ws-ticket') && request.method === 'POST') {
      return this.handleWsTicket(auth);
    }

    if (path.endsWith('/vapid-public-key') && request.method === 'GET') {
      const vapid = await this.resolveVapidKeys();
      return Response.json({ publicKey: vapid.publicKey });
    }

    if (path.endsWith('/send') && request.method === 'POST') {
      return this.handleSend(request, auth);
    }

    if (path.endsWith('/ack') && request.method === 'POST') {
      return this.handleAck(request, auth);
    }

    if (path.endsWith('/pending') && request.method === 'GET') {
      return this.handlePending(url, auth);
    }

    const blobMatch = path.match(/\/blob\/([A-Za-z0-9_-]{8,64})$/);
    if (blobMatch) {
      const blobId = blobMatch[1];
      if (request.method === 'PUT') {
        return this.handleUploadBlob(request, url, blobId, auth);
      }
      if (request.method === 'GET') {
        return this.handleDownloadBlob(blobId, auth);
      }
    }

    if (path.endsWith('/devices') && request.method === 'GET') {
      return this.handleListDevices();
    }

    if (path.endsWith('/devices') && request.method === 'POST') {
      return this.handleUpdateDevice(request, auth);
    }

    if (path.endsWith('/devices') && request.method === 'DELETE') {
      return this.handleDeleteDevice(request, auth);
    }

    if (path.endsWith('/subscribe') && request.method === 'POST') {
      return this.handleSubscribe(request, auth);
    }

    if (path.endsWith('/subscribe') && request.method === 'DELETE') {
      return this.handleUnsubscribe(auth);
    }

    if (path.endsWith('/status') && request.method === 'GET') {
      return this.handleStatus();
    }

    return new Response('Not Found', { status: 404 });
  }

  private async getOrCreateOwnVapidKeys(): Promise<StoredVapidKeys> {
    if (this.cachedVapid) return this.cachedVapid;

    let keys = await this.ctx.storage.get<StoredVapidKeys>(VAPID_STORAGE_KEY);
    if (!keys) {
      const subject = this.env.VAPID_SUBJECT || 'mailto:push-it@workers.dev';
      keys = await generateVapidKeys(subject);
      await this.ctx.storage.put(VAPID_STORAGE_KEY, keys);
    }
    this.cachedVapid = keys;
    return keys;
  }

  private async resolveVapidKeys(): Promise<VapidKeys> {
    if (this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY) {
      return {
        publicKey: this.env.VAPID_PUBLIC_KEY,
        privateKey: this.env.VAPID_PRIVATE_KEY,
        subject: this.env.VAPID_SUBJECT || 'mailto:push-it@workers.dev',
      };
    }

    if (this.cachedVapid) return this.cachedVapid;

    const vapidStub = this.env.ROOMS.get(this.env.ROOMS.idFromName(VAPID_DO_NAME));
    const res = await vapidStub.fetch('https://internal/internal/vapid-keys');
    const keys = (await res.json()) as StoredVapidKeys;
    this.cachedVapid = keys;
    return keys;
  }

  private broadcastJson(payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore dead sockets
      }
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const requiredAccessKey = this.env.ACCESS_KEY?.trim();
    if (requiredAccessKey) {
      const provided = (request.headers.get('x-access-key') || '').trim();
      if (!provided) {
        return Response.json(
          { error: 'Server passphrase required', code: 'ACCESS_KEY_REQUIRED' },
          { status: 403 },
        );
      }
      const [providedHash, expectedHash] = await Promise.all([
        sha256B64(provided),
        sha256B64(requiredAccessKey),
      ]);
      if (!timingSafeEqualStr(providedHash, expectedHash)) {
        return Response.json(
          { error: 'Invalid server passphrase', code: 'ACCESS_KEY_INVALID' },
          { status: 403 },
        );
      }
    }

    const [existingMeta, existingDevices] = await Promise.all([
      this.ctx.storage.get<RoomMeta>(ROOM_META_KEY),
      this.ctx.storage.list<StoredDevice>({ prefix: DEV_PREFIX, limit: 1 }),
    ]);

    if (existingMeta || existingDevices.size > 0) {
      return Response.json(
        {
          error: 'Room already exists. Use a pairing invite from an existing device.',
          code: 'ROOM_EXISTS',
        },
        { status: 409 },
      );
    }

    let body: {
      deviceId?: string;
      roomAuth?: string;
      iv?: string;
      ciphertext?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (
      !body.deviceId ||
      !DEVICE_ID_RE.test(body.deviceId) ||
      !body.roomAuth ||
      !TOKEN_RE.test(body.roomAuth) ||
      !body.iv ||
      !body.ciphertext ||
      body.ciphertext.length > 1000
    ) {
      return Response.json({ error: 'Invalid room initialization payload' }, { status: 400 });
    }

    const now = Date.now();
    const deviceToken = randomToken(32);
    const [roomAuthHash, tokenHash] = await Promise.all([
      sha256B64(body.roomAuth),
      sha256B64(deviceToken),
    ]);

    const meta: RoomMeta = {
      version: 2,
      roomAuthHash,
      createdAt: now,
    };

    const record: StoredDevice = {
      deviceId: body.deviceId,
      tokenHash,
      iv: body.iv,
      ciphertext: body.ciphertext,
      createdAt: now,
      updatedAt: now,
    };

    await Promise.all([
      this.ctx.storage.put(ROOM_META_KEY, meta),
      this.ctx.storage.put(`${DEV_PREFIX}${body.deviceId}`, record),
    ]);

    return Response.json({ ok: true, deviceToken });
  }

  private async handleCreateInvite(auth: AuthContext): Promise<Response> {
    const now = Date.now();
    const inviteToken = randomToken(24);
    const expiresAt = now + INVITE_TTL_MS;
    const invite: StoredInvite = {
      tokenHash: await sha256B64(inviteToken),
      createdBy: auth.deviceId,
      createdAt: now,
      expiresAt,
    };

    await this.ctx.storage.put(INVITE_KEY, invite);
    return Response.json({ ok: true, inviteToken, expiresAt });
  }

  private async handleDeleteInvite(): Promise<Response> {
    await this.ctx.storage.delete(INVITE_KEY);
    return Response.json({ ok: true });
  }

  private recordJoinFailure(now: number): void {
    this.joinFailTimestamps = this.joinFailTimestamps.filter(
      (ts) => now - ts < JOIN_FAIL_WINDOW_MS,
    );
    this.joinFailTimestamps.push(now);
  }

  private async handleJoin(request: Request): Promise<Response> {
    const now = Date.now();
    this.joinFailTimestamps = this.joinFailTimestamps.filter(
      (ts) => now - ts < JOIN_FAIL_WINDOW_MS,
    );
    if (this.joinFailTimestamps.length >= MAX_JOIN_FAILS_PER_WINDOW) {
      return Response.json(
        { error: 'Too many pairing attempts. Try again shortly.', code: 'RATE_LIMITED' },
        { status: 429 },
      );
    }

    let body: {
      deviceId?: string;
      roomAuth?: string;
      inviteToken?: string;
      iv?: string;
      ciphertext?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (
      !body.deviceId ||
      !DEVICE_ID_RE.test(body.deviceId) ||
      !body.roomAuth ||
      !TOKEN_RE.test(body.roomAuth) ||
      !body.inviteToken ||
      !TOKEN_RE.test(body.inviteToken) ||
      !body.iv ||
      !body.ciphertext ||
      body.ciphertext.length > 1000
    ) {
      this.recordJoinFailure(now);
      return Response.json({ error: 'Invalid pairing request', code: 'INVITE_INVALID' }, { status: 400 });
    }

    const [meta, invite] = await Promise.all([
      this.ctx.storage.get<RoomMeta>(ROOM_META_KEY),
      this.ctx.storage.get<StoredInvite>(INVITE_KEY),
    ]);

    if (!meta || !invite) {
      this.recordJoinFailure(now);
      return Response.json(
        { error: 'Pairing invite is invalid or already used', code: 'INVITE_INVALID' },
        { status: 403 },
      );
    }

    if (invite.expiresAt <= now) {
      await this.ctx.storage.delete(INVITE_KEY);
      this.recordJoinFailure(now);
      return Response.json(
        { error: 'Pairing invite has expired. Generate a new one.', code: 'INVITE_EXPIRED' },
        { status: 403 },
      );
    }

    const [roomAuthHash, inviteHash] = await Promise.all([
      sha256B64(body.roomAuth),
      sha256B64(body.inviteToken),
    ]);

    if (
      !timingSafeEqualStr(roomAuthHash, meta.roomAuthHash) ||
      !timingSafeEqualStr(inviteHash, invite.tokenHash)
    ) {
      this.recordJoinFailure(now);
      return Response.json(
        { error: 'Pairing invite is invalid', code: 'INVITE_INVALID' },
        { status: 403 },
      );
    }

    // Consume the single-use invite immediately
    await this.ctx.storage.delete(INVITE_KEY);

    const deviceToken = randomToken(32);
    const tokenHash = await sha256B64(deviceToken);
    const record: StoredDevice = {
      deviceId: body.deviceId,
      tokenHash,
      iv: body.iv,
      ciphertext: body.ciphertext,
      createdAt: now,
      updatedAt: now,
    };

    await this.ctx.storage.put(`${DEV_PREFIX}${body.deviceId}`, record);
    this.broadcastJson({ type: 'devices_updated', joinedDeviceId: body.deviceId });

    return Response.json({ ok: true, deviceToken });
  }

  private async handleWsTicket(auth: AuthContext): Promise<Response> {
    const now = Date.now();
    const existing = await this.ctx.storage.list<StoredWsTicket>({ prefix: WSTICKET_PREFIX });
    const expiredKeys: string[] = [];
    for (const [k, v] of existing) {
      if (v.expiresAt <= now) expiredKeys.push(k);
    }
    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
    }

    const ticket = randomToken(24);
    const ticketHash = await sha256B64(ticket);
    await this.ctx.storage.put<StoredWsTicket>(`${WSTICKET_PREFIX}${ticketHash}`, {
      deviceId: auth.deviceId,
      expiresAt: now + WS_TICKET_TTL_MS,
    });

    return Response.json({ ok: true, ticket });
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const ticket = url.searchParams.get('ticket') || '';
    if (!TOKEN_RE.test(ticket)) {
      return unauthorizedResponse('Missing WebSocket ticket');
    }

    const ticketKey = `${WSTICKET_PREFIX}${await sha256B64(ticket)}`;
    const stored = await this.ctx.storage.get<StoredWsTicket>(ticketKey);
    if (!stored) {
      return unauthorizedResponse('Invalid WebSocket ticket');
    }

    // Single-use ticket
    await this.ctx.storage.delete(ticketKey);

    if (stored.expiresAt <= Date.now()) {
      return unauthorizedResponse('Expired WebSocket ticket');
    }

    // Ensure device is still registered and not revoked
    const device = await this.ctx.storage.get<StoredDevice>(`${DEV_PREFIX}${stored.deviceId}`);
    if (!device || !device.tokenHash) {
      return unauthorizedResponse('Device revoked');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [stored.deviceId]);
    this.broadcastJson({ type: 'devices_updated' });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (message === 'ping') {
      ws.send('pong');
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    this.broadcastJson({ type: 'devices_updated' });
  }

  private async handleUploadBlob(
    request: Request,
    url: URL,
    blobId: string,
    auth: AuthContext,
  ): Promise<Response> {
    this.ensureBlobTable();
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_BLOB_BYTES) {
      return Response.json({ error: 'File must be between 1 byte and 8 MB' }, { status: 413 });
    }

    const now = Date.now();
    // Prune expired blobs first
    this.ctx.storage.sql.exec('DELETE FROM blobs WHERE ts < ?', now - MESSAGE_TTL_MS);

    // Prevent overwriting an existing active blob
    const existing = this.ctx.storage.sql
      .exec('SELECT 1 FROM blobs WHERE id = ? LIMIT 1', blobId)
      .toArray();
    if (existing.length > 0) {
      return Response.json({ error: 'Blob already exists' }, { status: 409 });
    }

    const senderId = auth.deviceId;
    const targetParam = url.searchParams.get('targetIds') || '';
    const targetIds = targetParam ? targetParam.split(',').filter(Boolean) : [];
    const targetSet = targetIds.length > 0 ? new Set(targetIds) : null;

    const allDevices = await this.ctx.storage.list<StoredDevice>({ prefix: DEV_PREFIX });
    const remaining: string[] = [];
    for (const dev of allDevices.values()) {
      if (!dev.tokenHash) continue;
      if (dev.deviceId === senderId) continue;
      if (targetSet && !targetSet.has(dev.deviceId)) continue;
      remaining.push(dev.deviceId);
    }

    const bytes = new Uint8Array(buf);
    const remainingJson = JSON.stringify(remaining);

    let chunkIndex = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += BLOB_CHUNK_SIZE) {
      const slice = bytes.slice(offset, offset + BLOB_CHUNK_SIZE);
      this.ctx.storage.sql.exec(
        'INSERT INTO blobs (id, chunk_index, data, ts, sender_id, remaining) VALUES (?, ?, ?, ?, ?, ?)',
        blobId,
        chunkIndex,
        slice,
        now,
        senderId,
        remainingJson,
      );
      chunkIndex++;
    }

    return Response.json({ ok: true, blobId, bytes: bytes.byteLength });
  }

  private handleDownloadBlob(blobId: string, auth: AuthContext): Response {
    this.ensureBlobTable();
    const deviceId = auth.deviceId;

    const rows = this.ctx.storage.sql
      .exec(
        'SELECT chunk_index, data, sender_id, remaining FROM blobs WHERE id = ? ORDER BY chunk_index ASC',
        blobId,
      )
      .toArray();

    if (rows.length === 0) {
      return new Response('Not Found', { status: 404 });
    }

    const senderId = String(rows[0].sender_id || '');
    let remaining: string[] = [];
    try {
      remaining = JSON.parse(String(rows[0].remaining || '[]')) as string[];
    } catch {
      remaining = [];
    }

    const isAllowed = remaining.includes(deviceId) || senderId === deviceId;
    if (!isAllowed) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    let totalLen = 0;
    const chunks: Uint8Array[] = [];
    for (const row of rows) {
      const raw = row.data as ArrayBuffer;
      const u8 = new Uint8Array(raw);
      chunks.push(u8);
      totalLen += u8.byteLength;
    }

    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    if (remaining.includes(deviceId)) {
      const next = remaining.filter((id) => id !== deviceId);
      if (next.length === 0) {
        this.ctx.storage.sql.exec('DELETE FROM blobs WHERE id = ?', blobId);
      } else {
        this.ctx.storage.sql.exec(
          'UPDATE blobs SET remaining = ? WHERE id = ?',
          JSON.stringify(next),
          blobId,
        );
      }
    }

    return new Response(combined, {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  }

  private async handleListDevices(): Promise<Response> {
    const onlineIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      for (const tag of this.ctx.getTags(ws)) onlineIds.add(tag);
    }

    const stored = await this.ctx.storage.list<StoredDevice>({ prefix: DEV_PREFIX });
    const devices = Array.from(stored.values())
      .filter((d) => Boolean(d.tokenHash))
      .map((d) => ({
        deviceId: d.deviceId,
        iv: d.iv,
        ciphertext: d.ciphertext,
        updatedAt: d.updatedAt,
        online: onlineIds.has(d.deviceId),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    return Response.json({ devices });
  }

  private async handleUpdateDevice(request: Request, auth: AuthContext): Promise<Response> {
    const body = (await request.json()) as {
      deviceId?: string;
      iv?: string;
      ciphertext?: string;
    };

    const targetId = body.deviceId || auth.deviceId;
    if (
      !DEVICE_ID_RE.test(targetId) ||
      !body.iv ||
      !body.ciphertext ||
      body.ciphertext.length > 1000
    ) {
      return Response.json({ error: 'Invalid device payload' }, { status: 400 });
    }

    // Only allow updating devices already paired in this room (never create new devices here)
    const existing = await this.ctx.storage.get<StoredDevice>(`${DEV_PREFIX}${targetId}`);
    if (!existing || !existing.tokenHash) {
      return Response.json({ error: 'Device not found in room' }, { status: 404 });
    }

    const record: StoredDevice = {
      ...existing,
      iv: body.iv,
      ciphertext: body.ciphertext,
      updatedAt: Date.now(),
    };

    await this.ctx.storage.put(`${DEV_PREFIX}${targetId}`, record);
    this.broadcastJson({ type: 'devices_updated' });
    return Response.json({ ok: true });
  }

  private async handleDeleteDevice(request: Request, auth: AuthContext): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { deviceId?: string };
    const targetId = body.deviceId || auth.deviceId;
    if (!DEVICE_ID_RE.test(targetId)) {
      return Response.json({ error: 'Invalid deviceId' }, { status: 400 });
    }

    await Promise.all([
      this.ctx.storage.delete(`${DEV_PREFIX}${targetId}`),
      this.ctx.storage.delete(`${SUB_PREFIX}${targetId}`),
    ]);

    // Close all sockets for the removed device with custom revocation code 4001
    for (const ws of this.ctx.getWebSockets(targetId)) {
      try {
        ws.close(4001, 'Device removed');
      } catch {
        // ignore
      }
    }

    // Remove the deleted device from pending message queues so messages aren't held forever
    const storedMsgs = await this.ctx.storage.list<StoredMessage>({ prefix: MSG_PREFIX });
    const msgDeletes: string[] = [];
    const msgUpdates: Array<[string, StoredMessage]> = [];
    const deliveredIds: string[] = [];
    for (const [key, entry] of storedMsgs) {
      if (!('envelope' in entry) || !entry.remaining.includes(targetId)) continue;
      const next = entry.remaining.filter((id) => id !== targetId);
      if (next.length === 0) {
        msgDeletes.push(key);
        deliveredIds.push(entry.envelope.id);
      } else {
        msgUpdates.push([key, { envelope: entry.envelope, remaining: next }]);
      }
    }
    if (msgDeletes.length > 0) await this.ctx.storage.delete(msgDeletes);
    for (const [k, v] of msgUpdates) await this.ctx.storage.put(k, v);
    if (deliveredIds.length > 0) {
      this.broadcastJson({ type: 'delivered', ids: deliveredIds });
    }

    // Clean up deleted device from blob remaining lists
    this.ensureBlobTable();
    const blobRows = this.ctx.storage.sql
      .exec('SELECT DISTINCT id, remaining FROM blobs')
      .toArray();
    for (const row of blobRows) {
      const id = String(row.id);
      try {
        const rem = JSON.parse(String(row.remaining || '[]')) as string[];
        if (!rem.includes(targetId)) continue;
        const next = rem.filter((x) => x !== targetId);
        if (next.length === 0) {
          this.ctx.storage.sql.exec('DELETE FROM blobs WHERE id = ?', id);
        } else {
          this.ctx.storage.sql.exec(
            'UPDATE blobs SET remaining = ? WHERE id = ?',
            JSON.stringify(next),
            id,
          );
        }
      } catch {
        // ignore
      }
    }

    this.broadcastJson({ type: 'devices_updated' });
    return Response.json({ ok: true });
  }

  private async handleSubscribe(request: Request, auth: AuthContext): Promise<Response> {
    const body = (await request.json()) as {
      subscription?: PushSubscription;
    };

    if (!body.subscription?.endpoint || !body.subscription?.keys?.p256dh) {
      return Response.json({ error: 'Invalid subscription payload' }, { status: 400 });
    }

    const record: StoredSubscription = {
      deviceId: auth.deviceId,
      subscription: body.subscription,
      updatedAt: Date.now(),
    };

    await this.ctx.storage.put(`${SUB_PREFIX}${auth.deviceId}`, record);
    return Response.json({ ok: true });
  }

  private async handleUnsubscribe(auth: AuthContext): Promise<Response> {
    await this.ctx.storage.delete(`${SUB_PREFIX}${auth.deviceId}`);
    return Response.json({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    const subs = await this.ctx.storage.list<StoredSubscription>({ prefix: SUB_PREFIX });
    return Response.json({
      onlineSockets: sockets.length,
      pushDevices: subs.size,
    });
  }

  private async pruneOldMessages(now: number): Promise<void> {
    const stored = await this.ctx.storage.list<StoredMessage | EncryptedEnvelope>({
      prefix: MSG_PREFIX,
    });
    const toDelete: string[] = [];
    const entries = Array.from(stored.entries());

    for (const [key, entry] of entries) {
      const env = 'envelope' in entry ? entry.envelope : entry;
      if (now - env.ts > MESSAGE_TTL_MS) {
        toDelete.push(key);
      }
    }

    const remaining = entries.length - toDelete.length;
    if (remaining > MAX_PENDING_MESSAGES) {
      const validKeys = entries
        .filter(([k]) => !toDelete.includes(k))
        .map(([k]) => k)
        .sort();
      const overflow = validKeys.slice(0, remaining - MAX_PENDING_MESSAGES);
      toDelete.push(...overflow);
    }

    if (toDelete.length > 0) {
      await this.ctx.storage.delete(toDelete);
    }
  }

  private async handleAck(request: Request, auth: AuthContext): Promise<Response> {
    const body = (await request.json()) as { messageId?: string };
    if (!body.messageId) {
      return Response.json({ ok: false }, { status: 400 });
    }

    const deviceId = auth.deviceId;
    const stored = await this.ctx.storage.list<StoredMessage>({ prefix: MSG_PREFIX });
    const deliveredIds: string[] = [];

    for (const [key, entry] of stored) {
      if (!('envelope' in entry) || entry.envelope.id !== body.messageId) continue;
      if (entry.remaining.includes(deviceId)) {
        const next = entry.remaining.filter((id) => id !== deviceId);
        if (next.length === 0) {
          await this.ctx.storage.delete(key);
          deliveredIds.push(body.messageId);
        } else {
          await this.ctx.storage.put(key, { envelope: entry.envelope, remaining: next });
        }
      }
      break;
    }

    // Even if it wasn't in the queue (e.g. direct push ack), notify sender sockets
    if (deliveredIds.length === 0) {
      deliveredIds.push(body.messageId);
    }
    this.broadcastJson({ type: 'delivered', ids: deliveredIds });
    return Response.json({ ok: true });
  }

  private async handlePending(url: URL, auth: AuthContext): Promise<Response> {
    const deviceId = auth.deviceId;
    const since = Number(url.searchParams.get('since') || '0');
    const now = Date.now();

    const stored = await this.ctx.storage.list<StoredMessage | EncryptedEnvelope>({
      prefix: MSG_PREFIX,
    });
    const toDelete: string[] = [];
    const toUpdate: Array<[string, StoredMessage]> = [];
    const fullyDeliveredIds: string[] = [];
    const messages: EncryptedEnvelope[] = [];

    for (const [key, entry] of stored) {
      const isWrapped = 'envelope' in entry;
      const env = isWrapped ? entry.envelope : entry;
      const remaining = isWrapped ? entry.remaining : [];

      if (now - env.ts > MESSAGE_TTL_MS) {
        toDelete.push(key);
        continue;
      }

      if (env.senderId === deviceId) continue;

      const targetedToDevice =
        !Array.isArray(env.targetIds) ||
        env.targetIds.length === 0 ||
        env.targetIds.includes(deviceId);

      if (!targetedToDevice) continue;

      if (isWrapped) {
        if (remaining.includes(deviceId)) {
          messages.push(env);
          const nextRemaining = remaining.filter((id) => id !== deviceId);
          if (nextRemaining.length === 0) {
            toDelete.push(key);
            fullyDeliveredIds.push(env.id);
          } else {
            toUpdate.push([key, { envelope: env, remaining: nextRemaining }]);
          }
        }
      } else if (env.ts > since) {
        messages.push(env);
      }
    }

    if (toDelete.length > 0) {
      await this.ctx.storage.delete(toDelete);
    }
    for (const [k, v] of toUpdate) {
      await this.ctx.storage.put(k, v);
    }

    if (fullyDeliveredIds.length > 0) {
      this.broadcastJson({ type: 'delivered', ids: fullyDeliveredIds });
    }

    messages.sort((a, b) => a.ts - b.ts);
    return Response.json({ messages });
  }

  private async handleSend(request: Request, auth: AuthContext): Promise<Response> {
    const envelope = (await request.json()) as EncryptedEnvelope;

    if (!envelope.id || !envelope.iv || !envelope.ciphertext) {
      return Response.json({ error: 'Invalid encrypted envelope' }, { status: 400 });
    }

    if (envelope.senderId && envelope.senderId !== auth.deviceId) {
      return Response.json({ error: 'Sender mismatch' }, { status: 403 });
    }
    envelope.senderId = auth.deviceId;

    if (envelope.ciphertext.length > 3500) {
      return Response.json({ error: 'Message too large' }, { status: 413 });
    }

    const now = Date.now();
    envelope.ts = envelope.ts || now;

    const allDevices = await this.ctx.storage.list<StoredDevice>({ prefix: DEV_PREFIX });
    const registeredIds = new Set<string>();
    for (const dev of allDevices.values()) {
      if (dev.tokenHash) registeredIds.add(dev.deviceId);
    }

    const filteredTargets = Array.isArray(envelope.targetIds)
      ? envelope.targetIds.filter((id) => registeredIds.has(id) && id !== auth.deviceId)
      : [];
    const targetSet =
      Array.isArray(envelope.targetIds) && envelope.targetIds.length > 0
        ? new Set(filteredTargets)
        : null;
    if (targetSet) {
      envelope.targetIds = filteredTargets;
    } else {
      delete envelope.targetIds;
    }

    const serialized = JSON.stringify({ type: 'message', envelope });

    // 1. Fan out to connected WebSockets (respecting targetIds and skipping sender)
    let wsDelivered = 0;
    const deliveredIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes(envelope.senderId)) continue;
      if (!tags.some((t) => registeredIds.has(t))) continue;
      if (targetSet && !tags.some((t) => targetSet.has(t))) continue;
      try {
        ws.send(serialized);
        wsDelivered++;
        for (const t of tags) deliveredIds.add(t);
      } catch {
        // Ignore dead sockets
      }
    }

    // 2. Queue only for intended registered devices that were NOT online right now;
    //    auto-deleted once every remaining device retrieves it (or after 28 days).
    const remaining: string[] = [];
    for (const devId of registeredIds) {
      if (devId === envelope.senderId) continue;
      if (targetSet && !targetSet.has(devId)) continue;
      if (deliveredIds.has(devId)) continue;
      remaining.push(devId);
    }

    if (remaining.length > 0) {
      const paddedTs = String(envelope.ts).padStart(15, '0');
      const record: StoredMessage = { envelope, remaining };
      await this.ctx.storage.put(`${MSG_PREFIX}${paddedTs}:${envelope.id}`, record);
      await this.pruneOldMessages(now);
    }

    // 3. Fan out Web Push to registered devices (respecting targetIds and skipping sender)
    let pushSent = 0;
    let pushFailed = 0;

    const vapid = await this.resolveVapidKeys();

    if (vapid.publicKey && vapid.privateKey) {
      const subs = await this.ctx.storage.list<StoredSubscription>({ prefix: SUB_PREFIX });
      const pushTasks: Promise<void>[] = [];

      for (const [storageKey, entry] of subs) {
        if (!registeredIds.has(entry.deviceId)) continue;
        if (entry.deviceId === envelope.senderId) continue;
        if (targetSet && !targetSet.has(entry.deviceId)) continue;

        pushTasks.push(
          (async () => {
            try {
              const payload = await buildPushPayload(
                {
                  data: envelope as unknown as Record<string, string | number>,
                  options: {
                    ttl: MAX_TTL_SECONDS,
                    urgency: 'high',
                  },
                },
                entry.subscription,
                vapid,
              );

              const res = await fetch(entry.subscription.endpoint, {
                method: payload.method,
                headers: payload.headers,
                body: payload.body,
              });

              if (res.status === 404 || res.status === 410) {
                await this.ctx.storage.delete(storageKey);
                pushFailed++;
              } else if (res.ok) {
                pushSent++;
              } else {
                pushFailed++;
              }
            } catch {
              pushFailed++;
            }
          })(),
        );
      }

      await Promise.all(pushTasks);
    }

    return Response.json({
      ok: true,
      delivered: remaining.length === 0 && wsDelivered > 0,
      wsDelivered,
      pushSent,
      pushFailed,
    });
  }
}
