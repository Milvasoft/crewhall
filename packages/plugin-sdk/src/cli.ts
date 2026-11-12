import { readFile } from 'node:fs/promises';
import { PluginManifest } from './manifest';
import { generateSigningKey, manifestDigest } from './package';

/**
 * crewhall-plugin (docs/contracts/eklentiler.md › Geliştirici akışı):
 *   validate <manifest.json>
 *   publish <manifest.json> --market <url> --token <developer token>
 *   keygen                                   (marketplace operators: an Ed25519 key pair)
 */

interface Io {
  out(line: string): void;
  err(line: string): void;
  fetch: typeof fetch;
}

const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readManifest(path: string, io: Io) {
  const parsed = PluginManifest.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      io.err(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return null;
  }
  return parsed.data;
}

export async function runCli(argv: string[], io: Io): Promise<number> {
  const [command, file, ...rest] = argv;
  if (command === 'keygen') {
    const key = await generateSigningKey();
    io.out(`MARKETPLACE_SIGNING_KEY=${key.privateKey}`);
    io.out(`public key (MARKETPLACE_PUBLIC_KEYS): ${key.publicKey}`);
    return 0;
  }
  if ((command === 'validate' || command === 'publish') && file) {
    const manifest = await readManifest(file, io);
    if (!manifest) return 1;
    io.out(`${manifest.id}@${manifest.version} ok (sha256 ${await manifestDigest(manifest)})`);
    if (command === 'validate') return 0;
    const market = flag(rest, 'market');
    const token = flag(rest, 'token');
    if (!market || !token) {
      io.err('publish needs --market <url> and --token <developer token>');
      return 2;
    }
    const res = await io.fetch(new URL(`/v1/plugins/${manifest.id}/versions`, market), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ manifest }),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; code?: string };
    if (!res.ok) {
      io.err(`marketplace answered ${res.status}: ${body.code ?? 'error'}`);
      return 1;
    }
    io.out(`uploaded, review status: ${body.status ?? 'pending'}`);
    return 0;
  }
  io.err(
    'usage: crewhall-plugin validate <manifest.json> | publish <manifest.json> --market <url> --token <t> | keygen',
  );
  return 2;
}

// Run as a script (`pnpm plugin …`), not when imported by tests.
if (process.argv[1]?.split('\\').join('/').endsWith('/src/cli.ts')) {
  void runCli(process.argv.slice(2), {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    fetch,
  }).then((code) => process.exit(code));
}
