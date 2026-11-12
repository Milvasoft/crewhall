import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger';
import { timed, timedSync, traced } from './timing';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const headers = new Map<string, string>();
  const c = { header: (k: string, v: string) => headers.set(k, v) } as unknown as Context;
  const info = vi.fn();
  const logger = { info } as unknown as Logger;
  const phases = () =>
    Object.fromEntries(
      (headers.get('Server-Timing') ?? '')
        .split(', ')
        .map((p) => p.split(';dur='))
        .map(([k, v]) => [k, Number(v)]),
    );
  return { c, logger, info, phases };
}

describe('mail request timing', () => {
  it('reports phases, a nested phase counted once', async () => {
    const h = harness();
    const out = await traced(h.c, h.logger, 'mailThread', async () => {
      await timed('connect', () => pause(20));
      await timed('imap', async () => {
        await pause(5);
        await timed('db', () => pause(80));
      });
      timedSync('sanitize', () => 'x'.repeat(10));
      return 'ok';
    });
    expect(out).toBe('ok');
    const p = h.phases();
    expect(p.connect).toBeGreaterThanOrEqual(15);
    expect(p.db).toBeGreaterThanOrEqual(75);
    // IMAP without the database time inside it (timers drift a few ms under load).
    expect(p.imap).toBeLessThan(p.db / 2);
    expect(p.total).toBeGreaterThanOrEqual(p.connect + p.imap + p.db);
    expect(h.info).not.toHaveBeenCalled();
  });

  it('logs a slow request with its breakdown, also when it fails', async () => {
    const h = harness();
    await expect(
      traced(h.c, h.logger, 'mailMessages', async () => {
        await timed('imap', () => pause(320));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(h.info).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'mailMessages', phases: { imap: expect.any(Number) } }),
      'mail request slow',
    );
    expect(h.phases().imap).toBeGreaterThan(300);
  });

  it('is a no-op outside a request', async () => {
    await expect(timed('db', async () => 7)).resolves.toBe(7);
  });
});
