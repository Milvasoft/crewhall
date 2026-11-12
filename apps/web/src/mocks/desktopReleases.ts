import {
  DESKTOP_UPLOAD_PART_BYTES,
  type DesktopPlatform,
  type DesktopPlatformReleases,
  type EndpointName,
} from '@crewhall/shared';
import { http, HttpResponse } from 'msw';
import { fileKind, MAIN_KIND, versionOf } from '@/features/desktopReleases/files';
import { newId } from '@/lib/ids';
import { actorOf, MockApiError, requireUser, type Resolvers } from './core';
import { type MockState } from './seed';

/**
 * Yönetim › Masaüstü sürümleri mock, same rules as the backend: the bucket is the state (files by
 * name, versions read from the names), publishing points the feed at a version (an older one rolls
 * back), the published version's files can be neither replaced nor deleted, blockmaps stay unless
 * asked, and a platform served from the server's folder cannot be published here.
 */
interface Stored {
  size: number;
  uploadedAt: string;
}

interface State {
  storage: boolean;
  /** Platforms whose feed comes from DESKTOP_UPDATES_DIR. */
  folder: DesktopPlatform[];
  files: Record<DesktopPlatform, Map<string, Stored>>;
  current: Record<DesktopPlatform, { version: string; releasedAt: string } | null>;
  /** A proxy in front of the store refusing larger requests with 413 (Cloudflare: 100 MB). */
  proxyLimit: number | null;
  partSize: number;
  /** Unfinished multipart uploads: the parts the store has, by number. */
  uploads: Map<
    string,
    { platform: DesktopPlatform; fileName: string; sizeBytes: number; parts: Map<number, number> }
  >;
  /** Part PUTs that fail like a dropped connection, by part number (tests resuming). */
  dropParts: Set<number>;
  /** The bucket CORS hides ETag (misconfigured). */
  hideEtag: boolean;
}

interface Options {
  storage?: boolean;
  folder?: DesktopPlatform[];
  seed?: boolean;
  proxyLimit?: number;
  partSize?: number;
  dropParts?: number[];
  hideEtag?: boolean;
}

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9)).toISOString();

function initial(opts: Options): State {
  const seed = opts.seed !== false;
  const win = new Map<string, Stored>();
  if (seed) {
    for (const [v, d] of [
      ['0.2.4', 14],
      ['0.2.5', 21],
    ] as const) {
      win.set(`Crewhall-Setup-${v}.exe`, { size: 114_857_600, uploadedAt: day(d) });
      win.set(`Crewhall-Setup-${v}.exe.blockmap`, { size: 121_344, uploadedAt: day(d) });
    }
  }
  return {
    storage: opts.storage ?? true,
    folder: opts.folder ?? [],
    files: { win, mac: new Map() },
    current: { win: seed ? { version: '0.2.5', releasedAt: day(21) } : null, mac: null },
    proxyLimit: opts.proxyLimit ?? null,
    partSize: opts.partSize ?? DESKTOP_UPLOAD_PART_BYTES,
    uploads: new Map(),
    dropParts: new Set(opts.dropParts ?? []),
    hideEtag: opts.hideEtag ?? false,
  };
}

let state = initial({});

/** Tests: start clean and shape the server (no S3, a platform served from the folder, empty). */
export function resetDesktopReleasesMock(opts: Options = {}): void {
  state = initial(opts);
  stored.clear();
}

/** Tests: the connection is back, parts go through again. */
export function restoreDesktopUploads(): void {
  state.dropParts.clear();
}

/** Tests: unfinished uploads the server still holds. */
export const pendingDesktopUploads = () => state.uploads.size;

/** Tests: how many times each part number reached the store. */
const stored = new Map<number, number>();
export const storedPartCounts = () => Object.fromEntries(stored);

function requireInstallAdmin(s: MockState) {
  if (actorOf(s, requireUser(s)).orgRole !== 'owner') throw new MockApiError('forbidden');
}

const parts = (v: string) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));

/** Semver order, newest first (1.0.0 before 1.0.0-beta). */
function newerFirst(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    return typeof p === 'number' && typeof q === 'number'
      ? q - p
      : String(q).localeCompare(String(p));
  }
  return 0;
}

function platformState(platform: DesktopPlatform): DesktopPlatformReleases {
  const current = state.current[platform];
  const byVersion = new Map<string, DesktopPlatformReleases['versions'][number]['files']>();
  for (const [name, f] of state.files[platform]) {
    const version = versionOf(name);
    const kind = fileKind(name, platform);
    if (!version || !kind) continue;
    const list = byVersion.get(version) ?? [];
    list.push({
      name,
      kind,
      sizeBytes: f.size,
      sha512: current?.version === version ? `mock-sha512-${name}` : null,
      uploadedAt: f.uploadedAt,
    });
    byVersion.set(version, list);
  }
  const versions = [...byVersion.entries()]
    .sort(([a], [b]) => newerFirst(a, b))
    .map(([version, files]) => ({
      version,
      current: current?.version === version,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
      uploadedAt:
        files
          .map((f) => f.uploadedAt ?? '')
          .sort()
          .at(-1) || null,
    }));
  return {
    platform,
    servedFrom: state.folder.includes(platform) ? 'folder' : current ? 's3' : null,
    current,
    versions,
  };
}

export const desktopReleaseResolvers: Partial<Resolvers<EndpointName>> = {
  listDesktopReleases: ({ s }) => {
    requireInstallAdmin(s);
    return { storage: state.storage, platforms: [platformState('win'), platformState('mac')] };
  },

  startDesktopUpload: ({ s, body, request }) => {
    requireInstallAdmin(s);
    if (!state.storage) throw new MockApiError('desktop_storage_missing');
    const { platform, fileName, sizeBytes } = body;
    if (!fileKind(fileName, platform) || !versionOf(fileName)) {
      throw new MockApiError('desktop_file_invalid');
    }
    if (state.current[platform]?.version === versionOf(fileName)) {
      throw new MockApiError('desktop_release_in_use');
    }
    // The same file again continues its unfinished upload; another size starts over.
    let uploadId: string | undefined;
    for (const [id, u] of state.uploads) {
      if (u.platform !== platform || u.fileName !== fileName) continue;
      if (u.sizeBytes === sizeBytes && !uploadId) uploadId = id;
      else state.uploads.delete(id);
    }
    if (!uploadId) {
      uploadId = `mock-${newId()}`;
      state.uploads.set(uploadId, { platform, fileName, sizeBytes, parts: new Map() });
    }
    const have = state.uploads.get(uploadId)!.parts;
    const origin = new URL(request.url).origin;
    const count = Math.max(1, Math.ceil(sizeBytes / state.partSize));
    return {
      uploadId,
      partSize: state.partSize,
      parts: Array.from({ length: count }, (_, i) => i + 1)
        .filter((n) => !have.has(n))
        .map((n) => ({ partNumber: n, url: `${origin}/__mock-desktop-part/${uploadId}/${n}` })),
      ...(have.size
        ? {
            uploadedParts: [...have].map(([partNumber, size]) => ({
              partNumber,
              etag: `"part-${partNumber}"`,
              sizeBytes: size,
            })),
          }
        : {}),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  },

  completeDesktopUpload: ({ s, params, body }) => {
    requireInstallAdmin(s);
    const up = state.uploads.get(params.upload ?? '');
    if (!up || up.fileName !== body.fileName) throw new MockApiError('not_found');
    const missing = body.parts.some(
      (p) => !up.parts.has(p.partNumber) || p.etag !== `"part-${p.partNumber}"`,
    );
    if (missing) throw new MockApiError('desktop_file_missing');
    const size = [...up.parts.values()].reduce((a, b) => a + b, 0);
    const uploadedAt = new Date().toISOString();
    state.files[up.platform].set(up.fileName, { size, uploadedAt });
    state.uploads.delete(params.upload ?? '');
    return {
      name: up.fileName,
      kind: fileKind(up.fileName, up.platform) ?? 'installer',
      sizeBytes: size,
      sha512: null,
      uploadedAt,
    };
  },

  abortDesktopUpload: ({ s, params }) => {
    requireInstallAdmin(s);
    state.uploads.delete(params.upload ?? '');
    return {};
  },

  publishDesktopRelease: ({ s, body }) => {
    requireInstallAdmin(s);
    const { platform } = body;
    if (state.folder.includes(platform)) throw new MockApiError('desktop_served_from_folder');
    if (fileKind(body.installer, platform) !== MAIN_KIND[platform]) {
      throw new MockApiError('desktop_file_invalid');
    }
    const files = state.files[platform];
    if (!files.has(body.installer) || (body.dmg && !files.has(body.dmg))) {
      throw new MockApiError('desktop_file_missing');
    }
    const version = body.version ?? versionOf(body.installer);
    if (!version) throw new MockApiError('desktop_version_invalid');
    state.current[platform] = { version, releasedAt: new Date().toISOString() };
    return platformState(platform);
  },

  deleteDesktopRelease: ({ s, params, query }) => {
    requireInstallAdmin(s);
    const platform = params.platform as DesktopPlatform;
    const version = params.version ?? '';
    if (state.current[platform]?.version === version) {
      throw new MockApiError('desktop_release_in_use');
    }
    const files = state.files[platform];
    const names = [...files.keys()].filter((n) => versionOf(n) === version);
    if (!names.length) throw new MockApiError('not_found');
    for (const n of names) {
      // Blockmaps stay by default: older apps still update by difference against them.
      if (fileKind(n, platform) === 'blockmap' && query.blockmaps !== 'true') continue;
      files.delete(n);
    }
    return platformState(platform);
  },
};

/** The presigned part PUTs the mock hands out. */
export const desktopReleaseRawHandlers = [
  http.put('*/__mock-desktop-part/:upload/:part', async ({ request, params }) => {
    const n = Number(params.part);
    if (state.dropParts.has(n)) return HttpResponse.error();
    const size = (await request.arrayBuffer()).byteLength;
    if (state.proxyLimit !== null && size > state.proxyLimit) {
      return new HttpResponse('Request Entity Too Large', { status: 413 });
    }
    const up = state.uploads.get(String(params.upload));
    if (!up) return new HttpResponse('NoSuchUpload', { status: 404 });
    up.parts.set(n, size);
    stored.set(n, (stored.get(n) ?? 0) + 1);
    return new HttpResponse(null, {
      status: 200,
      headers: state.hideEtag ? {} : { ETag: `"part-${n}"` },
    });
  }),
];
