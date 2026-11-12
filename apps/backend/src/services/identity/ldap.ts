import type { ConnectionOptions } from 'node:tls';
import { Client, type Entry } from 'ldapts';
import type { LdapConfig } from '@crewhall/shared';

/**
 * Active Directory / LDAP access with ldapts (MIT): a service account searches, the
 * person's own DN binds to prove the password. Nothing here touches the database.
 */

/** RFC 4515 escaping for values placed into a search filter. */
export function escapeFilterValue(value: string) {
  return value.replace(/[\\*()\0]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function fillFilter(template: string, values: Record<string, string>, raw = false) {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = values[key];
    if (v === undefined) return m;
    return raw ? v : escapeFilterValue(v);
  });
}

function tlsOptions(config: LdapConfig): ConnectionOptions {
  return {
    rejectUnauthorized: config.tlsVerify,
    ...(config.caCert ? { ca: [config.caCert] } : {}),
  };
}

function newClient(config: LdapConfig) {
  const ldaps = config.url.toLowerCase().startsWith('ldaps://');
  return new Client({
    url: config.url.replace(/\/+$/, ''),
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    strictDN: false,
    ...(ldaps ? { tlsOptions: tlsOptions(config) } : {}),
  });
}

async function open(config: LdapConfig) {
  const client = newClient(config);
  if (config.startTls && !config.url.toLowerCase().startsWith('ldaps://')) {
    await client.startTLS(tlsOptions(config));
  }
  return client;
}

/** Runs `fn` with a client bound as the service account (anonymous when bindDn is empty). */
export async function withServiceBind<T>(
  config: LdapConfig,
  bindPassword: string | null,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await open(config);
  try {
    if (config.bindDn) await client.bind(config.bindDn, bindPassword ?? '');
    return await fn(client);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export interface DirectoryUser {
  dn: string;
  uid: string;
  email: string | null;
  name: string | null;
  groups: string[];
  disabled: boolean;
}

const first = (v: Entry[string] | undefined): string | null => {
  if (v === undefined) return null;
  const x = Array.isArray(v) ? v[0] : v;
  if (x === undefined) return null;
  return Buffer.isBuffer(x) ? x.toString('utf8') : String(x);
};

const all = (v: Entry[string] | undefined): string[] => {
  if (v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)));
};

/** AD objectGUID bytes → canonical GUID string (little-endian first three groups). */
export function guidToString(buf: Buffer) {
  if (buf.length !== 16) return buf.toString('hex');
  const h = (b: number[]) => b.map((x) => buf[x]!.toString(16).padStart(2, '0')).join('');
  return `${h([3, 2, 1, 0])}-${h([5, 4])}-${h([7, 6])}-${h([8, 9])}-${h([10, 11, 12, 13, 14, 15])}`;
}

function uidOf(config: LdapConfig, entry: Entry) {
  const raw = entry[config.uidAttribute];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (Buffer.isBuffer(value)) return guidToString(value);
  if (value !== undefined && String(value)) return String(value);
  return entry.dn.toLowerCase();
}

function attributes(config: LdapConfig) {
  return [
    config.emailAttribute,
    config.nameAttribute,
    config.uidAttribute,
    'memberOf',
    'userAccountControl',
    'cn',
  ];
}

async function groupsOf(client: Client, config: LdapConfig, entry: Entry, username: string) {
  if (config.useMemberOf) {
    const groups = all(entry.memberOf);
    if (groups.length || !config.groupBaseDn) return groups;
  }
  if (!config.groupBaseDn) return [];
  const filter = fillFilter(config.groupFilter, { dn: entry.dn, username });
  const { searchEntries } = await client.search(config.groupBaseDn, {
    scope: 'sub',
    filter,
    attributes: [config.groupNameAttribute],
    sizeLimit: 1000,
  });
  return searchEntries.map((g) => first(g[config.groupNameAttribute]) ?? g.dn);
}

function toUser(config: LdapConfig, entry: Entry, groups: string[]): DirectoryUser {
  const uac = Number(first(entry.userAccountControl) ?? '0');
  return {
    dn: entry.dn,
    uid: uidOf(config, entry),
    email: first(entry[config.emailAttribute])?.toLowerCase() ?? null,
    name: first(entry[config.nameAttribute]) ?? first(entry.cn),
    groups,
    disabled: config.activeDirectory && (uac & 2) === 2,
  };
}

/** Finds exactly one entry for the typed name; two matches count as none (ambiguous). */
export async function findUser(
  client: Client,
  config: LdapConfig,
  username: string,
): Promise<DirectoryUser | null> {
  const filter = fillFilter(config.userFilter, { username });
  const { searchEntries } = await client.search(config.baseDn, {
    scope: 'sub',
    filter,
    attributes: attributes(config),
    explicitBufferAttributes: [config.uidAttribute === 'objectGUID' ? 'objectGUID' : '__none__'],
    sizeLimit: 2,
  });
  if (searchEntries.length !== 1) return null;
  const entry = searchEntries[0]!;
  return toUser(config, entry, await groupsOf(client, config, entry, username));
}

/** Every person the user filter matches (paged), for the directory sync. */
export async function listUsers(client: Client, config: LdapConfig): Promise<DirectoryUser[]> {
  const filter = fillFilter(config.userFilter, { username: '*' }, true);
  const { searchEntries } = await client.search(config.baseDn, {
    scope: 'sub',
    filter,
    attributes: attributes(config),
    explicitBufferAttributes: [config.uidAttribute === 'objectGUID' ? 'objectGUID' : '__none__'],
    paged: { pageSize: 500 },
  });
  const users: DirectoryUser[] = [];
  for (const entry of searchEntries) {
    const name = first(entry[config.emailAttribute]) ?? entry.dn;
    users.push(toUser(config, entry, await groupsOf(client, config, entry, name)));
  }
  return users;
}

/**
 * Proves the password with a bind as the person. An empty password is refused before
 * binding: many servers treat it as an anonymous ("unauthenticated") bind that succeeds.
 */
export async function verifyPassword(config: LdapConfig, dn: string, password: string) {
  if (!password) return false;
  const client = await open(config);
  try {
    await client.bind(dn, password);
    return true;
  } catch (err) {
    if (isInvalidCredentials(err)) return false;
    throw err;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export function isInvalidCredentials(err: unknown) {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { code?: unknown }).code === 49 ||
      (err as { name?: unknown }).name === 'InvalidCredentialsError')
  );
}

export interface TestStep {
  key: string;
  ok: boolean;
  detail: string | null;
  ms: number;
}

const describeError = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err).slice(0, 500);

/** "Bağlantıyı test et": connect (+ StartTLS), service bind, base search, optional user lookup. */
export async function testDirectory(
  config: LdapConfig,
  bindPassword: string | null,
  username?: string,
): Promise<{ ok: boolean; steps: TestStep[]; user: DirectoryUser | null }> {
  const steps: TestStep[] = [];
  const step = async <T>(key: string, fn: () => Promise<T>, detail?: (v: T) => string | null) => {
    const t0 = performance.now();
    try {
      const v = await fn();
      steps.push({
        key,
        ok: true,
        detail: detail ? detail(v) : null,
        ms: Math.round(performance.now() - t0),
      });
      return { ok: true as const, v };
    } catch (err) {
      steps.push({
        key,
        ok: false,
        detail: describeError(err),
        ms: Math.round(performance.now() - t0),
      });
      return { ok: false as const };
    }
  };

  const client = newClient(config);
  let user: DirectoryUser | null = null;
  try {
    if (config.startTls && !config.url.toLowerCase().startsWith('ldaps://')) {
      if (!(await step('starttls', () => client.startTLS(tlsOptions(config)))).ok) {
        return { ok: false, steps, user };
      }
    }
    const bind = await step(
      'bind',
      async () => {
        if (config.bindDn) await client.bind(config.bindDn, bindPassword ?? '');
        return config.bindDn || null;
      },
      (dn) => dn ?? 'anonymous',
    );
    if (!bind.ok) return { ok: false, steps, user };
    const search = await step(
      'search',
      async () => {
        const filter = fillFilter(config.userFilter, { username: '*' }, true);
        const { searchEntries } = await client.search(config.baseDn, {
          scope: 'sub',
          filter,
          attributes: ['dn'],
          sizeLimit: 1000,
        });
        return searchEntries.length;
      },
      (n) => `${n}`,
    );
    if (!search.ok) return { ok: false, steps, user };
    if (username) {
      const found = await step(
        'user',
        async () => {
          const u = await findUser(client, config, username);
          if (!u) throw new Error('not found');
          return u;
        },
        (u) => u.dn,
      );
      if (!found.ok) return { ok: false, steps, user };
      user = found.v;
    }
    return { ok: true, steps, user };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
