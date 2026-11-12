import { type DriveNode } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Segmented,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { SendToChatBody } from '@/components/chat/SendToChatDialog';
import { openDriveDialog, useDriveDialog } from './actions';
import { invalidateDrive, nodeQuery } from './api';
import { splitName } from './fileKinds';
import { NodePicker, type PickerPlace } from './NodePicker';
import { ShareDialogBody } from './ShareDialog';

/** Rename, new folder, move/copy and share; any Drive screen opens them (actions.ts). */
export function DriveDialogs() {
  const d = useDriveDialog();
  const close = () => openDriveDialog(null);
  return (
    <Dialog open={d !== null} onOpenChange={(v) => (v ? null : close())}>
      {d?.kind === 'rename' ? <RenameBody node={d.node} onClose={close} /> : null}
      {d?.kind === 'newFolder' ? (
        <NewFolderBody spaceId={d.spaceId} parentId={d.parentId} onClose={close} />
      ) : null}
      {d?.kind === 'move' || d?.kind === 'copy' ? (
        <MoveBody nodes={d.nodes} initial={d.kind} onClose={close} />
      ) : null}
      {d?.kind === 'share' ? <ShareDialogBody node={d.node} onClose={close} /> : null}
      {d?.kind === 'sendToChat' ? (
        <SendToChatBody target={d.target} title={d.title} onClose={close} />
      ) : null}
    </Dialog>
  );
}

function RenameBody({ node, onClose }: { node: DriveNode; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(node.name);
  const save = useMutation({
    mutationFn: () =>
      api.call('updateNode', { params: { nodeId: node.id }, body: { name: name.trim() } }),
    onSuccess: () => {
      invalidateDrive(qc);
      onClose();
    },
  });
  return (
    <DialogContent width={440}>
      <DialogHeader icon="edit" title={t('drive.rename.title')} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== node.name) save.mutate();
          else onClose();
        }}
      >
        <Field
          label={t('drive.rename.name')}
          error={
            save.error
              ? isApiError(save.error, 'node_name_taken')
                ? t('drive.rename.taken')
                : t(errorKey(save.error))
              : undefined
          }
        >
          <Input
            autoFocus
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => {
              // Select the name without the extension, like a file manager.
              const base = node.type === 'file' ? splitName(node.name)[0].length : node.name.length;
              e.currentTarget.setSelectionRange(0, base);
            }}
          />
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="pri"
            loading={save.isPending}
            disabled={!name.trim() || /[/\\]/.test(name)}
          >
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function NewFolderBody({
  spaceId,
  parentId,
  onClose,
}: {
  spaceId: string;
  parentId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState(t('drive.newFolder.default'));
  const save = useMutation({
    mutationFn: () =>
      api.call('createFolder', { params: { spaceId }, body: { parentId, name: name.trim() } }),
    onSuccess: (f) => {
      invalidateDrive(qc);
      toast(t('drive.newFolder.created', { name: f.name }));
      onClose();
    },
  });
  return (
    <DialogContent width={440}>
      <DialogHeader icon="folder" title={t('drive.newFolder.title')} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Field
          label={t('drive.rename.name')}
          error={
            save.error
              ? isApiError(save.error, 'node_name_taken')
                ? t('drive.rename.taken')
                : t(errorKey(save.error))
              : undefined
          }
        >
          <Input
            autoFocus
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" variant="pri" loading={save.isPending} disabled={!name.trim()}>
            {t('drive.newFolder.create')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** Taşı / kopyala (3.13): editable spaces left, the chosen space's tree right. */
function MoveBody({
  nodes,
  initial,
  onClose,
}: {
  nodes: DriveNode[];
  initial: 'move' | 'copy';
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { items: spaces } = useSpaces();
  const first = nodes[0]!;
  const parent = useQuery({ ...nodeQuery(first.parentId ?? ''), enabled: Boolean(first.parentId) });
  const [mode, setMode] = useState<'move' | 'copy'>(initial);
  const [place, setPlace] = useState<PickerPlace | null>(null);
  const current: PickerPlace = place ?? {
    spaceId: first.spaceId,
    folderId: first.parentId,
    path: parent.data ? [...parent.data.path, { id: parent.data.id, name: parent.data.name }] : [],
  };
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const destFolder = target?.id ?? current.folderId;
  const targetSpace = spaces.find((s) => s.id === current.spaceId);
  const crossSpace = current.spaceId !== first.spaceId;
  const size = nodes.reduce((a, n) => a + n.sizeBytes, 0);
  const sameAsSource = !crossSpace && destFolder === first.parentId && mode === 'move';

  const run = useMutation({
    mutationFn: () =>
      api.call(mode === 'move' ? 'moveNodes' : 'copyNodes', {
        body: {
          nodeIds: nodes.map((n) => n.id),
          target: { spaceId: current.spaceId, parentId: destFolder },
        },
      }),
    onSuccess: () => {
      invalidateDrive(qc);
      toast(t(mode === 'move' ? 'drive.move.moved' : 'drive.move.copied', { count: nodes.length }));
      onClose();
    },
  });
  const newFolder = useMutation({
    mutationFn: () =>
      api.call('createFolder', {
        params: { spaceId: current.spaceId },
        body: { parentId: current.folderId, name: t('drive.newFolder.default') },
      }),
    onSuccess: (f) => {
      invalidateDrive(qc);
      setPlace({ ...current, folderId: f.id, path: [...current.path, { id: f.id, name: f.name }] });
      setTarget(null);
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const targetPath = [targetSpace?.name, ...current.path.map((p) => p.name), target?.name]
    .filter(Boolean)
    .join(' › ');

  return (
    <DialogContent width={720}>
      <DialogHeader
        icon={mode === 'move' ? 'arrowR' : 'copy'}
        title={t(mode === 'move' ? 'drive.move.title' : 'drive.move.copyTitle', {
          count: nodes.length,
        })}
        description={`${nodes
          .map((n) => n.name)
          .slice(0, 3)
          .join(
            ', ',
          )}${nodes.length > 3 ? '…' : ''}${size ? ` · ${formatBytes(size, locale)}` : ''}`}
      />
      <Segmented
        value={mode}
        onValueChange={setMode}
        className="self-start"
        options={[
          { value: 'move', label: t('drive.move.move') },
          { value: 'copy', label: t('drive.move.copy') },
        ]}
      />
      <NodePicker
        mode="folder"
        writableOnly
        place={current}
        onPlace={(p) => {
          setPlace(p);
          setTarget(null);
        }}
        selectedId={target?.id}
        onSelect={(n) => setTarget(target?.id === n.id ? null : { id: n.id, name: n.name })}
        excludeIds={mode === 'move' ? new Set(nodes.map((n) => n.id)) : undefined}
      />
      {crossSpace && targetSpace ? (
        <Notice tone="warn">
          {t(mode === 'move' ? 'drive.move.crossSpace' : 'drive.move.crossSpaceCopy', {
            name: targetSpace.name,
            count: targetSpace.memberCount,
          })}
        </Notice>
      ) : null}
      {run.isError ? (
        <Notice tone="error">
          {isApiError(run.error, 'node_name_taken')
            ? t('drive.move.taken')
            : t(errorKey(run.error))}
        </Notice>
      ) : null}
      <DialogFooter className="justify-between">
        <span className="flex min-w-0 items-center gap-3">
          <Button
            size="sm"
            variant="gh"
            loading={newFolder.isPending}
            onClick={() => newFolder.mutate()}
          >
            <Icon name="plus" size={15} />
            {t('drive.newFolder.title')}
          </Button>
          <span className="truncate text-xs text-fg2">
            {t('drive.move.target', { path: targetPath })}
          </span>
        </span>
        <span className="flex gap-2">
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            loading={run.isPending}
            disabled={sameAsSource}
            onClick={() => run.mutate()}
          >
            {t(mode === 'move' ? 'drive.move.submitMove' : 'drive.move.submitCopy')}
          </Button>
        </span>
      </DialogFooter>
    </DialogContent>
  );
}
