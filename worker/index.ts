import { RoomDO, VAPID_DO_NAME, type Env } from './room-do';

export { RoomDO };

const ROOM_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
      if (env.VAPID_PUBLIC_KEY) {
        return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
      }
      const vapidStub = env.ROOMS.get(env.ROOMS.idFromName(VAPID_DO_NAME));
      const res = await vapidStub.fetch('https://internal/internal/vapid-keys');
      const keys = (await res.json()) as { publicKey: string };
      return Response.json({ publicKey: keys.publicKey });
    }

    const roomMatch = url.pathname.match(
      /^\/api\/room\/([^/]+)\/(ws|send|ack|pending|devices|subscribe|status|blob\/[A-Za-z0-9_-]{8,64})$/,
    );
    if (roomMatch) {
      const roomId = roomMatch[1];
      if (!ROOM_ID_RE.test(roomId) || roomId === VAPID_DO_NAME) {
        return Response.json({ error: 'Invalid roomId' }, { status: 400 });
      }
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
