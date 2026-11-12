import { type Space } from '@crewhall/shared';
import { Icon, SpaceBadge } from '@crewhall/ui';
import { isSpaceIcon, spaceName } from '@/components/spaces/spaceUtils';
import { useT } from '@/lib/i18n/I18nContext';

const ICON_SIZE = { sm: 12, md: 16, lg: 20, xl: 28 } as const;

/** Space badge: icon when one was chosen, else the first letter; personal space shows a person. */
export function SpaceAvatar({
  space,
  size = 'md',
}: {
  space: Pick<Space, 'kind' | 'name' | 'color' | 'icon'>;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const t = useT();
  const name = spaceName(space, t);
  const icon = space.kind === 'personal' ? 'user' : isSpaceIcon(space.icon) ? space.icon : null;
  return (
    <SpaceBadge color={space.color} name={name} size={size}>
      {icon ? <Icon name={icon} size={ICON_SIZE[size]} strokeWidth={2.2} /> : undefined}
    </SpaceBadge>
  );
}
