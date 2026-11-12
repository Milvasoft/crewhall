import {
  LEGACY_PATH_RULES,
  LEGACY_QUERY_KEYS,
  LEGACY_QUERY_VALUES,
  paths,
  toCurrentPath,
} from '@crewhall/shared';

/**
 * Web paths are English (docs/contracts/ingilizce-url.md, @crewhall/shared paths). Servers from
 * before that still serve the Turkish ones, and links in old notifications and e-mails stay
 * Turkish. So the app recognises a path in its current form (`toCurrentPath`) and opens it in
 * the form the server it talks to serves.
 */

export const ENGLISH_PATHS_CAPABILITY = 'paths.english';

/** The server serves English paths (bootstrap `server.capabilities`). */
export function servesEnglishPaths(capabilities: readonly string[] | null | undefined): boolean {
  return !!capabilities?.includes(ENGLISH_PATHS_CAPABILITY);
}

const reversed = LEGACY_PATH_RULES.map(([from, to]) => ({
  from: from.split('/').slice(1),
  to: to.split('/').slice(1),
}))
  // Most specific current form first; for equal ones the table's first old form wins
  // (`/notifications` → `/bildirimler`, not `/hesabim/bildirimler`).
  .map((rule, i) => ({ ...rule, i }))
  .sort((a, b) => b.to.length - a.to.length || a.i - b.i);

/** First segments of current paths whose query keys are ours to translate back. */
const CURRENT_ROOTS = new Set([
  '',
  ...reversed.map((r) => r.to[0]!),
  'chat',
  'drive',
  'm',
  'p',
  'b',
  'd',
  's',
  'f',
  'people',
  'spaces',
]);

const KEY_BACK = Object.fromEntries(Object.entries(LEGACY_QUERY_KEYS).map(([o, n]) => [n, o]));

function legacySegments(segments: string[]): string[] {
  for (const rule of reversed) {
    if (segments.length < rule.to.length) continue;
    const params = new Map<string, string>();
    let ok = true;
    for (let i = 0; i < rule.to.length; i++) {
      const want = rule.to[i]!;
      const have = segments[i]!;
      if (want.startsWith(':')) params.set(want, have);
      else if (want !== have) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const head = rule.from.map((s) => (s.startsWith(':') ? (params.get(s) ?? s) : s));
    return [...head, ...segments.slice(rule.to.length)];
  }
  return segments;
}

function legacyQuery(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? null : pair.slice(eq + 1);
      const values = LEGACY_QUERY_VALUES[key];
      const oldValue =
        value !== null && values
          ? (Object.entries(values).find(([, v]) => v === value)?.[0] ?? value)
          : value;
      const oldKey = KEY_BACK[key] ?? key;
      return oldValue === null ? oldKey : `${oldKey}=${oldValue}`;
    })
    .join('&');
}

const PARTS = /^([^?#]*)(\?[^#]*)?(#.*)?$/;

/**
 * The old Turkish form of a current path (query keys and values included), for a server from
 * before English paths. Paths that never changed come back as they are.
 */
export function toLegacyPath(input: string): string {
  const m = PARTS.exec(input);
  if (!m) return input;
  const [, path = '', query = '', hash = ''] = m;
  if (!path.startsWith('/')) return input;
  const segments = path.split('/').slice(1);
  if (!CURRENT_ROOTS.has(segments[0]!)) return input;
  const q = query ? `?${legacyQuery(query.slice(1))}` : '';
  return `/${legacySegments(segments).join('/')}${q}${hash}`;
}

/** A path (old or new) in the form this server serves. */
export function pathForServer(path: string, english: boolean): string {
  const current = toCurrentPath(path);
  return english ? current : toLegacyPath(current);
}

/** The pathname in its current form, old Turkish or not ("/toplantilar/oda/x" → "/meetings/room/x"). */
export function currentPathname(pathname: string): string {
  return toCurrentPath(pathname);
}

/** Meeting pages: the room in the app and the link join. */
const MEETING_PREFIXES = [`${paths.meetings()}/room/`, '/m/'];

/** A meeting page of the server, in either form (it opens in the meeting window). */
export function isMeetingPath(pathname: string): boolean {
  const p = currentPathname(pathname);
  return MEETING_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/** Sign-in on the way (session ran out, SSO, second factor), in either form. */
const AUTH_PREFIXES = [
  paths.login(),
  paths.forgotPassword(),
  paths.resetPassword(),
  paths.twoFactorSetup(),
  '/sso',
  '/oauth',
  '/api/auth',
];

export function isAuthPath(pathname: string): boolean {
  const p = currentPathname(pathname);
  return AUTH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}
