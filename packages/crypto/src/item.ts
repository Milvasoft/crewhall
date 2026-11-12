import { z } from 'zod';

/**
 * Decrypted item payload (schema v1). Everything here is secret: name, URLs, usernames and
 * notes included. Only `type` is also stored in clear (vault_items.type) for filtering, and
 * the ciphertext AAD binds it so the server cannot relabel an item.
 *
 * Objects are loose: fields added by a newer client survive an edit by an older one.
 */

export const ITEM_TYPES = ['login', 'note', 'card', 'api_key', 'ssh_key', 'identity'] as const;
export const ItemType = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemType>;

export const CustomFieldType = z.enum(['text', 'hidden', 'boolean', 'date']);
export type CustomFieldType = z.infer<typeof CustomFieldType>;

export const CustomField = z.looseObject({
  id: z.string().min(1).max(64),
  type: CustomFieldType,
  label: z.string().max(200),
  value: z.string().max(20_000),
});
export type CustomField = z.infer<typeof CustomField>;

/** Encrypted file; its key lives only here, inside the encrypted item. */
export const AttachmentRef = z.looseObject({
  id: z.uuid(),
  name: z.string().min(1).max(255),
  size: z.number().int().min(0),
  mime: z.string().max(255).nullable(),
  /** 32-byte file key, base64. */
  key: z.string().min(40).max(64),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export const PasswordHistoryEntry = z.looseObject({
  password: z.string().max(5000),
  changedAt: z.string(),
});
export type PasswordHistoryEntry = z.infer<typeof PasswordHistoryEntry>;

/** Environment tag shown next to names (design 8.4: Test, Prod). */
export const EnvTag = z.enum(['test', 'prod']);

const common = {
  v: z.literal(1),
  name: z.string().min(1).max(300),
  favorite: z.boolean().default(false),
  notes: z.string().max(100_000).default(''),
  tags: z.array(z.string().max(100)).max(50).default([]),
  env: EnvTag.nullable().default(null),
  fields: z.array(CustomField).max(100).default([]),
  attachments: z.array(AttachmentRef).max(100).default([]),
  /** Previous passwords / secrets, newest first; at most PASSWORD_HISTORY_LIMIT. */
  passwordHistory: z.array(PasswordHistoryEntry).max(50).default([]),
  /** Import notes kept until the person fixes the item (design 8.14). */
  importWarnings: z.array(z.string().max(100)).max(20).default([]),
  importedFrom: z.enum(['bitwarden']).optional(),
};

const s = (max = 5000) => z.string().max(max).default('');

export const LoginItem = z.looseObject({
  ...common,
  type: z.literal('login'),
  username: s(),
  password: s(),
  /** otpauth:// URI or a bare base32 secret. */
  totp: s(),
  uris: z.array(z.string().max(2000)).max(50).default([]),
});

export const NoteItem = z.looseObject({ ...common, type: z.literal('note') });

export const CardItem = z.looseObject({
  ...common,
  type: z.literal('card'),
  cardholder: s(200),
  brand: s(50),
  number: s(40),
  /** "01".."12" or empty. */
  expMonth: s(2),
  /** Four digits or empty. */
  expYear: s(4),
  code: s(10),
});

export const ApiKeyItem = z.looseObject({
  ...common,
  type: z.literal('api_key'),
  key: s(20_000),
  username: s(),
  url: s(2000),
  scope: s(1000),
  /** ISO date (YYYY-MM-DD); expiry warnings are computed on the device (design 8.4, 8.15). */
  expiresAt: z.string().max(10).nullable().default(null),
});

export const SshKeyItem = z.looseObject({
  ...common,
  type: z.literal('ssh_key'),
  privateKey: s(20_000),
  publicKey: s(5000),
  fingerprint: s(200),
  passphrase: s(),
  /** user@host:port the key is for. */
  host: s(500),
});

export const IdentityItem = z.looseObject({
  ...common,
  type: z.literal('identity'),
  title: s(50),
  firstName: s(200),
  middleName: s(200),
  lastName: s(200),
  username: s(200),
  company: s(200),
  email: s(320),
  phone: s(50),
  nationalId: s(50),
  passport: s(50),
  license: s(50),
  address1: s(500),
  address2: s(500),
  address3: s(500),
  city: s(200),
  state: s(200),
  postalCode: s(20),
  country: s(100),
});

export const ItemPayload = z.discriminatedUnion('type', [
  LoginItem,
  NoteItem,
  CardItem,
  ApiKeyItem,
  SshKeyItem,
  IdentityItem,
]);
export type ItemPayload = z.infer<typeof ItemPayload>;
export type ItemPayloadInput = z.input<typeof ItemPayload>;
export type ItemOf<T extends ItemType> = Extract<ItemPayload, { type: T }>;

export const PASSWORD_HISTORY_LIMIT = 10;

/** An empty item of the given type, ready for the edit form. */
export function emptyItem<T extends ItemType>(type: T, name = ''): ItemOf<T> {
  // Parsing with a placeholder name fills every default; the real name is set after.
  const parsed = ItemPayload.parse({ v: 1, type, name: name || '-' });
  return { ...parsed, name } as ItemOf<T>;
}

/** The secret a password history entry tracks for each type. */
export function primarySecret(item: ItemPayload): string {
  switch (item.type) {
    case 'login':
      return item.password;
    case 'api_key':
      return item.key;
    case 'card':
      return item.number;
    case 'ssh_key':
      return item.privateKey;
    default:
      return '';
  }
}

/**
 * Applies an edit: when the primary secret changed, the old one goes to the top of the
 * password history (design 8.8), keeping the newest PASSWORD_HISTORY_LIMIT entries.
 */
export function withHistory(
  before: ItemPayload,
  after: ItemPayload,
  now = new Date(),
): ItemPayload {
  if (before.type !== after.type || (after.type !== 'login' && after.type !== 'api_key'))
    return after;
  const old = primarySecret(before);
  if (!old || old === primarySecret(after)) return after;
  return {
    ...after,
    passwordHistory: [
      { password: old, changedAt: now.toISOString() },
      ...after.passwordHistory,
    ].slice(0, PASSWORD_HISTORY_LIMIT),
  };
}
