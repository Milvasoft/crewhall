import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Where the plugin keeps its state: one table of JSON documents, `kind` + `id`, listed by
 * `scope`. The engine reads whole lists per sync and they stay small (a board's links), so
 * nothing needs its own columns. Tests use the same interface over a Map.
 */
export type Kind = 'installation' | 'connection' | 'sync' | 'link' | 'log' | 'oauth';

export interface Store {
  get<T>(kind: Kind, id: string): Promise<T | null>;
  put<T>(kind: Kind, id: string, scope: string, value: T): Promise<void>;
  del(kind: Kind, id: string): Promise<void>;
  list<T>(kind: Kind, scope: string): Promise<T[]>;
  all<T>(kind: Kind): Promise<T[]>;
  delScope(kind: Kind, scope: string): Promise<void>;
}

export function memoryStore(): Store {
  const rows = new Map<string, { kind: Kind; id: string; scope: string; value: string }>();
  const at = (kind: Kind, id: string) => `${kind}\0${id}`;
  const of = <T>(raw: string) => JSON.parse(raw) as T;
  return {
    async get<T>(kind: Kind, id: string) {
      const r = rows.get(at(kind, id));
      return r ? of<T>(r.value) : null;
    },
    async put<T>(kind: Kind, id: string, scope: string, value: T) {
      rows.set(at(kind, id), { kind, id, scope, value: JSON.stringify(value) });
    },
    async del(kind, id) {
      rows.delete(at(kind, id));
    },
    async list<T>(kind: Kind, scope: string) {
      return [...rows.values()]
        .filter((r) => r.kind === kind && r.scope === scope)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((r) => of<T>(r.value));
    },
    async all<T>(kind: Kind) {
      return [...rows.values()].filter((r) => r.kind === kind).map((r) => of<T>(r.value));
    },
    async delScope(kind, scope) {
      for (const [k, r] of rows) if (r.kind === kind && r.scope === scope) rows.delete(k);
    },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workitems_docs (
  kind text NOT NULL,
  id text NOT NULL,
  scope text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS workitems_docs_scope ON workitems_docs (kind, scope, id);
`;

export async function postgresStore(url: string): Promise<Store & { close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query(SCHEMA);
  return {
    async get<T>(kind: Kind, id: string) {
      const r = await pool.query('SELECT value FROM workitems_docs WHERE kind=$1 AND id=$2', [
        kind,
        id,
      ]);
      return (r.rows[0]?.value as T | undefined) ?? null;
    },
    async put<T>(kind: Kind, id: string, scope: string, value: T) {
      await pool.query(
        `INSERT INTO workitems_docs (kind, id, scope, value) VALUES ($1,$2,$3,$4)
         ON CONFLICT (kind, id) DO UPDATE SET scope=$3, value=$4, updated_at=now()`,
        [kind, id, scope, JSON.stringify(value)],
      );
    },
    async del(kind, id) {
      await pool.query('DELETE FROM workitems_docs WHERE kind=$1 AND id=$2', [kind, id]);
    },
    async list<T>(kind: Kind, scope: string) {
      const r = await pool.query(
        'SELECT value FROM workitems_docs WHERE kind=$1 AND scope=$2 ORDER BY id',
        [kind, scope],
      );
      return r.rows.map((x) => x.value as T);
    },
    async all<T>(kind: Kind) {
      const r = await pool.query('SELECT value FROM workitems_docs WHERE kind=$1', [kind]);
      return r.rows.map((x) => x.value as T);
    },
    async delScope(kind, scope) {
      await pool.query('DELETE FROM workitems_docs WHERE kind=$1 AND scope=$2', [kind, scope]);
    },
    close: () => pool.end(),
  };
}

/** AES-256-GCM for tokens and the installation secret, keyed from PLUGIN_SECRET. */
export interface Sealer {
  seal(plain: string): string;
  open(stored: string): string;
}

export function sealer(secret: string): Sealer {
  if (secret.length < 32) throw new Error('PLUGIN_SECRET must be at least 32 characters');
  const key = createHash('sha256').update(`crewhall-workitems\0${secret}`).digest();
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
    },
    open(stored) {
      const raw = Buffer.from(stored, 'base64url');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
