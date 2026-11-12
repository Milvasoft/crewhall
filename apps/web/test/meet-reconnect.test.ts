import { getLogger, LoggerNames } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leftReason } from '@/components/meet/room/RoomView';
import { isExpectedDrop, softenConnectionDropLogs } from '@/lib/meet/livekitLog';

afterEach(() => vi.restoreAllMocks());

describe('leaving the room', () => {
  const connected = { connected: true, ended: false };
  it('tells a broken connection from leaving on purpose', () => {
    expect(leftReason(1, connected)).toBe('left');
    expect(leftReason(2, connected)).toBe('transferred');
    expect(leftReason(1, { ...connected, transferred: true })).toBe('transferred');
    expect(leftReason(4, connected)).toBe('removed');
    expect(leftReason(5, connected)).toBe('ended');
    expect(leftReason(10, connected)).toBe('ended');
    expect(leftReason(1, { connected: true, ended: true })).toBe('ended');
    // Reconnecting gave up, or the server went away.
    expect(leftReason(undefined, connected)).toBe('dropped');
    expect(leftReason(0, connected)).toBe('dropped');
    expect(leftReason(3, connected)).toBe('dropped');
    expect(leftReason(14, connected)).toBe('dropped');
  });

  it('says the room could not be reached when it never got in (H9)', () => {
    expect(leftReason(undefined, { connected: false, ended: false })).toBe('error');
    expect(leftReason(1, { connected: false, ended: false })).toBe('left');
  });
});

describe('livekit logs of a dropped connection', () => {
  it('writes the signal drop as a warning, other errors stay errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    softenConnectionDropLogs();
    const log = getLogger(LoggerNames.Signal);
    // loglevel binds console when the level is set: rebuild against the spies.
    log.setLevel(log.getLevel() as Parameters<typeof log.setLevel>[0], false);
    log.error('error reading from signal stream', { error: 'ConnectionError' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    log.error('could not negotiate');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('knows the messages of a drop', () => {
    expect(isExpectedDrop('error reading from signal stream')).toBe(true);
    expect(isExpectedDrop('websocket closed')).toBe(true);
    expect(isExpectedDrop('publishing track failed')).toBe(false);
    expect(isExpectedDrop(undefined)).toBe(false);
  });
});
