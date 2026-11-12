import { Icon, IconButton } from '@crewhall/ui';
import { useState } from 'react';
import { titleBarBridge } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Closes a view from its top bar. In the desktop app that bar is the window's title bar, where an
 * X at its end would sit right beside the window's own X: there it is a back arrow at the start.
 */
export function BarClose({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useI18n();
  const [desktop] = useState(() => titleBarBridge() !== null);
  return (
    <IconButton
      size="xs"
      tone="plain"
      className={desktop ? 'order-first' : className}
      aria-label={t('common.actions.close')}
      onClick={onClick}
    >
      <Icon name={desktop ? 'arrowL' : 'x'} size={15} />
    </IconButton>
  );
}
