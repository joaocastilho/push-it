import { fromBase64Url } from './crypto';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function getVapidPublicKey(): Promise<string | null> {
  const res = await fetch('/api/vapid-public-key');
  if (!res.ok) return null;
  const data = (await res.json()) as { publicKey: string | null };
  return data.publicKey;
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribePush(roomId: string, deviceId: string): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error('Web Push is not supported in this browser');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission denied');
  }

  const vapidPublicKey = await getVapidPublicKey();
  if (!vapidPublicKey) {
    throw new Error('Server VAPID_PUBLIC_KEY is not configured yet (run bun run gen:vapid)');
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(vapidPublicKey),
    });
  }

  const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      deviceName: navigator.userAgent.includes('Android') ? 'Android' : 'Desktop',
      subscription: sub.toJSON(),
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to register push subscription (${res.status})`);
  }

  return sub;
}

export async function unsubscribePush(roomId: string, deviceId: string): Promise<void> {
  const sub = await getCurrentPushSubscription();
  if (sub) {
    await sub.unsubscribe();
  }
  await fetch(`/api/room/${encodeURIComponent(roomId)}/subscribe`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
}
