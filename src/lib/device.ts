export type DeviceOs = 'android' | 'windows' | 'macos' | 'ios' | 'linux' | 'other';

export function detectOs(): DeviceOs {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // iPadOS 13+ reports Macintosh UA with touch support
  if (/Macintosh|Mac OS X/i.test(ua) && touchPoints > 1) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

export function isIosDevice(): boolean {
  return detectOs() === 'ios';
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    nav.standalone === true
  );
}

export function defaultDeviceName(os: DeviceOs): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  switch (os) {
    case 'android':
      return 'Android';
    case 'windows':
      return 'Windows';
    case 'macos':
      return 'Mac';
    case 'ios':
      return /iPhone/i.test(ua) ? 'iPhone' : /iPad|Macintosh/i.test(ua) ? 'iPad' : 'iOS';
    case 'linux':
      return 'Linux';
    default:
      return 'Device';
  }
}

export function normalizeOs(value: unknown): DeviceOs {
  if (
    value === 'android' ||
    value === 'windows' ||
    value === 'macos' ||
    value === 'ios' ||
    value === 'linux'
  ) {
    return value;
  }
  return 'other';
}

export const DEVICE_COLOR_OPTIONS = [
  { index: 0, name: 'Indigo', swatch: '#6366f1' },
  { index: 1, name: 'Sky', swatch: '#0ea5e9' },
  { index: 2, name: 'Emerald', swatch: '#10b981' },
  { index: 3, name: 'Amber', swatch: '#f59e0b' },
  { index: 4, name: 'Rose', swatch: '#f43f5e' },
  { index: 5, name: 'Violet', swatch: '#a855f7' },
  { index: 6, name: 'Teal', swatch: '#14b8a6' },
  { index: 7, name: 'Slate', swatch: '#64748b' },
] as const;

export const DEVICE_COLOR_COUNT = DEVICE_COLOR_OPTIONS.length;

export function normalizeDeviceColor(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DEVICE_COLOR_COUNT) {
    return value;
  }
  return undefined;
}

export function deviceColorIndex(deviceId?: string): number {
  const s = String(deviceId || 'default');
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % DEVICE_COLOR_COUNT;
}
