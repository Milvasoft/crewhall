import { type DriveNode } from '@crewhall/shared';
import { SelectionBar, SelectionButton } from '@/components/common/SelectionBar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { type useNodeActions } from './actions';

/** Bulk actions on Drive nodes (the folder, recent and search lists, Pages lists). */
export function NodeSelectionBar({
  nodes,
  actions,
  onClear,
}: {
  nodes: DriveNode[];
  actions: ReturnType<typeof useNodeActions>;
  onClear: () => void;
}) {
  const { t } = useI18n();
  if (!nodes.length) return null;
  // Recent and search mix spaces; a move goes to a folder of one space.
  const oneSpace = nodes.every((n) => n.spaceId === nodes[0]!.spaceId);
  return (
    <SelectionBar
      label={t('drive.selection.label')}
      count={t('drive.selection.count', { count: nodes.length })}
      clearLabel={t('drive.selection.clear')}
      onClear={onClear}
    >
      {nodes.length === 1 ? (
        <SelectionButton
          icon="share"
          label={t('drive.menu.share')}
          onClick={() => actions.share(nodes[0]!)}
        />
      ) : null}
      {oneSpace && nodes.every((n) => actions.can(n, 'space.edit_content')) ? (
        <SelectionButton
          icon="arrowR"
          label={t('drive.menu.move')}
          onClick={() => actions.move(nodes)}
        />
      ) : null}
      {nodes.some((n) => n.type === 'file') ? (
        <SelectionButton
          icon="download"
          label={t('drive.menu.download')}
          onClick={() => void actions.download(nodes)}
        />
      ) : null}
      {nodes.every((n) => actions.can(n, 'space.trash')) ? (
        <SelectionButton
          icon="trash"
          label={t('drive.selection.delete')}
          onClick={() => {
            actions.trash(nodes);
            onClear();
          }}
        />
      ) : null}
    </SelectionBar>
  );
}
