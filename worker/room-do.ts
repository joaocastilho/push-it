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
}

export interface EncryptedEnvelope {
  id: string;
  senderId: string;
  targetIds?: string[];
  iv: string;
  ciphertext: string;
  ts: number;
}

interface StoredSubscription {
  deviceId: string;
  subscription: PushSubscription;
  updatedAt: number;
}

interface StoredDevice {
  deviceId: string;
  iv: string;
  ciphertext: string;
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

const SUB_PREFIX = 'sub:';
const DEV_PREFIX = 'dev:';
const MSG_PREFIX = 'msg:';
const VAPID_STORAGE_KEY = 'vapid:keys';
const MAX_TTL_SECONDS = 2419200; // 28 days (Web Push / FCM max)
const MESSAGE_TTL_MS = MAX_TTL_SECONDS * 1000;
const MAX_PENDING_MESSAGES = 200;
export const VAPID_DO_NAME = '__vapid__';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

export class RoomDO extends DurableObject<Env> {
  private cachedVapid: StoredVapidKeys | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/internal/vapid-keys' && request.method === 'GET') {
      const keys = await this.getOrCreateOwnVapidKeys();
      return Response.json(keys);
    }

    if (path.endsWith('/ws')) {
      return this.handleWebSocket(request, url);
    }

    if (path.endsWith('/send') && request.method === 'POST') {
      return this.handleSend(request);
    }

    if (path.endsWith('/pending') && request.method === 'GET') {
      return this.handlePending(url);
    }

    if (path.endsWith('/devices') && request.method === 'GET') {
      return this.handleListDevices();
    }

    if (path.endsWith('/devices') && request.method === 'POST') {
      return this.handleUpsertDevice(request);
    }

    if (path.endsWith('/devices') && request.method === 'DELETE') {
      return this.handleDeleteDevice(request);
    }

    if (path.endsWith('/subscribe') && request.method === 'POST') {
      return this.handleSubscribe(request);
    }

    if (path.endsWith('/subscribe') && request.method === 'DELETE') {
      return this.handleUnsubscribe(request);
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

  private broadcastDevicesUpdated(): void {
    const msg = JSON.stringify({ type: 'devices_updated' });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore dead sockets
      }
    }
  }

  private handleWebSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const deviceId = url.searchParams.get('deviceId') || crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [deviceId]);
    this.broadcastDevicesUpdated();

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
    this.broadcastDevicesUpdated();
  }

  private async handleListDevices(): Promise<Response> {
    const onlineIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      for (const tag of this.ctx.getTags(ws)) onlineIds.add(tag);
    }

    const stored = await this.ctx.storage.list<StoredDevice>({ prefix: DEV_PREFIX });
    const devices = Array.from(stored.values())
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

  private async handleUpsertDevice(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      deviceId?: string;
      iv?: string;
      ciphertext?: string;
    };

    if (!body.deviceId || !body.iv || !body.ciphertext || body.ciphertext.length > 1000) {
      return Response.json({ error: 'Invalid device payload' }, { status: 400 });
    }

    const record: StoredDevice = {
      deviceId: body.deviceId,
      iv: body.iv,
      ciphertext: body.ciphertext,
      updatedAt: Date.now(),
    };

    await this.ctx.storage.put(`${DEV_PREFIX}${body.deviceId}`, record);
    this.broadcastDevicesUpdated();
    return Response.json({ ok: true });
  }

  private async handleDeleteDevice(request: Request): Promise<Response> {
    const body = (await request.json()) as { deviceId?: string };
    if (!body.deviceId) {
      return Response.json({ error: 'Missing deviceId' }, { status: 400 });
    }

    await Promise.all([
      this.ctx.storage.delete(`${DEV_PREFIX}${body.deviceId}`),
      this.ctx.storage.delete(`${SUB_PREFIX}${body.deviceId}`),
    ]);

    for (const ws of this.ctx.getWebSockets(body.deviceId)) {
      try {
        ws.close(1000, 'Device removed');
      } catch {
        // ignore
      }
    }

    this.broadcastDevicesUpdated();
    return Response.json({ ok: true });
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      deviceId: string;
      subscription: PushSubscription;
    };

    if (!body.deviceId || !body.subscription?.endpoint || !body.subscription?.keys?.p256dh) {
      return Response.json({ error: 'Invalid subscription payload' }, { status: 400 });
    }

    const record: StoredSubscription = {
      deviceId: body.deviceId,
      subscription: body.subscription,
      updatedAt: Date.now(),
    };

    await this.ctx.storage.put(`${SUB_PREFIX}${body.deviceId}`, record);
    return Response.json({ ok: true });
  }

  private async handleUnsubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as { deviceId?: string };
    if (!body.deviceId) {
      return Response.json({ error: 'Missing deviceId' }, { status: 400 });
    }
    await this.ctx.storage.delete(`${SUB_PREFIX}${body.deviceId}`);
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

  private async handlePending(url: URL): Promise<Response> {
    const deviceId = url.searchParams.get('deviceId') || '';
    const since = Number(url.searchParams.get('since') || '0');
    const now = Date.now();

    const stored = await this.ctx.storage.list<StoredMessage | EncryptedEnvelope>({
      prefix: MSG_PREFIX,
    });
    const toDelete: string[] = [];
    const toUpdate: Array<[string, StoredMessage]> = [];
    const messages: EncryptedEnvelope[] = [];

    for (const [key, entry] of stored) {
      const isWrapped = 'envelope' in entry;
      const env = isWrapped ? entry.envelope : entry;
      const remaining = isWrapped ? entry.remaining : [];

      if (now - env.ts > MESSAGE_TTL_MS) {
        toDelete.push(key);
        continue;
      }

      if (deviceId && env.senderId === deviceId) continue;

      const targetedToDevice =
        !Array.isArray(env.targetIds) ||
        env.targetIds.length === 0 ||
        (deviceId !== '' && env.targetIds.includes(deviceId));

      if (!targetedToDevice) continue;

      if (isWrapped && deviceId) {
        if (remaining.includes(deviceId)) {
          messages.push(env);
          const nextRemaining = remaining.filter((id) => id !== deviceId);
          if (nextRemaining.length === 0) {
            toDelete.push(key);
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

    messages.sort((a, b) => a.ts - b.ts);
    return Response.json({ messages });
  }

  private async handleSend(request: Request): Promise<Response> {
    const envelope = (await request.json()) as EncryptedEnvelope;

    if (!envelope.id || !envelope.senderId || !envelope.iv || !envelope.ciphertext) {
      return Response.json({ error: 'Invalid encrypted envelope' }, { status: 400 });
    }

    if (envelope.ciphertext.length > 3500) {
      return Response.json({ error: 'Message too large' }, { status: 413 });
    }

    const now = Date.now();
    envelope.ts = envelope.ts || now;

    const targetSet =
      Array.isArray(envelope.targetIds) && envelope.targetIds.length > 0
        ? new Set(envelope.targetIds)
        : null;

    const serialized = JSON.stringify({ type: 'message', envelope });

    // 1. Fan out to connected WebSockets (respecting targetIds and skipping sender)
    let wsDelivered = 0;
    const deliveredIds = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes(envelope.senderId)) continue;
      if (targetSet && !tags.some((t) => targetSet.has(t))) continue;
      try {
        ws.send(serialized);
        wsDelivered++;
        for (const t of tags) deliveredIds.add(t);
      } catch {
        // Ignore dead sockets
      }
    }

    // 2. Queue only for intended devices that were NOT online right now;
    //    auto-deleted once every remaining device retrieves it (or after 28 days).
    const allDevices = await this.ctx.storage.list<StoredDevice>({ prefix: DEV_PREFIX });
    const remaining: string[] = [];
    for (const dev of allDevices.values()) {
      if (dev.deviceId === envelope.senderId) continue;
      if (targetSet && !targetSet.has(dev.deviceId)) continue;
      if (deliveredIds.has(dev.deviceId)) continue;
      remaining.push(dev.deviceId);
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
      wsDelivered,
      pushSent,
      pushFailed,
    });
  }
}
