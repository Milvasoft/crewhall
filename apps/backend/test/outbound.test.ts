import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlockedAddressError,
  checkDestination,
  isInternalAddress,
  outboundFetch,
  outboundPolicy,
  type Resolved,
} from '../src/net/outbound';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

/** A policy whose DNS answers come from a table (`host` → addresses). */
const withDns = (
  table: Record<string, string[]>,
  env: { PRIVATE_FETCH_ALLOWLIST?: string; OUTBOUND_ALLOWED_PORTS?: string } = {},
) =>
  outboundPolicy(env, async (host) => {
    const list = table[host];
    if (!list) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return list.map((address): Resolved => ({ address, family: address.includes(':') ? 6 : 4 }));
  });

const blockedFor = async (url: string, policy = withDns({})) => {
  try {
    await checkDestination(new URL(url), policy);
    return null;
  } catch (err) {
    return err instanceof BlockedAddressError ? err.reason : 'other';
  }
};

describe('outbound request guard (SSRF)', () => {
  let server: Server;
  let port: number;
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      if (req.url === '/to-inside') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(1000));
      } else res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it('knows the addresses nobody outside should reach', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.14',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isInternalAddress(a), a).toBe(true);
    }
    for (const a of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isInternalAddress(a), a).toBe(false);
    }
  });

  it('refuses other protocols, odd ports and internal addresses', async () => {
    const dns = withDns({ 'example.com': ['93.184.216.34'], 'db.internal': ['172.18.0.4'] });
    expect(await blockedFor('ftp://example.com/x', dns)).toBe('protocol');
    expect(await blockedFor('file:///etc/passwd', dns)).toBe('protocol');
    expect(await blockedFor('https://example.com/', dns)).toBeNull();
    expect(await blockedFor('http://example.com:8080/', dns)).toBe('port');
    expect(await blockedFor('http://db.internal/', dns)).toBe('private');
    expect(await blockedFor('http://169.254.169.254/latest/meta-data/', dns)).toBe('private');
    expect(await blockedFor('http://[::ffff:127.0.0.1]/', dns)).toBe('private');
    expect(await blockedFor('http://nowhere.example/', dns)).toBe('dns');
    const ports = withDns({ 'example.com': ['93.184.216.34'] }, { OUTBOUND_ALLOWED_PORTS: '8080' });
    expect(await blockedFor('http://example.com:8080/', ports)).toBeNull();
  });

  it('refuses a name with any internal answer, the way rebinding starts', async () => {
    const dns = withDns({ 'rebind.test': ['93.184.216.34', '127.0.0.1'] });
    expect(await blockedFor('http://rebind.test/', dns)).toBe('private');
  });

  it('lets the allowlist open intranet ranges and hosts, any port', async () => {
    const dns = withDns(
      { 'wiki.corp.example': ['10.0.0.8'], 'n8n.lan': ['192.168.1.20'], 'other.lan': ['10.9.9.9'] },
      { PRIVATE_FETCH_ALLOWLIST: '192.168.1.0/24, *.corp.example' },
    );
    expect(await blockedFor('http://wiki.corp.example:8443/', dns)).toBeNull();
    expect(await blockedFor('http://n8n.lan:5678/hook', dns)).toBeNull();
    expect(await blockedFor('http://other.lan/', dns)).toBe('private');
    expect(await blockedFor('http://corp.example.evil.com/', dns)).toBe('dns');
  });

  it('connects to the address it checked, not to a second DNS answer', async () => {
    // pinned.test exists only in this table: reaching the stub proves the checked address is used.
    const policy = withDns(
      { 'pinned.test': ['127.0.0.1'] },
      { PRIVATE_FETCH_ALLOWLIST: 'pinned.test' },
    );
    const res = await outboundFetch(`http://pinned.test:${port}/hello`, { policy });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(seen.at(-1)!.headers.host).toBe(`pinned.test:${port}`);
  });

  it('checks every redirect, so one cannot lead inside', async () => {
    const policy = withDns(
      { 'pinned.test': ['127.0.0.1'] },
      { PRIVATE_FETCH_ALLOWLIST: 'pinned.test' },
    );
    seen.length = 0;
    await expect(
      outboundFetch(`http://pinned.test:${port}/to-inside`, { policy }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(seen.map((s) => s.path)).toEqual(['/to-inside']);
    const manual = await outboundFetch(`http://pinned.test:${port}/to-inside`, {
      policy,
      redirect: 'manual',
    });
    expect(manual.status).toBe(302);
  });

  it('stops reading a body past its limit', async () => {
    const policy = withDns({}, { PRIVATE_FETCH_ALLOWLIST: '127.0.0.1' });
    const res = await outboundFetch(`http://127.0.0.1:${port}/big`, { policy, maxBytes: 100 });
    await expect(res.text()).rejects.toThrow();
  });
});

/** Without an allowlist, quick access treats internal addresses as unreachable from here. */
describe('quick access links to internal addresses', () => {
  let app: TestApp;
  let owner: Client;
  let site: Server;
  let base: string;

  beforeAll(async () => {
    site = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>İç site</title>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    app = await createTestApp({ PRIVATE_FETCH_ALLOWLIST: '' });
    ({ owner } = await setupWithOwner(app));
  });
  afterAll(async () => {
    await app.close();
    site.close();
  });

  it('does not fetch its title and marks its health as not checkable, not as failing', async () => {
    const surfaceId = (await owner.api.call('listSurfaces')).items[0]!.id;
    const card = await owner.api.call('createCard', {
      params: { surfaceId },
      body: { type: 'link', link: { url: `${base}/` } },
    });
    if (card.type !== 'link') throw new Error('type');
    const linkId = card.config.item.linkId;
    const link = await owner.api.call('getLink', { params: { linkId } });
    expect(link.siteTitle).toBeNull();
    for (let i = 0; i < 3; i++) {
      const checked = await owner.api.call('checkLinkNow', { params: { linkId } });
      expect(checked.health).toMatchObject({ status: 'unknown', reason: 'internal' });
    }
  });
});
