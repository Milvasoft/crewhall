import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import pg from 'pg';

/**
 * pg_dump / pg_restore, from the image (local) or from a postgres image through Docker.
 * pg_dump refuses a server newer than itself, so the tools must be at least the server's major
 * version: the image ships PostgreSQL 18 (dumps 18 and every older server down to 9.2).
 */
export interface PgTools {
  dump(databaseUrl: string, file: string): Promise<void>;
  restore(databaseUrl: string, file: string): Promise<void>;
  /** Major version of pg_dump (18), or null when it cannot be run. */
  version(): Promise<number | null>;
}

/** The postgres image the docker tools run; its major version is what they support. */
export const PG_TOOLS_IMAGE = 'postgres:18';

/** pg_dump is older than the server: every dump would fail, so a backup does not start. */
export class PgVersionMismatchError extends Error {
  override name = 'PgVersionMismatchError';
  constructor(
    readonly client: number | null,
    readonly server: number,
  ) {
    super(
      client === null
        ? `pg_dump cannot be run; the PostgreSQL server is ${server}`
        : `pg_dump ${client} is older than the PostgreSQL ${server} server: install the ${server} client tools`,
    );
  }
}

const DUMP_ARGS = ['--format=custom', '--no-owner', '--no-privileges'];
const RESTORE_ARGS = ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction'];

/** Runs a command; stdin/stdout can be files. Rejects with the end of stderr. */
export function run(
  cmd: string,
  args: string[],
  io: { stdinFile?: string; stdoutFile?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [io.stdinFile ? 'pipe' : 'ignore', io.stdoutFile ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let out: Promise<void> = Promise.resolve();
    if (io.stdoutFile && child.stdout) {
      const sink = createWriteStream(io.stdoutFile);
      child.stdout.pipe(sink);
      out = new Promise((res, rej) => {
        sink.on('finish', res);
        sink.on('error', rej);
      });
    }
    if (io.stdinFile && child.stdin) createReadStream(io.stdinFile).pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => {
      void out.then(() =>
        code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`)),
      );
    });
  });
}

/** stdout of a command, or null when it fails or cannot start. */
function output(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/** "pg_dump (PostgreSQL) 18.6" → 18. */
export function majorOf(versionLine: string | null): number | null {
  const m = versionLine && /\(PostgreSQL\)\s+(\d+)/.exec(versionLine);
  return m ? Number(m[1]) : null;
}

/** The binaries in the backend image (postgresql18-client). */
export function localPgTools(): PgTools {
  return {
    version: async () => majorOf(await output('pg_dump', ['--version'])),
    dump: (url, file) => run('pg_dump', [...DUMP_ARGS, `--file=${file}`, url]),
    async restore(url, file) {
      await resetDatabase(url);
      await run('pg_restore', [...RESTORE_ARGS, `--dbname=${url}`, file]);
    },
  };
}

/**
 * The same tools from a postgres image (development, tests, hosts without the client).
 * `localhost` in the URL becomes the Docker host. Any other address is one the Docker host
 * itself reaches (a CI agent in a container sees Testcontainers on its network gateway), so
 * the tool container then uses the host's network: on the default bridge it has no route there.
 */
export function dockerPgTools(image = PG_TOOLS_IMAGE): PgTools {
  const isLocal = (url: string) =>
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  const target = (url: string) => {
    if (!isLocal(url)) return url;
    const u = new URL(url);
    u.hostname = 'host.docker.internal';
    return u.toString();
  };
  const docker = (url: string) => [
    'run',
    '--rm',
    '-i',
    ...(isLocal(url) ? ['--add-host', 'host.docker.internal:host-gateway'] : ['--network', 'host']),
    image,
  ];
  return {
    version: async () =>
      majorOf(await output('docker', ['run', '--rm', image, 'pg_dump', '--version'])),
    dump: (url, file) =>
      run('docker', [...docker(url), 'pg_dump', ...DUMP_ARGS, target(url)], { stdoutFile: file }),
    async restore(url, file) {
      await resetDatabase(url);
      await run(
        'docker',
        [...docker(url), 'pg_restore', ...RESTORE_ARGS, `--dbname=${target(url)}`],
        { stdinFile: file },
      );
    },
  };
}

/**
 * Empties the database before a restore: every schema the dump may recreate goes, so a
 * table added by a newer version (failed update) cannot survive the rollback.
 */
export async function resetDatabase(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string }>(
      `select nspname as name from pg_namespace
       where nspname not like 'pg\\_%' and nspname <> 'information_schema'`,
    );
    await client.query('begin');
    for (const r of rows) await client.query(`drop schema ${pg.escapeIdentifier(r.name)} cascade`);
    await client.query('create schema public');
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

/** Major version of the PostgreSQL server (server_version_num 180006 → 18). */
export async function serverMajor(url: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ v: string }>(
      `select current_setting('server_version_num') as v`,
    );
    return Math.floor(Number(rows[0]!.v) / 10_000);
  } finally {
    await client.end();
  }
}

export interface PgToolsCheck {
  client: number | null;
  server: number;
  compatible: boolean;
}

/** Whether these tools can dump this server (pg_dump at least the server's major version). */
export async function checkPgTools(tools: PgTools, url: string): Promise<PgToolsCheck> {
  const [client, server] = await Promise.all([tools.version(), serverMajor(url)]);
  return { client, server, compatible: client !== null && client >= server };
}

/** Applied migrations in the database (drizzle's journal table). */
export async function schemaLevel(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string; last: string | null }>(
      `select count(*) as n, max(created_at)::text as last from drizzle.__drizzle_migrations`,
    );
    return {
      migrations: Number(rows[0]?.n ?? 0),
      lastWhen: rows[0]?.last ? Number(rows[0].last) : null,
    };
  } catch {
    return { migrations: 0, lastWhen: null };
  } finally {
    await client.end();
  }
}
