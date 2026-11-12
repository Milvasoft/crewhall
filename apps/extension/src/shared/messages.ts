import type { PasswordOptions } from '@crewhall/crypto';

/** Requests to the service worker. Content scripts may only send the `capture.*` ones they own. */

export interface VaultEntry {
  id: string;
  vaultId: string;
  vaultName: string | null;
  type: string;
  name: string;
  username: string;
  host: string;
  hasTotp: boolean;
  favorite: boolean;
  /** Saved for the active page. */
  matches: boolean;
}

export interface VaultState {
  setUp: boolean;
  unlocked: boolean;
}

export type CaptureMode = 'new' | 'update' | 'locked';

export interface CapturePrompt {
  id: string;
  mode: CaptureMode;
  host: string;
  username: string;
  itemName: string | null;
  vaults: { id: string; name: string | null }[];
}

export type FillResult = 'filled' | 'no_fields' | 'blocked' | 'no_match';

export interface Requests {
  'vault.state': { in: Record<string, never>; out: VaultState };
  'vault.unlock': { in: { password: string }; out: VaultState };
  'vault.lock': { in: Record<string, never>; out: VaultState };
  'vault.list': { in: { pageUrl: string | null }; out: VaultEntry[] };
  'vault.fill': { in: { itemId: string; tabId: number }; out: FillResult };
  'vault.secret': {
    in: { itemId: string; field: 'username' | 'password' | 'totp' };
    out: { value: string };
  };
  'vault.totp': { in: { itemId: string }; out: { code: string; remaining: number; period: number } };
  'vault.generate': { in: { options: Partial<PasswordOptions> }; out: { value: string } };
  'vault.fillGenerated': { in: { value: string; tabId: number }; out: FillResult };
  'clipboard.clearLater': { in: { value: string }; out: null };
  'capture.submitted': { in: { username: string; password: string }; out: null };
  'capture.check': { in: Record<string, never>; out: { show: boolean } };
  'capture.prompt': { in: { tabId?: number }; out: CapturePrompt | null };
  'capture.save': { in: { id: string; tabId?: number; vaultId?: string }; out: null };
  'capture.dismiss': { in: { tabId?: number; never?: boolean }; out: null };
  'capture.openUnlock': { in: Record<string, never>; out: null };
  'features.sync': { in: Record<string, never>; out: null };
}

export type RequestName = keyof Requests;

/** Everything a page's content script is allowed to ask. */
export const CONTENT_SCRIPT_REQUESTS: readonly RequestName[] = [
  'capture.submitted',
  'capture.check',
];

export type Envelope = { [N in RequestName]: { t: N; p: Requests[N]['in'] } }[RequestName];

export type Reply<T> = { ok: true; value: T } | { ok: false; code: string; details?: unknown };

export class RequestError extends Error {
  constructor(
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = 'RequestError';
  }
}

export async function send<N extends RequestName>(
  t: N,
  p: Requests[N]['in'],
): Promise<Requests[N]['out']> {
  const reply = (await chrome.runtime.sendMessage({ t, p })) as
    Reply<Requests[N]['out']> | undefined;
  if (!reply) throw new RequestError('no_reply');
  if (!reply.ok) throw new RequestError(reply.code, reply.details);
  return reply.value;
}
