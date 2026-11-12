import { cbc } from '@noble/ciphers/aes.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { expand } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';
import { concat, CryptoError, equalBytes, fromB64, fromUtf8, toB64, utf8 } from './bytes';
import { emptyItem, ItemPayload, type CustomField, type ItemPayloadInput } from './item';
import { randomBytes } from './random';
import { hostOf } from './summary';
import { newId } from './random';

/**
 * Bitwarden / Vaultwarden migration (design 8.12-8.14). Everything runs on the device: the
 * export file is parsed here and only re-encrypted items reach the server.
 *
 * Supported inputs: unencrypted JSON, password-protected JSON (PBKDF2-SHA256 or Argon2id,
 * AES-256-CBC + HMAC-SHA256 "type 2" strings) and the individual-vault CSV. Account-restricted
 * encrypted exports need the Bitwarden account key and cannot be read.
 */

/** A leading byte-order mark (U+FEFF): JS whitespace classes match it. */
const BOM = /^\s+/;

export class ImportError extends Error {
  constructor(
    readonly code:
      'invalid_file' | 'password_required' | 'wrong_password' | 'account_encrypted' | 'unsupported',
  ) {
    super(code);
    this.name = 'ImportError';
  }
}

export type ImportWarning =
  | 'attachments_missing'
  | 'passkey_not_migrated'
  | 'invalid_expiry'
  | 'linked_field_dropped'
  | 'multiple_collections';

export interface ImportGroup {
  /** `none`, `folder:<id>` or `collection:<id>`. */
  key: string;
  kind: 'none' | 'folder' | 'collection';
  name: string;
  count: number;
}

export interface ImportCandidate {
  sourceId: string;
  group: string;
  payload: ItemPayload;
  createdAt: string | null;
  updatedAt: string | null;
  warnings: ImportWarning[];
  /** A note whose name looks like a token / API key / PAT (design 8.13 conversion option). */
  apiKeyLike: boolean;
}

export interface ParsedImport {
  format: 'json' | 'encrypted_json' | 'csv';
  items: ImportCandidate[];
  groups: ImportGroup[];
  stats: {
    total: number;
    byType: Record<string, number>;
    folders: number;
    collections: number;
    withTotp: number;
    withFields: number;
    skippedDeleted: number;
    /** Rows that could not be read or mapped (bad shape, unknown type); they are not in `items`. */
    failed: number;
  };
}

/* ------------------------------ Bitwarden JSON shape ------------------------------ */

const str = z.string().nullish();
const BwField = z.looseObject({
  name: str,
  value: str,
  type: z.number().nullish(),
  linkedId: z.unknown().optional(),
});
const BwItem = z.looseObject({
  id: z.string().nullish(),
  folderId: str,
  collectionIds: z.array(z.string()).nullish(),
  type: z.number(),
  name: str,
  notes: str,
  favorite: z.boolean().nullish(),
  fields: z.array(BwField).nullish(),
  login: z
    .looseObject({
      uris: z.array(z.looseObject({ uri: str })).nullish(),
      username: str,
      password: str,
      totp: str,
      fido2Credentials: z.array(z.unknown()).nullish(),
    })
    .nullish(),
  card: z
    .looseObject({
      cardholderName: str,
      brand: str,
      number: str,
      expMonth: str,
      expYear: str,
      code: str,
    })
    .nullish(),
  identity: z.record(z.string(), z.unknown()).nullish(),
  sshKey: z.looseObject({ privateKey: str, publicKey: str, keyFingerprint: str }).nullish(),
  passwordHistory: z.array(z.looseObject({ lastUsedDate: str, password: str })).nullish(),
  attachments: z.array(z.unknown()).nullish(),
  creationDate: str,
  revisionDate: str,
  deletedDate: str,
});
type BwItem = z.infer<typeof BwItem>;

const BwExport = z.looseObject({
  encrypted: z.boolean().optional(),
  passwordProtected: z.boolean().optional(),
  folders: z.array(z.looseObject({ id: z.string(), name: z.string() })).nullish(),
  collections: z.array(z.looseObject({ id: z.string(), name: z.string() })).nullish(),
  items: z.array(z.unknown()).nullish(),
});

const BwProtected = z.looseObject({
  encrypted: z.literal(true),
  passwordProtected: z.literal(true),
  salt: z.string(),
  kdfType: z.number(),
  kdfIterations: z.number(),
  kdfMemory: z.number().nullish(),
  kdfParallelism: z.number().nullish(),
  encKeyValidation_DO_NOT_EDIT: z.string(),
  data: z.string(),
});

/* ------------------------------ password-protected files ------------------------------ */

interface BwKeys {
  enc: Uint8Array;
  mac: Uint8Array;
}

async function bitwardenKey(
  password: string,
  salt: string,
  kdf: { type: number; iterations: number; memory?: number | null; parallelism?: number | null },
): Promise<BwKeys> {
  let key: Uint8Array;
  if (kdf.type === 0) {
    if (kdf.iterations < 5000 || kdf.iterations > 10_000_000) throw new ImportError('unsupported');
    key = await pbkdf2Async(sha256, utf8(password), utf8(salt), { c: kdf.iterations, dkLen: 32 });
  } else if (kdf.type === 1) {
    const memory = kdf.memory ?? 64;
    const parallelism = kdf.parallelism ?? 4;
    if (
      kdf.iterations < 1 ||
      kdf.iterations > 20 ||
      memory < 15 ||
      memory > 1024 ||
      parallelism < 1 ||
      parallelism > 16
    ) {
      throw new ImportError('unsupported');
    }
    key = await argon2idAsync(utf8(password), sha256(utf8(salt)), {
      t: kdf.iterations,
      m: memory * 1024,
      p: parallelism,
      dkLen: 32,
    });
  } else throw new ImportError('unsupported');
  // Bitwarden "stretches" the 32-byte key with HKDF-Expand into encryption and MAC keys.
  return { enc: expand(sha256, key, utf8('enc'), 32), mac: expand(sha256, key, utf8('mac'), 32) };
}

function decryptEncString(keys: BwKeys, value: string): string {
  const m = /^2\.([^|]+)\|([^|]+)\|([^|]+)$/.exec(value.trim());
  if (!m) throw new ImportError('invalid_file');
  const iv = fromB64(m[1] as string);
  const data = fromB64(m[2] as string);
  const mac = fromB64(m[3] as string);
  if (!equalBytes(hmac(sha256, keys.mac, concat(iv, data)), mac))
    throw new ImportError('wrong_password');
  try {
    return fromUtf8(cbc(keys.enc, iv).decrypt(data));
  } catch {
    throw new ImportError('wrong_password');
  }
}

function encryptEncString(keys: BwKeys, text: string, iv: Uint8Array = randomBytes(16)): string {
  const data = cbc(keys.enc, iv).encrypt(utf8(text));
  const mac = hmac(sha256, keys.mac, concat(iv, data));
  return `2.${toB64(iv)}|${toB64(data)}|${toB64(mac)}`;
}

const CHROME_CSV_HEADER = /^name,url,username,password(,|\r?$|\r?\n)/i;

/** What the file is, before asking for a password (design 8.12 format choice). */
export function sniffBitwardenFile(
  text: string,
): 'json' | 'encrypted_json' | 'account_encrypted' | 'csv' | 'unknown' {
  const t = text.trimStart();
  if (t.startsWith('{')) {
    try {
      const doc = BwExport.parse(JSON.parse(t));
      if (doc.encrypted && doc.passwordProtected) return 'encrypted_json';
      if (doc.encrypted) return 'account_encrypted';
      return 'json';
    } catch {
      return 'unknown';
    }
  }
  return /^(folder|collections),/i.test(t) ||
    /^[a-z_,]*login_username/i.test(t) ||
    CHROME_CSV_HEADER.test(t)
    ? 'csv'
    : 'unknown';
}

/* ------------------------------ mapping ------------------------------ */

export interface ImportOptions {
  /** Export password for password-protected JSON. */
  password?: string;
}

const API_KEY_NAME = /(\btoken\b|\bapi[\s_-]?key\b|\bpat\b)/i;

function fieldsOf(item: BwItem, warnings: Set<ImportWarning>): CustomField[] {
  const out: CustomField[] = [];
  for (const f of item.fields ?? []) {
    if (f.type === 3) {
      warnings.add('linked_field_dropped');
      continue;
    }
    const type = f.type === 1 ? 'hidden' : f.type === 2 ? 'boolean' : 'text';
    out.push({ id: newId(), type, label: (f.name ?? '').slice(0, 200), value: f.value ?? '' });
  }
  return out;
}

function month(value: string | null | undefined, warnings: Set<ImportWarning>) {
  if (!value) return '';
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return String(n).padStart(2, '0');
  warnings.add('invalid_expiry');
  return '';
}

function year(value: string | null | undefined, warnings: Set<ImportWarning>) {
  if (!value) return '';
  const v = value.trim();
  if (/^\d{4}$/.test(v)) return v;
  if (/^\d{2}$/.test(v)) return `20${v}`;
  warnings.add('invalid_expiry');
  return '';
}

const text = (v: unknown, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');

function mapItem(
  raw: BwItem,
): { payload: ItemPayload; warnings: ImportWarning[]; apiKeyLike: boolean } | null {
  const warnings = new Set<ImportWarning>();
  const name = text(raw.name, 300).trim() || '—';
  const base = {
    v: 1 as const,
    name,
    favorite: raw.favorite ?? false,
    notes: text(raw.notes, 100_000),
    fields: fieldsOf(raw, warnings),
    passwordHistory: (raw.passwordHistory ?? [])
      .filter((h) => h.password)
      .slice(0, 10)
      .map((h) => ({ password: h.password ?? '', changedAt: h.lastUsedDate ?? '' })),
    importedFrom: 'bitwarden' as const,
  };
  if (raw.attachments?.length) warnings.add('attachments_missing');
  let input: ItemPayloadInput;
  switch (raw.type) {
    case 1: {
      if (raw.login?.fido2Credentials?.length) warnings.add('passkey_not_migrated');
      input = {
        ...base,
        type: 'login',
        username: text(raw.login?.username),
        password: text(raw.login?.password),
        totp: text(raw.login?.totp, 5000),
        uris: (raw.login?.uris ?? [])
          .map((u) => text(u.uri, 2000))
          .filter(Boolean)
          .slice(0, 50),
      };
      break;
    }
    case 2:
      input = { ...base, type: 'note' };
      break;
    case 3:
      input = {
        ...base,
        type: 'card',
        cardholder: text(raw.card?.cardholderName, 200),
        brand: text(raw.card?.brand, 50),
        number: text(raw.card?.number, 40),
        expMonth: month(raw.card?.expMonth, warnings),
        expYear: year(raw.card?.expYear, warnings),
        code: text(raw.card?.code, 10),
      };
      break;
    case 4: {
      const id = raw.identity ?? {};
      input = {
        ...base,
        type: 'identity',
        title: text(id.title, 50),
        firstName: text(id.firstName, 200),
        middleName: text(id.middleName, 200),
        lastName: text(id.lastName, 200),
        username: text(id.username, 200),
        company: text(id.company, 200),
        email: text(id.email, 320),
        phone: text(id.phone, 50),
        nationalId: text(id.ssn, 50),
        passport: text(id.passportNumber, 50),
        license: text(id.licenseNumber, 50),
        address1: text(id.address1, 500),
        address2: text(id.address2, 500),
        address3: text(id.address3, 500),
        city: text(id.city, 200),
        state: text(id.state, 200),
        postalCode: text(id.postalCode, 20),
        country: text(id.country, 100),
      };
      break;
    }
    case 5:
      input = {
        ...base,
        type: 'ssh_key',
        privateKey: text(raw.sshKey?.privateKey, 20_000),
        publicKey: text(raw.sshKey?.publicKey),
        fingerprint: text(raw.sshKey?.keyFingerprint, 200),
      };
      break;
    default:
      return null;
  }
  const parsed = ItemPayload.safeParse(input);
  if (!parsed.success) return null;
  return {
    payload: parsed.data,
    warnings: [...warnings],
    apiKeyLike: parsed.data.type === 'note' && API_KEY_NAME.test(parsed.data.name),
  };
}

/**
 * Turns a note that holds a token into an api_key item (design 8.13 option). A single-line
 * note body becomes the key; anything longer stays in the notes.
 */
export function noteToApiKey(note: ItemPayload): ItemPayload {
  if (note.type !== 'note') return note;
  const body = note.notes.trim();
  const singleLine = body.length > 0 && !/\s/.test(body);
  return {
    ...emptyItem('api_key', note.name),
    ...note,
    type: 'api_key',
    key: singleLine ? body : '',
    notes: singleLine ? '' : note.notes,
  } as ItemPayload;
}

function buildResult(
  format: ParsedImport['format'],
  rawItems: unknown[],
  folders: Map<string, string>,
  collections: Map<string, string>,
): ParsedImport {
  const items: ImportCandidate[] = [];
  const groups = new Map<string, ImportGroup>();
  let skippedDeleted = 0;
  let failed = 0;
  for (const value of rawItems) {
    const parsed = BwItem.safeParse(value);
    if (!parsed.success) {
      failed++;
      continue;
    }
    const raw = parsed.data;
    if (raw.deletedDate) {
      skippedDeleted++;
      continue;
    }
    const mapped = mapItem(raw);
    if (!mapped) {
      failed++;
      continue;
    }
    const collectionIds = raw.collectionIds ?? [];
    let group: ImportGroup;
    if (collectionIds.length && collections.has(collectionIds[0] as string)) {
      const id = collectionIds[0] as string;
      if (collectionIds.length > 1) mapped.warnings.push('multiple_collections');
      group = groups.get(`collection:${id}`) ?? {
        key: `collection:${id}`,
        kind: 'collection',
        name: collections.get(id) as string,
        count: 0,
      };
    } else if (raw.folderId && folders.has(raw.folderId)) {
      group = groups.get(`folder:${raw.folderId}`) ?? {
        key: `folder:${raw.folderId}`,
        kind: 'folder',
        name: folders.get(raw.folderId) as string,
        count: 0,
      };
    } else {
      group = groups.get('none') ?? { key: 'none', kind: 'none', name: '', count: 0 };
    }
    group.count++;
    groups.set(group.key, group);
    items.push({
      sourceId: raw.id ?? newId(),
      group: group.key,
      payload: mapped.payload,
      createdAt: validDate(raw.creationDate),
      updatedAt: validDate(raw.revisionDate),
      warnings: mapped.warnings,
      apiKeyLike: mapped.apiKeyLike,
    });
  }
  const byType: Record<string, number> = {};
  for (const i of items) byType[i.payload.type] = (byType[i.payload.type] ?? 0) + 1;
  return {
    format,
    items,
    groups: [...groups.values()].sort((a, b) =>
      a.kind === 'none' ? -1 : b.kind === 'none' ? 1 : 0,
    ),
    stats: {
      total: items.length,
      byType,
      folders: folders.size,
      collections: collections.size,
      withTotp: items.filter((i) => i.payload.type === 'login' && i.payload.totp).length,
      withFields: items.filter((i) => i.payload.fields.length > 0).length,
      skippedDeleted,
      failed,
    },
  };
}

function validDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function parseBitwardenJson(
  textIn: string,
  options: ImportOptions = {},
): Promise<ParsedImport> {
  let json: unknown;
  try {
    json = JSON.parse(textIn.replace(BOM, ''));
  } catch {
    throw new ImportError('invalid_file');
  }
  const head = BwExport.safeParse(json);
  if (!head.success) throw new ImportError('invalid_file');
  let doc = head.data;
  let format: ParsedImport['format'] = 'json';
  if (doc.encrypted) {
    if (!doc.passwordProtected) throw new ImportError('account_encrypted');
    const prot = BwProtected.safeParse(json);
    if (!prot.success) throw new ImportError('invalid_file');
    if (!options.password) throw new ImportError('password_required');
    const keys = await bitwardenKey(options.password, prot.data.salt, {
      type: prot.data.kdfType,
      iterations: prot.data.kdfIterations,
      memory: prot.data.kdfMemory,
      parallelism: prot.data.kdfParallelism,
    });
    decryptEncString(keys, prot.data.encKeyValidation_DO_NOT_EDIT);
    const inner = BwExport.safeParse(JSON.parse(decryptEncString(keys, prot.data.data)));
    if (!inner.success || inner.data.encrypted) throw new ImportError('invalid_file');
    doc = inner.data;
    format = 'encrypted_json';
  }
  return buildResult(
    format,
    doc.items ?? [],
    new Map((doc.folders ?? []).map((f) => [f.id, f.name])),
    new Map((doc.collections ?? []).map((c) => [c.id, c.name])),
  );
}

/* ------------------------------ CSV ------------------------------ */


/** RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = input.replace(BOM, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ''));
}

/** Chrome's "export passwords" file: name,url,username,password and, in newer versions, note. */
function parseChromeCsv(rows: string[][], header: string[]): ParsedImport {
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? '' : (r[i] ?? '');
  };
  const items = rows
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => {
      const url = col(r, 'url').trim();
      return {
        type: 1,
        name: col(r, 'name').trim() || (url ? hostOf(url) : ''),
        notes: col(r, 'note'),
        favorite: false,
        fields: [],
        folderId: null,
        collectionIds: null,
        login: {
          uris: url ? [{ uri: url }] : [],
          username: col(r, 'username'),
          password: col(r, 'password'),
          totp: '',
        },
      };
    });
  return buildResult('csv', items, new Map(), new Map());
}

/** Bitwarden CSV: logins and notes only (design 8.12). */
export function parseBitwardenCsv(textIn: string): ParsedImport {
  const rows = parseCsv(textIn);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase());
  if (header && CHROME_CSV_HEADER.test(header.join(','))) return parseChromeCsv(rows, header);
  if (!header || !header.includes('name') || !header.includes('type'))
    throw new ImportError('invalid_file');
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? '' : (r[i] ?? '');
  };
  const folders = new Map<string, string>();
  const collections = new Map<string, string>();
  const items = rows.map((r) => {
    const folder = col(r, 'folder') || col(r, 'collections').split(',')[0] || '';
    const isCollection = !col(r, 'folder') && !!col(r, 'collections');
    if (folder) (isCollection ? collections : folders).set(folder, folder);
    const fields = col(r, 'fields')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(': ');
        return at < 0
          ? { name: line, value: '', type: 0 }
          : { name: line.slice(0, at), value: line.slice(at + 2), type: 0 };
      });
    const type = col(r, 'type').toLowerCase() === 'note' ? 2 : 1;
    return {
      type,
      name: col(r, 'name'),
      notes: col(r, 'notes'),
      favorite: col(r, 'favorite') === '1',
      fields,
      folderId: !isCollection && folder ? folder : null,
      collectionIds: isCollection && folder ? [folder] : null,
      login:
        type === 1
          ? {
              uris: col(r, 'login_uri')
                .split(/[,\n]/)
                .map((u) => ({ uri: u.trim() }))
                .filter((u) => u.uri),
              username: col(r, 'login_username'),
              password: col(r, 'login_password'),
              totp: col(r, 'login_totp'),
            }
          : null,
    };
  });
  return buildResult('csv', items, folders, collections);
}

/** Entry point for the import wizard: JSON (plain or protected) or CSV. */
export async function parseBitwardenExport(
  textIn: string,
  options: ImportOptions = {},
): Promise<ParsedImport> {
  const kind = sniffBitwardenFile(textIn);
  if (kind === 'csv') return parseBitwardenCsv(textIn);
  if (kind === 'unknown') throw new ImportError('invalid_file');
  return parseBitwardenJson(textIn, options);
}

/* ------------------------------ export ------------------------------ */

function toBwItem(p: ItemPayload, folderId: string | null) {
  const fields = p.fields.map((f) => ({
    name: f.label,
    value: f.value,
    type: f.type === 'hidden' ? 1 : f.type === 'boolean' ? 2 : 0,
    linkedId: null,
  }));
  const base = {
    id: newId(),
    organizationId: null,
    folderId,
    reprompt: 0,
    name: p.name,
    notes: p.notes || null,
    favorite: p.favorite,
    fields,
    collectionIds: null,
    passwordHistory: p.passwordHistory.length
      ? p.passwordHistory.map((h) => ({ lastUsedDate: h.changedAt, password: h.password }))
      : null,
  };
  switch (p.type) {
    case 'login':
      return {
        ...base,
        type: 1,
        login: {
          uris: p.uris.map((uri) => ({ match: null, uri })),
          username: p.username || null,
          password: p.password || null,
          totp: p.totp || null,
          fido2Credentials: [],
        },
      };
    case 'api_key':
      // Bitwarden has no API key type: a login keeps the secret in a copyable field.
      return {
        ...base,
        type: 1,
        fields: [
          ...fields,
          ...(p.scope ? [{ name: 'scope', value: p.scope, type: 0, linkedId: null }] : []),
          ...(p.expiresAt
            ? [{ name: 'expiresAt', value: p.expiresAt, type: 0, linkedId: null }]
            : []),
        ],
        login: {
          uris: p.url ? [{ match: null, uri: p.url }] : [],
          username: p.username || null,
          password: p.key || null,
          totp: null,
          fido2Credentials: [],
        },
      };
    case 'note':
      return { ...base, type: 2, secureNote: { type: 0 } };
    case 'card':
      return {
        ...base,
        type: 3,
        card: {
          cardholderName: p.cardholder || null,
          brand: p.brand || null,
          number: p.number || null,
          expMonth: p.expMonth ? String(Number(p.expMonth)) : null,
          expYear: p.expYear || null,
          code: p.code || null,
        },
      };
    case 'identity':
      return {
        ...base,
        type: 4,
        identity: {
          title: p.title || null,
          firstName: p.firstName || null,
          middleName: p.middleName || null,
          lastName: p.lastName || null,
          address1: p.address1 || null,
          address2: p.address2 || null,
          address3: p.address3 || null,
          city: p.city || null,
          state: p.state || null,
          postalCode: p.postalCode || null,
          country: p.country || null,
          company: p.company || null,
          email: p.email || null,
          phone: p.phone || null,
          ssn: p.nationalId || null,
          username: p.username || null,
          passportNumber: p.passport || null,
          licenseNumber: p.license || null,
        },
      };
    case 'ssh_key':
      return {
        ...base,
        type: 5,
        sshKey: { privateKey: p.privateKey, publicKey: p.publicKey, keyFingerprint: p.fingerprint },
      };
  }
}

/** Bitwarden-compatible unencrypted JSON; each group becomes a folder. */
export function toBitwardenJson(
  entries: { payload: ItemPayload; folder: string | null }[],
): string {
  const folderIds = new Map<string, string>();
  for (const e of entries)
    if (e.folder && !folderIds.has(e.folder)) folderIds.set(e.folder, newId());
  return JSON.stringify(
    {
      encrypted: false,
      folders: [...folderIds].map(([name, id]) => ({ id, name })),
      items: entries.map((e) =>
        toBwItem(e.payload, e.folder ? (folderIds.get(e.folder) ?? null) : null),
      ),
    },
    null,
    2,
  );
}

export const BITWARDEN_EXPORT_ITERATIONS = 600_000;

/**
 * Password-protected export (design 8.16 "Dışa aktar"), readable by Bitwarden: PBKDF2-SHA256
 * with 600 000 iterations, the same format the importer above reads.
 */
export async function encryptBitwardenExport(
  plainJson: string,
  password: string,
  fixed?: {
    salt?: string;
    iterations?: number;
    ivs?: [Uint8Array, Uint8Array];
    /** Argon2id-protected file (Bitwarden kdfType 1), memory in MiB. */
    argon2?: { iterations: number; memory: number; parallelism: number };
  },
): Promise<string> {
  if (!password) throw new CryptoError('invalid_input', 'export password required');
  const salt = fixed?.salt ?? toB64(randomBytes(16));
  const iterations = fixed?.iterations ?? BITWARDEN_EXPORT_ITERATIONS;
  const a = fixed?.argon2;
  const keys = await bitwardenKey(
    password,
    salt,
    a
      ? { type: 1, iterations: a.iterations, memory: a.memory, parallelism: a.parallelism }
      : { type: 0, iterations },
  );
  return JSON.stringify(
    {
      encrypted: true,
      passwordProtected: true,
      salt,
      kdfType: a ? 1 : 0,
      kdfIterations: a ? a.iterations : iterations,
      kdfMemory: a ? a.memory : null,
      kdfParallelism: a ? a.parallelism : null,
      encKeyValidation_DO_NOT_EDIT: encryptEncString(keys, newId(), fixed?.ivs?.[0]),
      data: encryptEncString(keys, plainJson, fixed?.ivs?.[1]),
    },
    null,
    2,
  );
}
