import { resources } from '@crewhall/i18n';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';

const leaves = (obj: unknown, prefix = ''): [string, string][] =>
  obj && typeof obj === 'object'
    ? Object.entries(obj).flatMap(([k, v]) => leaves(v, `${prefix}${k}.`))
    : [[prefix.slice(0, -1), String(obj)]];

const NUMBERS = [
  'revision',
  'capacity',
  'years',
  'count',
  'min',
  'step',
  'total',
  'days',
  'spaces',
  'invites',
  'members',
  'active',
  'archived',
  'value',
  'status',
  'version',
  'server',
  'ratio',
  'done',
  'failed',
  'n',
  'pct',
  'people',
  'links',
  'seconds',
  'w',
  'h',
  'hours',
  'attempt',
  'max',
  'limit',
  // mcp
  'calls',
  'pending',
  'writes',
  'errors',
  'tools',
  'resources',
  'rpm',
  'wpm',
  'kb',
  'ms',
  // vault
  'minutes',
  'remaining',
  'items',
  'bits',
  'length',
  'folders',
  'collections',
  'totp',
  'fields',
  'ok',
  'expired',
  'soon',
  'm',
  't',
  'p',
  'views',
  // wiki
  'blocks',
  // announcements
];
const STRINGS = [
  'role',
  'origin',
  'plugin',
  'tab',
  'permissions',
  'domain',
  'reason',
  'week',
  'spent',
  'estimate',
  'range',
  'service',
  'types',
  'hint',
  'scopes',
  'tag',
  'domains',
  'address',
  'org',
  'publisher',
  'duration',
  'subscriber',
  'name',
  'email',
  'date',
  'time',
  'when',
  'module',
  'language',
  'emails',
  'app',
  'scheme',
  'pair',
  'invited',
  'current',
  'ip',
  'q',
  'title',
  'text',
  'folder',
  'size',
  'path',
  'ago',
  'type',
  'used',
  'year',
  'space',
  'actor',
  'emoji',
  'names',
  'city',
  'level',
  'conversationTitle',
  'webhookName',
  'nodeName',
  'spaceName',
  'linkTitle',
  'zone',
  'first',
  'second',
  // mcp
  'client',
  'scope',
  'label',
  'requestId',
  'action',
  'code',
  'person',
  'kind',
  // vault
  'what',
  'vault',
  'who',
  // boards
  'by',
  'position',
  'shown',
  'next',
  'points',
  'key',
  'column',
  'from',
  'to',
  'user',
  'board',
  'start',
  'end',
  'width',
  'height',
  // wiki
  'target',
  'modules',
  'fileName',
  'error',
  // chat integrations
];

/** Words that read the same in Turkish and English UI copy (product names, tech terms). */
const SAME_IN_BOTH = new Set([
  'Crewhall',
  'Exchange',
  'NTLM',
  'Basic',
  'Türkçe',
  // Scrum terms used as-is in Turkish teams
  'Backlog',
  'Burndown',
  // GIPHY: brand, its required attribution ("Powered by GIPHY") and content ratings
  'GIF',
  'GIPHY',
  'Powered',
  'by',
  'PG',
  'PG-13',
  // Notification delivery (product and protocol names)
  'Notifike',
  // Desktop releases (electron-builder file kind)
  'Blockmap',
  'Port',
  'STARTTLS',
  // Operating systems and tools (WebDAV instructions), office products
  'Office',
  'Euro-Office',
  'ONLYOFFICE',
  'macOS',
  'Windows',
  'Linux',
  'rclone',
  'Ctrl',
  'Shift',
  'Alt',
  'Cmd',
  'Sprint',
  'WIP',
  'P1',
  'P2',
  'P3',
  'P4',
  'PNG',
  'SVG',
  'English',
  'Passkey',
  'passkey',
  'Chat',
  'Drive',
  'Portal',
  'Space',
  'Favicon',
  '2FA',
  'Link',
  'Normal',
  'PDF',
  // page export formats
  'Word',
  '.docx',
  'Markdown',
  '.md',
  'Video',
  'BOT',
  'AI',
  'Model',
  'Push',
  'Streamable',
  'HTTP',
  'OAuth',
  '2.1',
  'PKCE',
  'Claude',
  'Code',
  'Desktop',
  'claude.ai',
  'terminal',
  'IDE',
  'JSON',
  'KB',
  'Token',
  'REST',
  'API',
  'OpenAPI',
  'curl',
  'TypeScript',
  'Bearer',
  // AI providers (Yönetim › Yapay zekâ)
  'Anthropic',
  'ChatGPT',
  'OpenAI',
  'Gemini',
  'Google',
  'Mistral',
  'Azure',
  'OpenRouter',
  'token',
  'Idempotency-Key',
  'Test',
  'Prod',
  'URL',
  'IP',
  'TOTP',
  'CVV',
  'Argon2id',
  'MiB',
  'm',
  't',
  'p',
  'ms',
  'org',
  // portal and identity (technical terms kept as-is in Turkish UI)
  'Blog',
  'SEO',
  'Next.js',
  'Slug',
  'Logo',
  'MDX',
  'Mermaid',
  'HTML',
  'Site',
  'OK',
  'Issuer',
  'Discovery',
  'Client',
  'ID',
  'Web',
  'SPA',
  'Native',
  'secret',
  'Keycloak',
  'Microsoft',
  'Entra',
  'Google',
  'Workspace',
  'Okta',
  'SAML',
  'Active',
  'Directory',
  'OpenLDAP',
  'OpenID',
  'Connect',
  'IdP',
  'entity',
  'AD',
  'objectGUID',
  'entryUUID',
  'StartTLS',
  'Redirect',
  'URI',
  'SP',
  'Metadata',
  'TLS',
  'Sitemap',
  'Canonical',
  'Revalidate',
  'webhook',
  // tools module: formats, units and standards kept as they are
  '.NET',
  'SQL',
  'Kelvin',
  'Rankine',
  'UUID',
  'IBAN',
  'Excel',
  'TOML',
  'YAML',
  'CSV',
  'XML',
  'TypeScript',
]);

describe('web dictionaries', () => {
  it.each(['tr', 'en'] as const)('every %s message is valid ICU and formats', (locale) => {
    for (const [key, message] of leaves(resources[locale].web)) {
      const fmt = new IntlMessageFormat(message, locale);
      // Rich messages (`rich()`): every tag the message uses gets a handler, like <b>.
      const tags = [...message.matchAll(/<([a-zA-Z][\w-]*)>/g)].map((m) => m[1]!);
      const out = fmt.format({
        ...Object.fromEntries(NUMBERS.map((n) => [n, 2])),
        ...Object.fromEntries(STRINGS.map((n) => [n, 'x'])),
        ...Object.fromEntries(tags.map((tag) => [tag, (chunks: unknown[]) => chunks.join('')])),
        b: (chunks: unknown[]) => chunks.join(''),
      });
      expect(out, key).toBeTruthy();
    }
  });

  /**
   * A Turkish value equal to the English one is usually a string nobody translated. Product and
   * technical terms may stay the same; anything else fails here with the key in the message.
   */
  it('has no Turkish value left equal to the English one (except terms)', () => {
    const en = new Map(leaves(resources.en.web));
    const same = leaves(resources.tr.web).filter(([k, v]) => en.get(k) === v);
    const untranslated = same.filter(([, v]) => {
      const words = v
        .replace(/\{[^}]*\}/g, ' ')
        .split(/[^\p{L}\d.-]+/u)
        // Single letters are key names (Ctrl D), not copy.
        .filter((w) => w.length > 1 && /\p{L}/u.test(w));
      return words.some((w) => !SAME_IN_BOTH.has(w));
    });
    expect(untranslated.map(([k, v]) => `${k} = ${v}`)).toEqual([]);
  });

  /** White label: the app is the org's (bootstrap branding), never the old working name "Hub". */
  it('does not call the app "Hub"', () => {
    for (const locale of ['tr', 'en'] as const) {
      for (const [key, message] of leaves(resources[locale].web)) {
        expect(message.replace(/Docker Hub|GitHub/g, ''), key).not.toMatch(/\bHub\b/);
      }
    }
  });

  it('uses no em or en dashes (writing rule)', () => {
    for (const locale of ['tr', 'en'] as const) {
      for (const [key, message] of leaves(resources[locale].web)) {
        expect(message, key).not.toMatch(/[–—]/);
      }
    }
  });
});
