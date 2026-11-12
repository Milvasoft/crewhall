import { WsServerEvent } from '@crewhall/shared';

/** Frames from /ws are external input: anything that does not match the contract is dropped. */
export function parseServerEvent(raw: unknown): WsServerEvent | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = WsServerEvent.safeParse(v);
  return parsed.success ? parsed.data : null;
}
