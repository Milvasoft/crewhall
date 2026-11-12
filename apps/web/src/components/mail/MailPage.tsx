import { type MailAccountState, type MailMessage } from '@crewhall/shared';
import { EmptyState, Icon, IconButton, Tooltip } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';
import { type ComposeMode, type MailSearch } from '@/lib/mail/compose';
import { mailFoldersQuery, mailKeys, type MailListFilter } from '@/lib/mail/queries';
import { useShellLayout } from '@/lib/shell';
// The composer brings the rich text editor (the largest bundle of the app): loaded on demand.
const Composer = lazy(() => import('./Composer').then((m) => ({ default: m.Composer })));
import { folderLabel, MailSidebar } from './MailSidebar';
import { MessageList } from './MessageList';
import { ThreadView } from './ThreadView';

export type MailRouteSearch = MailSearch & { new?: 1; connected?: 1; error?: string };
type Search = MailRouteSearch;

/** /mail: folders, the message list and the conversation side by side (one at a time on phones). */
export function MailPage({ state, search }: { state: MailAccountState; search: Search }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: '/mail/' });
  const phone = useShellLayout() === 'phone';
  const account = state.account!;
  const folders = useQuery(mailFoldersQuery);
  const folder = search.folder ?? 'INBOX';
  const current = folders.data?.items.find((f) => f.path === folder);
  const filter: MailListFilter = {
    folder,
    q: search.q,
    filter: search.filter ?? 'all',
  };
  const [compose, setCompose] = useState<{ mode: ComposeMode; source: MailMessage | null } | null>(
    null,
  );

  const setSearch = useCallback(
    (next: Partial<Search>) =>
      void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true }),
    [navigate],
  );

  // Ctrl K "new e-mail" lands here with ?new=1; the composer stays open until it is closed.
  const open = compose ?? (search.new ? { mode: 'new' as const, source: null } : null);

  const onFilter = useCallback(
    (f: Partial<MailListFilter>) =>
      setSearch({
        ...('q' in f ? { q: f.q } : {}),
        ...(f.filter ? { filter: f.filter === 'all' ? undefined : f.filter } : {}),
        uid: undefined,
      }),
    [setSearch],
  );

  const list = (
    <MessageList
      filter={filter}
      onFilter={onFilter}
      selected={search.uid ?? null}
      onSelect={(uid) => setSearch({ uid })}
      onRemoved={(uids) => {
        if (search.uid && uids.includes(search.uid)) setSearch({ uid: undefined });
      }}
      me={account.email}
      folder={current}
      folders={folders.data?.items ?? []}
      onCompose={(mode, source) => setCompose({ mode, source })}
    />
  );
  const view = search.uid ? (
    <ThreadView
      key={`${folder}:${search.uid}`}
      folder={folder}
      uid={search.uid}
      folders={folders.data?.items ?? []}
      me={account.email}
      allowRemoteImages={state.server.allowRemoteImages}
      onCompose={(mode, source) => setCompose({ mode, source })}
      onClose={() => setSearch({ uid: undefined })}
    />
  ) : (
    <div className="hidden flex-1 md:flex">
      <EmptyState icon="mail" title={t('mail.view.empty')} className="m-auto" />
    </div>
  );

  return (
    <Workspace
      sidebar={
        <MailSidebar
          email={account.email}
          folder={folder}
          onCompose={() => setCompose({ mode: 'new', source: null })}
        />
      }
      crumbs={[{ label: t('mail.title') }, { label: current ? folderLabel(current, t) : folder }]}
      tools={
        <Tooltip content={t('mail.refresh')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('mail.refresh')}
            onClick={() => void qc.invalidateQueries({ queryKey: mailKeys.all })}
          >
            <Icon name="refresh" size={18} />
          </IconButton>
        </Tooltip>
      }
      bodyClassName="flex-row gap-0 overflow-hidden p-0 md:p-0"
    >
      {phone ? (
        search.uid ? (
          view
        ) : (
          list
        )
      ) : (
        <>
          {list}
          {view}
        </>
      )}
      {open ? (
        <Suspense fallback={null}>
          <Composer
            mode={open.mode}
            source={open.source}
            account={account}
            maxBytes={state.server.maxAttachmentBytes}
            onClose={() => {
              setCompose(null);
              if (search.new) setSearch({ new: undefined });
            }}
          />
        </Suspense>
      ) : null}
    </Workspace>
  );
}
