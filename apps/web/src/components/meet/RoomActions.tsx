import { MEET_LIMITS, type Meeting } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  ActionContextMenu,
  ActionDropdown,
  type ActionEntry,
} from '@/components/common/ActionMenu';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { meetKeys } from '@/lib/meet/queries';
import { useCopyLink, useFail } from './bits';

type Open = 'rename' | 'rotate' | 'delete' | null;

/**
 * A persistent room's actions (right-click on its row, or the "…" button, also on touch):
 * rename, copy the link, new link, delete. Only moderators (owner, space admins) see the ones
 * that change it; the server checks again.
 */
function useRoomActions(m: Meeting) {
  const { t } = useI18n();
  const copy = useCopyLink();
  const [open, setOpen] = useState<Open>(null);
  const manage = m.permissions.moderate;
  const entries: ActionEntry[] = [
    ...(manage
      ? [
          {
            kind: 'item' as const,
            key: 'rename',
            icon: 'edit' as const,
            label: t('meet.roomActions.rename'),
            onSelect: () => setOpen('rename'),
          },
        ]
      : []),
    {
      kind: 'item',
      key: 'copy',
      icon: 'link',
      label: t('meet.actions.copyLink'),
      onSelect: () => void copy(m.url),
    },
    ...(manage
      ? [
          {
            kind: 'item' as const,
            key: 'rotate',
            icon: 'refresh' as const,
            label: t('meet.roomActions.rotate'),
            onSelect: () => setOpen('rotate'),
          },
          { kind: 'sep' as const, key: 'sep' },
          {
            kind: 'item' as const,
            key: 'delete',
            icon: 'trash' as const,
            label: t('meet.roomActions.delete'),
            danger: true,
            disabledReason: m.live ? t('meet.roomActions.endFirst') : undefined,
            onSelect: () => setOpen('delete'),
          },
        ]
      : []),
  ];
  const close = (o: boolean) => !o && setOpen(null);
  const dialogs =
    open === 'rename' ? (
      <RenameRoomDialog m={m} onOpenChange={close} />
    ) : open === 'rotate' ? (
      <RotateLinkDialog m={m} onOpenChange={close} />
    ) : open === 'delete' ? (
      <DeleteRoomDialog m={m} onOpenChange={close} />
    ) : null;
  return { entries, dialogs };
}

/** Wraps a room row: its right-click menu, plus the "…" button placed by the row. */
export function RoomActions({
  m,
  children,
}: {
  m: Meeting;
  children: (menuButton: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const { entries, dialogs } = useRoomActions(m);
  const button = (
    <ActionDropdown entries={entries}>
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('meet.roomActions.menu', { title: m.title })}
      >
        <Icon name="dots" size={16} />
      </IconButton>
    </ActionDropdown>
  );
  return (
    <>
      <ActionContextMenu entries={entries}>{children(button)}</ActionContextMenu>
      {dialogs}
    </>
  );
}

function useRoomMutation<T>(fn: () => Promise<T>, done: MessageKey, onDone: () => void) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: meetKeys.all });
      toast(t(done));
      onDone();
    },
    onError: fail,
  });
}

function RenameRoomDialog({ m, onOpenChange }: { m: Meeting; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(m.title);
  const value = title.trim();
  const valid = value.length > 0 && value.length <= MEET_LIMITS.titleChars && value !== m.title;
  const save = useRoomMutation(
    () => api.call('updateMeeting', { params: { meetingId: m.id }, body: { title: value } }),
    'meet.roomActions.renamed',
    () => onOpenChange(false),
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader title={t('meet.roomActions.renameTitle')} />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Field
            label={t('meet.roomActions.name')}
            hint={t('meet.roomActions.sameLink', { address: m.url.replace(/^https?:\/\//, '') })}
            error={value.length === 0 ? t('meet.roomActions.nameRequired') : undefined}
          >
            <Input
              autoFocus
              value={title}
              maxLength={MEET_LIMITS.titleChars}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={!valid || save.isPending}>
              {t('common.actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RotateLinkDialog({ m, onOpenChange }: { m: Meeting; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const rotate = useRoomMutation(
    () => api.call('rotateMeetingLink', { params: { meetingId: m.id } }),
    'meet.roomActions.rotated',
    () => onOpenChange(false),
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader
          title={t('meet.roomActions.rotateTitle')}
          description={t('meet.roomActions.rotateBody')}
        />
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="pri" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
            {t('meet.roomActions.rotate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRoomDialog({ m, onOpenChange }: { m: Meeting; onOpenChange: (o: boolean) => void }) {
  const { t } = useI18n();
  const remove = useRoomMutation(
    () => api.call('cancelMeeting', { params: { meetingId: m.id } }),
    'meet.roomActions.deleted',
    () => onOpenChange(false),
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={460}>
        <DialogHeader
          title={t('meet.roomActions.deleteTitle', { title: m.title })}
          description={t('meet.roomActions.deleteBody')}
        />
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="dngf" disabled={remove.isPending} onClick={() => remove.mutate()}>
            <Icon name="trash" size={14} />
            {t('meet.roomActions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
