import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DESKTOP_FEED_FILE,
  DesktopPlatform,
  type DesktopInfo,
  type DesktopRelease,
} from '@crewhall/shared';
import type { Env } from '../../env';
import type { Storage } from '../../storage/s3';

/**
 * Desktop releases: the electron-updater generic feed and the installers, with single-range
 * requests for the blockmap based differential download. Two places hold them, looked at in
 * order: DESKTOP_UPDATES_DIR (apps/desktop `publish:updates` lays it out; the image always
 * sets it, often to an empty folder) and the app's S3 bucket under DESKTOP_UPDATES_S3_PREFIX,
 * where files are uploaded by hand. The first place that has a file serves it.
 */

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** A file name inside a platform folder; never a path. */
export function safeFileName(file: string): boolean {
  return FILE_NAME.test(file) && !file.includes('..');
}

interface FeedFile {
  url: string;
  size: number | null;
  sha512?: string;
}

/** The fields of electron-builder's latest.yml the server needs (no YAML library for five keys). */
export function parseFeed(text: string): {
  version: string | null;
  path: string | null;
  releaseDate: string | null;
  files: FeedFile[];
} {
  const value = (key: string) => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text);
    return m ? m[1]!.trim().replace(/^['"]|['"]$/g, '') : null;
  };
  const files: FeedFile[] = [];
  let current: FeedFile | null = null;
  for (const line of text.split(/\r?\n/)) {
    const url = /^\s*-\s*url:\s*(.+)$/.exec(line);
    if (url) {
      current = { url: url[1]!.trim().replace(/^['"]|['"]$/g, ''), size: null };
      files.push(current);
      continue;
    }
    const size = /^\s+size:\s*(\d+)/.exec(line);
    if (size && current) current.size = Number(size[1]);
    const sha = /^\s+sha512:\s*(\S+)/.exec(line);
    if (sha && current) current.sha512 = sha[1]!.replace(/^['"]|['"]$/g, '');
    if (/^\S/.test(line)) current = null;
  }
  return {
    version: value('version'),
    path: value('path'),
    releaseDate: value('releaseDate'),
    files,
  };
}

export function updateFileUrl(platform: DesktopPlatform, file: string): string {
  return `/api/v1/desktop/updates/${platform}/${encodeURIComponent(file)}`;
}

interface FileInfo {
  size: number;
  modified: Date | null;
  etag: string | null;
}

/** One place releases are kept. Names reaching it already passed safeFileName. */
export interface UpdateSource {
  /** Identity for the bootstrap cache. */
  key: string;
  stat(platform: DesktopPlatform, file: string): Promise<FileInfo | null>;
  readText(platform: DesktopPlatform, file: string): Promise<string | null>;
  /** Bytes start..end (inclusive), or the whole file. */
  open(
    platform: DesktopPlatform,
    file: string,
    range: { start: number; end: number } | null,
  ): Promise<ReadableStream>;
}

export function dirSource(dir: string): UpdateSource {
  const path = (platform: DesktopPlatform, file: string) => join(dir, platform, file);
  return {
    key: `dir:${dir}`,
    async stat(platform, file) {
      const info = await stat(path(platform, file)).catch(() => null);
      if (!info?.isFile()) return null;
      return {
        size: info.size,
        modified: info.mtime,
        etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
      };
    },
    readText: (platform, file) => readFile(path(platform, file), 'utf8').catch(() => null),
    async open(platform, file, range) {
      const stream = createReadStream(path(platform, file), range ?? {});
      return Readable.toWeb(stream) as ReadableStream;
    },
  };
}

/** `<prefix><platform>/<file>` in the app's bucket; files are dropped there by hand. */
export function s3Source(storage: Storage, prefix: string): UpdateSource {
  const key = (platform: DesktopPlatform, file: string) => `${prefix}${platform}/${file}`;
  return {
    key: `s3:${storage.bucket}/${prefix}`,
    async stat(platform, file) {
      const head = await storage.head(key(platform, file));
      if (!head) return null;
      return { size: head.size, modified: head.lastModified ?? null, etag: head.etag ?? null };
    },
    async readText(platform, file) {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await storage.getStream(key(platform, file))) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        return Buffer.concat(chunks).toString('utf8');
      } catch {
        return null;
      }
    },
    async open(platform, file, range) {
      const body = await storage.getStream(
        key(platform, file),
        range ? `bytes=${range.start}-${range.end}` : undefined,
      );
      return Readable.toWeb(body) as ReadableStream;
    },
  };
}

/** Where releases are looked for, in order; empty when neither is configured. */
export function updateSources(deps: { env: Env; storage: Storage | null }): UpdateSource[] {
  return [
    ...(deps.env.DESKTOP_UPDATES_DIR ? [dirSource(deps.env.DESKTOP_UPDATES_DIR)] : []),
    ...(deps.storage ? [s3Source(deps.storage, deps.env.DESKTOP_UPDATES_S3_PREFIX)] : []),
  ];
}

/** The release one source holds for a platform, or null when there is none (or it is unreadable). */
export async function readRelease(
  source: UpdateSource,
  platform: DesktopPlatform,
): Promise<DesktopRelease | null> {
  const text = await source.readText(platform, DESKTOP_FEED_FILE[platform]);
  if (text === null) return null;
  const feed = parseFeed(text);
  if (!feed.version) return null;
  // macOS: people install from the dmg; the updater uses the zip.
  const pick =
    (platform === 'mac' ? feed.files.find((f) => f.url.endsWith('.dmg')) : undefined) ??
    feed.files.find((f) => f.url === feed.path) ??
    feed.files[0];
  const file = pick?.url ?? feed.path;
  if (!file || !safeFileName(file)) return null;
  const size = pick?.size ?? (await source.stat(platform, file))?.size ?? null;
  return {
    platform,
    version: feed.version,
    url: updateFileUrl(platform, file),
    sizeBytes: size,
    releasedAt: feed.releaseDate,
  };
}

let cache: { key: string; at: number; info: DesktopInfo | null } | null = null;

/** For the public bootstrap; read at most every 30 s. Per platform, the first source with a feed. */
export async function desktopInfo(sources: UpdateSource[]): Promise<DesktopInfo | null> {
  if (!sources.length) return null;
  const key = sources.map((s) => s.key).join('|');
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.info;
  const releases: DesktopRelease[] = [];
  for (const platform of DesktopPlatform.options) {
    for (const source of sources) {
      const release = await readRelease(source, platform);
      if (release) {
        releases.push(release);
        break;
      }
    }
  }
  const info =
    releases.length === 0
      ? null
      : {
          version: releases
            .map((r) => r.version)
            .sort(compareVersions)
            .at(-1)!,
          platforms: releases,
        };
  cache = { key, at: Date.now(), info };
  return info;
}

export function resetDesktopCache(): void {
  cache = null;
}

/** "0.10.0" > "0.9.3"; pre-release suffixes sort before the plain version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * One byte range of `bytes=a-b`, `bytes=a-` or `bytes=-n`. Several ranges at once are ignored
 * (the whole file is sent, which the RFC allows); the app asks for one range at a time.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from, to] = m;
  if (from === '' && to === '') return null;
  let start: number;
  let end: number;
  if (from === '') {
    const n = Number(to);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const TYPES: Record<string, string> = {
  '.yml': 'text/yaml; charset=utf-8',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
  '.blockmap': 'application/octet-stream',
};

/** The file response from the first source that has it, or null when none does. */
export async function updateFileResponse(
  sources: UpdateSource[],
  platform: DesktopPlatform,
  file: string,
  { range, head }: { range?: string; head?: boolean },
): Promise<Response | null> {
  if (!safeFileName(file)) return null;
  let source: UpdateSource | null = null;
  let info: FileInfo | null = null;
  for (const s of sources) {
    info = await s.stat(platform, file);
    if (info) {
      source = s;
      break;
    }
  }
  if (!source || !info) return null;
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  const headers = new Headers({
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // The feed must be read fresh; installers carry their version in the name.
    'Cache-Control': ext === '.yml' ? 'no-cache' : 'public, max-age=3600',
  });
  if (info.etag) headers.set('ETag', info.etag);
  if (info.modified) headers.set('Last-Modified', info.modified.toUTCString());
  if (ext !== '.yml') headers.set('Content-Disposition', `attachment; filename="${file}"`);

  const r = parseRange(range, info.size);
  if (r === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = r ? r.start : 0;
  const end = r ? r.end : info.size - 1;
  headers.set('Content-Length', String(info.size === 0 ? 0 : end - start + 1));
  if (r) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  const status = r ? 206 : 200;
  if (head || info.size === 0) return new Response(null, { status, headers });
  return new Response(await source.open(platform, file, r), { status, headers });
}
