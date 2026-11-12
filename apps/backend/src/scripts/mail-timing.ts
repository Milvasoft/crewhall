/**
 * Mail timings on a running server (the test server too): opens the folder list, INBOX, a
 * second folder, the newest messages and a search several times as a signed-in person and
 * prints the median of each step with the server's own breakdown (Server-Timing: connect,
 * imap, db, body, sanitize).
 *
 *   pnpm --filter @crewhall/backend mail:timing -- --url https://hub.example.com --token <t>
 *
 * `--token` is a session token (the mobile app's bearer token, or the value of the
 * `better-auth.session_token` cookie of a browser session). Nothing is changed on the server;
 * `markSeen=false` keeps opened messages unread.
 */
import { parseArgs } from 'node:util';

interface Sample {
  ms: number;
  phases: Record<string, number>;
}

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    runs: { type: 'string', default: '5' },
    folder: { type: 'string' },
    q: { type: 'string', default: 'a' },
  },
});
if (!values.url || !values.token) {
  console.error('usage: mail:timing --url <hub url> --token <session token> [--runs 5]');
  process.exit(2);
}
const base = values.url.replace(/\/$/, '');
const runs = Math.max(1, Number(values.runs));
const headers = {
  Authorization: `Bearer ${values.token}`,
  Cookie: `better-auth.session_token=${values.token}`,
};

function phasesOf(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().split(';');
    const dur = params.find((p) => p.trim().startsWith('dur='));
    if (name && dur) out[name] = Number(dur.trim().slice(4));
  }
  return out;
}

async function call(path: string): Promise<{ sample: Sample; body: unknown }> {
  const t0 = performance.now();
  const res = await fetch(`${base}${path}`, { headers });
  const body: unknown = await res.json();
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return { sample: { ms, phases: phasesOf(res.headers.get('server-timing')) }, body };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function step(label: string, path: string) {
  const samples: Sample[] = [];
  let body: unknown;
  for (let i = 0; i < runs; i++) {
    const r = await call(path);
    samples.push(r.sample);
    body = r.body;
  }
  const names = [...new Set(samples.flatMap((s) => Object.keys(s.phases)))];
  const server = names
    .map((n) => `${n} ${median(samples.map((s) => s.phases[n] ?? 0)).toFixed(0)}`)
    .join(', ');
  console.log(
    `| ${label} | ${median(samples.map((s) => s.ms)).toFixed(0)} ms | ${server || '-'} |`,
  );
  return body;
}

interface Folders {
  items: { path: string; specialUse: string | null }[];
}
interface Page {
  items: { uid: number }[];
}

console.log(`${base}, ${runs} runs each (median)`);
console.log('| step | total (client) | server phases (ms) |');
console.log('|---|---|---|');
const folders = (await step('folders', '/api/v1/mail/folders')) as Folders;
const page = (await step('INBOX, page 1', '/api/v1/mail/messages?folder=INBOX&limit=50')) as Page;
const other =
  values.folder ?? folders.items.find((f) => f.path !== 'INBOX' && f.specialUse !== 'trash')?.path;
if (other) {
  await step(
    `switch folder (${other})`,
    `/api/v1/mail/messages?folder=${encodeURIComponent(other)}&limit=50`,
  );
}
for (const [i, m] of page.items.slice(0, 3).entries()) {
  await step(
    `open message ${i + 1}`,
    `/api/v1/mail/thread?folder=INBOX&uid=${m.uid}&markSeen=false`,
  );
}
const q = encodeURIComponent(values.q);
await step('search, headers', `/api/v1/mail/messages?folder=INBOX&q=${q}&scope=headers`);
await step('search, full text', `/api/v1/mail/messages?folder=INBOX&q=${q}`);
