import { OFFICE_EXTENSIONS, type OfficeExtension, type OfficeMode } from '@crewhall/shared';

/**
 * WOPI discovery (`/hosting/discovery`): which file types the document server opens, and the
 * editor URL (`urlsrc`) for each. Read once an hour per server; a failure is retried after 30 s.
 * Works with Collabora Online and with Office Online style servers (placeholders in urlsrc).
 */

export interface DiscoveryAction {
  app: string;
  name: string;
  ext: string;
  urlsrc: string;
}

export interface Discovery {
  actions: DiscoveryAction[];
}

const OK_TTL_MS = 60 * 60 * 1000;
const FAIL_TTL_MS = 30 * 1000;
const MAX_BYTES = 4 * 1024 * 1024;

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function attr(tag: string, name: string): string | null {
  const m = new RegExp(String.raw`\b${name}\s*=\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decode(m[2] ?? m[3] ?? '') : null;
}

/** Every `<action>` of every `<app>` in a discovery document. */
export function parseDiscovery(xml: string): Discovery {
  const actions: DiscoveryAction[] = [];
  for (const app of xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const appName = attr(app[1]!, 'name') ?? '';
    for (const a of app[2]!.matchAll(/<action\b([^>]*?)\/?>/g)) {
      const name = attr(a[1]!, 'name');
      const ext = attr(a[1]!, 'ext');
      const urlsrc = attr(a[1]!, 'urlsrc');
      if (name && ext && urlsrc)
        actions.push({ app: appName, name, ext: ext.toLowerCase(), urlsrc });
    }
  }
  return { actions };
}

const EDIT = new Set(['edit']);
const VIEW = new Set(['view', 'view_comment', 'embedview', 'mobileView']);

/** Office extensions the server can edit, and those it can only show. */
export function capabilitiesOf(d: Discovery) {
  const has = (ext: string, names: Set<string>) =>
    d.actions.some((a) => a.ext === ext && names.has(a.name));
  const edit = OFFICE_EXTENSIONS.filter((e) => has(e, EDIT));
  const view = OFFICE_EXTENSIONS.filter((e) => !edit.includes(e) && has(e, VIEW));
  return { edit: [...edit], view: [...view] as OfficeExtension[] };
}

/** The editor URL for a file type: the edit action when editing, a view action otherwise. */
export function actionFor(d: Discovery, ext: string, mode: OfficeMode): DiscoveryAction | null {
  const of = (names: Set<string>) => d.actions.find((a) => a.ext === ext && names.has(a.name));
  // Collabora has no separate view action for most types: read-only comes from CheckFileInfo.
  return mode === 'edit' ? (of(EDIT) ?? null) : (of(VIEW) ?? of(EDIT) ?? null);
}

/**
 * urlsrc + WOPISrc. Office Online style placeholders (`<ui=UI_LLCC&>`) are filled with the
 * locale or dropped; Collabora reads `lang`.
 */
export function actionUrl(urlsrc: string, wopiSrc: string, locale: string): string {
  const llcc = locale === 'en' ? 'en-US' : 'tr-TR';
  let url = urlsrc.replace(/<([a-z_]+)=([A-Z_]+)&?>/gi, (_, key: string, value: string) =>
    value === 'UI_LLCC' || value === 'DC_LLCC' ? `${key}=${llcc}&` : '',
  );
  url = url.replace(/<[^>]*>/g, '');
  const sep = url.endsWith('?') || url.endsWith('&') ? '' : url.includes('?') ? '&' : '?';
  return `${url}${sep}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=${locale}`;
}

const cache = new Map<string, { at: number; ok: boolean; value: Promise<Discovery> }>();

async function fetchDiscovery(base: string): Promise<Discovery> {
  const res = await fetch(`${base}/hosting/discovery`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`discovery answered HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('discovery document too large');
  const d = parseDiscovery(text);
  if (d.actions.length === 0) throw new Error('no WOPI actions in the discovery document');
  return d;
}

/** Discovery of the server at `base` (no trailing slash), cached. */
export async function getDiscovery(base: string, opts: { fresh?: boolean } = {}) {
  const hit = cache.get(base);
  if (!opts.fresh && hit && Date.now() - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) {
    return hit.value;
  }
  const entry = { at: Date.now(), ok: true, value: fetchDiscovery(base) };
  entry.value.catch(() => {
    entry.ok = false;
  });
  cache.set(base, entry);
  return entry.value;
}

export function clearDiscovery() {
  cache.clear();
}
