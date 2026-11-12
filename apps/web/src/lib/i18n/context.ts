import { sharedContext } from '@/lib/sharedContext';
import { type I18nValue } from './I18nContext';

/**
 * The context object lives apart from the dictionaries: editing a locale file re-runs
 * I18nContext.tsx in dev (HMR), and a fresh context there would no longer match the
 * provider already mounted, so every consumer would throw. It is also shared through
 * globalThis, so a route chunk with its own copy of this module still finds the provider.
 */
export const I18nContext = sharedContext<I18nValue | null>('crewhall.i18n', null);
