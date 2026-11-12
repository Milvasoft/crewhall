import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** What Windows asks of the provider while the folder is connected. */
export interface CloudFetchEvent {
  /**
   * `cancel` is no prompt signal. Closing the program reading the file sends nothing; it came about
   * a minute later, and only when another program was waiting for the same file. A download that
   * goes on regardless still completes the file.
   */
  type: 'fetch' | 'cancel';
  /** Absolute path, as Windows sees it now. */
  path: string;
  /** What the placeholder was created with. */
  identity: string;
  transferKey: string;
  offset: number;
  length: number;
  fileSize: number;
  /** The program reading the file; empty when Windows did not say. */
  process: string;
}

export interface CloudRootOptions {
  root: string;
  provider: string;
  account: string;
  /** Also adds the folder to Explorer's navigation pane, which writes to the registry. */
  shell?: boolean;
}

export interface NewPlaceholder {
  name: string;
  identity: string;
  size?: number;
  mtimeMs?: number;
  folder?: boolean;
}

export interface PlaceholderInfo {
  /** False for a plain file, which is what a new local file is until it is converted. */
  placeholder: boolean;
  inSync: boolean;
  identity: string;
  size: number;
  /** Bytes actually held on disk: 0 until the file is downloaded. */
  onDisk: number;
  pin: number;
}

/** What the "always keep" and "free up space" commands set. */
export const PinState = { unspecified: 0, pinned: 1, unpinned: 2 } as const;
export type PinStateValue = (typeof PinState)[keyof typeof PinState];

/** A rejected call carries the Windows code as `hresult`, as in "0x80070020". */
export type CloudFilesError = Error & { hresult: string };

/** Plain wrappers over the Cloud Files API (native/cloudfiles); each runs off the main thread. */
export interface CloudFilesNative {
  registerRoot(
    options: CloudRootOptions & {
      version: string;
      displayName?: string;
      icon?: string;
      /** What Explorer calls the state `setItemState` sets. */
      stateName?: string;
    },
  ): Promise<void>;
  unregisterRoot(options: CloudRootOptions): Promise<void>;
  /** Resolves to the key the other calls take. */
  connect(root: string, onEvent: (event: CloudFetchEvent) => void): Promise<string>;
  disconnect(key: string): Promise<void>;
  /** `data` from `offset`: 4 KB aligned, and so is the length except at the end of the file. */
  transfer(
    key: string,
    transferKey: string,
    data: Buffer,
    offset: number,
    total: number,
  ): Promise<void>;
  /** The program reading the file gets a read error. `status` is an NTSTATUS. */
  transferFail(
    key: string,
    transferKey: string,
    offset: number,
    length: number,
    status: number,
  ): Promise<void>;
  /** Into the existing folder `parent`; resolves to one HRESULT string per item. */
  createPlaceholders(parent: string, items: NewPlaceholder[]): Promise<string[]>;
  info(path: string): Promise<PlaceholderInfo>;
  /** The file's attributes, without opening it: works on any provider's placeholder. */
  attributes(path: string): Promise<number>;
  updatePlaceholder(
    path: string,
    update: {
      identity?: string;
      size?: number;
      mtimeMs?: number;
      dehydrate?: boolean;
      /** Fail if the file changed since it was last marked in sync. */
      verifyInSync?: boolean;
    },
  ): Promise<void>;
  convertToPlaceholder(path: string, identity: string): Promise<void>;
  dehydrate(path: string): Promise<void>;
  /** Resolves once the whole file is here, and holds a pool thread that long: keep these few. */
  hydrate(path: string): Promise<void>;
  /** `recurse`: everything inside a folder too. */
  setPin(path: string, state: PinStateValue, recurse?: boolean): Promise<void>;
  /** An icon and text next to Explorer's own status; empty `text` takes it off. */
  setItemState(path: string, text: string, icon: string): Promise<void>;
}

/** Where scripts/build.mjs puts the add-on, out of the asar so that Windows can load it. */
function packagedFile(): string {
  return join(__dirname, 'native', `win32-${process.arch}`, 'cloudfiles.node').replace(
    'app.asar',
    'app.asar.unpacked',
  );
}

/**
 * The add-on, or null where there is none (another OS, a build without it, a Windows too old for
 * the API): the app then simply offers no virtual drive.
 */
export function loadCloudFiles(
  file?: string,
  platform: NodeJS.Platform = process.platform,
): CloudFilesNative | null {
  if (platform !== 'win32') return null;
  const path = file ?? packagedFile();
  if (!existsSync(path)) return null;
  try {
    return createRequire(__filename)(path) as CloudFilesNative;
  } catch {
    return null;
  }
}
