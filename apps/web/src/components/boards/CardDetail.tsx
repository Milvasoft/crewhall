import {
  type BoardActivity,
  type BoardCardDetail,
  type BoardDetail,
  type ChecklistItem,
  paths,
  type UserSummary,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  DatePicker,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { NodePickerDialog } from '@/features/drive/NodePickerDialog';
import { nodeIcon } from '@/features/drive/fileKinds';
import { api } from '@/lib/api';
import { useBoardActions } from '@/lib/boards/actions';
import { activityQuery, boardKeys, putCardDetail } from '@/lib/boards/api';
import { cardRef } from '@/lib/boards/filters';
import { uploadToFolder } from '@/lib/boards/upload';
import { errorKey } from '@/lib/errors';
import { formatDate, formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { canView, openViewer } from '@/lib/viewer';
import { driveNodeSource } from '@/lib/viewerSources';
import { CardLinks } from './CardLinks';
import { CardTime } from './CardTime';
import { MultiPicker, labelOptions, peopleOptions } from './pickers';
import { AvatarStack, LabelChip } from './parts';
import { ResizablePane } from '@/components/shell/ResizablePane';

const shortId = () => Math.random().toString(36).slice(2, 10);

/**
 * Card detail (design 6.3): a wide modal with its own address. Left: fields, description,
 * subtasks, attachments (references to Drive nodes). Right: the card's activity with
 * comments; system lines (moves, assignments) arrive there too. Followers get comment
 * notifications; assignees and commenters follow automatically.
 */
export function CardDetail({
  board,
  card,
  loading,
  meId,
  onClose,
}: {
  board: BoardDetail;
  card: BoardCardDetail | undefined;
  loading: boolean;
  meId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        width={1040}
        className="h-[min(860px,calc(100vh-48px))] gap-0 overflow-hidden p-0"
      >
        {card ? (
          <Body board={board} card={card} meId={meId} onClose={onClose} />
        ) : (
          <div className="flex flex-1 flex-col gap-3 p-6">
            <DialogTitle className="sr-only">{t('boards.board')}</DialogTitle>
            {loading ? (
              <>
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-40 w-full" />
              </>
            ) : (
              <p className="m-auto text-sm text-fg2">{t('boards.detail.notFound')}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  board,
  card,
  meId,
  onClose,
}: {
  board: BoardDetail;
  card: BoardCardDetail;
  meId: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const actions = useBoardActions(board.board.id);
  const settings = board.board.settings;
  const key = cardRef(settings.key, card.number);
  const canEdit = card.board.myRole !== 'viewer';
  const column = board.columns.find((c) => c.id === card.columnId);
  const [title, setTitle] = useState(card.title);
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState(false);

  const saveTitle = () => {
    const v = title.trim();
    if (v && v !== card.title) void actions.updateCard(card.id, { title: v });
    else setTitle(card.title);
  };

  const attach = async (nodeId: string) => {
    try {
      putCardDetail(
        qc,
        await api.call('addBoardCardAttachment', { params: { cardId: card.id }, body: { nodeId } }),
      );
      void qc.invalidateQueries({ queryKey: boardKeys.activity(card.id) });
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const target = await api.call('getBoardAttachmentFolder', {
        params: { boardId: board.board.id },
      });
      for (const f of Array.from(files)) {
        const node = await uploadToFolder(f, {
          spaceId: target.spaceId,
          folderId: target.folderId,
          name: f.name,
        });
        await attach(node.id);
      }
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setUploading(false);
    }
  };

  const copyLink = () => {
    void navigator.clipboard?.writeText(
      `${window.location.origin}${paths.boardCard(board.board.id, key)}`,
    );
    toast(t('boards.detail.linkCopied'));
  };

  return (
    // Phone (H10): details, then activity below them in one scroll.
    <div className="flex min-h-0 flex-1 max-md:flex-col max-md:overflow-y-auto">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto max-md:flex-none max-md:overflow-visible">
        <header className="flex items-center gap-2 border-b border-line px-6 py-3 text-xs text-fg3">
          <span className="font-mono font-semibold text-fg2">{key}</span>
          {column ? (
            <span className="rounded-full bg-bg2 px-2 py-0.5 font-semibold text-fg2">
              {column.name}
            </span>
          ) : null}
          <span className="truncate">
            {t('boards.detail.created', {
              name: card.createdBy?.name ?? t('boards.activity.someone'),
              date: formatDate(card.createdAt, locale, { day: 'numeric', month: 'short' }),
            })}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('boards.detail.copyLink')}
              onClick={copyLink}
            >
              <Icon name="link" size={16} />
            </IconButton>
            {canEdit ? (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton size="sm" tone="plain" aria-label={t('boards.detail.menu')}>
                    <Icon name="dots" size={16} />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    icon="archive"
                    onSelect={() =>
                      void actions.updateCard(card.id, { archived: !card.archivedAt })
                    }
                  >
                    {card.archivedAt ? t('boards.detail.unarchive') : t('boards.detail.archive')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon="trash"
                    danger
                    onSelect={() => {
                      if (window.confirm(t('boards.detail.deleteConfirm', { key }))) {
                        void actions.deleteCard(card, key).then((ok) => ok && onClose());
                      }
                    }}
                  >
                    {t('boards.detail.delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('boards.detail.close')}
              onClick={onClose}
            >
              <Icon name="x" size={16} />
            </IconButton>
          </span>
        </header>
        <div className="flex flex-col gap-5 px-6 py-5">
          {card.archivedAt ? (
            <p className="rounded-md bg-bg2 px-3 py-2 text-[13px] text-fg2">
              {t('boards.detail.archivedNote')}
            </p>
          ) : null}
          {!canEdit ? <p className="text-[13px] text-fg3">{t('boards.detail.readOnly')}</p> : null}
          <DialogTitle asChild>
            <textarea
              value={title}
              readOnly={!canEdit}
              rows={1}
              aria-label={t('boards.list.title')}
              onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
              className="field-sizing-content resize-none overflow-hidden bg-transparent text-wtitle font-bold text-fg outline-none"
            />
          </DialogTitle>

          <dl className="grid grid-cols-[120px_1fr] items-center gap-x-4 gap-y-3 text-[13.5px]">
            <Row label={t('boards.detail.assignees')}>
              <span className="flex flex-wrap items-center gap-2">
                {card.assignees.map((p) => (
                  <Person key={p.id} person={p} />
                ))}
                {canEdit ? (
                  <MultiPicker
                    trigger={
                      <button
                        type="button"
                        className="flex size-7 items-center justify-center rounded-full bg-bg2 text-fg2 hover:bg-capsule"
                        aria-label={t('boards.detail.addAssignee')}
                      >
                        <Icon name="plus" size={14} />
                      </button>
                    }
                    placeholder={t('boards.filters.searchPeople')}
                    options={peopleOptions(board.people, meId)}
                    value={card.assignees.map((a) => a.id)}
                    onChange={(ids) => void actions.setAssignees(card.id, ids)}
                  />
                ) : null}
              </span>
            </Row>
            <Row label={t('boards.detail.labels')}>
              <span className="flex flex-wrap items-center gap-1.5">
                {card.labels.map((id) => {
                  const l = settings.labels.find((x) => x.id === id);
                  return l ? (
                    <LabelChip
                      key={id}
                      label={l}
                      onRemove={
                        canEdit
                          ? () =>
                              void actions.updateCard(card.id, {
                                labels: card.labels.filter((x) => x !== id),
                              })
                          : undefined
                      }
                    />
                  ) : null;
                })}
                {canEdit && settings.labels.length ? (
                  <MultiPicker
                    trigger={
                      <button
                        type="button"
                        className="flex h-6 items-center gap-1 rounded-xs bg-bg2 px-1.5 text-xs font-semibold text-fg2 hover:bg-capsule"
                      >
                        <Icon name="plus" size={12} />
                        {t('boards.detail.addLabel')}
                      </button>
                    }
                    options={labelOptions(settings.labels)}
                    value={card.labels}
                    onChange={(labels) => void actions.updateCard(card.id, { labels })}
                  />
                ) : null}
              </span>
            </Row>
            <Row label={t('boards.detail.startDate')}>
              <span className="flex items-center gap-2">
                <DatePicker
                  size="sm"
                  className="h-8 w-[150px]"
                  value={card.startAt ? localIso(card.startAt) : null}
                  max={card.dueAt ? localIso(card.dueAt) : undefined}
                  disabled={!canEdit}
                  aria-label={t('boards.detail.startDate')}
                  onChange={(v) => {
                    const [y, m, d] = (v ?? '').split('-').map(Number);
                    void actions.updateCard(card.id, {
                      startAt: v ? new Date(y!, m! - 1, d!, 9, 0, 0).toISOString() : null,
                    });
                  }}
                />
                {!card.startAt ? (
                  <span className="text-xs text-fg3">{t('boards.detail.noStart')}</span>
                ) : null}
              </span>
            </Row>
            <Row label={t('boards.detail.dueDate')}>
              <DueField
                value={card.dueAt}
                disabled={!canEdit}
                onChange={(dueAt) => void actions.updateCard(card.id, { dueAt })}
              />
            </Row>
            <Row label={t('boards.detail.column')}>
              <Select
                value={card.columnId}
                disabled={!canEdit}
                onValueChange={(columnId) =>
                  void actions
                    .move({ cardId: card.id, columnId, afterId: null, beforeId: null })
                    .then(() => qc.invalidateQueries({ queryKey: boardKeys.card(card.id) }))
                }
              >
                <SelectTrigger className="h-8 w-[220px] max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {board.columns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            {board.sprints ? (
              <Row label={t('boards.sprints.sprint')}>
                <Select
                  value={card.sprintId ?? 'backlog'}
                  disabled={!canEdit}
                  onValueChange={(v) =>
                    void actions
                      .planCard(card.id, v === 'backlog' ? null : v)
                      .then(() => qc.invalidateQueries({ queryKey: boardKeys.card(card.id) }))
                  }
                >
                  <SelectTrigger
                    className="h-8 w-[220px] max-w-full"
                    aria-label={t('boards.sprints.sprint')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {board.sprints.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                    {card.sprintId && !board.sprints.some((s) => s.id === card.sprintId) ? (
                      <SelectItem value={card.sprintId} disabled>
                        {t('boards.sprints.status.closed')}
                      </SelectItem>
                    ) : null}
                    <SelectItem value="backlog">{t('boards.sprints.backlog')}</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
            ) : null}
            {settings.fields.points ? (
              <Row label={t('boards.detail.points')}>
                <input
                  type="number"
                  min={0}
                  max={999}
                  disabled={!canEdit}
                  defaultValue={card.points ?? ''}
                  aria-label={t('boards.detail.points')}
                  onBlur={(e) => {
                    const v =
                      e.target.value === ''
                        ? null
                        : Math.max(0, Math.min(999, Number(e.target.value)));
                    if (v !== card.points) void actions.updateCard(card.id, { points: v });
                  }}
                  className="h-8 w-24 rounded-md bg-bg2 px-2.5 text-[13.5px] outline-none tn"
                />
              </Row>
            ) : null}
            {settings.fields.priority ? (
              <Row label={t('boards.detail.priority')}>
                <Select
                  value={card.priority ?? 'none'}
                  disabled={!canEdit}
                  onValueChange={(v) =>
                    void actions.updateCard(card.id, {
                      priority: v === 'none' ? null : (v as 'p1' | 'p2' | 'p3'),
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-[220px] max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['p1', 'p2', 'p3', 'none'] as const).map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`boards.detail.priorities.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            ) : null}
          </dl>

          <Description
            card={card}
            canEdit={canEdit}
            onSave={(description) => actions.updateCard(card.id, { description })}
          />
          <Checklist
            items={card.checklistItems}
            people={board.people}
            canEdit={canEdit}
            onChange={(checklistItems) => void actions.updateCard(card.id, { checklistItems })}
          />
          <CardLinks card={card} canEdit={canEdit} />
          <CardTime card={card} canEdit={canEdit} actions={actions} />

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h4 className="text-[13.5px] font-bold text-fg">{t('boards.detail.attachments')}</h4>
              {canEdit ? (
                <span className="ml-auto flex gap-1.5">
                  <Button size="xs" variant="out" onClick={() => setPicker(true)}>
                    <Icon name="folder" size={14} />
                    {t('boards.detail.attachFromDrive')}
                  </Button>
                  <Button size="xs" variant="out" loading={uploading} asChild={!uploading}>
                    {uploading ? (
                      t('boards.detail.uploading')
                    ) : (
                      <label className="cursor-pointer">
                        <Icon name="upload" size={14} />
                        {t('boards.detail.upload')}
                        <input
                          type="file"
                          multiple
                          className="sr-only"
                          onChange={(e) => void upload(e.target.files)}
                        />
                      </label>
                    )}
                  </Button>
                </span>
              ) : null}
            </div>
            {card.attachments.length ? (
              <ul className="grid grid-cols-2 gap-2">
                {card.attachments.map((a) => (
                  <li
                    key={a.nodeId}
                    className="flex items-center gap-2.5 rounded-lg bg-bg2 px-3 py-2"
                  >
                    <Icon
                      name={nodeIcon({ name: a.name, type: a.type, mime: a.mime })}
                      size={18}
                      className="text-fg2"
                    />
                    {/* Images, videos and PDFs open in the shared viewer, inside the app. */}
                    <button
                      type="button"
                      disabled={a.type !== 'file' || !canView(a.mime, a.name)}
                      onClick={(e) => {
                        const files = card.attachments.filter(
                          (x) => x.type === 'file' && canView(x.mime, x.name),
                        );
                        openViewer(
                          files.map((x) => driveNodeSource({ ...x, id: x.nodeId })),
                          files.indexOf(a),
                          e.currentTarget.closest('li'),
                        );
                      }}
                      className="flex min-w-0 flex-1 flex-col text-left enabled:cursor-pointer"
                    >
                      <span className="truncate text-[13px] font-semibold text-fg">{a.name}</span>
                      <span className="text-[11.5px] text-fg3">
                        {a.addedBy?.name.split(' ')[0] ?? ''}
                      </span>
                    </button>
                    {canEdit ? (
                      <IconButton
                        size="xs"
                        tone="plain"
                        aria-label={t('boards.detail.removeAttachment')}
                        onClick={() =>
                          void api
                            .call('removeBoardCardAttachment', {
                              params: { cardId: card.id, nodeId: a.nodeId },
                            })
                            .then((d) => putCardDetail(qc, d))
                            .catch((e: unknown) => toast(t(errorKey(e))))
                        }
                      >
                        <Icon name="x" size={14} />
                      </IconButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-fg3">{t('boards.detail.noAttachments')}</p>
            )}
          </section>
        </div>
      </div>
      <ActivityPane card={card} keyLabel={key} meId={meId} chats={settings.cardChats} />
      <NodePickerDialog
        open={picker}
        title={t('boards.detail.attachFromDrive')}
        confirm={t('boards.detail.attach')}
        onClose={() => setPicker(false)}
        onPick={(n) => {
          setPicker(false);
          void attach(n.id);
        }}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[13px] font-semibold text-fg3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Person({ person }: { person: UserSummary }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-bg2 py-0.5 pr-2.5 pl-0.5 text-[13px] font-semibold">
      <Avatar name={person.name} src={person.imageUrl} size="sm" />
      {person.name.split(' ')[0]}
    </span>
  );
}

/** `YYYY-MM-DD` of a moment in local time (date pickers). */
function localIso(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function DueField({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const now = useNow(60_000);
  const local = value ? new Date(value) : null;
  const inputValue = local
    ? `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
    : '';
  const days = local ? Math.ceil((local.getTime() - now) / 86_400_000) : null;
  return (
    <span className="flex items-center gap-2">
      <DatePicker
        size="sm"
        className="h-8 w-[150px]"
        value={inputValue || null}
        disabled={disabled}
        aria-label={t('boards.detail.dueDate')}
        onChange={(v) => {
          if (!v) return onChange(null);
          // End of the chosen day, local time.
          const [y, m, d] = v.split('-').map(Number);
          onChange(new Date(y!, m! - 1, d!, 18, 0, 0).toISOString());
        }}
      />
      {local ? (
        <span
          className={cn(
            'text-xs font-semibold',
            days !== null && days < 0
              ? 'text-danger'
              : days !== null && days <= 2
                ? 'text-warning'
                : 'text-fg3',
          )}
        >
          {formatDate(local, locale, { weekday: 'long', day: 'numeric', month: 'long' })}
          {' · '}
          {days !== null && days < 0
            ? t('boards.card.overdue', { days: -days })
            : t('boards.card.dueIn', { days: days ?? 0 })}
        </span>
      ) : (
        <span className="text-xs text-fg3">{t('boards.detail.noDue')}</span>
      )}
      {local && !disabled ? (
        <Button size="xs" variant="gh" onClick={() => onChange(null)}>
          {t('boards.detail.clearDue')}
        </Button>
      ) : null}
    </span>
  );
}

/** Plain-text description with "- " bullets; the block editor binds here once it ships. */
function Description({
  card,
  canEdit,
  onSave,
}: {
  card: BoardCardDetail;
  canEdit: boolean;
  onSave: (text: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.description);
  const [busy, setBusy] = useState(false);
  const lines = card.description.split('\n');
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center">
        <h4 className="text-[13.5px] font-bold text-fg">{t('boards.detail.description')}</h4>
        {canEdit && !editing ? (
          <Button
            size="xs"
            variant="gh"
            className="ml-auto"
            onClick={() => {
              setText(card.description);
              setEditing(true);
            }}
          >
            <Icon name="edit" size={14} />
            {t('boards.detail.edit')}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <>
          <Textarea
            autoFocus
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('boards.detail.descriptionPlaceholder')}
            aria-label={t('boards.detail.description')}
          />
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="inv"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await onSave(text);
                setBusy(false);
                setEditing(false);
              }}
            >
              {t('boards.detail.save')}
            </Button>
            <Button size="xs" variant="gh" onClick={() => setEditing(false)}>
              {t('boards.detail.cancel')}
            </Button>
          </div>
        </>
      ) : card.description ? (
        <div
          className={cn(
            'flex flex-col gap-1 text-[14px] leading-[22px] text-fg',
            canEdit && 'cursor-text',
          )}
          onDoubleClick={() => canEdit && (setText(card.description), setEditing(true))}
        >
          {lines.map((l, i) =>
            /^[•-] /.test(l) ? (
              <span key={i} className="flex gap-2 pl-1">
                <span className="text-fg3">•</span>
                <span>{l.slice(2)}</span>
              </span>
            ) : l ? (
              <p key={i}>{l}</p>
            ) : (
              <br key={i} />
            ),
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => {
            setText('');
            setEditing(true);
          }}
          className="rounded-md bg-bg2 px-3 py-3 text-left text-[13.5px] text-fg3 enabled:hover:bg-capsule"
        >
          {t('boards.detail.descriptionPlaceholder')}
        </button>
      )}
    </section>
  );
}

function Checklist({
  items,
  people,
  canEdit,
  onChange,
}: {
  items: ChecklistItem[];
  people: UserSummary[];
  canEdit: boolean;
  onChange: (items: ChecklistItem[]) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const done = items.filter((i) => i.done).length;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h4 className="text-[13.5px] font-bold text-fg">{t('boards.detail.checklist')}</h4>
        {items.length ? (
          <>
            <span className="text-xs font-semibold text-fg3 tn">
              {done} / {items.length}
            </span>
            <Progress
              value={(done / items.length) * 100}
              className="w-40"
              neutral={done < items.length}
            />
          </>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {items.map((it) => {
          const who = people.find((p) => p.id === it.assigneeId);
          return (
            <li
              key={it.id}
              className="group flex h-9 items-center gap-2.5 rounded-sm px-1 hover:bg-bg2"
            >
              <Checkbox
                checked={it.done}
                disabled={!canEdit}
                aria-label={it.text}
                onCheckedChange={(v) =>
                  onChange(items.map((x) => (x.id === it.id ? { ...x, done: v === true } : x)))
                }
              />
              <span
                className={cn('flex-1 truncate text-[13.5px]', it.done && 'text-fg3 line-through')}
              >
                {it.text}
              </span>
              {who ? <AvatarStack people={[who]} /> : null}
              {canEdit ? (
                <IconButton
                  size="xs"
                  tone="plain"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={t('boards.detail.removeItem')}
                  onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                >
                  <Icon name="x" size={13} />
                </IconButton>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canEdit ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            onChange([...items, { id: shortId(), text: v, done: false, assigneeId: null }]);
            setText('');
          }}
        >
          <Icon name="plus" size={15} className="text-fg3" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('boards.detail.addItem')}
            aria-label={t('boards.detail.addItem')}
            maxLength={500}
            className="h-8 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg3"
          />
        </form>
      ) : null}
    </section>
  );
}

function ActivityPane({
  card,
  keyLabel,
  meId,
  chats,
}: {
  card: BoardCardDetail;
  keyLabel: string;
  meId: string;
  chats: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);
  /** The card's chat room (chat type `card`), created on first use (design 6.3). */
  const openChat = async () => {
    setOpening(true);
    try {
      const { conversationId } = await api.call('openBoardCardConversation', {
        params: { cardId: card.id },
      });
      void navigate({ to: '/chat/c/$conversationId', params: { conversationId } });
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setOpening(false);
    }
  };
  const feed = useQuery(activityQuery(card.id));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setBusy(true);
    try {
      await api.call('addBoardCardComment', { params: { cardId: card.id }, body: { text: v } });
      setText('');
      void qc.invalidateQueries({ queryKey: boardKeys.activity(card.id) });
      void qc.invalidateQueries({ queryKey: boardKeys.card(card.id) });
      void qc.invalidateQueries({ queryKey: boardKeys.board(card.boardId) });
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  const toggleFollow = async () => {
    try {
      await api.call('setBoardCardFollowing', {
        params: { cardId: card.id },
        body: { following: !card.following },
      });
      void qc.invalidateQueries({ queryKey: boardKeys.card(card.id) });
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };
  return (
    <ResizablePane id="board-card" side="right" defaultWidth={380} className="max-md:w-full">
      <aside className="flex w-full min-w-0 flex-col border-l border-line bg-bg max-md:min-h-[420px] max-md:w-full max-md:border-t max-md:border-l-0">
        <header className="flex flex-col gap-2 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <h4 className="text-[13.5px] font-bold text-fg">{t('boards.detail.activity')}</h4>
            <span className="text-xs text-fg3 tn">{card.commentCount}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-fg2">
            <span>{t('boards.detail.followers', { count: card.followerIds.length })}</span>
            <button
              type="button"
              onClick={() => void toggleFollow()}
              className="ml-auto font-semibold text-fg hover:underline"
            >
              {card.following ? t('boards.detail.unfollow') : t('boards.detail.follow')}
            </button>
          </div>
          {chats ? (
            <Button
              size="xs"
              variant="out"
              loading={opening}
              className="self-start"
              onClick={() => void openChat()}
            >
              <Icon name="chat" size={14} />
              {t('boards.detail.chat')}
            </Button>
          ) : null}
        </header>
        <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {feed.isLoading ? <Skeleton className="h-4 w-2/3" /> : null}
          {feed.data?.length === 0 ? (
            <li className="text-xs text-fg3">{t('boards.activity.empty')}</li>
          ) : null}
          {feed.data?.map((a) => (
            <ActivityLine key={a.id} a={a} meId={meId} cardId={card.id} />
          ))}
        </ol>
        <form
          className="flex items-end gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t('boards.detail.commentPlaceholder', { key: keyLabel })}
            aria-label={t('boards.detail.commentPlaceholder', { key: keyLabel })}
            className="min-h-0 flex-1 resize-none"
          />
          <IconButton
            type="submit"
            aria-label={t('boards.detail.send')}
            disabled={busy || !text.trim()}
          >
            <Icon name="send" size={16} />
          </IconButton>
        </form>
      </aside>
    </ResizablePane>
  );
}

function ActivityLine({ a, meId, cardId }: { a: BoardActivity; meId: string; cardId: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const actor = a.actor?.name.split(' ')[0] ?? t('boards.activity.someone');
  const when = formatRelative(a.createdAt, locale);
  if (a.kind === 'comment') {
    return (
      <li className="group flex gap-2.5">
        <Avatar name={a.actor?.name ?? '?'} src={a.actor?.imageUrl} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-xs">
            <b className="font-semibold text-fg">{a.actor?.name ?? t('boards.activity.someone')}</b>
            <span className="text-fg3">{when}</span>
            {a.actor?.id === meId ? (
              <button
                type="button"
                className="ml-auto text-fg3 opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                aria-label={t('boards.detail.deleteComment')}
                onClick={() =>
                  void api
                    .call('deleteBoardCardComment', { params: { activityId: a.id } })
                    .then(() => qc.invalidateQueries({ queryKey: boardKeys.activity(cardId) }))
                }
              >
                <Icon name="trash" size={13} />
              </button>
            ) : null}
          </span>
          <p className="text-[13.5px] leading-[20px] whitespace-pre-wrap text-fg">{a.text}</p>
        </div>
      </li>
    );
  }
  const d = a.data;
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
  let line: string;
  switch (a.kind) {
    case 'moved':
      line = s('from')
        ? t('boards.activity.moved', { actor, from: s('from'), to: s('to') })
        : t('boards.activity.movedTo', { actor, to: s('to') });
      break;
    case 'assigned':
    case 'unassigned':
      line = t(`boards.activity.${a.kind}`, { actor, user: s('userName').split(' ')[0] ?? '' });
      break;
    case 'due_changed':
      line = s('dueAt')
        ? t('boards.activity.due_changed', {
            actor,
            date: formatDate(s('dueAt'), locale, { day: 'numeric', month: 'short' }),
          })
        : t('boards.activity.due_cleared', { actor });
      break;
    case 'checklist_done':
      line = t('boards.activity.checklist_done', { actor, count: Number(d.count ?? 1) });
      break;
    case 'renamed':
      line = t('boards.activity.renamed', { actor, to: s('to') });
      break;
    case 'attachment_added':
      line = t('boards.activity.attachment_added', { actor, name: s('name') });
      break;
    default:
      line = t(`boards.activity.${a.kind}`, { actor });
  }
  return (
    <li className="flex items-center gap-2 pl-1 text-xs text-fg3">
      <span className="size-1.5 shrink-0 rounded-full bg-line2" />
      <span className="min-w-0 flex-1">{line}</span>
      <span className="shrink-0">{when}</span>
    </li>
  );
}
