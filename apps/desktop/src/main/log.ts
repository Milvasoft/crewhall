import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/**
 * A small log file for things worth seeing from a packaged app (where the console goes nowhere):
 * `<userData>/logs/crewhall.log`, about 1 MB, the previous one kept as crewhall.old.log.
 * Never secrets: paths and events only.
 */
const MAX_BYTES = 1_000_000;
let queue: Promise<void> = Promise.resolve();

export function logFile(): string {
  return join(app.getPath('userData'), 'logs', 'crewhall.log');
}

export function log(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
  console.info(line.trimEnd());
  const file = logFile();
  queue = queue
    .then(async () => {
      await mkdir(join(file, '..'), { recursive: true });
      const size = await stat(file).then(
        (s) => s.size,
        () => 0,
      );
      if (size > MAX_BYTES) await rename(file, file.replace(/\.log$/, '.old.log'));
      await appendFile(file, line);
    })
    .catch(() => undefined);
}

/** A URL without its query and hash (tokens and ids of the query stay out of the log). */
export function pathOnly(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()];
    return `${u.origin}${u.pathname}${keys.length ? ` ?${keys.join(',')}` : ''}`;
  } catch {
    return url.slice(0, 80);
  }
}
