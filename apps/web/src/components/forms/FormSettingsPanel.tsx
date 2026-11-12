import { FORM_LIMITS, type Form, type FormSettings } from '@crewhall/shared';
import {
  Button,
  DatePicker,
  Field,
  Icon,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { nodesQuery } from '@/features/drive/api';
import { api } from '@/lib/api';
import { boardQuery, boardsQuery } from '@/lib/boards/api';
import { errorKey } from '@/lib/errors';
import { useModuleEnabled } from '@/lib/identity/modules';
import { useI18n } from '@/lib/i18n/I18nContext';
import { tableKeys, tablesQuery } from '@/lib/tables/api';

const ROOT = '__root__';

/**
 * Sharing and delivery of a form (roadmap 16): org or public link (copy, renew), anonymous,
 * one answer, closing date, confirmation text, owner notification, and where each answer
 * also lands (CSV table in Drive, a card on a board column, a row in a table).
 */
export function FormSettingsPanel({
  form,
  settings,
  onChange,
  canPublic,
  onRegenerate,
  regenerating,
}: {
  form: Form;
  settings: FormSettings;
  onChange: (s: FormSettings) => void;
  /** space.share_link for the viewer: public access may be chosen. */
  canPublic: boolean;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const { t } = useI18n();
  const boardsOn = useModuleEnabled('boards');
  const set = (patch: Partial<FormSettings>) => onChange({ ...settings, ...patch });
  const dest = settings.destinations;
  const setDest = (patch: Partial<FormSettings['destinations']>) =>
    set({ destinations: { ...dest, ...patch } });
  const folders = useQuery({
    ...nodesQuery(form.spaceId, null, { type: 'folder' }),
    enabled: dest.drive !== null,
  });
  const boards = useQuery({
    ...boardsQuery(form.spaceId),
    enabled: boardsOn && dest.board !== null,
  });
  const board = useQuery({
    ...boardQuery(dest.board?.boardId ?? ''),
    enabled: boardsOn && Boolean(dest.board?.boardId),
  });
  const tablesOn = useModuleEnabled('tables');
  const qc = useQueryClient();
  const tables = useQuery({
    ...tablesQuery(form.spaceId),
    enabled: tablesOn && dest.table !== null,
  });
  const newTable = useMutation({
    mutationFn: () => api.call('createFormTable', { params: { formId: form.id } }),
    onSuccess: (tb) => {
      void qc.invalidateQueries({ queryKey: tableKeys.list(form.spaceId) });
      setDest({ table: { tableId: tb.id } });
      toast(t('forms.deliver.tableCreated'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const closes = settings.closesAt ? settings.closesAt.slice(0, 10) : null;
  // The saved form knows its link; a new public setting shows it after saving.
  const link = settings.access === 'public' ? form.publicUrl : null;

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
      <Section icon="share" title={t('forms.share.title')}>
        <Segmented
          aria-label={t('forms.share.access')}
          value={settings.access}
          onValueChange={(v) => set({ access: v })}
          options={[
            { value: 'org', label: t('forms.share.org'), icon: 'users' },
            {
              value: 'public',
              label: t('forms.share.public'),
              icon: 'globe',
              disabled: !canPublic && settings.access !== 'public',
            },
          ]}
        />
        <p className="text-sm text-fg2">
          {settings.access === 'public' ? t('forms.share.publicHint') : t('forms.share.orgHint')}
        </p>
        {!canPublic && settings.access !== 'public' ? (
          <p className="text-xs text-fg3">{t('forms.share.publicNotAllowed')}</p>
        ) : null}
        {settings.access === 'public' ? (
          link ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                readOnly
                value={link}
                aria-label={t('forms.share.link')}
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="out"
                size="md"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  toast(t('forms.share.copied'));
                }}
              >
                <Icon name="copy" size={16} />
                {t('forms.share.copy')}
              </Button>
              <Button variant="gh" size="md" loading={regenerating} onClick={onRegenerate}>
                <Icon name="refresh" size={16} />
                {t('forms.share.regenerate')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-fg3">{t('forms.share.saveForLink')}</p>
          )
        ) : null}
        <Toggle
          title={t('forms.share.anonymous')}
          hint={t('forms.share.anonymousHint')}
          checked={settings.anonymous}
          onChange={(v) => set({ anonymous: v })}
        />
        <Toggle
          title={t('forms.share.oneResponse')}
          hint={
            settings.access === 'public'
              ? t('forms.share.oneResponsePublic')
              : t('forms.share.oneResponseHint')
          }
          checked={settings.oneResponse}
          onChange={(v) => set({ oneResponse: v })}
        />
        <Field label={t('forms.share.closesAt')} hint={t('forms.share.closesAtHint')}>
          <DatePicker
            className="max-w-[260px]"
            value={closes}
            onChange={(v) => set({ closesAt: v ? new Date(`${v}T23:59:59`).toISOString() : null })}
          />
        </Field>
        <Field label={t('forms.share.confirmation')}>
          <Textarea
            rows={2}
            value={settings.confirmation ?? ''}
            maxLength={FORM_LIMITS.helpChars}
            placeholder={t('forms.fill.thanksBody')}
            onChange={(e) => set({ confirmation: e.target.value || null })}
          />
        </Field>
      </Section>

      <Section icon="send" title={t('forms.deliver.title')}>
        <Toggle
          title={t('forms.deliver.notify')}
          hint={t('forms.deliver.notifyHint')}
          checked={settings.notifyOnResponse}
          onChange={(v) => set({ notifyOnResponse: v })}
        />
        <Toggle
          title={t('forms.deliver.drive')}
          hint={t('forms.deliver.driveHint')}
          checked={dest.drive !== null}
          onChange={(v) => setDest({ drive: v ? { parentId: null } : null })}
        />
        {dest.drive ? (
          <Field label={t('forms.deliver.driveFolder')}>
            <Select
              value={dest.drive.parentId ?? ROOT}
              onValueChange={(v) => setDest({ drive: { parentId: v === ROOT ? null : v } })}
            >
              <SelectTrigger size="sm" aria-label={t('forms.deliver.driveFolder')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT}>{t('forms.deliver.spaceRoot')}</SelectItem>
                {(folders.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {boardsOn ? (
          <Toggle
            title={t('forms.deliver.board')}
            hint={t('forms.deliver.boardHint')}
            checked={dest.board !== null}
            onChange={(v) =>
              setDest({ board: v ? { boardId: '', columnId: '', titleFieldId: null } : null })
            }
          />
        ) : null}
        {boardsOn && dest.board ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('forms.deliver.boardPick')}>
              <Select
                value={dest.board.boardId || undefined}
                onValueChange={(v) =>
                  setDest({
                    board: { boardId: v, columnId: '', titleFieldId: dest.board!.titleFieldId },
                  })
                }
              >
                <SelectTrigger size="sm" aria-label={t('forms.deliver.boardPick')}>
                  <SelectValue placeholder={t('forms.deliver.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {(boards.data?.items ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('forms.deliver.column')}>
              <Select
                value={dest.board.columnId || undefined}
                disabled={!board.data}
                onValueChange={(v) => setDest({ board: { ...dest.board!, columnId: v } })}
              >
                <SelectTrigger size="sm" aria-label={t('forms.deliver.column')}>
                  <SelectValue placeholder={t('forms.deliver.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {(board.data?.columns ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('forms.deliver.cardTitle')}>
              <Select
                value={dest.board.titleFieldId ?? ROOT}
                onValueChange={(v) =>
                  setDest({ board: { ...dest.board!, titleFieldId: v === ROOT ? null : v } })
                }
              >
                <SelectTrigger size="sm" aria-label={t('forms.deliver.cardTitle')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT}>{t('forms.deliver.cardTitleForm')}</SelectItem>
                  {form.fields
                    .filter((f) => f.type === 'short_text' || f.type === 'single_choice')
                    .map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        ) : null}
        {tablesOn ? (
          <Toggle
            title={t('forms.deliver.table')}
            hint={t('forms.deliver.tableHint')}
            checked={dest.table !== null}
            onChange={(v) => setDest({ table: v ? { tableId: '' } : null })}
          />
        ) : null}
        {tablesOn && dest.table ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('forms.deliver.tablePick')} className="min-w-[220px] flex-1">
              <Select
                value={dest.table.tableId || undefined}
                onValueChange={(v) => setDest({ table: { tableId: v } })}
              >
                <SelectTrigger size="sm" aria-label={t('forms.deliver.tablePick')}>
                  <SelectValue placeholder={t('forms.deliver.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {(tables.data?.items ?? []).map((tb) => (
                    <SelectItem key={tb.id} value={tb.id}>
                      {tb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              size="sm"
              variant="gh"
              disabled={newTable.isPending}
              onClick={() => newTable.mutate()}
            >
              <Icon name="table" size={15} />
              {t('forms.deliver.tableNew')}
            </Button>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

/** Settings are complete enough to save (a board destination needs its column, a table its id). */
export function settingsReady(s: FormSettings) {
  return (
    (!s.destinations.board ||
      Boolean(s.destinations.board.boardId && s.destinations.board.columnId)) &&
    (!s.destinations.table || Boolean(s.destinations.table.tableId))
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-surface p-5 shadow-[0_0_0_1px_var(--line)]">
      <h2 className="flex items-center gap-2 text-sub font-semibold">
        <Icon name={icon} size={18} />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Toggle({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-fg">{title}</span>
        <span className="text-xs text-fg2">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  );
}
