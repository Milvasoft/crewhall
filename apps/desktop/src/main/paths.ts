import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { View } from '../common/ipc';

/** dist/ holds main.cjs, preload.cjs, renderer/ and assets/ (scripts/build.mjs). */
export const DIST = __dirname;
export const PRELOAD = join(DIST, 'preload.cjs');
export const RENDERER_HTML = join(DIST, 'renderer', 'index.html');
export const RENDERER_URL_PREFIX = pathToFileURL(join(DIST, 'renderer')).href;

export function asset(name: string): string {
  return join(DIST, 'assets', name);
}

export function viewQuery(view: View, params: Record<string, string> = {}): Record<string, string> {
  return { view, ...params };
}
