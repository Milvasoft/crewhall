import { AUTOMATION_LIMITS, type AutomationRule, type Space } from '@crewhall/shared';
import {
  Button,
  cn,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Skeleton,
  Switch,
  Tag,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { ConfirmDialog, RenameInput } from '@/components/forms/parts';
import { Workspace } from '@/components/shell/Workspace';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import {
  automationKeys,
  catalogQuery,
  kindName,
  ruleQuery,
  rulesQuery,
  setRuleCache,
} from '@/lib/automations/api';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { draftReady, RuleEditor, type RuleDraft } from './RuleEditor';
import { RuleContextMenu, RUNS_HASH, useRenameRule } from './RuleMenu';
import { RunHistory, StatusLabel } from './RunHistory';

/** Right click on a list's empty area: "new rule" for those who manage automations. */
function NewRuleArea({
  space,
  canManage,
  children,
}: {
  space: Space | undefined;
  canManage: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (!space || !canManage) return <>{children}</>;
  return (
    <ActionContextMenu
      entries={[
        {
          kind: 'item',
          key: 'new',
          icon: 'plus',
          label: t('automations.nav.new'),
          onSelect: () =>
            void navigate({ to: '/automations/$spaceSlug/new', params: { spaceSlug: space.slug } }),
        },
      ]}
    >
      {children}
    </ActionContextMenu>
  );
}

function AutomationsSidebar({
  space,
  activeRuleId,
}: {
  space: Space | undefined;
  activeRuleId?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const canView = space ? canSpace('automations.view', space.myRole) : false;
  const rules = useQuery({ ...rulesQuery(space?.id ?? ''), enabled: Boolean(space) && canView });
  const canManage = space ? canSpace('automations.manage', space.myRole) : false;
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useRenameRule();
  return (
    <SpaceSidebar
      space={space}
      onSelect={(s) =>
        void navigate({ to: '/automations/$spaceSlug', params: { spaceSlug: s.slug } })
      }
    >
      <NewRuleArea space={space} canManage={canManage}>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
          <span className="eyebrow mt-1 mb-1 px-2.5">{t('automations.nav.rules')}</span>
          {space &&
            rules.data?.items.map((r) =>
              renaming === r.id ? (
                <RenameInput
                  key={r.id}
                  value={r.name}
                  label={t('automations.editor.name')}
                  maxLength={AUTOMATION_LIMITS.nameChars}
                  containerClassName="h-[var(--nv-h)] px-2.5 text-[13.5px]"
                  onCommit={(name) => {
                    setRenaming(null);
                    rename.mutate({ rule: r, name });
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <RuleContextMenu
                  key={r.id}
                  rule={r}
                  canManage={canManage}
                  spaceSlug={space.slug}
                  onRename={canManage ? () => setRenaming(r.id) : undefined}
                >
                  <Link
                    to="/automations/rule/$ruleId"
                    params={{ ruleId: r.id }}
                    className={cn(
                      'flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
                      r.id === activeRuleId && 'bg-bg2 font-semibold text-fg',
                    )}
                  >
                    <Icon name="zap" size={16} className={r.enabled ? 'text-fg' : 'text-fg3'} />
                    <span
                      className="min-w-0 flex-1 truncate"
                      // Double-click on the name renames (space admins).
                      onDoubleClick={canManage ? () => setRenaming(r.id) : undefined}
                    >
                      {r.name}
                    </span>
                  </Link>
                </RuleContextMenu>
              ),
            )}
          {rules.data && rules.data.items.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-fg3">{t('automations.nav.none')}</p>
          ) : null}
          {space && canManage ? (
            <Link
              to="/automations/$spaceSlug/new"
              params={{ spaceSlug: space.slug }}
              className="mt-3 flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
            >
              <Icon name="plus" size={16} />
              {t('automations.nav.new')}
            </Link>
          ) : null}
        </div>
      </NewRuleArea>
    </SpaceSidebar>
  );
}

/** Rules of a space (roadmap 17). */
export function AutomationsHome({ space }: { space: Space }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { canSpace } = usePermissions();
  const canView = canSpace('automations.view', space.myRole);
  const canManage = canSpace('automations.manage', space.myRole);
  const rules = useQuery({ ...rulesQuery(space.id), enabled: canView });
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useRenameRule();
  const toggle = useMutation({
    mutationFn: (r: AutomationRule) =>
      api.call('updateAutomationRule', { params: { ruleId: r.id }, body: { enabled: !r.enabled } }),
    onSuccess: (r) => setRuleCache(qc, r),
    onError: (e) => toast(t(errorKey(e))),
  });
  const newButton = canManage ? (
    <Button asChild size="sm" variant="inv">
      <Link to="/automations/$spaceSlug/new" params={{ spaceSlug: space.slug }}>
        <Icon name="plus" size={16} />
        {t('automations.nav.new')}
      </Link>
    </Button>
  ) : null;

  return (
    <Workspace
      sidebar={<AutomationsSidebar space={space} />}
      crumbs={[{ label: spaceName(space, t) }, { label: t('automations.title') }]}
      tools={newButton}
    >
      <NewRuleArea space={space} canManage={canManage}>
        <section className="flex flex-1 flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-title font-bold">
              {t('automations.home.title', { space: spaceName(space, t) })}
            </h1>
            <p className="text-sm text-fg2">{t('automations.home.intro')}</p>
          </div>
          {!canView ? (
            <EmptyState
              className="m-auto"
              icon="lock"
              title={t('automations.home.noAccess')}
              description={t('automations.home.noAccessBody')}
            />
          ) : rules.isLoading ? (
            <Skeleton className="h-32" />
          ) : rules.data?.items.length ? (
            <ul className="flex flex-col gap-2">
              {rules.data.items.map((r) => (
                <RuleContextMenu
                  key={r.id}
                  rule={r}
                  canManage={canManage}
                  spaceSlug={space.slug}
                  onRename={canManage ? () => setRenaming(r.id) : undefined}
                >
                  <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)]">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg2">
                      <Icon name="zap" size={18} />
                    </span>
                    {renaming === r.id ? (
                      <div className="min-w-0 flex-1">
                        <RenameInput
                          value={r.name}
                          label={t('automations.editor.name')}
                          maxLength={AUTOMATION_LIMITS.nameChars}
                          onCommit={(name) => {
                            setRenaming(null);
                            rename.mutate({ rule: r, name });
                          }}
                          onCancel={() => setRenaming(null)}
                        />
                      </div>
                    ) : (
                      <Link
                        to="/automations/rule/$ruleId"
                        params={{ ruleId: r.id }}
                        className="flex min-w-0 flex-1 flex-col hover:underline"
                      >
                        <span className="truncate text-sub font-semibold text-fg">{r.name}</span>
                        <span className="truncate text-xs text-fg2">
                          {kindName(locale, 'triggers', r.trigger.type)} →{' '}
                          {r.actions.map((a) => kindName(locale, 'actions', a.type)).join(', ')}
                        </span>
                      </Link>
                    )}
                    {r.disabledReason ? (
                      <Tag className="bg-danger text-white">{t('automations.home.stopped')}</Tag>
                    ) : null}
                    {r.lastStatus ? (
                      <span className="flex flex-col items-end gap-0.5">
                        <StatusLabel status={r.lastStatus} />
                        {r.lastRunAt ? (
                          <span className="text-xs text-fg3">
                            {formatRelative(r.lastRunAt, locale)}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-xs text-fg3">{t('automations.home.neverRan')}</span>
                    )}
                    <Switch
                      checked={r.enabled}
                      disabled={!canManage || toggle.isPending}
                      onCheckedChange={() => toggle.mutate(r)}
                      aria-label={t('automations.home.toggle', { name: r.name })}
                    />
                  </li>
                </RuleContextMenu>
              ))}
            </ul>
          ) : (
            <EmptyState
              className="m-auto"
              icon="zap"
              title={t('automations.home.empty')}
              description={t('automations.home.emptyBody')}
            >
              {newButton}
            </EmptyState>
          )}
        </section>
      </NewRuleArea>
    </Workspace>
  );
}

const emptyDraft = (name: string): RuleDraft => ({
  name,
  enabled: true,
  trigger: { type: '', config: {} },
  conditions: [],
  actions: [],
});

/** New rule (`/automations/<space>/new`). */
export function NewRulePage({ space }: { space: Space }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useQuery(catalogQuery);
  const [draft, setDraft] = useState<RuleDraft>(() => emptyDraft(t('automations.untitled')));
  const create = useMutation({
    mutationFn: () =>
      api.call('createAutomationRule', { params: { spaceId: space.id }, body: draft }),
    onSuccess: (rule) => {
      setRuleCache(qc, rule);
      toast(t('automations.editor.created'));
      void navigate({ to: '/automations/rule/$ruleId', params: { ruleId: rule.id } });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <Workspace
      sidebar={<AutomationsSidebar space={space} />}
      crumbs={[
        { label: spaceName(space, t) },
        { label: t('automations.title') },
        { label: t('automations.nav.new') },
      ]}
      tools={
        <Button
          size="sm"
          variant="pri"
          loading={create.isPending}
          disabled={!draftReady(draft, catalog.data)}
          onClick={() => create.mutate()}
        >
          {t('automations.editor.create')}
        </Button>
      }
    >
      {catalog.data ? (
        <div className="mx-auto w-full max-w-[860px]">
          <RuleEditor draft={draft} onChange={setDraft} catalog={catalog.data} spaceId={space.id} />
        </div>
      ) : (
        <Skeleton className="h-64" />
      )}
    </Workspace>
  );
}

const draftOf = (r: AutomationRule): RuleDraft => ({
  name: r.name,
  enabled: r.enabled,
  trigger: r.trigger,
  conditions: r.conditions,
  actions: r.actions,
});

/** A rule: editor, webhook details and run history (`/automations/rule/<id>`). */
export function RulePage({ ruleId }: { ruleId: string }) {
  const { t } = useI18n();
  const rule = useQuery(ruleQuery(ruleId));
  const { items } = useSpaces();
  const space = items.find((s) => s.id === rule.data?.spaceId);
  return (
    <Workspace
      sidebar={<AutomationsSidebar space={space} activeRuleId={ruleId} />}
      crumbs={[
        ...(space ? [{ label: spaceName(space, t) }] : []),
        {
          label: space ? (
            <Link
              to="/automations/$spaceSlug"
              params={{ spaceSlug: space.slug }}
              className="hover:underline"
            >
              {t('automations.title')}
            </Link>
          ) : (
            t('automations.title')
          ),
        },
        ...(rule.data ? [{ label: rule.data.name }] : []),
      ]}
    >
      {rule.isLoading ? (
        <Skeleton className="h-64" />
      ) : rule.data && space ? (
        <RuleBody key={rule.data.id} rule={rule.data} space={space} />
      ) : (
        <EmptyState
          className="m-auto"
          icon="zap"
          title={t('automations.notFound.title')}
          description={t('automations.notFound.body')}
        />
      )}
    </Workspace>
  );
}

function RuleBody({ rule, space }: { rule: AutomationRule; space: Space }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const canManage = canSpace('automations.manage', space.myRole);
  const catalog = useQuery(catalogQuery);
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule));
  const [base, setBase] = useState<RuleDraft>(() => draftOf(rule));
  // The tab lives in the URL hash so the list's "Run history" opens on it (`#runs`).
  const hash = useRouterState({ select: (s) => s.location.hash });
  const tab: 'rule' | 'runs' = hash === RUNS_HASH ? 'runs' : 'rule';
  const setTab = (next: 'rule' | 'runs') =>
    void navigate({
      to: '/automations/rule/$ruleId',
      params: { ruleId: rule.id },
      hash: next === 'runs' ? RUNS_HASH : '',
      replace: true,
    });
  const [deleting, setDeleting] = useState(false);
  // Renamed, paused or resumed from a list menu: take it unless it is being edited here.
  const [seen, setSeen] = useState({ name: rule.name, enabled: rule.enabled });
  if (seen.name !== rule.name || seen.enabled !== rule.enabled) {
    setSeen({ name: rule.name, enabled: rule.enabled });
    setDraft({
      ...draft,
      ...(draft.name === base.name ? { name: rule.name } : {}),
      ...(draft.enabled === base.enabled ? { enabled: rule.enabled } : {}),
    });
    setBase({ ...base, name: rule.name, enabled: rule.enabled });
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  const save = useMutation({
    mutationFn: () =>
      api.call('updateAutomationRule', { params: { ruleId: rule.id }, body: draft }),
    onSuccess: (r) => {
      setRuleCache(qc, r);
      setBase(draftOf(r));
      setDraft(draftOf(r));
      toast(t('automations.editor.saved'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const test = useMutation({
    mutationFn: () => api.call('testAutomationRule', { params: { ruleId: rule.id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: automationKeys.runs(rule.id) });
      void qc.invalidateQueries({ queryKey: automationKeys.rule(rule.id) });
      setTab('runs');
      toast(t('automations.editor.testStarted'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const regenerate = useMutation({
    mutationFn: () => api.call('regenerateAutomationHook', { params: { ruleId: rule.id } }),
    onSuccess: (r) => setRuleCache(qc, r),
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteAutomationRule', { params: { ruleId: rule.id } }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: automationKeys.rule(rule.id) });
      void qc.invalidateQueries({ queryKey: automationKeys.list(rule.spaceId) });
      toast(t('automations.editor.deleted'));
      void navigate({ to: '/automations/$spaceSlug', params: { spaceSlug: space.slug } });
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 flex-1 text-title font-bold break-words">{rule.name}</h1>
        {canManage ? (
          <>
            <Button
              variant="out"
              size="sm"
              loading={test.isPending}
              disabled={dirty}
              onClick={() => test.mutate()}
            >
              <Icon name="play" size={15} />
              {t('automations.editor.test')}
            </Button>
            <Button
              variant="pri"
              size="sm"
              disabled={!dirty || !draftReady(draft, catalog.data)}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {dirty ? t('automations.editor.save') : t('automations.editor.savedState')}
            </Button>
            <IconButton
              size="sm"
              aria-label={t('automations.editor.delete')}
              onClick={() => setDeleting(true)}
            >
              <Icon name="trash" size={16} />
            </IconButton>
          </>
        ) : null}
      </div>
      {rule.disabledReason ? (
        <Notice icon="alert" tone="danger">
          {t('automations.editor.stoppedNotice', { count: rule.failureStreak })}
        </Notice>
      ) : null}
      <nav className="flex gap-1 border-b border-line" aria-label={t('automations.editor.tabs')}>
        {(
          [
            ['rule', t('automations.editor.tabRule')],
            ['runs', t('automations.editor.tabRuns', { count: rule.runCount })],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              '-mb-px h-10 border-b-2 px-3 text-sm font-semibold',
              tab === id ? 'border-fg text-fg' : 'border-transparent text-fg2 hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'rule' ? (
        <>
          {catalog.data ? (
            <RuleEditor
              draft={draft}
              onChange={setDraft}
              catalog={catalog.data}
              spaceId={space.id}
              readOnly={!canManage}
            />
          ) : (
            <Skeleton className="h-64" />
          )}
          {canManage ? (
            <Secrets
              rule={rule}
              onRegenerate={() => regenerate.mutate()}
              regenerating={regenerate.isPending}
            />
          ) : null}
        </>
      ) : (
        <RunHistory ruleId={rule.id} />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('automations.editor.deleteTitle', { name: rule.name })}
        body={t('automations.editor.deleteBody')}
        confirm={t('automations.editor.delete')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function Notice({ icon, tone, children }: { icon: 'alert'; tone: 'danger'; children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-xl px-4 py-3 text-sm',
        tone === 'danger' && 'bg-danger/10 text-danger',
      )}
    >
      <Icon name={icon} size={16} className="mt-0.5 shrink-0" />
      {children}
    </p>
  );
}

/** Incoming webhook URL and the outgoing signing secret, copyable. */
function Secrets({
  rule,
  onRegenerate,
  regenerating,
}: {
  rule: AutomationRule;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const { t } = useI18n();
  const hasOutgoing = rule.actions.some((a) => a.type === 'webhook.send');
  if (!rule.hookUrl && !hasOutgoing) return null;
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v);
    toast(t('automations.editor.copied'));
  };
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] md:p-5">
      <h2 className="flex items-center gap-2 text-sub font-semibold">
        <Icon name="plug" size={18} />
        {t('automations.editor.webhooks')}
      </h2>
      {rule.hookUrl ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-cap font-medium text-fg2">{t('automations.editor.hookUrl')}</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              value={rule.hookUrl}
              aria-label={t('automations.editor.hookUrl')}
              onFocus={(e) => e.target.select()}
            />
            <Button variant="out" onClick={() => copy(rule.hookUrl!)}>
              <Icon name="copy" size={16} />
              {t('automations.editor.copy')}
            </Button>
            <Button variant="gh" loading={regenerating} onClick={onRegenerate}>
              <Icon name="refresh" size={16} />
              {t('automations.editor.regenerate')}
            </Button>
          </div>
          <p className="text-xs text-fg3">{t('automations.editor.hookHint')}</p>
        </div>
      ) : null}
      {hasOutgoing && rule.signingSecret ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-cap font-medium text-fg2">
            {t('automations.editor.signingSecret')}
          </span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              type="password"
              value={rule.signingSecret}
              aria-label={t('automations.editor.signingSecret')}
            />
            <Button variant="out" onClick={() => copy(rule.signingSecret!)}>
              <Icon name="copy" size={16} />
              {t('automations.editor.copy')}
            </Button>
          </div>
          <p className="text-xs text-fg3">{t('automations.editor.signingHint')}</p>
        </div>
      ) : null}
    </section>
  );
}
