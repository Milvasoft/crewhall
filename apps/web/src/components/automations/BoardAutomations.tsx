import { Button, Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { kindName, rulesQuery } from '@/lib/automations/api';
import { useModuleEnabled } from '@/lib/identity/modules';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';

/**
 * Board settings › Otomasyon (design 6.6): the space's rules that start from this board, and a
 * way to the automations page where rules are built.
 */
export function BoardAutomations({
  spaceId,
  boardId,
  onNavigate,
}: {
  spaceId: string;
  boardId: string;
  onNavigate: () => void;
}) {
  const { t, locale } = useI18n();
  const on = useModuleEnabled('automations');
  const { items } = useSpaces();
  const space = items.find((s) => s.id === spaceId);
  const rules = useQuery({ ...rulesQuery(spaceId), enabled: on, retry: false });
  if (!on || !space) {
    return (
      <p className="rounded-lg bg-bg2 px-4 py-3 text-[13.5px] text-fg2">
        {t('automations.board.off')}
      </p>
    );
  }
  const mine = (rules.data?.items ?? []).filter((r) => r.trigger.config.boardId === boardId);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13.5px] text-fg2">{t('automations.board.intro')}</p>
      {mine.length ? (
        <ul className="flex flex-col gap-1.5">
          {mine.map((r) => (
            <li key={r.id}>
              <Link
                to="/automations/rule/$ruleId"
                params={{ ruleId: r.id }}
                onClick={onNavigate}
                className="flex items-center gap-2.5 rounded-lg bg-bg2 px-3 py-2.5 text-sm hover:bg-capsule"
              >
                <Icon name="zap" size={16} className={r.enabled ? 'text-fg' : 'text-fg3'} />
                <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
                <span className="truncate text-xs text-fg2">
                  {r.actions.map((a) => kindName(locale, 'actions', a.type)).join(', ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : rules.data ? (
        <p className="text-sm text-fg3">{t('automations.board.none')}</p>
      ) : null}
      <Button asChild variant="out" size="sm" className="self-start">
        <Link to="/automations/$spaceSlug" params={{ spaceSlug: space.slug }} onClick={onNavigate}>
          <Icon name="zap" size={15} />
          {t('automations.board.open')}
        </Link>
      </Button>
    </div>
  );
}
