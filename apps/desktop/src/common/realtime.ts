import { WS_CLOSE, WsServerEvent } from '@crewhall/shared';
import { presenceFields, type DeviceState } from './presence';

/** The part of the WebSocket API the client uses (global WebSocket in Electron's main process). */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export interface RealtimeOptions {
  /** createWsTicket; throws when signed out. */
  getTicket: () => Promise<{ ticket: string; path: string }>;
  /** API origin; http(s) becomes ws(s). */
  origin: () => string;
  openSocket: (url: string) => SocketLike;
  onEvent: (event: WsServerEvent) => void;
  /** Connected (true) or not; used to refetch the badge after a gap. */
  onStatus?: (connected: boolean) => void;
  /** Delays in ms; tests shorten them. */
  backoff?: readonly number[];
  /** The computer's idle time and lock state, for presence (common/presence). */
  device?: () => DeviceState;
}

const CONNECTING = 0;
const OPEN = 1;

/**
 * The desktop app's own /ws connection (doc 17 §6). It never claims focus: the web page in the
 * window reports focus itself, so the server's push and notification rules stay as they are. It
 * reports the computer for presence: active within 15 minutes of input, not when locked.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  /** Waiting for a ticket; a second connect now would leave two sockets. */
  private connecting = false;

  constructor(private readonly o: RealtimeOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.dropSocket();
  }

  /** Reconnect now (signed in, network back). */
  retryNow(): void {
    if (!this.running) return;
    if (this.connecting) return;
    const state = this.socket?.readyState;
    if (state === OPEN || state === CONNECTING) return;
    this.attempt = 0;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    void this.connect();
  }

  /** The computer locked, slept or woke up: tell the server now, not at the next beat. */
  beatNow(): void {
    this.beat();
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Whatever was on the old socket stops here: one socket, one copy of every event. */
  private dropSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onmessage = null;
    s.onclose = null;
    s.close(1000);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retry) clearTimeout(this.retry);
    this.heartbeat = null;
    this.retry = null;
  }

  private scheduleRetry(): void {
    if (!this.running || this.retry) return;
    const steps = this.o.backoff ?? [1000, 2000, 5000, 10_000, 30_000];
    const delay = steps[Math.min(this.attempt, steps.length - 1)]!;
    this.attempt++;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (!this.running || this.connecting) return;
    this.connecting = true;
    let ticket: { ticket: string; path: string };
    try {
      ticket = await this.o.getTicket();
    } catch {
      this.connecting = false;
      this.scheduleRetry();
      return;
    }
    this.connecting = false;
    if (!this.running) return;
    const base = new URL(this.o.origin());
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = ticket.path;
    base.search = `?ticket=${encodeURIComponent(ticket.ticket)}`;

    let socket: SocketLike;
    try {
      socket = this.o.openSocket(base.href);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.dropSocket();
    this.socket = socket;
    socket.onmessage = (ev) => this.handle(ev.data);
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.o.onStatus?.(false);
      // 4403: access is gone (account disabled); try again only slowly.
      if (ev.code === WS_CLOSE.forbidden) this.attempt = Number.MAX_SAFE_INTEGER;
      this.scheduleRetry();
    };
    socket.onerror = () => undefined;
  }

  private handle(data: unknown): void {
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = WsServerEvent.safeParse(json);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === 'ready') {
      this.attempt = 0;
      this.o.onStatus?.(true);
      this.beat();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.beat(), event.heartbeatSeconds * 1000);
    }
    this.o.onEvent(event);
  }

  private beat(): void {
    if (this.socket?.readyState !== OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: 'heartbeat',
        ...(this.o.device ? presenceFields(this.o.device()) : { active: false }),
        focused: false,
        activeConversationId: null,
      }),
    );
  }
}
