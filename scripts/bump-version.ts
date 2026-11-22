import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

type BumpKind = 'patch' | 'minor' | 'major' | 'auto';

const PKG_PATH = 'package.json';
const EXT_MANIFEST_PATH = 'extension/manifest.json';
const CODE_PATH_RE = /^(src\/|worker\/|public\/|extension\/|index\.html$|vite\.config\.ts$|wrangler\.jsonc$)/;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function bumpSemver(version: string, kind: 'patch' | 'minor' | 'major'): string {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid SemVer version: ${version}`);
  }
  const [maj, min, pat] = parts;
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function syncExtensionVersion(version: string): boolean {
  const manifest = readJson(EXT_MANIFEST_PATH);
  if (manifest.version === version) return false;
  manifest.version = version;
  writeJson(EXT_MANIFEST_PATH, manifest);
  return true;
}

function getHeadPkgVersion(): string | null {
  try {
    const raw = execSync('git show HEAD:package.json', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function getStagedFiles(): string[] {
  const out = execSync('git diff --cached --name-only', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const mode = (process.argv[2] || 'patch') as BumpKind;
const pkg = readJson(PKG_PATH);
const currentVersion = String(pkg.version || '1.0.0');

if (mode === 'auto') {
  const staged = getStagedFiles();
  const hasCodeChange = staged.some((f) => CODE_PATH_RE.test(f));
  if (!hasCodeChange) {
    process.exit(0);
  }

  const headVersion = getHeadPkgVersion();
  if (headVersion && headVersion !== currentVersion) {
    // Version was already bumped manually (e.g. bump:minor or bump:major) — just sync extension manifest
    if (syncExtensionVersion(currentVersion)) {
      execSync(`git add ${EXT_MANIFEST_PATH}`);
    }
    console.log(`[version] Keeping manual bump v${currentVersion}`);
    process.exit(0);
  }

  const next = bumpSemver(currentVersion, 'patch');
  pkg.version = next;
  writeJson(PKG_PATH, pkg);
  syncExtensionVersion(next);
  execSync(`git add ${PKG_PATH} ${EXT_MANIFEST_PATH}`);
  console.log(`[version] Auto-bumped v${currentVersion} -> v${next}`);
  process.exit(0);
}

if (mode === 'patch' || mode === 'minor' || mode === 'major') {
  const next = bumpSemver(currentVersion, mode);
  pkg.version = next;
  writeJson(PKG_PATH, pkg);
  syncExtensionVersion(next);
  console.log(`[version] Bumped (${mode}) v${currentVersion} -> v${next}`);
  process.exit(0);
}

console.error(`Unknown mode: ${mode}. Use patch | minor | major | auto.`);
process.exit(1);
