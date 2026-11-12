import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DEFAULT_GLOBAL_SHORTCUT } from '../common/global-shortcut';

const Pair = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  spaceName: z.string(),
  folderId: z.string().nullable(),
  folderPath: z.string(),
  localPath: z.string().min(1),
  paused: z.boolean(),
});

const Brand = z.object({
  orgName: z.string(),
  appName: z.string(),
  logoUrl: z.string().nullable(),
  iconUrl: z.string().nullable(),
  showPoweredBy: z.boolean(),
  defaultLocale: z.string(),
  /** What the server offers (bootstrap `server.capabilities`): e.g. English web paths. */
  capabilities: z.array(z.string()).default([]),
});

const Settings = z.object({
  /** Origin of the organization's server; null until the first-run screen is done. */
  serverUrl: z.string().nullable().default(null),
  brand: Brand.nullable().default(null),
  notifications: z.boolean().default(true),
  /** System-wide shortcut that opens the app; null: switched off. */
  globalShortcut: z.string().nullable().default(DEFAULT_GLOBAL_SHORTCUT),
  /** "Gönder → Crewhall" and "Crewhall'a yükle" in Windows Explorer. */
  explorerMenu: z.boolean().default(true),
  /** The signed-in person's language (GET /me), so the shell speaks like the web app. */
  userLocale: z.string().nullable().default(null),
  /** Autostart is switched on once, at the first connect; afterwards the person decides. */
  autostartInitialized: z.boolean().default(false),
  /** Developers only: another update feed instead of the server's /api/v1/desktop/updates. */
  updateUrl: z.url().nullable().default(null),
  syncPairs: z.array(Pair).default([]),
  /** The virtual drive; `userId`: whose files are on disk, so that another person's never mix in. */
  virtualDrive: z
    .object({
      enabled: z.boolean(),
      root: z.string().nullable(),
      userId: z.string().nullable(),
    })
    .default({ enabled: false, root: null, userId: null }),
  bounds: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .default(null),
  /** Last size and place of a meeting window (shared by all meetings). */
  meetingBounds: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .default(null),
});

export type Settings = z.infer<typeof Settings>;
export type StoredBrand = z.infer<typeof Brand>;

/** userData/settings.json; invalid or missing files fall back to defaults. */
export class SettingsStore {
  private value: Settings;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    this.value = SettingsStore.read(file);
  }

  static read(file: string): Settings {
    try {
      const parsed = Settings.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // first run
    }
    return Settings.parse({});
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch };
    const snapshot = JSON.stringify(this.value, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, snapshot);
      await rename(`${this.file}.tmp`, this.file);
    });
    return this.value;
  }

  flush(): Promise<void> {
    return this.writing;
  }
}
