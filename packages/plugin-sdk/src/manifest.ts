import { z } from 'zod';

/**
 * The plugin manifest (docs/contracts/eklentiler.md › Manifest). Crewhall never runs plugin
 * code: the manifest says where the plugin's own server is (`origin`), what it may do
 * (`permissions`) and where it plugs in (`entryPoints`). The marketplace signs it.
 */

/** The plugin contract this SDK speaks; a Crewhall installation accepts `apiLevel.min` up to it. */
export const PLUGIN_API_LEVEL = 2;

/**
 * Crewhall's personal token / MCP scopes (`MCP_SCOPES`): a plugin acting for a person gets at
 * most these, and never more than the person has. `offline:access` is the plugins' own: no
 * token or assistant connection can hold it.
 */
export const PLUGIN_PERMISSIONS = [
  'hub:read',
  'pages:write',
  'quick:write',
  'drive:write',
  'boards:write',
  'chat:send',
  'portal:draft',
  'portal:publish',
  'meetings:write',
  'calendar:write',
  'contacts:write',
  'tables:write',
  /** Notify people who opened the plugin (installation-level, docs/contracts/eklentiler.md). */
  'notifications:write',
  /**
   * Work while nobody has the plugin open, as a person who said yes in Crewhall's own dialog
   * (docs/contracts/eklentiler.md › Arka planda çalışma).
   */
  'offline:access',
] as const;
export const PluginPermission = z.enum(PLUGIN_PERMISSIONS);
export type PluginPermission = z.infer<typeof PluginPermission>;

/**
 * Browser features a plugin's tabs and cards may use (docs/contracts/eklentiler.md › Tarayıcı
 * yetenekleri). The admin grants them like permissions; only granted ones are delegated to the
 * frame (`allow`), and only for the plugin's own origin.
 */
export const PLUGIN_BROWSER_CAPABILITIES = [
  'microphone',
  'camera',
  'geolocation',
  'clipboard-write',
] as const;
export const PluginBrowserCapability = z.enum(PLUGIN_BROWSER_CAPABILITIES);
export type PluginBrowserCapability = z.infer<typeof PluginBrowserCapability>;

/**
 * The iframe `allow` attribute for the granted capabilities, each for `origin` only:
 * `microphone https://wa.acme.com; geolocation https://wa.acme.com`. Empty grants nothing.
 */
export function frameAllow(origin: string, granted: readonly PluginBrowserCapability[]): string {
  return PLUGIN_BROWSER_CAPABILITIES.filter((c) => granted.includes(c))
    .map((c) => `${c} ${origin}`)
    .join('; ');
}

/**
 * Events a plugin may subscribe to; each needs `hub:read`. Payloads carry ids and metadata only:
 * content is read through the API with a person's session token, within their access.
 */
export const PLUGIN_EVENTS = [
  /** A message in a group, space or alert conversation (never direct chats). */
  'message.created',
  'node.created',
  'node.updated',
  'member.joined',
  /** A board card changed (`data.change`: created, updated, moved, deleted, restored, assignees, comment). */
  'board.card.changed',
] as const;
export const PluginEventType = z.enum(PLUGIN_EVENTS);
export type PluginEventType = z.infer<typeof PluginEventType>;

/** Reverse domain name, at least two labels: `com.acme.whatsapp`. */
export const PluginId = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/, 'reverse domain name, e.g. com.acme.tool');
export type PluginId = z.infer<typeof PluginId>;

export const SemVer = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/, 'semver: 1.2.3');

/** One string, or one per language (`tr` is the fallback, then `en`). */
export const LocalizedText = z.union([
  z.string().min(1).max(500),
  z
    .object({
      tr: z.string().min(1).max(500).optional(),
      en: z.string().min(1).max(500).optional(),
    })
    .refine((v) => v.tr || v.en, 'tr or en'),
]);
export type LocalizedText = z.infer<typeof LocalizedText>;

export function localize(text: LocalizedText, locale: string): string {
  if (typeof text === 'string') return text;
  return (locale === 'en' ? (text.en ?? text.tr) : (text.tr ?? text.en)) ?? '';
}

/** A path on the plugin's own origin: `/tab?x=1`; never another host. */
export const PluginPath = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)[^\s\\]*$/, 'a path starting with / on the plugin origin');

/** https origin; http only for localhost while developing. */
export const PluginOrigin = z
  .string()
  .max(255)
  .refine((v) => {
    try {
      const u = new URL(v);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      return u.origin === v && (u.protocol === 'https:' || (u.protocol === 'http:' && local));
    } catch {
      return false;
    }
  }, 'an https origin like https://plugin.example.com (http only on localhost)');

const Key = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const PluginTab = z.object({
  id: Key,
  title: LocalizedText,
  /** A Crewhall icon name (ui icons); a generic one when unknown. */
  icon: z.string().max(32).optional(),
  url: PluginPath,
  /** `rail`: its own module in the left rail; `chat`: a tab in the chat sidebar. */
  placement: z.enum(['rail', 'chat']),
  /** Also in the mobile app (its Eklentiler screen); false for a desktop-only page. */
  mobile: z.boolean().default(true),
});
export type PluginTab = z.infer<typeof PluginTab>;

export const PluginCard = z.object({
  id: Key,
  title: LocalizedText,
  url: PluginPath,
  size: z.enum(['s', 'm', 'l']).default('m'),
  /** Also on the mobile home screen. */
  mobile: z.boolean().default(true),
});
export type PluginCard = z.infer<typeof PluginCard>;

export const PluginCommand = z.object({
  /** Typed as `/name` in a chat composer. */
  name: Key,
  description: LocalizedText,
  /** POST target on the plugin server (signed request). */
  url: PluginPath,
});
export type PluginCommand = z.infer<typeof PluginCommand>;

export const PluginTool = z.object({
  /** Shown to assistants as `plugin.<id>.<name>`. */
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  description: z.string().min(1).max(1000),
  /** JSON Schema of the input (an object schema). */
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  url: PluginPath,
  /** Changes data: waits for the person's approval like Crewhall's own write tools. */
  write: z.boolean().default(false),
});
export type PluginTool = z.infer<typeof PluginTool>;

export const PluginEvent = z.object({
  type: PluginEventType,
  url: PluginPath,
});
export type PluginEvent = z.infer<typeof PluginEvent>;

/**
 * `hosted`: one server at `origin` for every organization (the publisher runs it).
 * `self`: each organization runs its own copy; `origin` is the reviewed reference deployment,
 * the admin gives their own https origin at install and that copy must serve the same manifest
 * at `/.well-known/crewhall-plugin.json` (docs/contracts/eklentiler.md › Kendi sunucusunda).
 */
export const PluginHosting = z.enum(['hosted', 'self']);
export type PluginHosting = z.infer<typeof PluginHosting>;

/** Where a self-hosted copy serves its manifest. */
export const SELF_HOSTED_MANIFEST_PATH = '/.well-known/crewhall-plugin.json';

export const PluginManifest = z
  .object({
    manifestVersion: z.literal(1),
    id: PluginId,
    version: SemVer,
    name: LocalizedText,
    /**
     * Short source name on its notifications ("WhatsApp"), when `name` carries more than the
     * source (a warning, a suffix). Default: its only tab's title, else `name`.
     */
    notificationName: LocalizedText.optional(),
    description: LocalizedText,
    publisher: z.object({
      name: z.string().min(1).max(120),
      url: z.url().max(255).optional(),
      email: z.email().max(255).optional(),
    }),
    homepage: z.url().max(255).optional(),
    /** Icon on the plugin origin (square, 128 px or more). */
    icon: PluginPath.optional(),
    apiLevel: z.object({
      min: z.number().int().min(1),
      max: z.number().int().min(1).optional(),
    }),
    origin: PluginOrigin,
    hosting: PluginHosting.default('hosted'),
    permissions: z.array(PluginPermission).max(PLUGIN_PERMISSIONS.length).default([]),
    /** Browser features its frames may ask for; each needs the admin's grant. */
    browser: z.array(PluginBrowserCapability).max(PLUGIN_BROWSER_CAPABILITIES.length).default([]),
    entryPoints: z
      .object({
        tabs: z.array(PluginTab).max(8).default([]),
        cards: z.array(PluginCard).max(8).default([]),
        commands: z.array(PluginCommand).max(16).default([]),
        tools: z.array(PluginTool).max(32).default([]),
        events: z.array(PluginEvent).max(16).default([]),
      })
      .default({ tabs: [], cards: [], commands: [], tools: [], events: [] }),
    /** Install / uninstall callbacks (signed): the installation secret arrives here once. */
    lifecycle: z
      .object({ url: PluginPath.default('/crewhall/lifecycle') })
      .default({ url: '/crewhall/lifecycle' }),
  })
  .superRefine((m, ctx) => {
    const unique = (list: string[], path: string) => {
      const seen = new Set<string>();
      for (const v of list) {
        if (seen.has(v))
          ctx.addIssue({ code: 'custom', path: ['entryPoints', path], message: `duplicate ${v}` });
        seen.add(v);
      }
    };
    unique(
      m.entryPoints.tabs.map((t) => t.id),
      'tabs',
    );
    unique(
      m.entryPoints.cards.map((t) => t.id),
      'cards',
    );
    unique(
      m.entryPoints.commands.map((t) => t.name),
      'commands',
    );
    unique(
      m.entryPoints.tools.map((t) => t.name),
      'tools',
    );
    if (new Set(m.browser).size !== m.browser.length) {
      ctx.addIssue({ code: 'custom', path: ['browser'], message: 'duplicate capability' });
    }
    if (m.apiLevel.max !== undefined && m.apiLevel.max < m.apiLevel.min) {
      ctx.addIssue({ code: 'custom', path: ['apiLevel'], message: 'max < min' });
    }
    if (m.entryPoints.events.length && !m.permissions.includes('hub:read')) {
      ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'events need hub:read' });
    }
    if (m.entryPoints.tools.some((t) => t.write) && !m.permissions.some((p) => p !== 'hub:read')) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions'],
        message: 'write tools need a write permission',
      });
    }
  });
export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginManifestInput = z.input<typeof PluginManifest>;

/** Can an installation at `level` run this manifest? */
export function apiLevelSupported(
  manifest: Pick<PluginManifest, 'apiLevel'>,
  level = PLUGIN_API_LEVEL,
) {
  return manifest.apiLevel.min <= level && (manifest.apiLevel.max ?? Infinity) >= level;
}

/** Absolute URL of a manifest path on the plugin origin. */
export function pluginUrl(manifest: Pick<PluginManifest, 'origin'>, path: string): string {
  const u = new URL(path, manifest.origin);
  if (u.origin !== manifest.origin) throw new Error('path leaves the plugin origin');
  return u.toString();
}

/** Compares two semver strings (pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2) as [string, string | undefined];
    return { nums: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
