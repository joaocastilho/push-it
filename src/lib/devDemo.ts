import type { StoredMessage } from './db';
import type { DeviceOs } from './device';

export interface DemoDevice {
  deviceId: string;
  name: string;
  os: DeviceOs;
  color?: number;
  online: boolean;
  updatedAt: number;
  lastSeenAt?: number;
}

export function createLocalDemoData(
  myDeviceId: string,
  myDeviceName: string,
  myOs: DeviceOs,
): { devices: DemoDevice[]; messages: StoredMessage[] } {
  const now = Date.now();
  const min = 60 * 1000;

  const devices: DemoDevice[] = [
    {
      deviceId: myDeviceId,
      name: myDeviceName,
      os: myOs,
      color: 0,
      online: true,
      updatedAt: now,
      lastSeenAt: now,
    },
    {
      deviceId: 'demo-iphone',
      name: 'iPhone 16 Pro',
      os: 'ios',
      color: 1,
      online: true,
      updatedAt: now - 2 * min,
      lastSeenAt: now - 2 * min,
    },
    {
      deviceId: 'demo-macbook',
      name: 'MacBook Pro',
      os: 'macos',
      color: 2,
      online: true,
      updatedAt: now - 5 * min,
      lastSeenAt: now - 5 * min,
    },
    {
      deviceId: 'demo-pixel',
      name: 'Pixel 9',
      os: 'android',
      color: 5,
      online: false,
      updatedAt: now - 42 * min,
      lastSeenAt: now - 42 * min,
    },
  ];

  const messages: StoredMessage[] = [
    {
      id: 'demo-1',
      senderId: 'demo-iphone',
      senderName: 'iPhone 16 Pro',
      senderOs: 'ios',
      ts: now - 48 * min,
      type: 'link',
      title: 'SolidJS 2.0 Signals & Reactive Primitives',
      content: 'https://github.com/solidjs/solid/blob/main/packages/solid/src/reactive/signal.ts',
      direction: 'in',
    },
    {
      id: 'demo-2',
      senderId: myDeviceId,
      senderName: myDeviceName,
      senderOs: myOs,
      targetNames: ['iPhone 16 Pro'],
      ts: now - 45 * min,
      type: 'text',
      content: 'Got it, opening that on desktop now.',
      direction: 'out',
      status: 'delivered',
    },
    {
      id: 'demo-3',
      senderId: 'demo-macbook',
      senderName: 'MacBook Pro',
      senderOs: 'macos',
      ts: now - 39 * min,
      type: 'text',
      content:
        'Meeting notes for Q4 launch:\n1. Finalize end-to-end encryption key rotation\n2. Test PWA share sheet on iOS Safari and Android Chrome\n3. Ship redesigned conversation layout with fixed header and crisp typography\n4. Run Lighthouse audit before tagging v2.3.0',
      direction: 'in',
    },
    {
      id: 'demo-4',
      senderId: myDeviceId,
      senderName: myDeviceName,
      senderOs: myOs,
      ts: now - 32 * min,
      type: 'link',
      content: 'https://developers.cloudflare.com/durable-objects/best-practices/websockets/',
      direction: 'out',
      status: 'delivered',
    },
    {
      id: 'demo-5',
      senderId: 'demo-pixel',
      senderName: 'Pixel 9',
      senderOs: 'android',
      ts: now - 26 * min,
      type: 'text',
      content: 'Wi-Fi guest password for the studio: neon-horizon-8492-cobalt',
      expiresAt: now + 9 * min,
      direction: 'in',
    },
    {
      id: 'demo-6',
      senderId: myDeviceId,
      senderName: myDeviceName,
      senderOs: myOs,
      targetNames: ['MacBook Pro', 'iPhone 16 Pro'],
      ts: now - 19 * min,
      type: 'text',
      content:
        'Here is a longer paragraph to verify wrapping and vertical spacing inside message bubbles when a conversation has plenty of messages and scrolls past the viewport height. None of this text should ever be clipped or truncated vertically or horizontally.',
      direction: 'out',
      status: 'delivered',
    },
    {
      id: 'demo-7',
      senderId: 'demo-iphone',
      senderName: 'iPhone 16 Pro',
      senderOs: 'ios',
      ts: now - 14 * min,
      type: 'file',
      content: 'wireframe-v2-final.pdf',
      fileName: 'wireframe-v2-final.pdf',
      mimeType: 'application/pdf',
      fileSize: 2_480_120,
      direction: 'in',
    },
    {
      id: 'demo-8',
      senderId: 'demo-macbook',
      senderName: 'MacBook Pro',
      senderOs: 'macos',
      ts: now - 10 * min,
      type: 'text',
      content: 'bun run typecheck && bun run build',
      direction: 'in',
    },
    {
      id: 'demo-9',
      senderId: myDeviceId,
      senderName: myDeviceName,
      senderOs: myOs,
      ts: now - 6 * min,
      type: 'link',
      title: 'Cloudflare Workers Release Notes',
      content: 'https://developers.cloudflare.com/workers/platform/changelog/',
      direction: 'out',
      status: 'delivered',
    },
    {
      id: 'demo-10',
      senderId: 'demo-iphone',
      senderName: 'iPhone 16 Pro',
      senderOs: 'ios',
      ts: now - 2 * min,
      type: 'text',
      content: 'Looks super clean! Ready to ship once the scroll container and bubble layout are polished.',
      direction: 'in',
    },
  ];

  return { devices, messages };
}
