import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const semverOrEmpty = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d+\.\d+\.\d+/)
    .optional(),
);

/**
 * Process configuration (design doc 17 §11). Validated once at start;
 * a missing or malformed variable stops the process with a readable message.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Public URL of the web app; links in e-mails point here. */
  HUB_URL: z.url().default('http://localhost:5173'),
  /** Public URL of this api (better-auth baseURL). Same as HUB_URL behind Caddy. */
  API_URL: z.url().default('http://localhost:3000'),
  /**
   * Federation (roadmap 26): talk to peer installations over plain http. Only for development
   * and tests (several local instances on localhost ports); production peers are https.
   */
  FEDERATION_ALLOW_HTTP: bool,
  /** Central plugin marketplace (docs/contracts/eklentiler.md); its catalog and packages. */
  MARKETPLACE_URL: z.url().default('https://market.crewhall.dev'),
  /**
   * Trusted marketplace keys, `keyId:base64-spki` separated by commas. A package signed by
   * any other key is refused; empty means no plugin can be installed.
   */
  MARKETPLACE_PUBLIC_KEYS: list.transform((items) =>
    items.flatMap((item) => {
      const at = item.indexOf(':');
      return at > 0 ? [{ keyId: item.slice(0, at), publicKey: item.slice(at + 1) }] : [];
    }),
  ),
  /**
   * Shared channels (kararlar.md 2026-10-29): channel invites from these peer domains are
   * accepted at once into the default space (the demo and test servers; comma separated).
   */
  FEDERATION_AUTO_ACCEPT_DOMAINS: list,
  /** Extra browser origins allowed by CORS and better-auth (comma separated). */
  WEB_ORIGINS: list,
  /** Non-browser origins for better-auth, e.g. the mobile scheme `crewhall://`, `exp://`. */
  TRUSTED_ORIGINS: list,

  DATABASE_URL: z.string().min(1),
  MIGRATE_ON_START: bool,
  /** Run the job handlers inside the api (development); production uses the worker service. */
  WORKER_IN_PROCESS: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1')),
  MIGRATIONS_DIR: z.preprocess(emptyToUndefined, z.string().optional()),

  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  /** Fixed setup token; when empty a random one is generated and logged. */
  SETUP_TOKEN: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  /** Allow sign-up without an invitation (off by default: invite-only). */
  SIGNUP_OPEN: bool,
  TOTP_ISSUER: z.string().default('Crewhall'),

  SMTP_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().optional()),

  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  S3_PUBLIC_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  S3_BUCKET: z.string().default('crewhall'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

  /**
   * Live demo: the data resets every hour to the sample, sign-in lists the sample accounts.
   * Never on a real install: the reset empties the database and the bucket.
   */
  DEMO_MODE: bool,
  /**
   * Demo only: after every reset federation is turned on with these peers (comma separated
   * domains) and shared channel invites are fetched again from them.
   */
  DEMO_FEDERATION_PEERS: list,
  /** Backups (tools/crewhall, Yönetim › Yedekler): the snapshots folder, /backups in the image. */
  CREWHALL_BACKUP_DIR: z.string().default('/backups'),
  /** `docker` runs pg_dump from the postgres image (development without the client). */
  CREWHALL_PG_TOOLS: z.enum(['local', 'docker']).default('local'),

  /**
   * Desktop app releases this server hands out (installers and the electron-updater feed):
   * <dir>/win/latest.yml + installer + blockmap, <dir>/mac/latest-mac.yml + zip/dmg. Missing or
   * empty: no desktop downloads, the apps see "no update". /app/desktop-updates in the image.
   */
  DESKTOP_UPDATES_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Without DESKTOP_UPDATES_DIR the releases are read from the app's S3 bucket under this prefix:
   * `<prefix><win|mac>/<file>`, uploaded by hand.
   */
  DESKTOP_UPDATES_S3_PREFIX: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('desktop-updates/')
      .transform((p) => (p.endsWith('/') ? p : `${p}/`)),
  ),

  /** Server version shown to clients; defaults to apps/backend/package.json (the image tag). */
  APP_VERSION: z.preprocess(emptyToUndefined, z.string().optional()),
  /** CI's build number and the commit of this image (apps/backend/Dockerfile); getCompat says them. */
  BUILD_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  BUILD_COMMIT: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Oldest mobile app version this server supports (major.minor.patch); empty = no limit. */
  MIN_MOBILE_VERSION: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d+\.\d+\.\d+/)
      .optional(),
  ),

  /**
   * Oldest app versions this server accepts (shared compat.ts); older apps get 426
   * client_outdated. Empty: iOS and Android fall back to MIN_MOBILE_VERSION, then to
   * MIN_CLIENT_DEFAULTS.
   */
  MIN_CLIENT_IOS: semverOrEmpty,
  MIN_CLIENT_ANDROID: semverOrEmpty,
  MIN_CLIENT_DESKTOP: semverOrEmpty,
  /** Where the update prompt sends an outdated app (App Store, Play Store, download page). */
  CLIENT_STORE_URL_IOS: z.preprocess(emptyToUndefined, z.url().optional()),
  CLIENT_STORE_URL_ANDROID: z.preprocess(emptyToUndefined, z.url().optional()),
  CLIENT_STORE_URL_DESKTOP: z.preprocess(emptyToUndefined, z.url().optional()),

  /**
   * Requests made for addresses people type (link titles and health, automation webhooks,
   * federation) never reach private, loopback or metadata addresses (src/net/outbound.ts).
   * Intranet exceptions: comma list of CIDRs, hosts or `*.corp.example`; they may use any port.
   */
  PRIVATE_FETCH_ALLOWLIST: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Ports besides 80 and 443 those requests may use on public addresses (comma list). */
  OUTBOUND_ALLOWED_PORTS: z.preprocess(emptyToUndefined, z.string().optional()),

  /** HMAC key of the portal revalidate webhook (doc 17 §11); the Next.js site has the same. */
  PORTAL_REVALIDATE_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),

  /** GIPHY API (GIFs in chat, the org's own key); tests point it at a stub. */
  GIPHY_API_URL: z.url().default('https://api.giphy.com'),
  /** Expo push service (doc 17 §10); tests point it at a stub. */
  EXPO_PUSH_URL: z.url().default('https://exp.host/--/api/v2/push'),
  /** Expo access token when enhanced push security is on (optional). */
  EXPO_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Firebase service account for direct FCM (HTTP v1) pushes: a path to the JSON file
   * (development) or the JSON itself (production secrets). Without it FCM devices get no push.
   */
  FIREBASE_SERVICE_ACCOUNT_FILE: z.preprocess(emptyToUndefined, z.string().optional()),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.preprocess(emptyToUndefined, z.string().optional()),
  /** FCM API origin; tests point it at a stub. */
  FCM_API_URL: z.url().default('https://fcm.googleapis.com'),
  /**
   * iOS incoming calls (CallKit): VoIP pushes straight to APNs with a token-based key (.p8). The
   * key itself (PEM; "\n" escapes allowed) or a path to it, its id, the team id and the app's
   * bundle id; without all of them no VoIP push is sent (iPhones get the ordinary push).
   */
  APNS_KEY_P8: z.preprocess(emptyToUndefined, z.string().optional()),
  APNS_KEY_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  APNS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  APNS_TEAM_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  APNS_BUNDLE_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * The build of devices that did not say which one they are (registerPushDevice
   * apnsEnvironment): production for TestFlight and App Store, sandbox for development builds.
   */
  APNS_ENV: z.preprocess(emptyToUndefined, z.enum(['production', 'sandbox']).default('production')),
  /** APNs origins instead of Apple's (production, sandbox); tests point them at stubs. */
  APNS_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  APNS_SANDBOX_URL: z.preprocess(emptyToUndefined, z.url().optional()),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
  OTEL_SERVICE_NAME: z.string().default('crewhall-backend'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
