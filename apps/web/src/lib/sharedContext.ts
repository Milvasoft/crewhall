import { createContext, type Context } from 'react';

type Registry = Map<string, Context<unknown>>;
const REGISTRY = Symbol.for('crewhall.web.contexts');

/**
 * A React context that stays one object however often its module is evaluated.
 *
 * The app-wide providers (i18n, theme) sit above the router, while route pages are separate
 * chunks loaded later. If such a chunk gets its own copy of the context module (a dev server
 * that hot-updated or re-optimized while the tab stayed open, or a tab mixing chunks from two
 * deployments), a plain createContext() would make a second context: the provider fills the
 * first, the page reads the second and finds nothing ("useI18n must be used inside
 * <I18nProvider>", H1). Keyed on globalThis, every copy returns the same context.
 */
export function sharedContext<T>(key: string, defaultValue: T): Context<T> {
  const host = globalThis as { [REGISTRY]?: Registry };
  const registry = (host[REGISTRY] ??= new Map());
  let ctx = registry.get(key) as Context<T> | undefined;
  if (!ctx) {
    ctx = createContext<T>(defaultValue);
    ctx.displayName = key;
    registry.set(key, ctx as Context<unknown>);
  }
  return ctx;
}
