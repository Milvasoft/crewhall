import { type DriveNode } from '@crewhall/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { surfacesQuery } from '@/features/quick/api';
import { useChatEnabled } from '@/lib/chat/enabled';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newTabLabel, openInNewTab } from '@/lib/newTab';
import { useOfficeMode } from '@/lib/office/queries';
import { type NodeActions } from './actions';
import { isPreviewable } from './fileKinds';

/**
 * Right-click menu of Drive nodes (3.12): type-specific items on top, the same skeleton for
 * every type, single-item entries hidden in multi-select, forbidden ones greyed with a reason.
 */
export function useNodeMenu(actions: NodeActions) {
  const { t } = useI18n();
  const surfaces = useQuery({ ...surfacesQuery, retry: false });
  const officeMode = useOfficeMode();
  const navigate = useNavigate();
  const chatOn = useChatEnabled();

  return (nodes: DriveNode[]): ActionEntry[] => {
    const one = nodes.length === 1 ? nodes[0]! : null;
    const all = (a: Parameters<NodeActions['can']>[1]) => nodes.every((n) => actions.can(n, a));
    const noEdit = all('space.edit_content') ? undefined : t('drive.menu.noEdit');
    const noTrash = all('space.trash') ? undefined : t('drive.menu.noTrash');
    const files = nodes.filter((n) => n.type === 'file');
    const entries: ActionEntry[] = [];

    if (one) {
      if (one.type === 'file' && isPreviewable(one)) {
        entries.push({
          kind: 'item',
          key: 'preview',
          icon: 'eye',
          label: t('drive.menu.preview'),
          shortcut: t('drive.keys.space'),
          onSelect: () => actions.preview(one),
        });
      } else {
        entries.push({
          kind: 'item',
          key: 'open',
          icon: 'arrowUR',
          label: t('drive.menu.open'),
          shortcut: '↵',
          onSelect: () => actions.open(one),
        });
      }
      entries.push({
        kind: 'item',
        key: 'newTab',
        icon: 'ext',
        label: t(newTabLabel()),
        onSelect: () => openInNewTab(actions.href(one)),
      });
      const office = officeMode(one, actions.can(one, 'space.edit_content'));
      if (office) {
        entries.push({
          kind: 'item',
          key: 'office',
          icon: office === 'edit' ? 'edit' : 'eye',
          label: t(office === 'edit' ? 'office.open.editInOffice' : 'office.open.view'),
          onSelect: () => void navigate({ to: '/office/$nodeId', params: { nodeId: one.id } }),
        });
      }
      entries.push({
        kind: 'item',
        key: 'share',
        icon: 'share',
        label: t('drive.menu.share'),
        disabledReason:
          actions.can(one, 'space.share_user') || actions.can(one, 'space.share_link')
            ? undefined
            : t('drive.menu.noShare'),
        onSelect: () => actions.share(one),
      });
      entries.push({
        kind: 'item',
        key: 'link',
        icon: 'link',
        label: t('drive.menu.copyLink'),
        shortcut: 'Ctrl Shift C',
        onSelect: () => actions.copyLink(one),
      });
      if (chatOn) {
        entries.push({
          kind: 'item',
          key: 'sendToChat',
          icon: 'send',
          label: t('chat.refs.sendToChat'),
          onSelect: () => actions.sendToChat(one),
        });
      }
      entries.push({
        kind: 'item',
        key: 'fav',
        icon: 'star',
        label: one.favorite ? t('drive.menu.unfavorite') : t('drive.menu.favorite'),
        onSelect: () => actions.favorite(one),
      });
      const targets = (surfaces.data?.items ?? []).filter((s) => s.canEdit);
      if (targets.length) {
        entries.push({
          kind: 'sub',
          key: 'pin',
          icon: 'pin',
          label: t('drive.menu.pin'),
          items: targets.map((s) => ({
            key: s.id,
            label: s.owner.type === 'space' ? s.owner.spaceName : t('home.mine'),
            onSelect: () => actions.pin(one, s.id),
          })),
        });
      }
      entries.push({ kind: 'sep', key: 's1' });
      entries.push({
        kind: 'item',
        key: 'rename',
        icon: 'edit',
        label: t('drive.menu.rename'),
        shortcut: 'F2',
        disabledReason: noEdit,
        onSelect: () => actions.rename(one),
      });
    }
    entries.push({
      kind: 'item',
      key: 'move',
      icon: 'arrowR',
      label: t('drive.menu.move'),
      shortcut: 'M',
      disabledReason: noEdit,
      onSelect: () => actions.move(nodes),
    });
    entries.push({
      kind: 'item',
      key: 'copy',
      icon: 'copy',
      label: t('drive.menu.copy'),
      onSelect: () => actions.copy(nodes),
    });
    if (files.length) {
      entries.push({
        kind: 'item',
        key: 'download',
        icon: 'download',
        label: t('drive.menu.download'),
        onSelect: () => void actions.download(files),
      });
    }
    if (one) {
      if (one.type === 'file') {
        entries.push({
          kind: 'item',
          key: 'versions',
          icon: 'history',
          label: t('drive.menu.versions', { count: one.version ?? 1 }),
          onSelect: () => actions.details(one),
        });
      }
      entries.push({
        kind: 'item',
        key: 'details',
        icon: 'info',
        label: t('drive.menu.details'),
        shortcut: 'I',
        onSelect: () => actions.details(one),
      });
    }
    entries.push({ kind: 'sep', key: 's2' });
    entries.push({
      kind: 'item',
      key: 'trash',
      icon: 'trash',
      label: t('drive.menu.trash'),
      shortcut: 'Del',
      danger: true,
      disabledReason: noTrash,
      onSelect: () => actions.trash(nodes),
    });
    return entries;
  };
}
