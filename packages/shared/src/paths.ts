/**
 * Web paths of the app (docs/contracts/ingilizce-url.md): the one place that writes them. The
 * backend (mail links, notification URLs, redirects), web, mobile and desktop take paths from
 * here instead of writing them by hand. Paths are English; the old Turkish ones (sent mail, stored
 * notifications, bookmarks) still work: `toCurrentPath` turns them into the current ones.
 *
 * No web path may start with a backend prefix (/api /ws /mcp /dav /caldav /carddav /collab
 * /healthz /readyz /.well-known /oauth/authorize|register|token|revoke): the proxy sends those to
 * the backend. `/davet` hit `/dav` that way, which is why the invitation link moved to `/invite`.
 */

const seg = (value: string) => encodeURIComponent(value);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** What an in-app address points at, for internal references; `card`: a board's `KEY-12`. */
export type InternalTarget =
  { kind: 'node'; id: string } | { kind: 'card'; boardId: string; ref: string };

/**
 * The item behind an in-app path (`/p/…`, `/b/…`, `/d/…`, `/drive/…`), or null. `path` may carry
 * a query: a Drive address with `?preview=` means that file.
 */
export function internalTargetOf(path: string): InternalTarget | null {
  const [pathname = '', search = ''] = path.split('?');
  const preview = new RegExp(`(?:^|&)preview=(${UUID})(?:&|$)`, 'i').exec(search);
  const test = (re: string) => new RegExp(`^${re}/?$`, 'i').exec(pathname);
  if (test('/drive/[^/]+(?:/folder/[^/]+)?') && preview) return { kind: 'node', id: preview[1]! };
  const m =
    test(`/drive/[^/]+/folder/(${UUID})`) ??
    test(`/p/(?:[^/]*-)?(${UUID})`) ??
    test(`/d/(${UUID})`) ??
    test(`/b/(${UUID})`);
  if (m) return { kind: 'node', id: m[1]! };
  const card = test(`/b/(${UUID})/([^/]+)`);
  if (card && card[2] !== 'settings') return { kind: 'card', boardId: card[1]!, ref: card[2]! };
  return null;
}

/** Rail modules and their path segment (`/$module/$space`). */
export const MODULE_PATHS = {
  chat: '/chat',
  drive: '/drive',
  pages: '/pages',
  boards: '/boards',
  drawings: '/drawings',
  meet: '/meetings',
  calendar: '/calendar',
  contacts: '/contacts',
  vault: '/vault',
  forms: '/forms',
  automations: '/automations',
  mail: '/mail',
} as const;
export type ModulePathId = keyof typeof MODULE_PATHS;

/** Vault list categories (`/vault/:vaultId/:category`). */
export const VAULT_CATEGORY_SLUGS = [
  'all',
  'favorites',
  'logins',
  'notes',
  'cards',
  'api-keys',
  'ssh-keys',
  'identities',
  'trash',
] as const;
export type VaultCategorySlug = (typeof VAULT_CATEGORY_SLUGS)[number];

/** Yönetim pages (`/admin/:section`). */
export const ADMIN_SECTIONS = [
  'general',
  'members',
  'spaces',
  'brand',
  'theme',
  'security',
  'sso',
  'integrations',
  'federation',
  'mail',
  'calendar',
  'delivery',
  'ai',
  'mcp',
  'stats',
  'compliance',
  'backups',
  'desktop',
  /** Bildirilen içerik: chat reports (API 54). */
  'reports',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** Hesabım pages (`/account/:section`). */
export const ACCOUNT_SECTIONS = [
  'profile',
  'appearance',
  'security',
  'webdav',
  'mcp',
  'approvals',
] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number];

export const paths = {
  home: () => '/',
  notifications: () => '/notifications',

  // Chat
  chat: () => '/chat',
  chatSearch: () => '/chat/search',
  chatNew: () => '/chat/new',
  chatConversation: (id: string) => `/chat/c/${seg(id)}`,
  chatFiles: (id: string) => `/chat/c/${seg(id)}/files`,
  chatPinned: (id: string) => `/chat/c/${seg(id)}/pinned`,

  // Drive
  drive: () => '/drive',
  driveSearch: () => '/drive/search',
  driveRecent: () => '/drive/recent',
  driveSpace: (space: string) => `/drive/${seg(space)}`,
  driveFolder: (space: string, folderId: string) => `/drive/${seg(space)}/folder/${seg(folderId)}`,
  driveTrash: (space: string) => `/drive/${seg(space)}/trash`,
  /** Public share link. */
  share: (token: string) => `/s/${seg(token)}`,

  // Pages (wiki)
  pages: (space?: string) => (space ? `/pages/${seg(space)}` : '/pages'),
  pagesSearch: () => '/pages/search',
  /** A page by its ref (`<slug>-<id>` or the id). */
  page: (ref: string) => `/p/${seg(ref)}`,

  // Boards and drawings
  boards: (space?: string) => (space ? `/boards/${seg(space)}` : '/boards'),
  board: (boardId: string) => `/b/${seg(boardId)}`,
  boardCard: (boardId: string, cardRef: string) => `/b/${seg(boardId)}/${seg(cardRef)}`,
  boardSettings: (boardId: string) => `/b/${seg(boardId)}/settings`,
  drawings: (space?: string) => (space ? `/drawings/${seg(space)}` : '/drawings'),
  drawing: (drawingId: string) => `/d/${seg(drawingId)}`,

  // Meetings
  meetings: () => '/meetings',
  /** In-app room page. */
  meetingRoom: (slug: string) => `/meetings/room/${seg(slug)}`,
  meetingSummary: (sessionId: string) => `/meetings/summary/${seg(sessionId)}`,
  /** The join link everybody (member or guest) opens. */
  meetingJoin: (slug: string) => `/m/${seg(slug)}`,

  calendar: () => '/calendar',

  // Contacts
  contacts: () => '/contacts',
  contactsPeople: () => '/contacts/people',
  contactsOrgChart: () => '/contacts/org-chart',
  contactsCompanies: () => '/contacts/companies',
  person: (userId: string) => `/people/${seg(userId)}`,

  // Vault
  vault: () => '/vault',
  vaultCategory: (vaultId: string, category: VaultCategorySlug) =>
    `/vault/${seg(vaultId)}/${category}`,
  vaultAccess: (vaultId: string) => `/vault/${seg(vaultId)}/access`,
  vaultSettings: () => '/vault/settings',
  vaultLog: () => '/vault/log',
  vaultImport: () => '/vault/import',
  vaultHealth: () => '/vault/health',
  vaultShare: (token: string) => `/vault-share/${seg(token)}`,

  // Forms
  forms: (space?: string) => (space ? `/forms/${seg(space)}` : '/forms'),
  form: (formId: string) => `/forms/f/${seg(formId)}`,
  formResults: (formId: string) => `/forms/f/${seg(formId)}/results`,
  formEdit: (formId: string) => `/forms/edit/${seg(formId)}`,
  /** Public fill link. */
  formFill: (token: string) => `/f/${seg(token)}`,

  // Automations
  automations: (space?: string) => (space ? `/automations/${seg(space)}` : '/automations'),
  automationNew: (space: string) => `/automations/${seg(space)}/new`,
  automationRule: (ruleId: string) => `/automations/rule/${seg(ruleId)}`,

  // Mail, announcements, spaces
  mail: () => '/mail',
  mailSettings: () => '/mail/settings',
  announcements: () => '/announcements',
  announcement: (id: string) => `/announcements/${seg(id)}`,
  /** The thank-you wall. */
  kudos: () => '/announcements/kudos',
  spaceSettings: (space: string) => `/spaces/${seg(space)}/settings`,
  module: (id: ModulePathId, space?: string) =>
    space ? `${MODULE_PATHS[id]}/${seg(space)}` : MODULE_PATHS[id],

  // Hesabım
  account: (section?: AccountSection) => (section ? `/account/${section}` : '/account'),
  accountMcpApi: () => '/account/mcp/api',
  accountMcpDocs: () => '/account/mcp/docs',
  accountMcpActivity: () => '/account/mcp/activity',
  accountMcpClient: (grantId: string) => `/account/mcp/client/${seg(grantId)}`,
  accountApproval: (approvalId: string) => `/account/approvals/${seg(approvalId)}`,

  // Yönetim
  admin: (section?: AdminSection) => (section ? `/admin/${section}` : '/admin'),
  adminMember: (userId: string) => `/admin/members/${seg(userId)}`,
  adminIdentityProvider: (providerId: string) => `/admin/integrations/identity/${seg(providerId)}`,
  adminIdentityProviderNew: () => '/admin/integrations/identity/new',

  // Outside the app shell
  invite: (token: string) => `/invite/${seg(token)}`,
  setup: () => '/setup',
  login: () => '/login',
  login2fa: () => '/login/2fa',
  login2faBackup: () => '/login/2fa/backup',
  twoFactorSetup: () => '/security/2fa-setup',
  resetPassword: () => '/reset-password',
  forgotPassword: () => '/forgot-password',
  mobileLogin: () => '/mobile-login',
  oauthConsent: () => '/oauth/consent',
  oauthDone: () => '/oauth/done',
  ssoConsent: () => '/sso/consent',
} as const;

/** `path` with a query string; undefined and null values are left out. */
export function withQuery(
  path: string,
  query: Record<string, string | number | boolean | null | undefined>,
): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

/**
 * Old Turkish paths → current ones, most specific first. `:name` matches one segment and is
 * carried over; segments after the matched ones stay as they are.
 */
export const LEGACY_PATH_RULES: readonly (readonly [from: string, to: string])[] = [
  ['/bildirimler', '/notifications'],
  ['/hesabim/bildirimler', '/notifications'],

  ['/chat/ara', '/chat/search'],
  ['/chat/yeni', '/chat/new'],
  ['/chat/c/:id/dosyalar', '/chat/c/:id/files'],
  ['/chat/c/:id/sabitlenenler', '/chat/c/:id/pinned'],

  ['/drive/ara', '/drive/search'],
  ['/drive/son', '/drive/recent'],
  ['/drive/:space/cop-kutusu', '/drive/:space/trash'],
  ['/drive/:space/k/:folder', '/drive/:space/folder/:folder'],

  ['/cizimler', '/drawings'],
  ['/duyurular', '/announcements'],

  ['/formlar/f/:id/sonuclar', '/forms/f/:id/results'],
  ['/formlar/y/:id', '/forms/edit/:id'],
  ['/formlar', '/forms'],

  ['/hesap/gorunum', '/account/appearance'],
  ['/hesap/guvenlik', '/account/security'],
  ['/hesap/profil', '/account/profile'],
  ['/hesap/mcp/belgeler', '/account/mcp/docs'],
  ['/hesap/mcp/etkinlik', '/account/mcp/activity'],
  ['/hesap/mcp/istemci', '/account/mcp/client'],
  ['/hesap/onaylar', '/account/approvals'],
  ['/hesap', '/account'],

  ['/kasa/ayarlar', '/vault/settings'],
  ['/kasa/gunluk', '/vault/log'],
  ['/kasa/ice-aktar', '/vault/import'],
  ['/kasa/saglik', '/vault/health'],
  ['/kasa/:v/erisim', '/vault/:v/access'],
  ['/kasa/:v/tumu', '/vault/:v/all'],
  ['/kasa/:v/favoriler', '/vault/:v/favorites'],
  ['/kasa/:v/girisler', '/vault/:v/logins'],
  ['/kasa/:v/notlar', '/vault/:v/notes'],
  ['/kasa/:v/kartlar', '/vault/:v/cards'],
  ['/kasa/:v/api-anahtarlari', '/vault/:v/api-keys'],
  ['/kasa/:v/ssh-anahtarlari', '/vault/:v/ssh-keys'],
  ['/kasa/:v/kimlikler', '/vault/:v/identities'],
  ['/kasa/:v/cop', '/vault/:v/trash'],
  ['/kasa', '/vault'],
  ['/kasa-paylasim', '/vault-share'],

  ['/kisiler', '/people'],
  ['/rehber/kisiler', '/contacts/people'],
  ['/rehber/sema', '/contacts/org-chart'],
  ['/rehber/sirketler', '/contacts/companies'],
  ['/rehber', '/contacts'],

  ['/otomasyonlar/k/:id', '/automations/rule/:id'],
  ['/otomasyonlar/:space/yeni', '/automations/:space/new'],
  ['/otomasyonlar', '/automations'],

  ['/panolar', '/boards'],
  ['/b/:id/ayarlar', '/b/:id/settings'],

  ['/posta/ayarlar', '/mail/settings'],
  ['/posta', '/mail'],

  ['/sayfalar/ara', '/pages/search'],
  ['/sayfalar', '/pages'],

  ['/spaces/:space/ayarlar', '/spaces/:space/settings'],
  ['/takvim', '/calendar'],

  ['/toplantilar/oda', '/meetings/room'],
  ['/toplantilar/ozet', '/meetings/summary'],
  ['/toplantilar', '/meetings'],

  ['/yonetim/bildirim-gonderimi', '/admin/delivery'],
  ['/yonetim/entegrasyonlar/kimlik/yeni', '/admin/integrations/identity/new'],
  ['/yonetim/entegrasyonlar/kimlik', '/admin/integrations/identity'],
  ['/yonetim/entegrasyonlar', '/admin/integrations'],
  ['/yonetim/federasyon', '/admin/federation'],
  ['/yonetim/genel', '/admin/general'],
  ['/yonetim/guvenlik', '/admin/security'],
  ['/yonetim/istatistikler', '/admin/stats'],
  ['/yonetim/marka', '/admin/brand'],
  ['/yonetim/masaustu', '/admin/desktop'],
  ['/yonetim/posta', '/admin/mail'],
  ['/yonetim/spaceler', '/admin/spaces'],
  ['/yonetim/tema', '/admin/theme'],
  ['/yonetim/uyeler', '/admin/members'],
  ['/yonetim/uyumluluk', '/admin/compliance'],
  ['/yonetim/yapay-zeka', '/admin/ai'],
  ['/yonetim/yedekler', '/admin/backups'],
  ['/yonetim', '/admin'],

  ['/davet', '/invite'],
  ['/guvenlik/2fa-kur', '/security/2fa-setup'],
  ['/kurulum', '/setup'],
  ['/login/2fa/yedek', '/login/2fa/backup'],
  ['/mobil-giris', '/mobile-login'],
  ['/oauth/onay', '/oauth/consent'],
  ['/oauth/tamam', '/oauth/done'],
  ['/sifre-yenile', '/reset-password'],
  ['/sifremi-unuttum', '/forgot-password'],
  ['/sso/onay', '/sso/consent'],
];

const parsed = LEGACY_PATH_RULES.map(([from, to]) => ({
  from: from.split('/').slice(1),
  to: to.split('/').slice(1),
}));

/** The current path for an old one; anything else comes back as it was. */
function currentSegments(segments: string[]): string[] | null {
  for (const rule of parsed) {
    if (segments.length < rule.from.length) continue;
    const params = new Map<string, string>();
    let ok = true;
    for (let i = 0; i < rule.from.length; i++) {
      const want = rule.from[i]!;
      const have = segments[i]!;
      if (want.startsWith(':')) params.set(want, have);
      else if (want !== have) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const head = rule.to.map((s) => (s.startsWith(':') ? (params.get(s) ?? s) : s));
    return [...head, ...segments.slice(rule.from.length)];
  }
  return null;
}

/** Old Turkish query keys → current ones (`/calendar?etkinlik=…` → `?event=…`). */
export const LEGACY_QUERY_KEYS: Readonly<Record<string, string>> = {
  adim: 'step',
  aktarim: 'export',
  arac: 'tool',
  arama: 'call',
  baglandi: 'connected',
  davet: 'invite',
  detay: 'detail',
  departman: 'department',
  dosya: 'file',
  etiket: 'tag',
  etkinlik: 'event',
  filtre: 'filter',
  gorunum: 'view',
  grup: 'group',
  gun: 'days',
  hata: 'error',
  kisi: 'person',
  klasor: 'folder',
  onizle: 'preview',
  pencere: 'window',
  satir: 'row',
  sekme: 'tab',
  surum: 'version',
  tarih: 'date',
  tur: 'type',
  yeni: 'new',
  yorum: 'comment',
  yorumlar: 'comments',
  yuzey: 'surface',
};

/** Old Turkish values of enum-like query keys, by the current key. */
export const LEGACY_QUERY_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  view: {
    gun: 'day',
    hafta: 'week',
    ay: 'month',
    ajanda: 'agenda',
    planlanan: 'scheduled',
    kayitlar: 'recordings',
    bana: 'mine',
    yaklasan: 'upcoming',
    liste: 'list',
    izgara: 'grid',
  },
  date: { gecmis: 'overdue', hafta: 'week', ay: 'month', yok: 'none' },
  person: { ben: 'me', yok: 'none' },
  group: { kisi: 'person', etiket: 'tag' },
  new: { hemen: 'now', planla: 'schedule', oda: 'room' },
  filter: { okunmamis: 'unread', bayrakli: 'flagged' },
  tab: {
    alanlar: 'fields',
    paylasim: 'sharing',
    onizleme: 'preview',
    politika: 'policy',
    baglantilar: 'connections',
    webhooklar: 'webhooks',
    kullanim: 'usage',
  },
  panel: { yorumlar: 'comments', surumler: 'versions' },
};

/**
 * Keys renamed only under one path root: a short key that means something else elsewhere
 * (Drive's `g=izgara` was the view; portal docs keep their own `g`).
 */
export const LEGACY_QUERY_KEYS_BY_ROOT: Readonly<Record<string, Readonly<Record<string, string>>>> =
  {
    drive: { g: 'view' },
  };

/** First path segments of the web app, old and new: their queries are ours to translate. */
const APP_ROOTS = new Set([
  '',
  ...Object.values(MODULE_PATHS).map((p) => p.slice(1)),
  ...LEGACY_PATH_RULES.flatMap(([from, to]) => [from.split('/')[1]!, to.split('/')[1]!]),
  'p',
  'b',
  'd',
  'm',
  's',
  'f',
  'people',
  'portal',
  'spaces',
]);

function currentQuery(query: string, root: string): string {
  const byRoot = LEGACY_QUERY_KEYS_BY_ROOT[root];
  return query
    .split('&')
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf('=');
      const rawKey = eq < 0 ? pair : pair.slice(0, eq);
      const rawValue = eq < 0 ? null : pair.slice(eq + 1);
      const key = byRoot?.[rawKey] ?? LEGACY_QUERY_KEYS[rawKey] ?? rawKey;
      let value = rawValue;
      if (rawValue !== null) {
        const mapped = LEGACY_QUERY_VALUES[key]?.[rawValue];
        if (mapped) value = mapped;
      }
      return value === null ? key : `${key}=${value}`;
    })
    .join('&');
}

const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i;

/**
 * Turns an old Turkish web path (or a full URL to one) into the current English path, query
 * keys and enum values included. The origin, other query values and the hash are kept; a path
 * that is already current, or not one of ours, comes back unchanged. Pure: safe for web, mobile,
 * desktop and the backend alike.
 */
export function toCurrentPath(input: string): string {
  const m = URL_PARTS.exec(input);
  if (!m) return input;
  const [, origin = '', path = '', query = '', hash = ''] = m;
  if (!path.startsWith('/')) return input;
  const segments = path.split('/').slice(1);
  if (!APP_ROOTS.has(segments[0]!)) return input;
  const next = currentSegments(segments) ?? segments;
  const q = query ? `?${currentQuery(query.slice(1), next[0]!)}` : '';
  return `${origin}/${next.join('/')}${q}${hash}`;
}

/** Whether `input` is an old Turkish path that `toCurrentPath` would change. */
export function isLegacyPath(input: string): boolean {
  return toCurrentPath(input) !== input;
}
