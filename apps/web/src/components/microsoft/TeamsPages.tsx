import { Button, Input, Segmented, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { isSignedOut, loadTokens, officeApi, saveTokens } from '@/lib/microsoft/office';
import { loadTeams, teamsSignIn } from '@/lib/microsoft/teams';
import { PaneFrame, SignInPrompt } from './OfficeAuth';
import { SaveForm } from './SaveForm';

/**
 * The Teams app's pages (sonraki-isler.md): connecting a Teams person to Crewhall for the
 * message extension, the "Crewhall'a kaydet" dialog and the configurable tab.
 */

/** `/teams/link`: the message extension's sign-in popup (a top-level window: normal session). */
export function TeamsLinkPage() {
  const { t } = useI18n();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  useEffect(() => {
    void (async () => {
      try {
        const { code } = await api.call('createTeamsLinkCode');
        const teams = await loadTeams();
        if (!teams) throw new Error('not in Teams');
        teams.authentication.notifySuccess(code);
        setState('done');
      } catch {
        setState('failed');
      }
    })();
  }, []);
  return (
    <PaneFrame title={t('microsoft.teamsPages.linkTitle')}>
      <p className="m-0 text-cap text-fg2">{t('microsoft.teamsPages.linkBody')}</p>
      {state === 'working' ? <Skeleton className="h-10 rounded-lg" /> : null}
      {state === 'done' ? <Notice tone="info">{t('microsoft.teamsPages.linkDone')}</Notice> : null}
      {state === 'failed' ? (
        <Notice tone="error">{t('microsoft.teamsPages.linkFailed')}</Notice>
      ) : null}
    </PaneFrame>
  );
}

/** Token sign-in inside Teams frames (tab, dialog) with the app's OIDC client. */
function TeamsSignedIn({
  clientId,
  title,
  children,
}: {
  clientId: string;
  title: string;
  children: (client: ReturnType<typeof officeApi>) => ReactNode;
}) {
  const { t } = useI18n();
  const [signedIn, setSignedIn] = useState(() => loadTokens(clientId) !== null);
  const [failed, setFailed] = useState(false);
  const client = useMemo(() => officeApi(clientId), [clientId]);
  const me = useQuery({
    queryKey: ['teams', 'me', signedIn],
    queryFn: async () => {
      try {
        return await client.call('me');
      } catch (e) {
        // The refresh token ran out: sign in again.
        if (isSignedOut(e)) saveTokens(clientId, null);
        throw e;
      }
    },
    enabled: signedIn,
    retry: false,
  });
  const expired = me.isError && isSignedOut(me.error);
  const signIn = async () => {
    const teams = await loadTeams();
    if (!teams) {
      setFailed(true);
      return;
    }
    const ok = await teamsSignIn(teams, clientId);
    setSignedIn(ok);
    setFailed(!ok);
  };
  return (
    <PaneFrame title={title}>
      {!signedIn || expired ? (
        <SignInPrompt failed={failed} onSignIn={() => void signIn()} />
      ) : me.data ? (
        children(client)
      ) : me.isError ? (
        <Notice tone="error">{t(errorKey(me.error))}</Notice>
      ) : (
        <Skeleton className="h-24 rounded-lg" />
      )}
    </PaneFrame>
  );
}

/** `/teams/save?draft=&client=`: the message action's dialog. */
export function TeamsSavePage({ clientId, draftId }: { clientId: string; draftId: string }) {
  const { t } = useI18n();
  return (
    <TeamsSignedIn clientId={clientId} title={t('microsoft.teamsPages.saveTitle')}>
      {(client) => <TeamsDraftForm client={client} draftId={draftId} />}
    </TeamsSignedIn>
  );
}

function TeamsDraftForm({
  client,
  draftId,
}: {
  client: ReturnType<typeof officeApi>;
  draftId: string;
}) {
  const { t } = useI18n();
  const draft = useQuery({
    queryKey: ['teams', 'draft', draftId],
    queryFn: () => client.call('getTeamsDraft', { params: { draftId } }),
    retry: false,
  });
  if (draft.isError) return <Notice tone="error">{t('microsoft.teamsPages.draftGone')}</Notice>;
  if (!draft.data) return <Skeleton className="h-24 rounded-lg" />;
  const d = draft.data;
  return (
    <div className="flex flex-col gap-2">
      {d.from ? (
        <span className="text-cap text-fg2">
          {t('microsoft.teamsPages.from', { name: d.from })}
        </span>
      ) : null}
      <blockquote className="m-0 max-h-32 overflow-auto rounded-lg bg-bg2 px-3 py-2 text-cap whitespace-pre-wrap">
        {d.text}
      </blockquote>
      <SaveForm
        client={client}
        item={{
          source: 'teams',
          title: d.title,
          from: d.from ? { name: d.from, email: null } : null,
          sentAt: d.sentAt,
          text: d.text,
          link: d.link,
        }}
        onSaved={() => {
          // Close the dialog in Teams; elsewhere the saved notice stays.
          void loadTeams().then((teams) => teams?.dialog.url.submit());
        }}
      />
    </div>
  );
}

/** `/teams/tab/config?client=`: pick the page or board this tab shows. */
export function TeamsTabConfigPage({ clientId }: { clientId: string }) {
  const { t } = useI18n();
  return (
    <TeamsSignedIn clientId={clientId} title={t('microsoft.teamsPages.tabTitle')}>
      {(client) => <TabPicker client={client} clientId={clientId} />}
    </TeamsSignedIn>
  );
}

function TabPicker({
  client,
  clientId,
}: {
  client: ReturnType<typeof officeApi>;
  clientId: string;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<'page' | 'board'>('page');
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const results = useQuery({
    queryKey: ['teams', 'search', kind, q],
    queryFn: () => client.call('searchNodes', { query: { q, type: kind, limit: 20 } as never }),
    enabled: q.trim().length >= 2,
  });
  useEffect(() => {
    void loadTeams().then((teams) => {
      if (!teams) return;
      teams.pages.config.registerOnSaveHandler((event) => {
        if (!chosen) return event.notifyFailure('nothing chosen');
        const origin = window.location.origin;
        const webPath = kind === 'page' ? `/p/${chosen.id}` : `/b/${chosen.id}`;
        void teams.pages.config
          .setConfig({
            entityId: `${kind}:${chosen.id}`,
            suggestedDisplayName: chosen.name,
            contentUrl: `${origin}/teams/tab?client=${encodeURIComponent(clientId)}&kind=${kind}&id=${chosen.id}`,
            websiteUrl: `${origin}${webPath}`,
          })
          .then(() => event.notifySuccess());
      });
      teams.pages.config.setValidityState(chosen !== null);
    });
  }, [chosen, kind, clientId]);
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={kind}
        onValueChange={(v) => {
          setKind(v);
          setChosen(null);
        }}
        aria-label={t('microsoft.teamsPages.tabTitle')}
        options={[
          { value: 'page', label: t('microsoft.teamsPages.tabPage') },
          { value: 'board', label: t('microsoft.teamsPages.tabBoard') },
        ]}
      />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('microsoft.teamsPages.tabSearch')}
        aria-label={t('microsoft.teamsPages.tabSearch')}
      />
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {(results.data?.items ?? []).map((hit) => (
          <li key={hit.node.id}>
            <Button
              variant={chosen?.id === hit.node.id ? 'inv' : 'gh'}
              className="w-full justify-start"
              onClick={() => setChosen({ id: hit.node.id, name: hit.node.name })}
            >
              {hit.node.name} · {hit.space.name}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `/teams/tab?client=&kind=&id=`: a read view of the page or board, with a link to Crewhall. */
export function TeamsTabPage({
  clientId,
  kind,
  id,
}: {
  clientId: string;
  kind: 'page' | 'board';
  id: string;
}) {
  const { t } = useI18n();
  return (
    <TeamsSignedIn clientId={clientId} title={t('microsoft.teamsPages.tabTitle')}>
      {(client) =>
        kind === 'page' ? (
          <PageView client={client} id={id} />
        ) : (
          <BoardView client={client} id={id} />
        )
      }
    </TeamsSignedIn>
  );
}

function OpenLink({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <Button asChild variant="out" size="sm" className="self-start">
      <a href={path} target="_blank" rel="noreferrer">
        {t('microsoft.teamsPages.tabOpen')}
      </a>
    </Button>
  );
}

function PageView({ client, id }: { client: ReturnType<typeof officeApi>; id: string }) {
  const { t } = useI18n();
  const page = useQuery({
    queryKey: ['teams', 'page', id],
    queryFn: () => client.call('exportPage', { params: { nodeId: id }, query: {} as never }),
  });
  if (page.isError) return <Notice tone="error">{t('microsoft.teamsPages.tabEmpty')}</Notice>;
  if (!page.data) return <Skeleton className="h-40 rounded-lg" />;
  const first = page.data.files[0];
  return (
    <div className="flex flex-col gap-3">
      <OpenLink path={`/p/${id}`} />
      <pre className="m-0 rounded-lg bg-surface p-3 text-cap whitespace-pre-wrap shadow-line">
        {first?.markdown ?? ''}
      </pre>
    </div>
  );
}

function BoardView({ client, id }: { client: ReturnType<typeof officeApi>; id: string }) {
  const { t } = useI18n();
  const board = useQuery({
    queryKey: ['teams', 'board', id],
    queryFn: () => client.call('getBoard', { params: { boardId: id } }),
  });
  if (board.isError) return <Notice tone="error">{t('microsoft.teamsPages.tabEmpty')}</Notice>;
  if (!board.data) return <Skeleton className="h-40 rounded-lg" />;
  const b = board.data;
  return (
    <div className="flex flex-col gap-3">
      <OpenLink path={`/b/${id}`} />
      <div className="flex gap-3 overflow-x-auto pb-2">
        {b.columns.map((col) => (
          <section
            key={col.id}
            aria-label={col.name}
            className="flex w-60 shrink-0 flex-col gap-2 rounded-xl bg-bg2 p-2"
          >
            <h2 className="m-0 px-1 text-cap font-semibold">{col.name}</h2>
            {b.cards
              .filter((c) => c.columnId === col.id)
              .map((c) => (
                <a
                  key={c.id}
                  href={`/b/${id}/${c.number}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg bg-surface p-2 text-cap text-fg no-underline shadow-line"
                >
                  {c.title}
                </a>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
