import { getLogger, LoggerNames } from 'livekit-client';

/**
 * A dropped signal connection is something LiveKit recovers from (it reconnects, and the room
 * shows "Yeniden bağlanıyor…"), yet livekit-client logs it with console.error: a red error in
 * the console and in error collectors for what is a network event. These messages go out as
 * warnings instead; every other error stays an error.
 */
export const EXPECTED_DROPS = [
  /error reading from signal stream/i,
  /websocket (closed|error)/i,
  /could not connect .*signal/i,
  /ping timeout/i,
];

export const isExpectedDrop = (msg: unknown) =>
  typeof msg === 'string' && EXPECTED_DROPS.some((r) => r.test(msg));

const LOGGERS = [LoggerNames.Signal, LoggerNames.Engine, LoggerNames.Room, LoggerNames.Default];
let installed = false;

export function softenConnectionDropLogs() {
  if (installed) return;
  installed = true;
  for (const name of LOGGERS) {
    const logger = getLogger(name);
    const factory = logger.methodFactory;
    logger.methodFactory = (method, level, loggerName) => {
      const raw = factory(method, level, loggerName);
      if (method !== 'error') return raw;
      const warn = factory('warn', level, loggerName);
      return (...args: unknown[]) => (isExpectedDrop(args[0]) ? warn : raw)(...args);
    };
    // loglevel builds its methods when the level is set.
    logger.setLevel(logger.getLevel() as Parameters<typeof logger.setLevel>[0], false);
  }
}
