/**
 * Name rules of the file sync: which local names are ignored, which names cannot exist on
 * the other side, and how conflict copies are named.
 */

/** Editor lock files, OS metadata and our own partial downloads never sync. */
const IGNORED = [
  /^\.DS_Store$/,
  /^\._/,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /^Icon\r$/,
  /^~\$/,
  /^\.~lock\..*#$/,
  /\.tmp$/i,
  /^\.crewhall-/,
];

export function isIgnored(name: string): boolean {
  return IGNORED.some((re) => re.test(name));
}

/** Prefix of the temporary files the sync writes before renaming them into place. */
export const PARTIAL_PREFIX = '.crewhall-';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what Windows forbids
const WINDOWS_BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

export type SyncPlatform = 'win32' | 'darwin' | 'linux';

/** Why a remote name cannot be written to this computer, or null when it can. */
export function localNameProblem(name: string, platform: SyncPlatform): string | null {
  if (name === '.' || name === '..' || name.length === 0) return 'invalid_name';
  if (Buffer.byteLength(name, 'utf8') > 255) return 'name_too_long';
  if (name.includes('/') || name.includes('\0')) return 'invalid_name';
  if (platform === 'win32') {
    if (WINDOWS_BAD_CHARS.test(name)) return 'invalid_name';
    if (WINDOWS_RESERVED.test(name)) return 'reserved_name';
    if (/[. ]$/.test(name)) return 'invalid_name';
  }
  return null;
}

/** Why a local name cannot be uploaded (the server trims names and forbids / and \). */
export function remoteNameProblem(name: string): string | null {
  if (name.length === 0 || name.length > 255) return 'invalid_name';
  if (name !== name.trim()) return 'invalid_name';
  if (/[/\\]/.test(name) || name.includes('\0')) return 'invalid_name';
  return null;
}

/** File systems that treat "Rapor.pdf" and "rapor.pdf" as the same file. */
export function isCaseInsensitive(platform: SyncPlatform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Splits "rapor.final.pdf" into ["rapor.final", ".pdf"]; dot files keep their name. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * "Rapor (çakışan kopya LAPTOP 2026-10-22 1405).pdf". `label` is the translated
 * "conflicted copy" text; `taken` tells whether a name is already used in the folder.
 */
export function conflictName(
  name: string,
  label: string,
  device: string,
  at: Date,
  taken: (candidate: string) => boolean,
): string {
  const [stem, ext] = splitExtension(name);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;
  // eslint-disable-next-line no-control-regex -- strip what file names cannot hold
  const safeDevice = device.replace(/[<>:"/\\|?*()\u0000-\u001f]/g, '').trim();
  const base = `${stem} (${[label, safeDevice, stamp].filter(Boolean).join(' ')}`;
  let candidate = `${base})${ext}`;
  for (let i = 2; taken(candidate); i++) candidate = `${base} ${i})${ext}`;
  return candidate;
}

/** Joins sync paths; they always use "/" whatever the OS. */
export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function depth(path: string): number {
  return path.split('/').length;
}

/** True when `path` is `folder` itself or inside it. */
export function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}
