import { type DriveNode } from '@crewhall/shared';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader } from '@crewhall/ui';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { NodePicker, type PickerPlace } from './NodePicker';

/** Pick any Drive node (quick access "Dosya / klasör" card). */
export function NodePickerDialog({
  open,
  title,
  confirm,
  onClose,
  onPick,
  accept,
}: {
  open: boolean;
  title: string;
  confirm: string;
  onClose: () => void;
  onPick: (node: DriveNode) => void;
  /** Only these nodes can be picked; folders still open. */
  accept?: (node: DriveNode) => boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      {open ? (
        <Body title={title} confirm={confirm} onClose={onClose} onPick={onPick} accept={accept} />
      ) : null}
    </Dialog>
  );
}

function Body({
  title,
  confirm,
  onClose,
  onPick,
  accept,
}: {
  title: string;
  confirm: string;
  onClose: () => void;
  onPick: (node: DriveNode) => void;
  /** Only these nodes can be picked; folders still open. */
  accept?: (node: DriveNode) => boolean;
}) {
  const { t } = useI18n();
  const { preferred } = useSpaces();
  const [place, setPlace] = useState<PickerPlace>({
    spaceId: preferred()?.id ?? '',
    folderId: null,
    path: [],
  });
  const [picked, setPicked] = useState<DriveNode | null>(null);
  return (
    <DialogContent width={640}>
      <DialogHeader icon="folder" title={title} description={t('drive.picker.hint')} />
      <NodePicker
        mode="node"
        place={place}
        onPlace={(p) => {
          setPlace(p);
          setPicked(null);
        }}
        selectedId={picked?.id}
        onSelect={setPicked}
        accept={accept}
      />
      <DialogFooter>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button variant="pri" disabled={!picked} onClick={() => picked && onPick(picked)}>
          {confirm}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
