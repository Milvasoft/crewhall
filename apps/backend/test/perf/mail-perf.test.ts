import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearBodies } from '../../src/services/mail/body';
import { closeAllMailConnections } from '../../src/services/mail/imap';
import { settleLive } from '../../src/services/mail/live';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from '../helpers';
import { MAILBOXES, startGreenMail, withMailbox, type GreenMail } from '../mail-containers';

/**
 * Mail performance benchmark (not part of the normal run): `MAIL_PERF=1 pnpm vitest run
 * test/perf/mail-perf.test.ts`. 8 000 messages in INBOX (1 in 50 with a 300 KB attachment,
 * conversations of 4), 1 000 in another folder, behind a TCP proxy that adds RTT_MS each way so
 * round trips cost what they cost on a real server. Writes a table to MAIL_PERF_OUT.
 */

const RUN = process.env.MAIL_PERF === '1';
const RTT_MS = Number(process.env.MAIL_PERF_RTT ?? 25);
const INBOX_COUNT = Number(process.env.MAIL_PERF_COUNT ?? 8000);
const EXTRA_FOLDERS = Array.from({ length: 12 }, (_, i) => `Proje ${i + 1}`);

/** Delays every chunk by `delay` ms in both directions (half a round trip each way). */
function latencyProxy(port: number, host: string, delay: number) {
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    const pipe = (from: net.Socket, to: net.Socket) =>
      from.on('data', (chunk) => setTimeout(() => to.write(chunk), delay));
    pipe(client, upstream);
    pipe(upstream, client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
  });
  return new Promise<{ port: number; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () => server.close(),
      }),
    ),
  );
}

/** Counts IMAP commands (round trips) the app sends while `fn` runs. */
let commands = 0;
const proto = ImapFlow.prototype as unknown as { exec: (...args: unknown[]) => unknown };
const realExec = proto.exec;
let trace: string[] | null = null;
proto.exec = function (this: unknown, ...args: unknown[]) {
  commands += 1;
  const t0 = performance.now();
  const result = realExec.apply(this, args) as Promise<unknown>;
  if (trace) {
    const log = trace;
    void Promise.resolve(result).finally(() =>
      log.push(`${String(args[0])} ${(performance.now() - t0).toFixed(0)} ms`),
    );
  }
  return result;
};

async function seed(gm: GreenMail) {
  const pdf = Buffer.alloc(300 * 1024, 7);
  await withMailbox(gm, MAILBOXES.elif, async (c) => {
    await c.mailboxCreate('Arsiv').catch(() => undefined);
    // A realistic folder tree: servers without LIST-STATUS answer each folder's counters apart.
    for (const name of EXTRA_FOLDERS) await c.mailboxCreate(name).catch(() => undefined);
    const append = async (folder: string, i: number) => {
      const root = `<thread-${Math.floor(i / 4)}@perf.example>`;
      const own = `<m-${folder}-${i}@perf.example>`;
      const raw = await new MailComposer({
        from: `Gönderen ${i % 37} <sender${i % 37}@perf.example>`,
        to: MAILBOXES.elif.address,
        subject: `${i % 4 ? 'Re: ' : ''}Konu ${Math.floor(i / 4)} rapor ${i}`,
        messageId: own,
        ...(i % 4 ? { inReplyTo: root, references: root } : {}),
        date: new Date(Date.now() - (INBOX_COUNT - i) * 60_000),
        html: `<p>Merhaba,</p><p>İleti ${i}: ${'lorem ipsum dolor sit amet '.repeat(40)}</p><img src="https://tracker.example/${i}.gif">`,
        text: `İleti ${i}`,
        attachments: i % 50 === 0 ? [{ filename: `ek-${i}.pdf`, content: pdf }] : [],
      })
        .compile()
        .build();
      await c.append(folder, raw, i % 3 ? [] : ['\\Seen']);
    };
    for (let i = 0; i < INBOX_COUNT; i++) await append('INBOX', i);
    for (let i = 0; i < 1000; i++) await append('Arsiv', i);
  });
}

describe.skipIf(!RUN)('mail performance', () => {
  let gm: GreenMail;
  let app: TestApp;
  let elif: Client;
  let proxy: { port: number; close: () => void };
  const rows: string[] = [];

  beforeAll(async () => {
    [gm, app] = await Promise.all([startGreenMail(), createTestApp()]);
    proxy = await latencyProxy(gm.imapPort, gm.host, RTT_MS / 2);
    const { owner } = await setupWithOwner(app);
    ({ person: elif } = await join(app, owner, 'elif@milvasoft.com', 'member'));
    await owner.api.call('mailUpdateServerSettings', {
      body: {
        imapHost: '127.0.0.1',
        imapPort: proxy.port,
        imapSecurity: 'none',
        smtpHost: gm.host,
        smtpPort: gm.smtpPort,
        smtpSecurity: 'none',
        authMode: 'password',
      },
    });
    await elif.api.call('mailConnectAccount', {
      body: { email: MAILBOXES.elif.address, password: MAILBOXES.elif.password },
    });
    const started = Date.now();
    await seed(gm);
    rows.push(
      `seed: ${INBOX_COUNT + 1000} messages in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
  }, 900_000);

  afterAll(async () => {
    await closeAllMailConnections();
    proxy?.close();
    await app?.close();
    await gm?.container.stop();
    const out = process.env.MAIL_PERF_OUT;
    if (out) writeFileSync(out, `${rows.join('\n')}\n`);
    console.log(rows.join('\n'));
  });

  /**
   * Median of `runs` timings; `cold` closes the pooled connection before every run. Background
   * work (prefetch, flag refresh) finishes before each run: GreenMail runs one command per
   * mailbox at a time, so a prefetch still running would bill its time to the next request,
   * which a real server (and a person taking a second to click) does not.
   */
  async function measure(
    label: string,
    fn: () => Promise<unknown>,
    opts: { cold?: boolean; runs?: number; before?: () => void } = {},
  ) {
    const times: number[] = [];
    let cmds = 0;
    let bytes = 0;
    for (let i = 0; i < (opts.runs ?? 5); i++) {
      await settleLive();
      if (opts.cold) await closeAllMailConnections();
      opts.before?.();
      commands = 0;
      const t0 = performance.now();
      const result = await fn();
      times.push(performance.now() - t0);
      cmds = commands;
      bytes = JSON.stringify(result).length;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    rows.push(`| ${label} | ${median.toFixed(0)} ms | ${cmds} | ${(bytes / 1024).toFixed(0)} KB |`);
    return median;
  }

  it('measures the screens', async () => {
    rows.push(
      `RTT ${RTT_MS} ms`,
      '| step | median | IMAP commands | response |',
      '|---|---|---|---|',
    );
    // Without a cache yet (a fresh account): answered live while the background builds it.
    await measure(
      'open INBOX, page 1, no cache yet',
      () => elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 50 } }),
      { runs: 1 },
    );
    const t0 = performance.now();
    await settleLive();
    rows.push(
      `| background sync of INBOX (${INBOX_COUNT}) | ${(performance.now() - t0).toFixed(0)} ms | | |`,
    );
    await measure('folders (cold connection)', () => elif.api.call('mailFolders'), { cold: true });
    await measure('folders', () => elif.api.call('mailFolders'));
    const page1 = await elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 50 } });
    await measure('open INBOX, page 1', () =>
      elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 50 } }),
    );
    // After a break the pooled connection is gone (90 s idle): what a returning user waits for.
    await measure(
      'open INBOX, page 1 (cold connection)',
      () => elif.api.call('mailMessages', { query: { folder: 'INBOX', limit: 50 } }),
      { cold: true },
    );
    await measure('scroll, page 2', () =>
      elif.api.call('mailMessages', {
        query: { folder: 'INBOX', limit: 50, cursor: page1.nextCursor! },
      }),
    );
    await measure('switch folder (Arsiv)', () =>
      elif.api.call('mailMessages', { query: { folder: 'Arsiv', limit: 50 } }),
    );
    const plain = page1.items.find((m) => !m.hasAttachments)!;
    const withFile = page1.items.find((m) => m.hasAttachments)!;
    if (process.env.MAIL_PERF_TRACE) {
      trace = [];
      clearBodies();
      await elif.api.call('mailThread', {
        query: { folder: 'INBOX', uid: plain.uid, markSeen: 'false' },
      });
      rows.push(`trace: ${trace.join(', ')}`);
      trace = null;
    }
    await measure(
      'open message, body not cached',
      () =>
        elif.api.call('mailThread', {
          query: { folder: 'INBOX', uid: plain.uid, markSeen: 'false' },
        }),
      { before: clearBodies },
    );
    await measure('open message (conversation)', () =>
      elif.api.call('mailThread', {
        query: { folder: 'INBOX', uid: plain.uid, markSeen: 'false' },
      }),
    );
    await measure(
      'open message, body cached (cold connection)',
      () =>
        elif.api.call('mailThread', {
          query: { folder: 'INBOX', uid: plain.uid, markSeen: 'false' },
        }),
      { cold: true },
    );
    await measure(
      'open message with 300 KB attachment, not cached',
      () =>
        elif.api.call('mailThread', {
          query: { folder: 'INBOX', uid: withFile.uid, markSeen: 'false' },
        }),
      { before: clearBodies },
    );
    await measure('open message with 300 KB attachment', () =>
      elif.api.call('mailThread', {
        query: { folder: 'INBOX', uid: withFile.uid, markSeen: 'false' },
      }),
    );
    await measure('search "rapor 7999", headers (first answer)', () =>
      elif.api.call('mailMessages', {
        query: { folder: 'INBOX', q: 'rapor 7999', scope: 'headers' },
      }),
    );
    await measure('search "rapor 7999"', () =>
      elif.api.call('mailMessages', { query: { folder: 'INBOX', q: 'rapor 7999' } }),
    );
    expect(page1.items).toHaveLength(50);
  }, 900_000);
});
