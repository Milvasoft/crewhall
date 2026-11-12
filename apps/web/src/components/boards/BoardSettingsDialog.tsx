import { DEFAULT_CAPACITY_HOURS, type BoardDetail, type BoardLabel } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Switch,
  toast,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';
import { BoardAutomations } from '@/components/automations/BoardAutomations';
import { useBoardActions } from '@/lib/boards/actions';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { LabelChip, LABEL_COLORS, LABEL_VAR } from './parts';

type Tab = 'general' | 'columns' | 'automation' | 'danger';

/**
 * Board settings (design 6.6): general (name, key, card chats, fields; sprints live in the
 * backlog view), columns with WIP and the done column, labels from the category palette,
 * automation note and the danger zone. Only space admins and the board's creator see it.
 */
export function BoardSettingsDialog({
  detail,
  onClose,
}: {
  detail: BoardDetail;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('general');
  const tabs: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
    { id: 'general', label: t('boards.settings.general'), icon: 'settings' },
    { id: 'columns', label: t('boards.settings.columnsLabels'), icon: 'board' },
    { id: 'automation', label: t('boards.settings.automation'), icon: 'zap' },
    { id: 'danger', label: t('boards.settings.danger'), icon: 'alert' },
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        width={880}
        className="h-[min(720px,calc(100vh-48px))] flex-row gap-0 overflow-hidden p-0"
      >
        <nav className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-line bg-bg p-3">
          <button
            type="button"
            onClick={onClose}
            className="mb-2 flex items-center gap-1.5 px-2 text-xs font-semibold text-fg2 hover:text-fg"
          >
            <Icon name="arrowL" size={14} />
            {t('boards.settings.back')}
          </button>
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-current={tab === x.id ? 'page' : undefined}
              onClick={() => setTab(x.id)}
              className={cn(
                'flex h-9 items-center gap-2 rounded-sm px-2.5 text-[13.5px] font-medium',
                tab === x.id ? 'bg-capsule font-semibold text-fg' : 'text-fg2 hover:bg-bg2',
              )}
            >
              <Icon name={x.icon} size={16} />
              {x.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
          <DialogHeader title={`${t('boards.settings.title')} · ${detail.board.name}`} />
          {tab === 'general' ? <General detail={detail} /> : null}
          {tab === 'columns' ? <ColumnsAndLabels detail={detail} /> : null}
          {tab === 'automation' ? (
            <BoardAutomations
              spaceId={detail.board.spaceId}
              boardId={detail.board.id}
              onNavigate={onClose}
            />
          ) : null}
          {tab === 'danger' ? <Danger detail={detail} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sub font-semibold text-fg">{title}</h3>
        {hint ? <p className="text-xs text-fg3">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function General({ detail }: { detail: BoardDetail }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const actions = useBoardActions(detail.board.id);
  const s = detail.board.settings;
  const [name, setName] = useState(detail.board.name);
  const [key, setKey] = useState(s.key);
  const save = async (body: Parameters<typeof actions.updateBoard>[0]) => {
    if (await actions.updateBoard(body)) toast(t('boards.settings.saved'));
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('boards.settings.name')}>
          <Input
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() && name !== detail.board.name && void save({ name: name.trim() })
            }
          />
        </Field>
        <Field
          label={t('boards.settings.key')}
          hint={t('boards.settings.keyHint', { key: key || s.key })}
        >
          <Input
            value={key}
            maxLength={6}
            onChange={(e) =>
              setKey(e.target.value.toLocaleUpperCase('en').replace(/[^A-Z0-9]/g, ''))
            }
            onBlur={() => /^[A-Z][A-Z0-9]{1,5}$/.test(key) && key !== s.key && void save({ key })}
          />
        </Field>
      </div>
      <Toggle
        title={t('boards.settings.cardChats')}
        hint={t('boards.settings.cardChatsHint')}
        checked={s.cardChats}
        onChange={(cardChats) => void save({ cardChats })}
      />
      <Section title={t('boards.settings.fields')}>
        <Toggle
          title={t('boards.settings.fieldPoints')}
          checked={s.fields.points}
          onChange={(points) => void save({ fields: { ...s.fields, points } })}
        />
        <Toggle
          title={t('boards.settings.fieldPriority')}
          checked={s.fields.priority}
          onChange={(priority) => void save({ fields: { ...s.fields, priority } })}
        />
      </Section>
      <Section title={t('boards.settings.archiveDays')}>
        <Toggle
          title={
            s.doneArchiveDays
              ? t('boards.settings.archiveAfter', { days: s.doneArchiveDays })
              : t('boards.settings.archiveNever')
          }
          checked={s.doneArchiveDays !== null}
          onChange={(on) => void save({ doneArchiveDays: on ? 30 : null })}
        />
      </Section>
      <Section title={t('boards.settings.capacity')} hint={t('boards.settings.capacityHint')}>
        <label className="flex items-center gap-2 text-[13px] text-fg2">
          <Input
            type="number"
            min={1}
            max={168}
            key={s.capacityHours ?? DEFAULT_CAPACITY_HOURS}
            defaultValue={s.capacityHours ?? DEFAULT_CAPACITY_HOURS}
            aria-label={t('boards.settings.capacity')}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value));
              if (v >= 1 && v <= 168 && v !== (s.capacityHours ?? DEFAULT_CAPACITY_HOURS)) {
                void save({ capacityHours: v });
              }
            }}
            className="h-9 w-24"
          />
          {t('boards.settings.capacityUnit')}
        </label>
      </Section>
      <Section title={t('boards.settings.sprint')} hint={t('boards.sprints.manageHint')}>
        <Button
          size="xs"
          variant="out"
          className="self-start"
          onClick={() =>
            void navigate({
              to: '/b/$boardId',
              params: { boardId: detail.board.id },
              search: { view: 'backlog' },
            })
          }
        >
          {t('boards.sprints.openBacklog')}
        </Button>
      </Section>
    </div>
  );
}

function Toggle({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded-lg bg-bg2 px-3.5 py-3">
      <span className="flex flex-1 flex-col">
        <span className="text-sm font-semibold text-fg">{title}</span>
        {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  );
}

function ColumnsAndLabels({ detail }: { detail: BoardDetail }) {
  const { t } = useI18n();
  const actions = useBoardActions(detail.board.id);
  const labels = detail.board.settings.labels;
  const [newLabel, setNewLabel] = useState('');
  const uses = (id: string) => detail.cards.filter((c) => c.labels.includes(id)).length;
  const saveLabels = (next: BoardLabel[]) => void actions.updateBoard({ labels: next });
  return (
    <div className="flex flex-col gap-6">
      <Section title={t('boards.settings.columns')} hint={t('boards.settings.columnsHint')}>
        <ul className="flex flex-col gap-1.5">
          {detail.columns.map((c, i) => (
            <li key={c.id} className="flex items-center gap-3 rounded-lg bg-bg2 px-3 py-2">
              <span className="flex flex-col">
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label="↑"
                  disabled={i === 0}
                  onClick={() =>
                    void actions.moveColumn(
                      c.id,
                      detail.columns[i - 2]?.id ?? null,
                      detail.columns[i - 1]!.id,
                    )
                  }
                >
                  <Icon name="chevU" size={13} />
                </IconButton>
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label="↓"
                  disabled={i === detail.columns.length - 1}
                  onClick={() =>
                    void actions.moveColumn(
                      c.id,
                      detail.columns[i + 1]!.id,
                      detail.columns[i + 2]?.id ?? null,
                    )
                  }
                >
                  <Icon name="chevD" size={13} />
                </IconButton>
              </span>
              <input
                defaultValue={c.name}
                aria-label={t('boards.column.rename')}
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== c.name &&
                  void actions.updateColumn(c.id, { name: e.target.value.trim() })
                }
                className="h-8 min-w-0 flex-1 rounded-md bg-surface px-2.5 text-[13.5px] font-semibold outline-none"
              />
              {c.isDone ? (
                <span className="text-xs font-semibold text-success">
                  {t('boards.settings.doneColumn')}
                </span>
              ) : null}
              <label className="flex items-center gap-1.5 text-xs text-fg2">
                WIP
                <input
                  defaultValue={c.wipLimit ?? ''}
                  inputMode="numeric"
                  placeholder="—"
                  aria-label={t('boards.column.setWip')}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    const next = e.target.value && n > 0 ? Math.min(999, Math.round(n)) : null;
                    if (next !== c.wipLimit) void actions.updateColumn(c.id, { wipLimit: next });
                  }}
                  className="h-8 w-14 rounded-md bg-surface px-2 text-center text-[13px] outline-none tn"
                />
              </label>
              <Switch
                checked={c.isDone}
                aria-label={t('boards.settings.doneColumn')}
                onCheckedChange={(isDone) => void actions.updateColumn(c.id, { isDone })}
              />
            </li>
          ))}
        </ul>
        <Button
          size="xs"
          variant="out"
          className="self-start"
          onClick={() => void actions.addColumn(t('boards.column.namePlaceholder'))}
        >
          <Icon name="plus" size={14} />
          {t('boards.column.add')}
        </Button>
      </Section>
      <Section title={t('boards.settings.labels')}>
        <ul className="flex flex-col gap-1.5">
          {labels.map((l) => (
            <li key={l.id} className="flex items-center gap-3 rounded-lg bg-bg2 px-3 py-2">
              <LabelChip label={l} />
              <input
                defaultValue={l.name}
                aria-label={t('boards.settings.labelName')}
                maxLength={40}
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== l.name &&
                  saveLabels(
                    labels.map((x) => (x.id === l.id ? { ...x, name: e.target.value.trim() } : x)),
                  )
                }
                className="h-8 min-w-0 flex-1 rounded-md bg-surface px-2.5 text-[13.5px] outline-none"
              />
              <span className="flex gap-1">
                {LABEL_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    aria-pressed={l.color === color}
                    onClick={() =>
                      saveLabels(labels.map((x) => (x.id === l.id ? { ...x, color } : x)))
                    }
                    className={cn(
                      'size-5 rounded-full',
                      l.color === color && 'ring-2 ring-fg ring-offset-2 ring-offset-bg2',
                    )}
                    style={{ background: LABEL_VAR[color] }}
                  />
                ))}
              </span>
              <span className="w-6 text-right text-xs text-fg3 tn">{uses(l.id)}</span>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('boards.settings.removeLabel')}
                onClick={() => saveLabels(labels.filter((x) => x.id !== l.id))}
              >
                <Icon name="trash" size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newLabel.trim();
            if (!name) return;
            const id = `l${Date.now().toString(36).slice(-6)}`;
            const color = LABEL_COLORS[labels.length % LABEL_COLORS.length]!;
            saveLabels([...labels, { id, name, color }]);
            setNewLabel('');
          }}
        >
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t('boards.settings.newLabel')}
            maxLength={40}
            className="max-w-[260px]"
          />
          <Button size="sm" variant="out" type="submit">
            {t('boards.settings.newLabel')}
          </Button>
        </form>
      </Section>
    </div>
  );
}

function Danger({ detail }: { detail: BoardDetail }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-4 rounded-lg border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] px-4 py-3">
      <span className="flex flex-1 flex-col">
        <span className="text-sm font-semibold text-fg">{t('boards.settings.deleteBoard')}</span>
        <span className="text-xs text-fg2">{t('boards.settings.deleteBoardHint')}</span>
      </span>
      <Button
        variant="dngf"
        size="sm"
        onClick={async () => {
          try {
            await api.call('trashNodes', { body: { nodeIds: [detail.board.id] } });
            invalidateDrive(qc);
            void qc.invalidateQueries({ queryKey: ['boards'] });
            void navigate({
              to: '/boards/$spaceSlug',
              params: { spaceSlug: detail.board.space.slug },
            });
          } catch (e) {
            toast(t(errorKey(e)));
          }
        }}
      >
        {t('boards.settings.deleteBoard')}
      </Button>
    </div>
  );
}
