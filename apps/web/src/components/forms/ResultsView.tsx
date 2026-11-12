import {
  answerText,
  ratingScale,
  type Form,
  type FormField,
  type FormFieldStats,
  type FormFile,
  type FormResponse,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  Checkbox,
  cn,
  EmptyState,
  Icon,
  IconButton,
  SelectAllCheckbox,
  Segmented,
  Skeleton,
  Table,
  Td,
  Th,
  toast,
  Tr,
} from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AllPagesNote, SelectionBar, SelectionButton } from '@/components/common/SelectionBar';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { csvUrl, formKeys, responsesQuery, statsQuery } from '@/lib/forms/api';
import { fieldIcon } from '@/lib/forms/fields';
import { formatDate, formatNumber, formatPercent, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { ConfirmDialog } from './parts';

type View = 'summary' | 'table';

/**
 * Results of a form (roadmap 16): a summary per field (bars for choices and ratings, figures
 * for numbers, latest texts) and the answer table, with CSV download.
 */
export function ResultsView({ form, canDelete }: { form: Form; canDelete: boolean }) {
  const { t } = useI18n();
  const [view, setView] = useState<View>('summary');
  const stats = useQuery(statsQuery(form.id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          aria-label={t('forms.results.view')}
          value={view}
          onValueChange={setView}
          options={[
            { value: 'summary', label: t('forms.results.summary'), icon: 'activity' },
            { value: 'table', label: t('forms.results.table'), icon: 'table' },
          ]}
        />
        <span className="text-sm text-fg2">
          {t('forms.results.total', { count: stats.data?.total ?? form.responseCount })}
        </span>
        <Button asChild variant="out" size="sm" className="ml-auto">
          <a href={csvUrl(form.id)} download>
            <Icon name="download" size={15} />
            {t('forms.results.csv')}
          </a>
        </Button>
      </div>
      {view === 'summary' ? (
        stats.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : !stats.data || stats.data.total === 0 ? (
          <EmptyState
            className="m-auto"
            icon="inbox"
            title={t('forms.results.emptyTitle')}
            description={t('forms.results.emptyBody')}
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <DailyCard daily={stats.data.daily} />
            {form.fields.map((f) => {
              const s = stats.data!.fields.find((x) => x.fieldId === f.id);
              return s ? <FieldSummary key={f.id} field={f} stats={s} formId={form.id} /> : null;
            })}
          </div>
        )
      ) : (
        <ResponsesTable form={form} canDelete={canDelete} />
      )}
    </div>
  );
}

function Card({
  field,
  answered,
  children,
}: {
  field?: FormField;
  answered?: number;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)]">
      {field ? (
        <header className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg2">
            <Icon name={fieldIcon(field.type)} size={16} />
          </span>
          <span className="flex min-w-0 flex-col">
            <h3 className="text-sm font-semibold break-words text-fg">{field.label}</h3>
            <span className="text-xs text-fg3">
              {t('forms.results.answered', { count: answered ?? 0 })}
            </span>
          </span>
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Horizontal bars: one hue, value and share labelled in text ink (dataviz: single series). */
function Bars({
  rows,
  total,
}: {
  rows: { key: string; label: string; count: number }[];
  total: number;
}) {
  const { locale } = useI18n();
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li
          key={r.key}
          className="group flex flex-col gap-1"
          title={`${r.label}: ${r.count} (${formatPercent(total ? (r.count / total) * 100 : 0, locale)})`}
        >
          <span className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-fg">{r.label}</span>
            <span className="shrink-0 text-xs text-fg2 tabular-nums">
              {r.count} · {formatPercent(total ? (r.count / total) * 100 : 0, locale)}
            </span>
          </span>
          <span className="h-2.5 w-full rounded-[4px] bg-bg2">
            <span
              className="block h-full rounded-[4px] bg-accent transition-[width] group-hover:brightness-95"
              style={{ width: `${(r.count / max) * 100}%`, minWidth: r.count ? 4 : 0 }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The last 30 days (UTC) with empty days filled in, oldest first. */
function lastDays(daily: { date: string; count: number }[], days = 30) {
  const by = new Map(daily.map((d) => [d.date, d.count]));
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date, count: by.get(date) ?? 0 };
  });
}

function DailyCard({ daily: raw }: { daily: { date: string; count: number }[] }) {
  const { t, locale } = useI18n();
  const daily = lastDays(raw);
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] md:col-span-2">
      <h3 className="text-sm font-semibold">{t('forms.results.daily')}</h3>
      <div
        className="flex h-24 items-end gap-[2px]"
        role="img"
        aria-label={t('forms.results.daily')}
      >
        {daily.map((d) => (
          <span
            key={d.date}
            className={cn(
              'min-w-[4px] flex-1 rounded-t-[4px] hover:brightness-95',
              d.count ? 'bg-accent' : 'bg-bg2',
            )}
            style={{ height: d.count ? `${Math.max(8, (d.count / max) * 100)}%` : '4px' }}
            title={`${formatDate(`${d.date}T12:00:00Z`, locale)}: ${d.count}`}
          />
        ))}
      </div>
      {daily.length ? (
        <span className="flex justify-between text-xs text-fg3">
          <span>{formatDate(`${daily[0]!.date}T12:00:00Z`, locale)}</span>
          <span>{formatDate(`${daily.at(-1)!.date}T12:00:00Z`, locale)}</span>
        </span>
      ) : null}
    </section>
  );
}

function FieldSummary({
  field,
  stats,
  formId,
}: {
  field: FormField;
  stats: FormFieldStats;
  formId: string;
}) {
  const { t, locale } = useI18n();
  if (field.type === 'single_choice' || field.type === 'multi_choice') {
    return (
      <Card field={field} answered={stats.answered}>
        <Bars
          total={stats.answered}
          rows={field.choices.map((c) => ({
            key: c.id,
            label: c.label,
            count: stats.counts[c.id] ?? 0,
          }))}
        />
      </Card>
    );
  }
  if (field.type === 'rating') {
    const scale = ratingScale(field);
    return (
      <Card field={field} answered={stats.answered}>
        {stats.average !== null ? (
          <p className="flex items-baseline gap-1.5">
            <span className="text-title font-bold tabular-nums">
              {formatNumber(stats.average, locale, 1)}
            </span>
            <span className="text-sm text-fg2">/ {scale}</span>
          </p>
        ) : null}
        <Bars
          total={stats.answered}
          rows={Array.from({ length: scale }, (_, i) => String(scale - i)).map((v) => ({
            key: v,
            label: t('forms.results.stars', { n: Number(v) }),
            count: stats.counts[v] ?? 0,
          }))}
        />
      </Card>
    );
  }
  if (field.type === 'number') {
    return (
      <Card field={field} answered={stats.answered}>
        <dl className="grid grid-cols-3 gap-2">
          {(
            [
              ['average', stats.average],
              ['min', stats.min],
              ['max', stats.max],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex flex-col rounded-lg bg-bg2 p-3">
              <dt className="text-xs text-fg2">{t(`forms.results.${k}`)}</dt>
              <dd className="text-sub font-bold tabular-nums">
                {v === null ? '—' : formatNumber(v, locale, 2)}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }
  return (
    <Card field={field} answered={stats.answered}>
      <LatestAnswers field={field} formId={formId} />
    </Card>
  );
}

/** Text, date and file fields: the latest few answers (the table has them all). */
function LatestAnswers({ field, formId }: { field: FormField; formId: string }) {
  const { t } = useI18n();
  const list = useInfiniteQuery(responsesQuery(formId));
  if (list.isLoading) return <Skeleton className="h-20" />;
  const rows = (list.data?.pages[0]?.items ?? [])
    .map((r) => ({ id: r.id, text: answerText(field, r.answers[field.id]) }))
    .filter((r) => r.text)
    .slice(0, 5);
  if (rows.length === 0) return <p className="text-sm text-fg3">{t('forms.results.noAnswers')}</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => (
        <li
          key={r.id}
          className="line-clamp-2 rounded-lg bg-bg2 px-3 py-2 text-sm break-words text-fg"
        >
          {r.text}
        </li>
      ))}
    </ul>
  );
}

function ResponsesTable({ form, canDelete }: { form: Form; canDelete: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const list = useInfiniteQuery(responsesQuery(form.id));
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const stats = useQuery(statsQuery(form.id));
  const selection = useSelection(rows.map((r) => r.id));
  useSelectionKeys(selection, canDelete);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const remove = useMutation({
    // One call per answer: there is no bulk endpoint and a form rarely has thousands to clear.
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api.call('deleteFormResponse', { params: { responseId: id } });
      }
    },
    onSuccess: (_d, ids) => {
      toast(
        t(ids.length > 1 ? 'forms.results.deletedMany' : 'forms.results.deleted', {
          count: ids.length,
        }),
      );
    },
    onError: (e) => toast(t(errorKey(e))),
    onSettled: () => {
      setDeleting(null);
      selection.clear();
      void qc.invalidateQueries({ queryKey: formKeys.responses(form.id) });
      void qc.invalidateQueries({ queryKey: formKeys.stats(form.id) });
    },
  });

  if (list.isLoading) return <Skeleton className="h-48" />;
  if (rows.length === 0) {
    return (
      <EmptyState
        className="m-auto"
        icon="inbox"
        title={t('forms.results.emptyTitle')}
        description={t('forms.results.emptyBody')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {canDelete ? (
        <AllPagesNote
          selection={selection}
          list={list}
          idsOf={(pages) => pages.flatMap((p) => p.items.map((r) => r.id))}
          total={stats.data?.total}
        />
      ) : null}
      <div className="overflow-x-auto rounded-2xl bg-surface shadow-[0_0_0_1px_var(--line)]">
        <Table className="min-w-[640px]">
          <thead>
            <Tr>
              {canDelete ? (
                <Th className="w-9">
                  <SelectAllCheckbox
                    state={selection.state}
                    onChange={selection.setAll}
                    label={t('ui.selectAll')}
                  />
                </Th>
              ) : null}
              <Th>{t('forms.results.submittedAt')}</Th>
              <Th>{t('forms.results.respondent')}</Th>
              {form.fields.map((f) => (
                <Th key={f.id} className="max-w-[240px] truncate">
                  {f.label}
                </Th>
              ))}
              {canDelete ? <Th className="w-10" aria-label={t('forms.results.actions')} /> : null}
            </Tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id} selected={selection.has(r.id)}>
                {canDelete ? (
                  <Td>
                    <Checkbox
                      checked={selection.has(r.id)}
                      onCheckedChange={() => selection.toggle(r.id)}
                      aria-label={t('forms.results.select', {
                        date: `${formatDate(r.submittedAt, locale)} ${formatTime(r.submittedAt, locale)}`,
                      })}
                    />
                  </Td>
                ) : null}
                <Td className="whitespace-nowrap text-fg2">
                  {formatDate(r.submittedAt, locale)} {formatTime(r.submittedAt, locale)}
                </Td>
                <Td>
                  <Respondent r={r} />
                </Td>
                {form.fields.map((f) => (
                  <Td key={f.id} className="max-w-[280px] align-top">
                    <AnswerCell field={f} r={r} />
                  </Td>
                ))}
                {canDelete ? (
                  <Td>
                    <IconButton
                      size="sm"
                      tone="plain"
                      aria-label={t('forms.results.delete')}
                      onClick={() => setDeleting([r.id])}
                    >
                      <Icon name="trash" size={15} />
                    </IconButton>
                  </Td>
                ) : null}
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('forms.results.deleteTitle', { count: deleting?.length ?? 1 })}
        body={t('forms.results.deleteBody', { count: deleting?.length ?? 1 })}
        confirm={t('forms.results.delete')}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
      {selection.count ? (
        <SelectionBar
          label={t('ui.selectionActions')}
          count={t('ui.selectedCount', { count: selection.count })}
          clearLabel={t('ui.clearSelection')}
          onClear={selection.clear}
        >
          <SelectionButton
            icon="trash"
            label={t('forms.results.delete')}
            onClick={() => setDeleting([...selection.selected])}
          />
        </SelectionBar>
      ) : null}
      {list.hasNextPage ? (
        <Button
          variant="out"
          size="sm"
          className="self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('forms.results.more')}
        </Button>
      ) : null}
    </div>
  );
}

function Respondent({ r }: { r: FormResponse }) {
  const { t } = useI18n();
  if (!r.respondent) return <span className="text-fg3">{t('forms.results.anonymous')}</span>;
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <Avatar name={r.respondent.name} src={r.respondent.imageUrl} size="sm" />
      {r.respondent.name}
    </span>
  );
}

function AnswerCell({ field, r }: { field: FormField; r: FormResponse }) {
  const { t } = useI18n();
  const v = r.answers[field.id];
  if (field.type === 'file' && Array.isArray(v)) {
    return (
      <span className="flex flex-col gap-1">
        {(v as FormFile[]).map((f) => (
          <button
            key={f.fileId}
            type="button"
            className="flex items-center gap-1 text-left text-sm font-medium text-fg underline-offset-2 hover:underline"
            onClick={async () => {
              try {
                const { url } = await api.call('getFormFileUrl', { params: { fileId: f.fileId } });
                window.location.assign(url);
              } catch (e) {
                toast(t(errorKey(e)));
              }
            }}
          >
            <Icon name="download" size={13} />
            <span className="truncate">{f.name}</span>
          </button>
        ))}
      </span>
    );
  }
  const text = answerText(field, v);
  return text ? (
    <span className="line-clamp-3 break-words" title={text}>
      {text}
    </span>
  ) : (
    <span className="text-fg3">—</span>
  );
}
