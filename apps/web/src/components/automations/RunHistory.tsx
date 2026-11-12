import { type AutomationRun, type AutomationRunStatus } from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  EmptyState,
  Icon,
  SelectAllCheckbox,
  Skeleton,
  Tag,
  type IconName,
} from '@crewhall/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AllPagesNote, SelectionBar, SelectionButton } from '@/components/common/SelectionBar';
import { kindName, runsQuery } from '@/lib/automations/api';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { useSelection, useSelectionKeys, type Selection } from '@/lib/selection';

const STATUS: Record<AutomationRunStatus, { key: MessageKey; icon: IconName; cls: string }> = {
  queued: { key: 'automations.status.queued', icon: 'clock', cls: 'text-fg2' },
  running: { key: 'automations.status.running', icon: 'refresh', cls: 'text-fg2' },
  succeeded: { key: 'automations.status.succeeded', icon: 'checkC', cls: 'text-success' },
  failed: { key: 'automations.status.failed', icon: 'alert', cls: 'text-danger' },
  skipped: { key: 'automations.status.skipped', icon: 'minus', cls: 'text-fg3' },
};

export function StatusLabel({ status }: { status: AutomationRunStatus }) {
  const { t } = useI18n();
  const s = STATUS[status];
  return (
    <span className={cn('flex items-center gap-1.5 text-sm font-semibold', s.cls)}>
      <Icon name={s.icon} size={15} />
      {t(s.key)}
    </span>
  );
}

/** The selected runs as a JSON file, for a support ticket or a look elsewhere. */
function downloadRuns(runs: AutomationRun[], ruleId: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(runs, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `automation-${ruleId}-runs.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Run history of a rule: status, time, steps with their errors (roadmap 17). Runs are a log and
 * cannot be changed; the one bulk action is taking them away as a file.
 */
export function RunHistory({ ruleId }: { ruleId: string }) {
  const { t } = useI18n();
  const runs = useInfiniteQuery({ ...runsQuery(ruleId), refetchInterval: 5_000 });
  const rows = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const selection = useSelection(rows.map((r) => r.id));
  useSelectionKeys(selection);
  if (runs.isLoading) return <Skeleton className="h-40" />;
  if (rows.length === 0) {
    return (
      <EmptyState
        className="m-auto"
        icon="history"
        title={t('automations.runs.emptyTitle')}
        description={t('automations.runs.emptyBody')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-3 px-4 text-xs text-fg2">
        <SelectAllCheckbox
          state={selection.state}
          onChange={selection.setAll}
          label={t('ui.selectAll')}
        />
        {t('ui.selectAll')}
      </span>
      <AllPagesNote
        selection={selection}
        list={runs}
        idsOf={(pages) => pages.flatMap((p) => p.items.map((r) => r.id))}
      />
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <RunRow key={r.id} run={r} selection={selection} />
        ))}
      </ul>
      {runs.hasNextPage ? (
        <Button
          variant="out"
          size="sm"
          className="self-center"
          loading={runs.isFetchingNextPage}
          onClick={() => void runs.fetchNextPage()}
        >
          {t('automations.runs.more')}
        </Button>
      ) : null}
      {selection.count ? (
        <SelectionBar
          label={t('ui.selectionActions')}
          count={t('ui.selectedCount', { count: selection.count })}
          clearLabel={t('ui.clearSelection')}
          onClear={selection.clear}
        >
          <SelectionButton
            icon="download"
            label={t('automations.runs.download')}
            onClick={() =>
              downloadRuns(
                rows.filter((r) => selection.has(r.id)),
                ruleId,
              )
            }
          />
        </SelectionBar>
      ) : null}
    </div>
  );
}

function RunRow({ run, selection }: { run: AutomationRun; selection: Selection }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(run.status === 'failed');
  const ms =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;
  return (
    <li className="rounded-xl bg-surface shadow-[0_0_0_1px_var(--line)]">
      <div className="flex items-center gap-3 pl-4">
        <Checkbox
          checked={selection.has(run.id)}
          onCheckedChange={() => selection.toggle(run.id)}
          aria-label={t('automations.runs.select', {
            date: `${formatDate(run.createdAt, locale)} ${formatTime(run.createdAt, locale)}`,
          })}
        />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 py-3 pr-4 text-left"
        >
          <StatusLabel status={run.status} />
          <span className="text-sm text-fg2">
            {formatDate(run.createdAt, locale)} {formatTime(run.createdAt, locale)}
          </span>
          {run.test ? <Tag>{t('automations.runs.test')}</Tag> : null}
          {ms !== null ? (
            <span className="text-xs text-fg3">{t('automations.runs.ms', { count: ms })}</span>
          ) : null}
          <Icon name={open ? 'chevU' : 'chevD'} size={15} className="ml-auto text-fg3" />
        </button>
      </div>
      {open ? (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
          {run.error && run.steps.length === 0 ? (
            <p className="text-sm text-danger">
              {t(`automations.runErrors.${run.error}` as MessageKey)}
            </p>
          ) : null}
          {run.steps.map((s) => (
            <div key={s.actionId} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm">
                <StatusLabel status={s.status} />
                <span className="text-fg">{kindName(locale, 'actions', s.type)}</span>
              </span>
              {s.error ? (
                <span className="text-xs text-danger">
                  {t(`errors.${s.error.code}` as MessageKey)}
                  {s.error.message && s.error.message !== s.error.code
                    ? ` · ${s.error.message}`
                    : ''}
                </span>
              ) : null}
            </div>
          ))}
          <details className="text-xs text-fg2">
            <summary className="cursor-pointer select-none">{t('automations.runs.event')}</summary>
            <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-bg2 p-2 font-mono text-[11.5px] whitespace-pre-wrap">
              {JSON.stringify(run.event, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
    </li>
  );
}
