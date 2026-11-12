import { Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Shown to admins where an AI button would be while AI is on but not set up: the button used to
 * vanish without a word. People who cannot change the settings see nothing.
 */
export function AiSetupHint({ variant = 'inline' }: { variant?: 'inline' | 'tool' }) {
  const { t } = useI18n();
  if (variant === 'tool') {
    return (
      <Link
        to="/admin/ai"
        className="ch-tool text-fg2"
        title={t('ai.setup.hint')}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Icon name="sparkle" size={16} /> {t('ai.setup.short')}
      </Link>
    );
  }
  return (
    <Link
      to="/admin/ai"
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg2 hover:bg-bg2 hover:text-fg"
    >
      <Icon name="sparkle" size={14} className="text-accent-text" />
      {t('ai.setup.hint')}
    </Link>
  );
}
