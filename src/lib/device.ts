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
