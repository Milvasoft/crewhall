import { z } from 'zod';

/**
 * Per-account vault settings (design 8.16), stored encrypted on the server (user_keys.settings)
 * so they follow the person, not the browser. TOFU fingerprint pins live here too.
 */

export const AUTO_LOCK_CHOICES = [1, 5, 10, 15, 30, 60] as const;
/** Minutes the vault waits after the tab or window is hidden; 0: at once, null: never. */
export const HIDDEN_LOCK_CHOICES = [0, 1, 5, 15, null] as const;
export const CLIPBOARD_CHOICES = [15, 30, 60, 120] as const;

const PasswordPrefs = z.object({
  length: z.number().int().min(8).max(64).default(22),
  upper: z.boolean().default(true),
  lower: z.boolean().default(true),
  digits: z.boolean().default(true),
  symbols: z.boolean().default(true),
  avoidAmbiguous: z.boolean().default(false),
});

const PassphrasePrefs = z.object({
  words: z.number().int().min(4).max(10).default(5),
  separator: z.string().max(3).default('-'),
  capitalize: z.boolean().default(true),
  includeNumber: z.boolean().default(true),
  lang: z.enum(['tr', 'en']).default('tr'),
});

export const VaultSettings = z.object({
  /** Tells an older copy from the server apart (openSettings in @crewhall/crypto). */
  revision: z.number().int().min(0).default(0),
  /** Set by acceptSettings: a key without a pin needs confirming, it is not "first seen". */
  confirmNewKeys: z.boolean().default(false),
  /** Idle lock (user decision 2026-10-29: 10 minutes on desktop, web and mobile). */
  autoLockMinutes: z.number().int().min(1).max(240).default(10),
  /**
   * Lock this many minutes after the tab or window is hidden; 0 at once, null never. Coming back
   * before then keeps it open (copy a password, paste it elsewhere, return).
   */
  hiddenLockMinutes: z.number().int().min(0).max(60).nullable().default(5),
  /** Older apps (mobile) read this; it mirrors hiddenLockMinutes !== null. */
  lockOnHidden: z.boolean().default(true),
  clipboardSeconds: z.number().int().min(10).max(600).default(30),
  revealSeconds: z.number().int().min(10).max(300).default(30),
  generator: z
    .object({
      mode: z.enum(['password', 'passphrase']).default('password'),
      password: PasswordPrefs.default(PasswordPrefs.parse({})),
      passphrase: PassphrasePrefs.default(PassphrasePrefs.parse({})),
    })
    .default({
      mode: 'password',
      password: PasswordPrefs.parse({}),
      passphrase: PassphrasePrefs.parse({}),
    }),
  /** userId → public key fingerprint first seen (TOFU, doc 17 §7 threat table). */
  pins: z.record(z.string(), z.string()).default({}),
});
export type VaultSettings = z.infer<typeof VaultSettings>;

export const DEFAULT_SETTINGS: VaultSettings = VaultSettings.parse({});

/**
 * Settings saved before the hidden-lock wait existed: the old 5-minute idle default becomes the
 * new 10, and "lock as soon as hidden" becomes the new 5-minute wait (user decision 2026-10-29).
 */
function migrate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || 'hiddenLockMinutes' in value) return value;
  const old = value as { autoLockMinutes?: unknown; lockOnHidden?: unknown };
  return {
    ...value,
    ...(old.autoLockMinutes === 5 || old.autoLockMinutes === undefined
      ? { autoLockMinutes: 10 }
      : {}),
    hiddenLockMinutes: old.lockOnHidden === false ? null : 5,
  };
}

/** `readable` is false when these are not settings: the defaults must not pass for mine. */
export function readSettings(value: unknown): { settings: VaultSettings; readable: boolean } {
  const parsed = VaultSettings.safeParse(migrate(value));
  if (!parsed.success) return { settings: DEFAULT_SETTINGS, readable: false };
  return {
    settings: { ...parsed.data, lockOnHidden: parsed.data.hiddenLockMinutes !== null },
    readable: true,
  };
}

export function parseSettings(value: unknown): VaultSettings {
  return readSettings(value).settings;
}
