import type { ModuleKey, OrgAction, OrgRole } from '@crewhall/shared';

/**
 * Every page and settings page one can go to, in one place (Ctrl K "Git", later the mobile
 * search). Data only: ids, paths, who may open it and search words in Turkish and English. The
 * label and icon of an id live with each client (web: routes/labels.ts), so this file has no
 * React and no i18n and can move to packages/shared as it is.
 */
export interface RouteEntry {
  id: string;
  path: string;
  /** Breadcrumb parent: `admin.ai` under `admin` reads "Yönetim › Yapay zekâ". */
  parent?: string;
  /** A heading entry ("Yönetim", "Hesabım") that opens its first page; never a recent page. */
  section?: boolean;
  /** Hidden while this module is switched off for the org. */
  module?: ModuleKey;
  /**
   * Who may open it. `member`: not a guest; `orgAdmin`: owner or admin (the Yönetim area);
   * `installAdmin`: the person who runs the server.
   */
  access?: 'member' | 'orgAdmin' | 'installAdmin';
  /** Any of these org permissions (on top of `access`). */
  can?: OrgAction[];
  /** Synonyms, Turkish and English, lower case; diacritics do not matter when searching. */
  keywords: string[];
}

export const ROUTE_CATALOG = [
  // Modules
  {
    id: 'home',
    path: '/',
    keywords: ['ana sayfa', 'başlangıç', 'yüzey', 'home', 'start', 'dashboard'],
  },
  {
    id: 'chat',
    path: '/chat',
    module: 'chat',
    keywords: ['sohbet', 'mesaj', 'konuşma', 'kanal', 'messages', 'dm'],
  },
  {
    id: 'chat.search',
    path: '/chat/search',
    parent: 'chat',
    module: 'chat',
    keywords: ['mesaj ara', 'search messages', 'find message'],
  },
  {
    id: 'drive',
    path: '/drive',
    keywords: ['dosya', 'klasör', 'belge', 'files', 'folders', 'documents', 'storage'],
  },
  {
    id: 'drive.recent',
    path: '/drive/recent',
    parent: 'drive',
    keywords: ['son açılanlar', 'son dosyalar', 'recent', 'recently opened'],
  },
  {
    id: 'drive.search',
    path: '/drive/search',
    parent: 'drive',
    keywords: ['dosya ara', 'search files', 'find file'],
  },
  {
    id: 'pages',
    path: '/pages',
    module: 'wiki',
    keywords: ['wiki', 'doküman', 'not', 'bilgi bankası', 'docs', 'notes', 'knowledge base'],
  },
  {
    id: 'pages.search',
    path: '/pages/search',
    parent: 'pages',
    module: 'wiki',
    keywords: ['sayfa ara', 'wiki ara', 'search pages'],
  },
  {
    id: 'boards',
    path: '/boards',
    module: 'boards',
    keywords: ['pano', 'kanban', 'görev', 'iş', 'board', 'tasks', 'project'],
  },
  {
    id: 'drawings',
    path: '/drawings',
    module: 'drawings',
    keywords: ['çizim', 'diyagram', 'beyaz tahta', 'drawing', 'diagram', 'whiteboard', 'sketch'],
  },
  {
    id: 'meet',
    path: '/meetings',
    module: 'meet',
    keywords: ['toplantı', 'görüşme', 'video', 'arama', 'meeting', 'call', 'conference'],
  },
  {
    id: 'calendar',
    path: '/calendar',
    module: 'calendar',
    keywords: ['takvim', 'etkinlik', 'randevu', 'calendar', 'events', 'schedule'],
  },
  {
    id: 'calendar.bookings',
    path: '/bookings',
    parent: 'calendar',
    module: 'calendar',
    keywords: ['rezervasyon', 'toplantı odası', 'oda', 'masa', 'booking', 'room', 'desk'],
  },
  {
    id: 'contacts',
    path: '/contacts',
    module: 'contacts',
    keywords: ['rehber', 'kişiler', 'telefon', 'directory', 'people', 'contacts'],
  },
  {
    id: 'contacts.chart',
    path: '/contacts/org-chart',
    parent: 'contacts',
    module: 'contacts',
    keywords: ['organizasyon şeması', 'org şeması', 'hiyerarşi', 'org chart', 'hierarchy'],
  },
  {
    id: 'contacts.external',
    path: '/contacts/people',
    parent: 'contacts',
    module: 'contacts',
    keywords: ['dış kişiler', 'müşteri', 'tedarikçi', 'external contacts', 'customers'],
  },
  {
    id: 'contacts.companies',
    path: '/contacts/companies',
    parent: 'contacts',
    module: 'contacts',
    keywords: ['şirket', 'firma', 'companies', 'organizations'],
  },
  {
    id: 'vault',
    path: '/vault',
    module: 'vault',
    keywords: ['kasa', 'şifre', 'parola', 'gizli', 'vault', 'passwords', 'secrets'],
  },
  {
    id: 'vault.settings',
    path: '/vault/settings',
    parent: 'vault',
    module: 'vault',
    keywords: ['kasa ayarları', 'passkey', 'ana parola', 'kurtarma', 'vault settings', 'recovery'],
  },
  {
    id: 'vault.health',
    path: '/vault/health',
    parent: 'vault',
    module: 'vault',
    keywords: ['zayıf şifre', 'tekrar eden', 'güvenlik', 'password health', 'weak passwords'],
  },
  {
    id: 'vault.log',
    path: '/vault/log',
    parent: 'vault',
    module: 'vault',
    keywords: ['günlük', 'kayıt', 'erişim günlüğü', 'audit', 'access log'],
  },
  {
    id: 'vault.import',
    path: '/vault/import',
    parent: 'vault',
    module: 'vault',
    access: 'member',
    keywords: ['içe aktar', 'bitwarden', 'vaultwarden', 'import'],
  },
  {
    id: 'forms',
    path: '/forms',
    module: 'forms',
    keywords: ['form', 'anket', 'başvuru', 'survey', 'forms'],
  },
  {
    id: 'automations',
    path: '/automations',
    module: 'automations',
    keywords: ['otomasyon', 'kural', 'iş akışı', 'tetikleyici', 'automation', 'workflow', 'rules'],
  },
  {
    id: 'mail',
    path: '/mail',
    module: 'mail',
    access: 'member',
    keywords: ['posta', 'e-posta', 'eposta', 'gelen kutusu', 'mail', 'email', 'inbox'],
  },
  {
    id: 'mail.settings',
    path: '/mail/settings',
    parent: 'mail',
    module: 'mail',
    access: 'member',
    keywords: ['posta hesabı', 'imap', 'smtp', 'imza', 'mail settings', 'signature', 'account'],
  },
  {
    id: 'tools',
    path: '/tools',
    module: 'tools',
    keywords: [
      'araç',
      'araçlar',
      'geliştirici',
      'json',
      'base64',
      'jwt',
      'regex',
      'tools',
      'developer',
    ],
  },
  {
    id: 'announcements',
    path: '/announcements',
    access: 'member',
    keywords: ['duyuru', 'haber', 'bülten', 'announcements', 'news'],
  },
  {
    id: 'portal',
    path: '/portal',
    module: 'portal',
    can: ['portal.edit', 'portal.publish'],
    keywords: ['portal', 'web sitesi', 'site', 'blog', 'cms', 'website'],
  },
  {
    id: 'notifications',
    path: '/notifications',
    keywords: ['bildirim', 'uyarı', 'notifications', 'alerts', 'inbox'],
  },

  // Hesabım
  {
    id: 'account',
    path: '/account/profile',
    section: true,
    keywords: ['hesabım', 'ayarlar', 'my account', 'settings', 'preferences'],
  },
  {
    id: 'account.profile',
    path: '/account/profile',
    parent: 'account',
    keywords: ['profil', 'ad', 'fotoğraf', 'avatar', 'profile', 'name', 'photo'],
  },
  {
    id: 'account.security',
    path: '/account/security',
    parent: 'account',
    keywords: [
      'şifre',
      'parola',
      'iki adımlı',
      '2fa',
      'totp',
      'passkey',
      'oturumlar',
      'password',
      'two factor',
      'sessions',
    ],
  },
  {
    id: 'account.appearance',
    path: '/account/appearance',
    parent: 'account',
    keywords: [
      'tema',
      'koyu',
      'açık',
      'dil',
      'yazı boyutu',
      'theme',
      'dark mode',
      'language',
      'appearance',
    ],
  },
  {
    id: 'account.notifications',
    path: '/account/notifications',
    parent: 'account',
    keywords: [
      'bildirim',
      'bildirimler',
      'push',
      'masaüstü',
      'e-posta özeti',
      'sessiz saatler',
      'notifications',
      'desktop',
      'quiet hours',
    ],
  },
  {
    id: 'account.about',
    path: '/account/about',
    parent: 'account',
    keywords: ['sürüm', 'versiyon', 'version', 'commit', 'lisans', 'license', 'about'],
  },
  {
    id: 'account.webdav',
    path: '/account/webdav',
    parent: 'account',
    keywords: [
      'webdav',
      'drive bağla',
      'ağ sürücüsü',
      'finder',
      'gezgin',
      'network drive',
      'mount',
    ],
  },
  {
    id: 'account.mcp',
    path: '/account/mcp',
    parent: 'account',
    module: 'mcp',
    keywords: [
      'mcp',
      'api',
      'token',
      'anahtar',
      'claude',
      'chatgpt',
      'yapay zekâ bağla',
      'connect ai',
      'access token',
    ],
  },
  {
    id: 'account.approvals',
    path: '/account/approvals',
    parent: 'account',
    module: 'mcp',
    keywords: [
      'onay',
      'onaylar',
      'bekleyen',
      'yapay zekâ onayı',
      'mcp onayı',
      'izin',
      'approval',
      'approvals',
      'pending',
      'ai approval',
    ],
  },
  {
    id: 'account.mcpActivity',
    path: '/account/mcp/activity',
    parent: 'account',
    module: 'mcp',
    keywords: ['mcp etkinliği', 'araç çağrıları', 'kayıt', 'activity', 'tool calls', 'log'],
  },
  {
    id: 'account.mcpDocs',
    path: '/account/mcp/docs',
    parent: 'account',
    module: 'mcp',
    keywords: ['araç belgeleri', 'mcp araçları', 'tools', 'documentation', 'reference'],
  },
  {
    id: 'account.restApi',
    path: '/account/mcp/api',
    parent: 'account',
    module: 'mcp',
    keywords: ['rest', 'api', 'geliştirici', 'openapi', 'developer', 'endpoints'],
  },

  // Yönetim
  {
    id: 'admin',
    path: '/admin/general',
    section: true,
    access: 'orgAdmin',
    keywords: [
      'yönetim',
      'yönetici',
      'kurum ayarları',
      'admin',
      'administration',
      'organization settings',
    ],
  },
  {
    id: 'admin.general',
    path: '/admin/general',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: [
      'kurum',
      'modüller',
      'bölge',
      'saat dilimi',
      'politika',
      'organization',
      'modules',
      'region',
      'timezone',
    ],
  },
  {
    id: 'admin.members',
    path: '/admin/members',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: ['üye', 'kullanıcı', 'davet', 'rol', 'members', 'users', 'invite', 'roles'],
  },
  {
    id: 'admin.spaces',
    path: '/admin/spaces',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: ['space', 'alan', 'ekip', 'arşiv', 'spaces', 'teams', 'archive'],
  },
  {
    id: 'admin.stats',
    path: '/admin/stats',
    parent: 'admin',
    access: 'orgAdmin',
    can: ['org.view_stats'],
    keywords: [
      'istatistik',
      'rapor',
      'kullanım',
      'depolama',
      'statistics',
      'usage',
      'reports',
      'analytics',
    ],
  },
  {
    id: 'admin.delivery',
    path: '/admin/delivery',
    parent: 'admin',
    access: 'orgAdmin',
    can: ['org.update_settings'],
    keywords: [
      'bildirim gönderimi',
      'push',
      'fcm',
      'firebase',
      'smtp',
      'e-posta gönderimi',
      'notifike',
      'delivery',
      'email delivery',
    ],
  },
  {
    id: 'admin.brand',
    path: '/admin/brand',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: ['marka', 'logo', 'kurum adı', 'favicon', 'brand', 'branding'],
  },
  {
    id: 'admin.theme',
    path: '/admin/theme',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: ['tema', 'renk', 'vurgu', 'yazı tipi', 'theme', 'colors', 'accent', 'font'],
  },
  {
    id: 'admin.security',
    path: '/admin/security',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: [
      'güvenlik politikası',
      'iki adımlı zorunlu',
      'oturum süresi',
      'ip',
      'security policy',
      'enforce 2fa',
    ],
  },
  {
    id: 'admin.sso',
    path: '/admin/sso',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: [
      'sso',
      'oidc',
      'oauth',
      'tek oturum',
      'uygulama',
      'single sign-on',
      'apps',
      'client',
    ],
  },
  {
    id: 'admin.compliance',
    path: '/admin/compliance',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: [
      'uyumluluk',
      'kvkk',
      'gdpr',
      'saklama',
      'denetim',
      'compliance',
      'retention',
      'audit',
    ],
  },
  {
    id: 'admin.mcp',
    path: '/admin/mcp',
    parent: 'admin',
    access: 'orgAdmin',
    module: 'mcp',
    keywords: ['mcp', 'api', 'bağlantılar', 'yapay zekâ erişimi', 'connections', 'ai access'],
  },
  {
    id: 'admin.federation',
    path: '/admin/federation',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: ['federasyon', 'diğer kurum', 'bağlı kurumlar', 'federation', 'partner orgs'],
  },
  {
    id: 'admin.integrations',
    path: '/admin/integrations',
    parent: 'admin',
    access: 'orgAdmin',
    keywords: [
      'entegrasyon',
      'kimlik sağlayıcı',
      'ldap',
      'azure',
      'google',
      'keycloak',
      'integrations',
      'identity provider',
    ],
  },
  {
    id: 'admin.backups',
    path: '/admin/backups',
    parent: 'admin',
    access: 'installAdmin',
    keywords: ['yedek', 'geri yükleme', 'backup', 'restore', 'snapshot'],
  },
  {
    id: 'admin.desktop',
    path: '/admin/desktop',
    parent: 'admin',
    access: 'installAdmin',
    keywords: [
      'masaüstü',
      'sürüm',
      'güncelleme',
      'kurulum',
      'exe',
      'dmg',
      'yükle',
      'desktop',
      'release',
      'update',
      'installer',
    ],
  },
  {
    id: 'admin.ai',
    path: '/admin/ai',
    parent: 'admin',
    access: 'orgAdmin',
    module: 'ai',
    keywords: [
      'yapay zekâ',
      'ai',
      'llm',
      'model',
      'anahtar',
      'openai',
      'claude',
      'anthropic',
      'ollama',
      'api key',
    ],
  },
  {
    id: 'admin.mail',
    path: '/admin/mail',
    parent: 'admin',
    access: 'orgAdmin',
    module: 'mail',
    keywords: ['posta sunucusu', 'smtp', 'imap', 'e-posta', 'mail', 'mail server'],
  },
  {
    id: 'admin.calendar',
    path: '/admin/calendar',
    parent: 'admin',
    access: 'orgAdmin',
    module: 'calendar',
    keywords: [
      'takvim',
      'google takvim',
      'outlook',
      'microsoft 365',
      'calendar',
      'google calendar',
      'oauth',
    ],
  },
  {
    id: 'admin.bookings',
    path: '/admin/bookings',
    parent: 'admin',
    access: 'orgAdmin',
    module: 'calendar',
    keywords: ['oda', 'masa', 'rezervasyon', 'toplantı odası', 'room', 'desk', 'booking'],
  },
] as const satisfies readonly RouteEntry[];

export type RouteId = (typeof ROUTE_CATALOG)[number]['id'];

export const ROUTE_BY_ID = Object.fromEntries(
  ROUTE_CATALOG.map((r): [string, RouteEntry] => [r.id, r]),
) as Record<RouteId, RouteEntry>;

export interface RouteViewer {
  role: OrgRole;
  installAdmin?: boolean;
  /** Org modules switched on. */
  modules: ReadonlySet<ModuleKey>;
  can: (action: OrgAction) => boolean;
}

/** Whether this person may open the page: role, module switch and permission. */
export function canOpenRoute(r: RouteEntry, v: RouteViewer): boolean {
  if (r.module && !v.modules.has(r.module)) return false;
  if (r.access === 'member' && v.role === 'guest') return false;
  if (r.access === 'orgAdmin' && v.role !== 'owner' && v.role !== 'admin') return false;
  if (r.access === 'installAdmin' && !v.installAdmin) return false;
  if (r.can && !r.can.some((a) => v.can(a))) return false;
  if (r.parent) {
    const p = ROUTE_BY_ID[r.parent as RouteId] as RouteEntry | undefined;
    if (p && !canOpenRoute(p, v)) return false;
  }
  return true;
}

/** The page a path belongs to: exact match, else the longest catalogue path it sits under. */
export function routeOfPath(pathname: string): RouteId | undefined {
  const path = pathname.replace(/\/+$/, '') || '/';
  let best: RouteEntry | undefined;
  for (const r of ROUTE_CATALOG as readonly RouteEntry[]) {
    if (r.section) continue;
    if (r.path === path) return r.id as RouteId;
    if (
      r.path !== '/' &&
      path.startsWith(`${r.path}/`) &&
      r.path.length > (best?.path.length ?? 0)
    ) {
      best = r;
    }
  }
  return best?.id as RouteId | undefined;
}
