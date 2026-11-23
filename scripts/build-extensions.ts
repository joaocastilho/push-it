import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = 'extension';
const FIREFOX_UNPACKED_DIR = 'extension-firefox';
const DIST_EXT_DIR = 'dist-extensions';

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function collectFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(root, full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
}

// Pure-Bun standard ZIP builder (DEFLATE) so it works identically on Windows, macOS, and Linux
function createZip(sourceDir: string, outFile: string): void {
  const files = collectFiles(sourceDir);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const filePath of files) {
    const relName = relative(sourceDir, filePath).replace(/\\/g, '/');
    const nameBytes = new TextEncoder().encode(relName);
    const data = new Uint8Array(readFileSync(filePath));
    const compressed = Bun.deflateSync(data, { level: 9 });
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, 0x04034b50, true); // signature
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0, true); // flags
    ldv.setUint16(8, 8, true); // compression: deflate
    ldv.setUint16(10, 0, true); // mod time
    ldv.setUint16(12, 0x5421, true); // mod date
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, compressed.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true); // extra length
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, compressed);

    // Central directory header (46 bytes + name)
    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true); // signature
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, 8, true); // compression: deflate
    cdv.setUint16(12, 0, true); // mod time
    cdv.setUint16(14, 0x5421, true); // mod date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, compressed.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra length
    cdv.setUint16(32, 0, true); // comment length
    cdv.setUint16(34, 0, true); // disk start
    cdv.setUint16(36, 0, true); // internal attrs
    cdv.setUint32(38, 0, true); // external attrs
    cdv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);

    centralParts.push(central);
    offset += localHeader.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const totalLen = offset + centralSize + eocd.length;
  const archive = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    archive.set(part, pos);
    pos += part.length;
  }
  writeFileSync(outFile, archive);
}

// 1. Build unpacked Firefox MV3 extension
rmSync(FIREFOX_UNPACKED_DIR, { recursive: true, force: true });
mkdirSync(FIREFOX_UNPACKED_DIR, { recursive: true });
cpSync(SRC_DIR, FIREFOX_UNPACKED_DIR, { recursive: true });

const ffManifestPath = join(FIREFOX_UNPACKED_DIR, 'manifest.json');
const manifest = JSON.parse(readFileSync(ffManifestPath, 'utf8')) as Record<string, unknown>;
manifest.background = {
  scripts: ['background.js'],
  type: 'module',
};
manifest.browser_specific_settings = {
  gecko: {
    id: 'push-it@push-it.app',
    strict_min_version: '121.0',
  },
};
writeFileSync(ffManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// 2. Package Chromium (.zip) and Firefox (.xpi) archives
rmSync(DIST_EXT_DIR, { recursive: true, force: true });
mkdirSync(DIST_EXT_DIR, { recursive: true });
createZip(SRC_DIR, join(DIST_EXT_DIR, 'push-it-chromium.zip'));
createZip(FIREFOX_UNPACKED_DIR, join(DIST_EXT_DIR, 'push-it-firefox.xpi'));

const version = String(manifest.version || '1.0.0');
console.log(`Built extensions v${version}:`);
console.log(`  - ${DIST_EXT_DIR}/push-it-chromium.zip (Chrome, Edge, Brave, Arc, Vivaldi)`);
console.log(`  - ${DIST_EXT_DIR}/push-it-firefox.xpi  (Firefox, Zen, Floorp, LibreWolf)`);
console.log(`  - ${FIREFOX_UNPACKED_DIR}/             (Unpacked Firefox dev folder)`);
