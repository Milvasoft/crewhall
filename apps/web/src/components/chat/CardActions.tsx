import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { boardQuery, boardsQuery } from '@/lib/boards/api';
import { patchMessage, putMessages } from '@/lib/chat/cache';
import { type Conversation, type Message } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { spacesQuery } from '@/lib/queries';
import { PersonAvatar, useMyId } from './common';

/**
 * Under a webhook or integration card: "Ben bakıyorum" (everyone sees who took it) and
 * "Panoda iş aç" (a board card with the alert's title and link, optionally assigned).
 */
export function CardActions({ m, conv }: { m: Message; conv: Conversation }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const me = useMyId();
  const boardsOn = useModuleEnabled('boards');
  const [busy, setBusy] = useState(false);
  const [carding, setCarding] = useState(false);
  const claim = m.claim ?? null;
  const mine = claim?.user.id === me;
  const canWrite = conv.permissions.write;
  if (!m.card || !canWrite) return null;

  const toggle = async () => {
    setBusy(true);
    try {
      const next = await api.call(mine ? 'unclaimMessage' : 'claimMessage', {
        params: { messageId: m.id },
      });
      putMessages(qc, next.conversationId, [next]);
      patchMessage(qc, next.conversationId, next.id, () => next);
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-no-quick-react="">
      {claim ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-bg2 py-0.5 pr-2.5 pl-1 text-xs font-semibold">
          <PersonAvatar user={claim.user} size="sm" />
          {mine
            ? t('chat.cardActions.claimedByMe')
            : t('chat.cardActions.claimedBy', { name: claim.user.name })}
        </span>
      ) : null}
      <Button size="xs" variant="out" disabled={busy} onClick={() => void toggle()}>
        <Icon name={mine ? 'x' : 'eye'} size={13} />
        {mine ? t('chat.cardActions.release') : t('chat.cardActions.claim')}
      </Button>
      {boardsOn ? (
        <Button size="xs" variant="out" onClick={() => setCarding(true)}>
          <Icon name="board" size={13} />
          {t('chat.cardActions.toBoard')}
        </Button>
      ) : null}
      {carding ? <ToBoardDialog m={m} conv={conv} onOpenChange={setCarding} /> : null}
    </div>
  );
}

const NOBODY = 'none';

function ToBoardDialog({
  m,
  conv,
  onOpenChange,
}: {
  m: Message;
  conv: Conversation;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const card = m.card!;
  // Until the person picks, the chat's space (or the first one), its first board and column.
  const spaces = useQuery(spacesQuery());
  const [pickedSpace, setSpaceId] = useState(conv.spaceId ?? '');
  const spaceId = pickedSpace || spaces.data?.items[0]?.id || '';
  const boards = useQuery({ ...boardsQuery(spaceId), enabled: !!spaceId });
  const [pickedBoard, setBoardId] = useState('');
  const boardId = boards.data?.items.some((b) => b.id === pickedBoard)
    ? pickedBoard
    : (boards.data?.items[0]?.id ?? '');
  const board = useQuery({ ...boardQuery(boardId), enabled: !!boardId });
  const [pickedColumn, setColumnId] = useState('');
  const columnId = board.data?.columns.some((c) => c.id === pickedColumn)
    ? pickedColumn
    : (board.data?.columns[0]?.id ?? '');
  const [assignee, setAssignee] = useState(NOBODY);
  const [title, setTitle] = useState(card.title);
  const [busy, setBusy] = useState(false);

  const link = card.buttons[0]?.url;
  const description = [
    card.subtitle,
    card.text,
    ...card.fields.map((f) => `${f.label}: ${f.value}`),
    link,
  ]
    .filter(Boolean)
    .join('\n');

  const create = async () => {
    if (!boardId || !columnId || !title.trim()) return;
    setBusy(true);
    try {
      const created = await api.call('createBoardCard', {
        params: { boardId },
        body: {
          columnId,
          title: title.trim(),
          description: description || undefined,
          assigneeIds: assignee === NOBODY ? [] : [assignee],
        },
      });
      toast(t('chat.cardActions.created', { title: created.title }));
      onOpenChange(false);
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={460}>
        <DialogHeader
          title={t('chat.cardActions.toBoard')}
          description={t('chat.cardActions.toBoardHint')}
        />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label={t('chat.cardActions.title')}>
            <Input value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label={t('chat.cardActions.space')}>
            <Select
              value={spaceId}
              onValueChange={(v) => {
                setSpaceId(v);
                setBoardId('');
                setColumnId('');
              }}
            >
              <SelectTrigger aria-label={t('chat.cardActions.space')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(spaces.data?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('chat.cardActions.board')}>
            <Select
              value={boardId}
              onValueChange={(v) => {
                setBoardId(v);
                setColumnId('');
              }}
            >
              <SelectTrigger aria-label={t('chat.cardActions.board')}>
                <SelectValue placeholder={t('chat.cardActions.noBoard')} />
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
          <Field label={t('chat.cardActions.column')}>
            <Select value={columnId} onValueChange={setColumnId}>
              <SelectTrigger aria-label={t('chat.cardActions.column')}>
                <SelectValue />
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
          <Field label={t('chat.cardActions.assignee')}>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger aria-label={t('chat.cardActions.assignee')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NOBODY}>{t('chat.cardActions.nobody')}</SelectItem>
                {(board.data?.people ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={busy || !columnId || !title.trim()}>
              {t('chat.cardActions.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
