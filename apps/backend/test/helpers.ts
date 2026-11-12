import { createApiClient } from '@crewhall/api-client';
import { sql } from 'drizzle-orm';
import { inject } from 'vitest';
import { loadEnv, type Env } from '../src/env';
import { createLogger } from '../src/logger';
import { createMemoryMailer } from '../src/mail/mailer';
import { totpCode } from '../src/scripts/totp';
import { build, type Built } from '../src/server';

export const WEB_ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct-horse-battery-staple';

export interface TestApp extends Built {
  mailer: ReturnType<typeof createMemoryMailer>;
  env: Env;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<Record<string, string>> = {}) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    AUTH_SECRET: 'test-secret-0123456789abcdef0123456789',
    HUB_URL: WEB_ORIGIN,
    API_URL: 'http://localhost:3000',
    TRUSTED_ORIGINS: 'crewhall://',
    S3_ENDPOINT: inject('s3Endpoint'),
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test-secret',
    // A fresh bucket per test app keeps files independent.
    S3_BUCKET: `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    LOG_LEVEL: 'silent',
    // Test stubs listen on this machine (test/outbound.test.ts covers the guard itself).
    PRIVATE_FETCH_ALLOWLIST: '127.0.0.0/8,::1,localhost',
    ...overrides,
  });
  const mailer = createMemoryMailer();
  const built = await build(env, {
    logger: createLogger(process.env.TEST_LOG_LEVEL ?? 'silent'),
    mailer,
  });
  await resetDb(built);
  return { ...built, mailer, env } satisfies TestApp;
}

/**
 * Empties every table between test files; migrations stay. One TRUNCATE for all tables:
 * a statement per table took ~10 s with 60+ tables and timed out under load.
 */
export async function resetDb(app: Pick<Built, 'deps'>) {
  await app.deps.db.execute(sql`
    do $$ declare names text; begin
      select string_agg(quote_ident(tablename), ', ') into names
        from pg_tables where schemaname = 'public';
      if names is not null then
        execute 'truncate table ' || names || ' restart identity cascade';
      end if;
    end $$;`);
}

interface RawResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/**
 * A browser-like client: keeps cookies, sends the web Origin, and exposes the typed
 * api-client so every call is checked against the contract schemas.
 */
export class Client {
  readonly cookies = new Map<string, string>();
  bearer: string | null = null;
  /** Sent as X-Forwarded-For, as Caddy would. */
  ip: string | null = null;

  constructor(private readonly app: TestApp) {}

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { Origin: WEB_ORIGIN, ...extra };
    if (this.cookies.size) {
      h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (this.bearer) h.Authorization = `Bearer ${this.bearer}`;
    if (this.ip) h['X-Forwarded-For'] = this.ip;
    return h;
  }

  private store(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const extra = Object.fromEntries(new Headers(init.headers).entries());
    const res = await this.app.app.request(url, { ...init, headers: this.headers(extra) });
    this.store(res);
    return res;
  };

  readonly api = createApiClient({
    baseUrl: 'http://localhost:3000',
    fetch: (input, init) => this.fetch(input as string | URL, init),
    validateResponses: true,
  });

  async raw<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<RawResponse<T>> {
    const res = await this.fetch(`http://localhost:3000${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
  }

  auth<T = unknown>(path: string, body: unknown) {
    return this.raw<T>('POST', `/api/auth${path}`, body);
  }

  /** E-mail + password sign-in, finishing the TOTP step when the account has one. */
  async signIn(email: string, password = PASSWORD, totpUri?: string) {
    const res = await this.auth<{ twoFactorRedirect?: boolean }>('/sign-in/email', {
      email,
      password,
    });
    if (res.status !== 200) return res;
    if (res.body.twoFactorRedirect) {
      if (!totpUri) throw new Error(`${email} needs a TOTP code`);
      return this.auth('/two-factor/verify-totp', { code: await totpCode(totpUri) });
    }
    return res;
  }

  /** Enrols TOTP through better-auth's real endpoints; returns the otpauth URI. */
  async enrolTotp(password = PASSWORD) {
    const enabled = await this.auth<{ totpURI: string; backupCodes: string[] }>(
      '/two-factor/enable',
      { password },
    );
    if (enabled.status !== 200) throw new Error(`enable failed: ${JSON.stringify(enabled.body)}`);
    const verified = await this.auth('/two-factor/verify-totp', {
      code: await totpCode(enabled.body.totpURI),
    });
    if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`);
    return enabled.body;
  }
}

export const SETUP_BODY = {
  org: { name: 'Milvasoft', slug: 'milvasoft', defaultLocale: 'tr' as const },
  owner: { name: 'Ahmet Buğra Kösen', email: 'bugra@milvasoft.com', password: PASSWORD },
};

/** Runs setup and signs the owner in with TOTP enrolled, ready for org endpoints. */
export async function setupWithOwner(app: TestApp) {
  const owner = new Client(app);
  const setup = await owner.raw<{ orgId: string; ownerId: string }>('POST', '/api/v1/setup', {
    ...SETUP_BODY,
    spaces: [
      { name: 'Milvasoft', color: 's1', isDefault: true },
      { name: 'Altyapı', color: 's2' },
    ],
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);
  await owner.signIn(SETUP_BODY.owner.email);
  const totp = await owner.enrolTotp();
  return { owner, ...setup.body, totpUri: totp.totpURI };
}

/** Pulls the first URL with the given path prefix out of the newest mail to `to`. */
export function linkFromMail(app: TestApp, to: string, prefix: string) {
  const mail = [...app.mailer.outbox].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`no mail to ${to}`);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}[^"\\s<]+`).exec(mail.text);
  if (!match) throw new Error(`no ${prefix} link in mail to ${to}`);
  return match[0];
}

/** Invites `email`, signs the person up through better-auth and accepts the invitation. */
export async function join(
  app: TestApp,
  admin: Client,
  email: string,
  role: 'admin' | 'member' | 'guest',
  spaceIds: string[] = [],
) {
  const inv = await admin.api.call('createInvitation', { body: { email, role, spaceIds } });
  const token = decodeURIComponent(new URL(inv.url!).pathname.split('/').pop()!);
  const person = new Client(app);
  const signUp = await person.auth('/sign-up/email', {
    email,
    password: PASSWORD,
    name: email.split('@')[0],
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed ${JSON.stringify(signUp.body)}`);
  const me = await person.api.call('acceptInvitation', { params: { token } });
  return { person, me, inv, token };
}

/** Uploads bytes through the real multipart flow: presigned PUTs straight to SeaweedFS. */
export async function uploadFile(
  c: Client,
  input: {
    spaceId: string;
    parentId?: string | null;
    name: string;
    content: Buffer;
    mime?: string;
    onConflict?: 'ask' | 'version' | 'rename' | 'replace';
    nodeId?: string;
  },
) {
  const upload = await c.api.call('createUpload', {
    body: {
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      name: input.name,
      sizeBytes: input.content.length,
      mime: input.mime,
      onConflict: input.onConflict,
      nodeId: input.nodeId,
    },
  });
  const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  const { parts } = await c.api.call('getUploadPartUrls', {
    params: { uploadId: upload.id },
    body: { partNumbers: numbers },
  });
  const done: { partNumber: number; etag: string }[] = [];
  for (const p of parts) {
    const start = (p.partNumber - 1) * upload.partSize;
    const body = input.content.subarray(start, start + upload.partSize);
    const res = await fetch(p.url, { method: 'PUT', body });
    if (!res.ok) throw new Error(`part ${p.partNumber} PUT ${res.status}: ${await res.text()}`);
    done.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' });
  }
  return c.api.call('completeUpload', { params: { uploadId: upload.id }, body: { parts: done } });
}
