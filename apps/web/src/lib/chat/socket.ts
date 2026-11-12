import { type WsClientEvent, type WsServerEvent } from '@crewhall/shared';
import { parseServerEvent } from './events';

/**
 * The /ws connection (doc 17 §6, design 4.18): a 30-second ticket from HTTP opens it, a
 * heartbeat every 25 s keeps presence alive (the server closes with 4408 when they stop), and a dropped socket retries after 1-2-4-8… seconds
 * (at most 30). Listeners learn about reconnects so they can catch up on missed messages.
 */

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'retrying';

export interface SocketState {
  status: SocketStatus;
  /** Failed attempts since the last open socket. */
  attempt: number;
  /** When the next attempt starts (epoch ms) while retrying. */
  retryAt: number | null;
  /** The socket has been open at least once since start(). */
  everOpened: boolean;
}

export interface SocketOptions {
  /** Ticket and the path to open (`/ws`). */
  getTicket: () => Promise<{ ticket: string; path: string }>;
  url: (ticket: string, path: string) => string;
  onEvent: (e: WsServerEvent) => void;
  /** After every open; `reconnected` is true when an earlier socket had been open. */
  onOpen?: (reconnected: boolean) => void;
  /** The ticket request failed for good (signed out): stop retrying. */
  isFatal?: (error: unknown) => boolean;
  /** Whether the person used the app in the last 15 minutes (presence away). */
  isActive?: () => boolean;
  /** Seconds since the last input; with it the server decides activity itself. */
  getIdleSeconds?: () => number;
  /** Tab visible: without a focused session the server sends push instead. */
  isFocused?: () => boolean;
  /** Conversation on screen: while focused, the server notifies nothing from it (H8). */
  getActiveConversation?: () => string | null;
  WebSocketImpl?: typeof WebSocket;
}

export const HEARTBEAT_MS = 25_000;
export const MAX_BACKOFF_MS = 30_000;

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

const INITIAL: SocketState = { status: 'idle', attempt: 0, retryAt: null, everOpened: false };

export class ChatSocket {
  private ws: WebSocket | null = null;
  private state: SocketState = INITIAL;
  private listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Bumps on every connect so late callbacks from an old socket are ignored. */
  private generation = 0;

  constructor(private readonly opts: SocketOptions) {}

  getState = (): SocketState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.set(INITIAL);
  }

  /** "Şimdi dene" (4.18) and the browser's online event skip the remaining wait. */
  retryNow(): void {
    if (!this.running || this.state.status === 'open' || this.state.status === 'connecting') {
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  }

  /** Dev and QA: drop the link as a network outage would and stay down for `ms`. */
  simulateOutage(ms: number): void {
    if (!this.running) return;
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    ws?.close(4000);
    const attempt = this.state.attempt + 1;
    this.set({ status: 'retrying', attempt, retryAt: Date.now() + ms });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) void this.connect();
    }, ms);
  }

  send(e: WsClientEvent): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(e));
    return true;
  }

  private set(patch: Partial<SocketState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.beat) clearInterval(this.beat);
    this.retryTimer = null;
    this.beat = null;
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    this.set({ status: 'connecting', retryAt: null });
    let ticket: { ticket: string; path: string };
    try {
      ticket = await this.opts.getTicket();
    } catch (e) {
      if (gen !== this.generation) return;
      if (this.opts.isFatal?.(e)) {
        this.stop();
        return;
      }
      this.scheduleRetry();
      return;
    }
    if (gen !== this.generation || !this.running) return;

    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.opts.url(ticket.ticket, ticket.path));
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      const reconnected = this.state.everOpened;
      this.set({ status: 'open', attempt: 0, retryAt: null, everOpened: true });
      this.startHeartbeat(gen);
      this.opts.onOpen?.(reconnected);
    };
    ws.onmessage = (m: MessageEvent) => {
      if (gen !== this.generation) return;
      const e = parseServerEvent(m.data);
      if (e) this.opts.onEvent(e);
    };
    ws.onclose = () => {
      if (gen !== this.generation) return;
      this.ws = null;
      if (this.beat) clearInterval(this.beat);
      this.beat = null;
      if (this.running) this.scheduleRetry();
    };
    // An error is followed by close; nothing to do here.
    ws.onerror = () => undefined;
  }

  /** Also sent right away when the tab becomes visible or hidden, or another chat opens. */
  sendHeartbeat(): void {
    this.send({
      type: 'heartbeat',
      active: this.opts.isActive?.() ?? true,
      focused: this.opts.isFocused?.() ?? true,
      ...(this.opts.getIdleSeconds
        ? { client: 'web' as const, idleSeconds: this.opts.getIdleSeconds() }
        : {}),
      ...(this.opts.getActiveConversation
        ? { activeConversationId: this.opts.getActiveConversation() }
        : {}),
    });
  }

  private startHeartbeat(gen: number): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = setInterval(() => {
      if (gen !== this.generation) return;
      this.sendHeartbeat();
    }, HEARTBEAT_MS);
  }

  private scheduleRetry(): void {
    const attempt = this.state.attempt + 1;
    const wait = backoffMs(attempt);
    this.set({ status: 'retrying', attempt, retryAt: Date.now() + wait });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) void this.connect();
    }, wait);
  }
}
