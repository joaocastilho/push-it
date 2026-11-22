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
  iv: string;
  ciphertext: string;
  ts: number;
}

interface StoredSubscription {
  deviceId: string;
  deviceName?: string;
  subscription: PushSubscription;
  updatedAt: number;
}

interface StoredVapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const SUB_PREFIX = 'sub:';
const VAPID_STORAGE_KEY = 'vapid:keys';
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

  private handleWebSocket(request: Request, url: URL): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const deviceId = url.searchParams.get('deviceId') || crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: tag the socket with deviceId so we can skip echo
    this.ctx.acceptWebSocket(server, [deviceId]);

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
  }

  private async handleSubscribe(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      deviceId: string;
      deviceName?: string;
      subscription: PushSubscription;
    };

    if (!body.deviceId || !body.subscription?.endpoint || !body.subscription?.keys?.p256dh) {
      return Response.json({ error: 'Invalid subscription payload' }, { status: 400 });
    }

    const record: StoredSubscription = {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
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

  private async handleSend(request: Request): Promise<Response> {
    const envelope = (await request.json()) as EncryptedEnvelope;

    if (!envelope.id || !envelope.senderId || !envelope.iv || !envelope.ciphertext) {
      return Response.json({ error: 'Invalid encrypted envelope' }, { status: 400 });
    }

    // Limit ciphertext size so Web Push (4 KB limit) always succeeds
    if (envelope.ciphertext.length > 3500) {
      return Response.json(
        { error: 'Payload too large for Web Push (max ~2.5 KB plaintext)' },
        { status: 413 },
      );
    }

    const serialized = JSON.stringify({ type: 'message', envelope });

    // 1. Fan out to all connected WebSockets (except sender)
    let wsDelivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes(envelope.senderId)) continue;
      try {
        ws.send(serialized);
        wsDelivered++;
      } catch {
        // Ignore dead sockets; runtime cleans them up
      }
    }

    // 2. Fan out Web Push to registered devices (except sender)
    let pushSent = 0;
    let pushFailed = 0;

    const vapid = await this.resolveVapidKeys();

    if (vapid.publicKey && vapid.privateKey) {
      const subs = await this.ctx.storage.list<StoredSubscription>({ prefix: SUB_PREFIX });
      const pushTasks: Promise<void>[] = [];

      for (const [storageKey, entry] of subs) {
        if (entry.deviceId === envelope.senderId) continue;

        pushTasks.push(
          (async () => {
            try {
              const payload = await buildPushPayload(
                {
                  data: envelope as unknown as Record<string, string | number>,
                  options: {
                    ttl: 86400,
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
                // Subscription expired/revoked — prune it
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
