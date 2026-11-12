import { z } from 'zod';
import { PluginBrowserCapability, PluginPermission } from './manifest';

/**
 * The iframe bridge (docs/contracts/eklentiler.md › Köprü): a plugin page inside Crewhall talks
 * to the host only through `postMessage`. The host answers only the plugin origin from the
 * manifest and only its own iframe; the plugin talks only to the window that sent `init`.
 *
 * Host → plugin: `init` (who, where, theme), `theme`, `response`.
 * Plugin → host: `ready`, `request` (token, navigate, toast, resize).
 */

export const BRIDGE_VERSION = 1;

export const Theme = z.object({
  scheme: z.enum(['light', 'dark']),
  /** The org's accent colour, #rrggbb. */
  accent: z.string().max(16),
});
export type Theme = z.infer<typeof Theme>;

/**
 * A list of enum values where an older build may meet values it does not know yet: a host and a
 * plugin page ship on their own schedules (a phone app keeps its SDK copy until it updates), so a
 * value added later is dropped instead of failing the whole frame.
 */
function knownOnly<T extends string>(values: z.ZodType<T>) {
  return z
    .array(z.string())
    .default([])
    .transform((list) => list.filter((v): v is T => values.safeParse(v).success));
}

export const BridgeContext = z.object({
  pluginId: z.string(),
  installationId: z.string(),
  placement: z.enum(['rail', 'chat', 'card']),
  /** The tab or card id from the manifest. */
  entryId: z.string(),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  org: z.object({ id: z.string(), name: z.string() }),
  locale: z.string(),
  theme: Theme,
  /** Where the page runs: Crewhall's web app or a WebView in the mobile app. */
  platform: z.enum(['web', 'mobile']).default('web'),
  /** What the admin granted this installation (may be less than the manifest asks for). */
  permissions: knownOnly(PluginPermission),
  /** Browser features granted to this frame (the rest are not delegated). */
  browser: knownOnly(PluginBrowserCapability),
});
export type BridgeContext = z.infer<typeof BridgeContext>;
/** What a host passes; `platform` and `permissions` have defaults. */
export type BridgeContextInput = z.input<typeof BridgeContext>;

export const BridgeRequest = z.discriminatedUnion('method', [
  /** A fresh session token (5 minutes) for the plugin server. */
  z.object({ method: z.literal('token') }),
  /** Open a Crewhall screen, e.g. `/chat/c/<id>`. */
  z.object({
    method: z.literal('navigate'),
    to: z
      .string()
      .regex(/^\/(?!\/)/)
      .max(500),
  }),
  z.object({
    method: z.literal('toast'),
    text: z.string().min(1).max(300),
    tone: z.enum(['info', 'error']).default('info'),
  }),
  /** Cards: the height the content needs (the host clamps it). */
  z.object({ method: z.literal('resize'), height: z.number().int().min(40).max(2000) }),
  /**
   * Background access for this person: `status` only reads, `grant` opens Crewhall's own consent
   * dialog, `revoke` takes it back. Answers `{ granted }`.
   */
  z.object({
    method: z.literal('offlineAccess'),
    action: z.enum(['status', 'grant', 'revoke']),
  }),
]);
export type BridgeRequest = z.infer<typeof BridgeRequest>;

const Envelope = z.object({ crewhall: z.literal(BRIDGE_VERSION), id: z.string().max(64) });

export const PluginToHost = z.discriminatedUnion('type', [
  Envelope.extend({ type: z.literal('ready') }),
  Envelope.extend({ type: z.literal('request'), request: BridgeRequest }),
]);
export type PluginToHost = z.infer<typeof PluginToHost>;

export const HostToPlugin = z.discriminatedUnion('type', [
  Envelope.extend({ type: z.literal('init'), context: BridgeContext }),
  Envelope.extend({ type: z.literal('theme'), theme: Theme }),
  Envelope.extend({
    type: z.literal('response'),
    replyTo: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
export type HostToPlugin = z.infer<typeof HostToPlugin>;

const newId = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

// ---- plugin side ----

export interface Bridge {
  readonly context: BridgeContext;
  /** A session token for the plugin server, cached until shortly before it expires. */
  getToken(): Promise<string>;
  navigate(to: string): Promise<void>;
  toast(text: string, tone?: 'info' | 'error'): Promise<void>;
  resize(height: number): Promise<void>;
  offlineAccess(action: 'status' | 'grant' | 'revoke'): Promise<{ granted: boolean }>;
  onTheme(listener: (theme: Theme) => void): () => void;
  close(): void;
}

/** react-native-webview's channel from the page to the app. */
interface NativeChannel {
  postMessage(message: string): void;
}

interface WindowLike {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (e: MessageEvent) => void): void;
}

/** How often, and how many times at most, `connect()` says `ready` until `init` comes. */
export const READY_RETRY_MS = 1_000;
export const READY_MAX_TRIES = 15;

/**
 * Call from the plugin page: announces `ready` and resolves with the bridge once the host
 * sends `init`. The first window that answers becomes the only one the bridge talks to. In the
 * mobile app's WebView (react-native-webview) the same calls go through the native channel.
 *
 * `ready` is said again every second (at most 15 times) until `init` arrives: the page may load
 * before the host listens (a WebView's message handler, a frame mounted late), and a single
 * `ready` would then be lost. Hosts answer each one with the same `init`; later ones are ignored.
 */
export function connect(
  opts: {
    timeoutMs?: number;
    window?: WindowLike;
    native?: NativeChannel;
    retryMs?: number;
    maxTries?: number;
  } = {},
): Promise<Bridge> {
  const win = opts.window ?? (globalThis as unknown as WindowLike);
  const retryMs = opts.retryMs ?? READY_RETRY_MS;
  const maxTries = opts.maxTries ?? READY_MAX_TRIES;
  // Long enough for every try and a moment for the last answer.
  const timeoutMs = opts.timeoutMs ?? retryMs * maxTries + 2_000;
  return new Promise((resolve, reject) => {
    let hostOrigin: string | null = null;
    let context: BridgeContext | null = null;
    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const themeListeners = new Set<(t: Theme) => void>();
    let cached: { token: string; until: number } | null = null;

    // In the mobile app the page is a WebView: messages go out through ReactNativeWebView and
    // come in from the native side, which dispatches them with no source window.
    const native =
      opts.native ?? (globalThis as { ReactNativeWebView?: NativeChannel }).ReactNativeWebView;
    const send = (msg: PluginToHost) =>
      native
        ? native.postMessage(JSON.stringify(msg))
        : win.parent.postMessage(msg, hostOrigin ?? '*');
    const request = <T>(req: z.input<typeof BridgeRequest>) =>
      new Promise<T>((res, rej) => {
        const id = newId();
        pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
        send({ crewhall: BRIDGE_VERSION, id, type: 'request', request: BridgeRequest.parse(req) });
      });

    const onMessage = (e: MessageEvent) => {
      let data: unknown = e.data;
      if (native) {
        // Frames inside the page have a source window; only the app's messages have none.
        if (e.source) return;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data) as unknown;
          } catch {
            return;
          }
        }
      } else {
        if (e.source !== win.parent && opts.window === undefined) return;
        if (hostOrigin && e.origin !== hostOrigin) return;
      }
      const msg = HostToPlugin.safeParse(data);
      if (!msg.success) return;
      const m = msg.data;
      if (m.type === 'init' && !context) {
        hostOrigin = e.origin;
        context = m.context;
        clearTimeout(timer);
        clearInterval(again);
        resolve(bridge);
      } else if (m.type === 'theme') {
        for (const l of themeListeners) l(m.theme);
      } else if (m.type === 'response') {
        const p = pending.get(m.replyTo);
        if (!p) return;
        pending.delete(m.replyTo);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? 'request failed'));
      }
    };

    const bridge: Bridge = {
      get context() {
        return context!;
      },
      async getToken() {
        if (cached && cached.until > Date.now()) return cached.token;
        const r = await request<{ token: string; expiresAt: string }>({ method: 'token' });
        cached = { token: r.token, until: Date.parse(r.expiresAt) - 30_000 };
        return r.token;
      },
      navigate: (to) => request({ method: 'navigate', to }),
      toast: (text, tone = 'info') => request({ method: 'toast', text, tone }),
      resize: (height) => request({ method: 'resize', height: Math.round(height) }),
      offlineAccess: (action) => request({ method: 'offlineAccess', action }),
      onTheme(listener) {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      },
      close() {
        clearInterval(again);
        win.removeEventListener('message', onMessage);
        nativeTarget?.removeEventListener('message', onMessage as EventListener);
        for (const p of pending.values()) p.reject(new Error('bridge closed'));
        pending.clear();
      },
    };

    const timer = setTimeout(() => {
      clearInterval(again);
      win.removeEventListener('message', onMessage);
      nativeTarget?.removeEventListener('message', onMessage as EventListener);
      reject(new Error('no Crewhall host answered'));
    }, timeoutMs);
    win.addEventListener('message', onMessage);
    // react-native-webview delivers on document on Android, on window on iOS.
    const nativeTarget = native && typeof document !== 'undefined' ? document : null;
    nativeTarget?.addEventListener('message', onMessage as EventListener);
    let tries = 0;
    const announce = () => {
      tries++;
      send({ crewhall: BRIDGE_VERSION, id: newId(), type: 'ready' });
    };
    const again = setInterval(() => {
      if (context || tries >= maxTries) clearInterval(again);
      else announce();
    }, retryMs);
    announce();
  });
}

// ---- host side (Crewhall's web and mobile apps) ----

export interface HostHandlers {
  token(): Promise<{ token: string; expiresAt: string }>;
  navigate(to: string): void;
  toast(text: string, tone: 'info' | 'error'): void;
  resize?(height: number): void;
  /** Absent on hosts without the consent dialog: the request fails and the plugin says so. */
  offlineAccess?(action: 'status' | 'grant' | 'revoke'): Promise<{ granted: boolean }>;
}

/** Answers one plugin's messages; the transport (iframe or WebView) is the caller's. */
function hostCore(
  context: BridgeContext,
  handlers: HostHandlers,
  post: (msg: HostToPlugin) => void,
) {
  const receive = async (data: unknown) => {
    const msg = PluginToHost.safeParse(data);
    if (!msg.success) return;
    const m = msg.data;
    if (m.type === 'ready') {
      post({ crewhall: BRIDGE_VERSION, id: newId(), type: 'init', context });
      return;
    }
    const reply = (ok: boolean, result?: unknown, error?: string) =>
      post({
        crewhall: BRIDGE_VERSION,
        id: newId(),
        type: 'response',
        replyTo: m.id,
        ok,
        ...(result !== undefined ? { result } : {}),
        ...(error ? { error } : {}),
      });
    try {
      const r = m.request;
      if (r.method === 'token') return reply(true, await handlers.token());
      if (r.method === 'offlineAccess') {
        if (!handlers.offlineAccess) return reply(false, undefined, 'unsupported');
        return reply(true, await handlers.offlineAccess(r.action));
      }
      if (r.method === 'navigate') handlers.navigate(r.to);
      else if (r.method === 'toast') handlers.toast(r.text, r.tone);
      else if (r.method === 'resize') handlers.resize?.(r.height);
      reply(true);
    } catch (err) {
      reply(false, undefined, err instanceof Error ? err.message : 'failed');
    }
  };
  return {
    receive,
    setTheme: (theme: Theme) =>
      post({ crewhall: BRIDGE_VERSION, id: newId(), type: 'theme', theme }),
  };
}

/**
 * Crewhall side: listens to one plugin iframe. Messages from any other window or origin are
 * ignored; `init` goes out each time the plugin says `ready` (a reload inside the frame).
 */
export function attachHost(opts: {
  window: Window;
  frame: () => Window | null;
  origin: string;
  /** Defaults fill in `platform` (web) and `permissions` (none). */
  context: BridgeContextInput;
  handlers: HostHandlers;
}): { setTheme(theme: Theme): void; detach(): void } {
  const core = hostCore(BridgeContext.parse(opts.context), opts.handlers, (msg) =>
    opts.frame()?.postMessage(msg, opts.origin),
  );
  const listener = (e: MessageEvent) => {
    if (e.origin !== opts.origin || !opts.frame() || e.source !== opts.frame()) return;
    void core.receive(e.data);
  };
  opts.window.addEventListener('message', listener);
  return {
    setTheme: core.setTheme,
    detach: () => opts.window.removeEventListener('message', listener),
  };
}

/**
 * The mobile app's side (react-native-webview), without DOM types:
 * - `receive` gets `onMessage`'s `event.nativeEvent.data` (a JSON string), after the app checked
 *   that `event.nativeEvent.url` is on the plugin origin;
 * - `send` gets a script for `webview.injectJavaScript` that hands the message to the page.
 */
export function createNativeHost(opts: {
  /** `platform` defaults to `mobile` here. */
  context: BridgeContextInput;
  handlers: HostHandlers;
  send: (script: string) => void;
}): { receive(data: string): void; setTheme(theme: Theme): void } {
  const context = BridgeContext.parse({ platform: 'mobile', ...opts.context });
  const core = hostCore(context, opts.handlers, (msg) => opts.send(injectScript(msg)));
  return {
    receive: (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      void core.receive(parsed);
    },
    setTheme: core.setTheme,
  };
}

/**
 * A script that dispatches `msg` as a source-less message event on the page's window (once:
 * the SDK's document listener is for `webview.postMessage`, which Android delivers there).
 */
export function injectScript(msg: HostToPlugin): string {
  // JSON.stringify twice: the inner one is the message, the outer one a safe JS string literal.
  const data = JSON.stringify(JSON.stringify(msg));
  return `(function(){var d=${data};window.dispatchEvent(new MessageEvent('message',{data:d}));})();true;`;
}
