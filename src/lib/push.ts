import { fromBase64Url, isSafeHttpUrl, makeAuthHeader, toBase64Url } from './crypto';
import type { StoredMessage } from './db';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function getVapidPublicKey(
  roomId: string,
  deviceId: string,
  deviceToken: string,
): Promise<string | null> {
  const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/vapid-public-key`, {
    headers: { authorization: makeAuthHeader(deviceId, deviceToken) },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { publicKey: string | null };
  return data.publicKey;
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function subscriptionMatchesVapidKey(sub: PushSubscription, vapidPublicKey: string): boolean {
  const keyBuf = sub.options?.applicationServerKey;
  if (!keyBuf) return false;
  return toBase64Url(new Uint8Array(keyBuf)) === vapidPublicKey;
}

async function uploadSubscription(
  roomId: string,
  deviceId: string,
  deviceToken: string,
  sub: PushSubscription,
): Promise<void> {
  const res = await fetch(`/api/room/${encodeURIComponent(roomId)}/subscribe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: makeAuthHeader(deviceId, deviceToken),
    },
    body: JSON.stringify({
      subscription: sub.toJSON(),
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to register push subscription (${res.status})`);
  }
}

export async function subscribePush(
  roomId: string,
  deviceId: string,
  deviceToken: string,
): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error('Web Push is not supported in this browser');
  }

  if (Notification.permission === 'denied') {
    throw new Error('Notifications are blocked — allow them in your browser site settings');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked — allow them in your browser site settings'
        : 'Notification permission was not granted',
    );
  }

  const vapidPublicKey = await getVapidPublicKey(roomId, deviceId, deviceToken);
  if (!vapidPublicKey) {
    throw new Error('Server VAPID_PUBLIC_KEY is not configured yet');
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !subscriptionMatchesVapidKey(sub, vapidPublicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(vapidPublicKey),
    });
  }

  await uploadSubscription(roomId, deviceId, deviceToken, sub);
  return sub;
}

export async function syncPushSubscription(
  roomId: string,
  deviceId: string,
  deviceToken: string,
): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const vapidPublicKey = await getVapidPublicKey(roomId, deviceId, deviceToken);
  if (!vapidPublicKey) return false;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !subscriptionMatchesVapidKey(sub, vapidPublicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(vapidPublicKey),
    });
  }

  await uploadSubscription(roomId, deviceId, deviceToken, sub);
  return true;
}

export async function unsubscribePush(
  roomId: string,
  deviceId: string,
  deviceToken: string,
): Promise<void> {
  const sub = await getCurrentPushSubscription();
  if (sub) {
    await sub.unsubscribe();
  }
  await fetch(`/api/room/${encodeURIComponent(roomId)}/subscribe`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      authorization: makeAuthHeader(deviceId, deviceToken),
    },
  });
}

export async function showLocalNotification(item: StoredMessage): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const isLink = item.type === 'link' && isSafeHttpUrl(item.content);
    const isPhoto = item.type === 'file' && Boolean(item.mimeType?.startsWith('image/'));
    const fromPrefix = item.senderName ? `${item.senderName} · ` : '';
    const notifTitle = isLink
      ? `${fromPrefix}${item.title || 'New Link — Tap to Open'}`
      : item.type === 'file'
        ? `${fromPrefix}${isPhoto ? 'New Photo' : 'New File'}`
        : `${fromPrefix}${item.title || 'New Message'}`;

    const notifBody =
      item.type === 'file'
        ? item.fileName || 'Open Push It to view'
        : item.content.slice(0, 180);

    await reg.showNotification(notifTitle, {
      body: notifBody,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: item.id,
      data: {
        id: item.id,
        type: isLink ? 'link' : 'text',
        url: isLink ? item.content : `/?msg=${encodeURIComponent(item.id)}`,
      },
    });
  } catch {
    // ignore local notification failures
  }
}

export async function showTestNotification(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') {
    throw new Error('Notifications are not enabled');
  }
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Push It', {
    body: 'Notifications are working on this device!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'push-it-test',
    data: { type: 'app', url: '/' },
  });
}
