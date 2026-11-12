import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import type { WsClientEvent, WsServerEvent } from '@crewhall/shared';
import type { Client, TestApp } from './helpers';

/** Real http server around the test app, with the WebSocket gateway attached. */
export async function listen(app: TestApp) {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.app.fetch, port: 0 }, () => resolve(s as Server)) as Server;
  });
  app.realtime.attach(server);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export class WsClient {
  readonly events: WsServerEvent[] = [];
  private waiters: { pred: (e: WsServerEvent) => boolean; resolve: (e: WsServerEvent) => void }[] =
    [];
  closeCode: number | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const event = JSON.parse(String(raw)) as WsServerEvent;
      this.events.push(event);
      for (const w of [...this.waiters]) {
        if (w.pred(event)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    });
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static async open(port: number, client: Client) {
    const t = await client.api.call('createWsTicket');
    return WsClient.openWithTicket(port, t.ticket);
  }

  static async openWithTicket(port: number, ticket: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
    const c = new WsClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return c;
  }

  /** Resolves with the first (already received or future) event matching `pred`. */
  waitFor<T extends WsServerEvent['type']>(
    type: T,
    pred: (e: Extract<WsServerEvent, { type: T }>) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<Extract<WsServerEvent, { type: T }>> {
    const match = (e: WsServerEvent) =>
      e.type === type && pred(e as Extract<WsServerEvent, { type: T }>);
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen as Extract<WsServerEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const done = (e: WsServerEvent) => {
        clearTimeout(timer);
        resolve(e as Extract<WsServerEvent, { type: T }>);
      };
      this.waiters.push({ pred: match, resolve: done });
    });
  }

  of<T extends WsServerEvent['type']>(type: T) {
    return this.events.filter((e) => e.type === type) as Extract<WsServerEvent, { type: T }>[];
  }

  send(event: WsClientEvent) {
    this.ws.send(JSON.stringify(event));
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  waitClosed(timeoutMs = 15_000) {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }
}

/** Stand-in for the Expo push service: records sends, answers tickets and receipts. */
export async function expoStub() {
  const sent: { to: string; title: string; body: string; priority?: string; data?: unknown }[] = [];
  const dead = new Set<string>();
  const receiptsDead = new Set<string>();
  let n = 0;
  const tickets = new Map<string, string>();
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/send')) {
        const list = JSON.parse(raw) as { to: string; title: string; body: string }[];
        const data = list.map((m) => {
          sent.push(m);
          if (dead.has(m.to)) {
            return { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } };
          }
          const id = `ticket-${++n}`;
          tickets.set(id, m.to);
          return { status: 'ok', id };
        });
        res.end(JSON.stringify({ data }));
        return;
      }
      if (req.url?.endsWith('/getReceipts')) {
        const { ids } = JSON.parse(raw) as { ids: string[] };
        const data: Record<string, unknown> = {};
        for (const id of ids) {
          const to = tickets.get(id);
          data[id] =
            to && receiptsDead.has(to)
              ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok' };
        }
        res.end(JSON.stringify({ data }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    dead,
    receiptsDead,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const uuid = () => crypto.randomUUID();

/** Polls until `cond` holds (no fixed sleeps: they break under load). */
export async function until(cond: () => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
