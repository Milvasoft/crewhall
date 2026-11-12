import SMB2 from 'v9u-smb2';
import type { MountItem } from '@crewhall/shared';
import { joinPath, mimeOf, type MountAdapter } from './adapter';

/**
 * Windows file shares (SMB 2, NTLMv2 with a service account). Kerberos is not available to a
 * server-side Node client; the desktop app's virtual drive will cover per-person access later.
 */

export interface SmbTarget {
  share: string;
  domain: string;
  username: string;
  password: string;
  rootPath: string;
}

/** Swappable for tests: there is no SMB server in the test stack. */
type ClientFactory = (t: SmbTarget) => Pick<
  SMB2,
  'readdir' | 'readFile' | 'writeFile' | 'mkdir' | 'exists' | 'getSize' | 'disconnect'
>;

const defaultFactory: ClientFactory = (t) =>
  new SMB2({
    share: t.share.replace(/\//g, '\\'),
    domain: t.domain,
    username: t.username,
    password: t.password,
    autoCloseTimeout: 0,
  });

let factory = defaultFactory;

export function setSmbClientFactory(f: ClientFactory | null) {
  factory = f ?? defaultFactory;
}

const win = (path: string) => path.split('/').filter(Boolean).join('\\');

async function freeName(
  client: ReturnType<ClientFactory>,
  folder: string,
  name: string,
) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    if (!(await client.exists(win(joinPath(folder, candidate))))) return candidate;
  }
  throw new Error('no free name');
}

export function smbAdapter(target: SmbTarget): MountAdapter {
  const full = (path: string) => joinPath(target.rootPath, path);
  /** One connection per operation; closed afterwards so idle mounts hold no sockets. */
  const withClient = async <T>(run: (c: ReturnType<ClientFactory>) => Promise<T>) => {
    const client = factory(target);
    try {
      return await run(client);
    } finally {
      client.disconnect();
    }
  };
  return {
    list: (path) =>
      withClient(async (c) => {
        const entries = await c.readdir(win(full(path)), { stats: true });
        const items: MountItem[] = entries.map((e) => ({
          name: e.name,
          path: joinPath(path, e.name),
          type: e.isDirectory() ? 'folder' : 'file',
          sizeBytes: null,
          mime: e.isDirectory() ? null : mimeOf(e.name),
          modifiedAt: e.mtime ? new Date(e.mtime).toISOString() : null,
        }));
        return items.sort((x, y) =>
          x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'folder' ? -1 : 1,
        );
      }),
    read: (path) =>
      withClient(async (c) => {
        const body = await c.readFile(win(full(path)));
        const name = path.split('/').pop() ?? path;
        return { name, mime: mimeOf(name), size: body.length, body };
      }),
    write: (folder, name, content, mime) =>
      withClient(async (c) => {
        const free = await freeName(c, full(folder), name);
        await c.writeFile(win(full(joinPath(folder, free))), content);
        return {
          name: free,
          path: joinPath(folder, free),
          type: 'file' as const,
          sizeBytes: content.length,
          mime: mime ?? mimeOf(free),
          modifiedAt: new Date().toISOString(),
        };
      }),
    mkdir: (folder, name) =>
      withClient(async (c) => {
        const free = await freeName(c, full(folder), name);
        await c.mkdir(win(full(joinPath(folder, free))));
        return {
          name: free,
          path: joinPath(folder, free),
          type: 'folder' as const,
          sizeBytes: null,
          mime: null,
          modifiedAt: new Date().toISOString(),
        };
      }),
    check: () =>
      withClient(async (c) => {
        await c.readdir(win(full('')), { stats: true });
      }),
  };
}
