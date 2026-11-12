import { type MailFolder, type MailSpecialUse } from '@crewhall/shared';
import { Button, cn, Icon, IconButton, Skeleton, type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ActionContextMenu,
  ActionDropdown,
  type ActionEntry,
} from '@/components/common/ActionMenu';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';
import { useI18n, type I18nValue } from '@/lib/i18n/I18nContext';
import { mailFoldersQuery } from '@/lib/mail/queries';
import { InboxNav } from './inbox/InboxSidebar';
import { useMailBulk } from './useMailBulk';

const SPECIAL_ICON: Record<MailSpecialUse, IconName> = {
  inbox: 'inbox',
  drafts: 'edit',
  sent: 'send',
  archive: 'archive',
  junk: 'alert',
  trash: 'trash',
};

export function folderLabel(f: Pick<MailFolder, 'specialUse' | 'name'>, t: I18nValue['t']) {
  return f.specialUse ? t(`mail.special.${f.specialUse}`) : f.name;
}

/** Nesting depth of a folder from its path, for the indent in the list. */
function depth(f: MailFolder) {
  if (!f.delimiter || f.specialUse) return 0;
  return Math.min(3, f.path.split(f.delimiter).length - 1);
}

export function MailSidebar({
  email,
  folder,
  onCompose,
}: {
  email: string;
  folder: string | null;
  onCompose: () => void;
}) {
  const { t } = useI18n();
  const folders = useQuery(mailFoldersQuery);
  const bulk = useMailBulk();
  const navigate = useNavigate();
  return (
    <ModuleSidebar label={t('mail.sidebar')} className="gap-px overflow-hidden px-2.5 py-3">
      <div className="mb-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
        <span className="flex size-9 items-center justify-center rounded-md bg-bg2">
          <Icon name="mail" size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{t('mail.title')}</span>
          <span className="truncate text-xs text-fg3">{email}</span>
        </div>
      </div>
      <Button variant="pri" size="sm" className="mx-1 mb-3" onClick={onCompose}>
        <Icon name="compose" size={16} />
        {t('mail.newMessage')}
      </Button>
      <span className="eyebrow mb-1 px-2.5">{t('mail.folders')}</span>
      <nav
        aria-label={t('mail.folders')}
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto"
      >
        {folders.isPending
          ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mx-2.5 my-1 h-6" />)
          : (folders.data?.items ?? []).map((f) => {
              const active = f.path === (folder ?? 'INBOX');
              const name = folderLabel(f, t);
              // The right-click menu and the "…" button offer the same folder actions.
              const entries: ActionEntry[] = [
                {
                  kind: 'item',
                  key: 'open',
                  icon: 'folder',
                  label: t('mail.menu.openFolder'),
                  onSelect: () => void navigate({ to: '/mail', search: { folder: f.path } }),
                },
                {
                  kind: 'item',
                  key: 'markAll',
                  icon: 'checkC',
                  label: t('mail.bulk.markAllRead'),
                  disabledReason: f.unread === 0 ? t('mail.menu.noUnread') : undefined,
                  onSelect: () => void bulk(f.path, 'seen', { kind: 'folder' }),
                },
              ];
              return (
                <ActionContextMenu key={f.path} entries={entries}>
                  <div className="group relative flex shrink-0">
                    <Link
                      to="/mail"
                      search={{ folder: f.path }}
                      aria-current={active ? 'page' : undefined}
                      style={{ paddingLeft: `${10 + depth(f) * 14}px` }}
                      className={cn(
                        'flex h-[var(--nv-h)] min-w-0 flex-1 items-center gap-2.5 rounded-sm pr-9 text-[13.5px] leading-[18px] font-medium whitespace-nowrap text-fg2 hover:bg-bg2 hover:text-fg',
                        active && 'bg-capsule font-semibold text-fg hover:bg-capsule',
                      )}
                    >
                      <Icon name={f.specialUse ? SPECIAL_ICON[f.specialUse] : 'folder'} size={16} />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      {f.unread > 0 && f.specialUse !== 'sent' && f.specialUse !== 'trash' ? (
                        <span
                          className="text-xs font-semibold text-fg tn group-focus-within:invisible group-hover:invisible"
                          aria-label={t('mail.unreadCount', { count: f.unread })}
                        >
                          {f.unread}
                        </span>
                      ) : null}
                    </Link>
                    <ActionDropdown entries={entries}>
                      <IconButton
                        size="xs"
                        tone="plain"
                        aria-label={t('mail.bulk.folderMenu', { folder: name })}
                        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
                      >
                        <Icon name="dots" size={14} />
                      </IconButton>
                    </ActionDropdown>
                  </div>
                </ActionContextMenu>
              );
            })}
      </nav>
      <InboxNav />
      <div className="mt-auto flex shrink-0 flex-col gap-px border-t border-line pt-2">
        <Link
          to="/mail/settings"
          className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
        >
          <Icon name="settings" size={16} />
          <span className="flex-1">{t('mail.settingsLink')}</span>
        </Link>
      </div>
    </ModuleSidebar>
  );
}
