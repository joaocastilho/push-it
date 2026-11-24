import pkg from '../package.json';
import { PAIR_DO_NAME, RoomDO, VAPID_DO_NAME, type Env } from './room-do';

export { RoomDO };

const ROOM_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function withSecurityHeaders(res: Response, noStore = false): Response {
  if (res.status === 101) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (noStore) {
    headers.set('cache-control', 'no-store');
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/version' && request.method === 'GET') {
      return withSecurityHeaders(
        Response.json({
          version: pkg.version,
          accessKeyRequired: Boolean(env.ACCESS_KEY && env.ACCESS_KEY.trim().length > 0),
        }),
        true,
      );
    }

    if (url.pathname === '/api/pair/resolve' && request.method === 'POST') {
      const pairStub = env.ROOMS.get(env.ROOMS.idFromName(PAIR_DO_NAME));
      const clientIp =
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown';
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.set('x-client-ip', clientIp);
      const fwdReq = new Request(request.url, {
        method: 'POST',
        headers: fwdHeaders,
        body: request.body,
      });
      const res = await pairStub.fetch(fwdReq);
      return withSecurityHeaders(res, true);
    }

    const roomMatch = url.pathname.match(
      /^\/api\/room\/([^/]+)\/(init|join|invites|pin|ws-ticket|ws|send|ack|pending|devices|subscribe|status|vapid-public-key|blob\/[A-Za-z0-9_-]{8,64})$/,
    );
    if (roomMatch) {
      const roomId = roomMatch[1];
      if (!ROOM_ID_RE.test(roomId) || roomId === VAPID_DO_NAME || roomId === PAIR_DO_NAME) {
        return withSecurityHeaders(
          Response.json({ error: 'Invalid roomId' }, { status: 400 }),
          true,
        );
      }
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      const res = await stub.fetch(request);
      return withSecurityHeaders(res, true);
    }

    if (url.pathname.startsWith('/api/')) {
      return withSecurityHeaders(
        Response.json({ error: 'Not Found' }, { status: 404 }),
        true,
      );
    }

    const assetRes = await env.ASSETS.fetch(request);
    const contentType = assetRes.headers.get('content-type') || '';
    const isVolatileAsset =
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname === '/sw.js' ||
      url.pathname === '/manifest.webmanifest' ||
      contentType.includes('text/html');
    return withSecurityHeaders(assetRes, isVolatileAsset);
  },
} satisfies ExportedHandler<Env>;
