import { type Space } from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { type MessageKey } from '@/lib/i18n/I18nContext';

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/** Personal spaces are shown with the localized name, never the stored one. */
export function spaceName(space: Pick<Space, 'kind' | 'name'>, t: T): string {
  return space.kind === 'personal' ? t('spaces.personal') : space.name;
}

/** "7 üye · Sahip" or "Yalnız sen" for the personal space. */
export function spaceSubtitle(space: Space, t: T): string {
  if (space.kind === 'personal') return t('spaces.onlyYou');
  return `${t('spaces.memberCount', { count: space.memberCount })} · ${t(`common.roles.space.${space.myRole}`)}`;
}

/** Badge icons offered in "Yeni space" (stored as `icon`, letters when null). */
export const SPACE_ICONS: IconName[] = [
  'folder',
  'code',
  'server',
  'phone',
  'users',
  'star',
  'flag',
  'bolt',
  'globe',
  'layers',
];

export function isSpaceIcon(v: string | null | undefined): v is IconName {
  return Boolean(v && (SPACE_ICONS as string[]).includes(v));
}
