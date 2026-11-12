/**
 * Ops CLI inside the backend image: `node dist/crewhall.js <command>`. Operators use the
 * host script tools/crewhall/crewhall, which runs this in a one-off backend container.
 *
 *   backup [--trigger manual|nightly|update] [--note text] [--config file] [--print-id]
 *   list [--json]
 *   restore <id> --yes [--force]
 *   config <id>               decrypted .env of the snapshot to stdout
 *   export <id>               tar of the snapshot and its objects to stdout
 *   import                    tar from stdin
 *   prune --keep <n> [--all]
 *   voip-test --email <e-mail> | --token <hex> [--end <callId>]
 *                             test call to iPhones through APNs (VoIP, CallKit)
 *
 * Logs go to stderr, so stdout carries only the data asked for.
 */
import {
  createBackup,
  exportSnapshot,
  importArchive,
  readConfig,
  restoreBackup,
} from '../ops/backup';
import { opsDepsFromEnv } from '../ops/deps';
import { BackupTrigger } from '../ops/repo';
import { createDb } from '@crewhall/db';
import { loadEnv } from '../env';
import { sendTestVoip } from '../services/notifications/voip-test';

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const next = argv[i + 1];
    if (
      next !== undefined &&
      !next.startsWith('--') &&
      !['--yes', '--force', '--all', '--json', '--print-id'].includes(a)
    ) {
      flags.set(a, next);
      i++;
    } else flags.set(a, true);
  }
  const str = (name: string) => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  return { positional, has: (name: string) => flags.has(name), str };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const args = parse(rest);
  if (command === 'voip-test') return voipTest(args);
  const deps = opsDepsFromEnv();
  const passphrase = process.env.CREWHALL_BACKUP_PASSPHRASE ?? null;
  switch (command) {
    case 'backup': {
      const m = await createBackup(deps, {
        trigger: BackupTrigger.parse(args.str('--trigger') ?? 'manual'),
        note: args.str('--note') ?? null,
        configFile: args.str('--config') ?? null,
        passphrase,
      });
      if (args.has('--print-id')) process.stdout.write(`${m.id}\n`);
      return;
    }
    case 'list': {
      const list = await deps.repo.list();
      if (args.has('--json')) {
        process.stdout.write(
          `${JSON.stringify(list.map(({ objects, ...m }) => ({ ...m, objects: { count: objects.count, bytes: objects.bytes } })))}\n`,
        );
        return;
      }
      for (const m of list) {
        process.stdout.write(
          `${m.id}  ${m.trigger.padEnd(7)}  ${m.version.padEnd(10)}  db ${mb(m.database.bytes)}  ${m.objects.count} dosya ${mb(m.objects.bytes)}${m.config ? '  +config' : ''}${m.note ? `  ${m.note}` : ''}\n`,
        );
      }
      if (!list.length) process.stderr.write('crewhall: henüz yedek yok\n');
      return;
    }
    case 'restore': {
      const id = args.positional[0];
      if (!id) throw new Error('restore <id>');
      if (!args.has('--yes'))
        throw new Error('restore replaces the database and files: pass --yes');
      await restoreBackup(deps, id, { force: args.has('--force') });
      return;
    }
    case 'config': {
      const id = args.positional[0];
      if (!id) throw new Error('config <id>');
      if (!passphrase) throw new Error('set CREWHALL_BACKUP_PASSPHRASE');
      process.stdout.write(await readConfig(deps.repo, id, passphrase));
      return;
    }
    case 'export': {
      const id = args.positional[0];
      if (!id) throw new Error('export <id>');
      await exportSnapshot(deps.repo, id, process.stdout);
      return;
    }
    case 'import': {
      const added = await importArchive(deps.repo, process.stdin);
      for (const m of added) process.stderr.write(`crewhall: alındı ${m.id}\n`);
      return;
    }
    case 'prune': {
      const keep = Number(args.str('--keep'));
      if (!Number.isInteger(keep) || keep < 1) throw new Error('prune --keep <n> (n >= 1)');
      const r = await deps.repo.prune(
        keep,
        args.has('--all') ? ['manual', 'nightly', 'update'] : undefined,
      );
      process.stderr.write(`crewhall: ${r.snapshots.length} yedek, ${r.objects} dosya silindi\n`);
      return;
    }
    default:
      throw new Error('commands: backup, list, restore, config, export, import, prune, voip-test');
  }
}

async function voipTest(args: ReturnType<typeof parse>) {
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const r = await sendTestVoip(env, db, {
      email: args.str('--email'),
      token: args.str('--token'),
      end: args.str('--end'),
    });
    for (const x of r.results)
      process.stderr.write(`crewhall: ${x.token} ${x.result}
`);
    // The call id ends a test call still showing: voip-test ... --end <id>.
    process.stdout.write(`${r.callId}
`);
  } finally {
    await close();
  }
}

if (process.argv[1]?.replaceAll('\\', '/').match(/(scripts\/crewhall\.ts|dist\/crewhall\.js)$/)) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (e: unknown) => {
      process.stderr.write(`crewhall: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
