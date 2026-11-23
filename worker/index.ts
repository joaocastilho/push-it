import pkg from '../package.json';
import { RoomDO, VAPID_DO_NAME, type Env } from './room-do';

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

    const roomMatch = url.pathname.match(
      /^\/api\/room\/([^/]+)\/(init|join|invites|ws-ticket|ws|send|ack|pending|devices|subscribe|status|vapid-public-key|blob\/[A-Za-z0-9_-]{8,64})$/,
    );
    if (roomMatch) {
      const roomId = roomMatch[1];
      if (!ROOM_ID_RE.test(roomId) || roomId === VAPID_DO_NAME) {
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
    return withSecurityHeaders(assetRes, false);
  },
} satisfies ExportedHandler<Env>;
