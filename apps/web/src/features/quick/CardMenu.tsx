import { type Card, paths } from '@crewhall/shared';
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  toast,
  type IconName,
} from '@crewhall/ui';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode } from 'react';
import { nodeHref, nodeLocation } from '@/features/drive/paths';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newTabLabel, openInNewTab } from '@/lib/newTab';
import { useSpaces } from '@/lib/useSpaces';
import { useQuick } from './context';
import { canEditCard } from './EditCardDialog';
import { openLink } from './LinkBits';
import { presetSizes } from './sizes';

type Entry =
  | {
      kind: 'item';
      key: string;
      icon: IconName;
      label: string;
      shortcut?: string;
      danger?: boolean;
      onSelect: () => void;
    }
  | { kind: 'sep'; key: string }
  | { kind: 'sizes'; key: string };

/** One menu for right click and the edit-mode gear (2.7). */
function useEntries(card: Card): Entry[] {
  const { t } = useI18n();
  const q = useQuick();
  const navigate = useNavigate();
  const { items: spaces } = useSpaces();
  const entries: Entry[] = [];
  const link = card.type === 'link' ? card.links[card.config.item.linkId] : undefined;
  // Page cards point at a Drive node too: open, new tab and copy work the same way.
  const node = card.type === 'node' || card.type === 'page' ? card.node : null;
  const slug = node ? spaces.find((s) => s.id === node.spaceId)?.slug : undefined;

  if (q.canEdit && canEditCard(card)) {
    entries.push({
      kind: 'item',
      key: 'edit',
      icon: 'edit',
      label: t('quick.menu.edit'),
      shortcut: 'E',
      onSelect: () => q.openEdit(card),
    });
  }
  if (link) {
    entries.push({
      kind: 'item',
      key: 'open',
      icon: 'ext',
      label: t('quick.menu.openLink'),
      shortcut: '↵',
      onSelect: () => openLink(link),
    });
  }
  if (node && slug) {
    entries.push({
      kind: 'item',
      key: 'open',
      icon: 'arrowUR',
      label: t(`quick.menu.open.${node.type}`),
      shortcut: '↵',
      onSelect: () => void navigate(nodeLocation(node, slug)),
    });
    entries.push({
      kind: 'item',
      key: 'tab',
      icon: 'ext',
      label: t(newTabLabel()),
      onSelect: () => openInNewTab(nodeHref(node, slug)),
    });
  }
  if (q.canEdit) {
    entries.push({ kind: 'sizes', key: 'sizes' });
    entries.push({
      kind: 'item',
      key: 'dup',
      icon: 'copy',
      label: t('quick.menu.duplicate'),
      shortcut: 'Ctrl D',
      onSelect: () => q.duplicate(card),
    });
  }
  if (card.type === 'chat') {
    entries.push({
      kind: 'item',
      key: 'open',
      icon: 'chat',
      label: t('quick.menu.open.chat'),
      shortcut: '↵',
      onSelect: () =>
        void navigate({
          to: '/chat/c/$conversationId',
          params: { conversationId: card.config.conversationId },
        }),
    });
  }
  if (card.type === 'meeting') {
    entries.push({
      kind: 'item',
      key: 'open',
      icon: 'video',
      label: t('quick.menu.open.meeting'),
      onSelect: () => void navigate({ to: '/meetings' }),
    });
  }
  if (card.type === 'vault_item') {
    entries.push({
      kind: 'item',
      key: 'open',
      icon: 'vault',
      label: t('quick.menu.open.vault_item'),
      onSelect: () =>
        void navigate({
          to: '/vault/$vaultId/$category',
          params: { vaultId: card.config.vaultId, category: 'all' },
          search: { item: card.config.itemId },
        }),
    });
  }
  const chatHref =
    card.type === 'chat'
      ? `${window.location.origin}${paths.chatConversation(card.config.conversationId)}`
      : null;
  if (link || (node && slug) || chatHref) {
    entries.push({
      kind: 'item',
      key: 'copy',
      icon: 'link',
      label: t('quick.menu.copyLink'),
      onSelect: () => {
        void navigator.clipboard?.writeText(link ? link.url : (chatHref ?? nodeHref(node!, slug!)));
        toast(t('quick.menu.copied'));
      },
    });
  }
  // A vault card only goes to the person's own home (the server decides; this hides the dead end).
  const targets = q.surfaces.filter(
    (s) =>
      s.canEdit && s.id !== q.surface.id && (card.type !== 'vault_item' || s.owner.type === 'user'),
  );
  if (q.canEdit && targets.length) {
    entries.push({
      kind: 'item',
      key: 'move',
      icon: 'arrowR',
      label: t('quick.menu.move'),
      onSelect: () => q.openMove(card),
    });
  }
  if (q.surface.owner.type === 'space' && q.mySurfaceId) {
    entries.push({
      kind: 'item',
      key: 'pin',
      icon: 'pin',
      label: t('quick.menu.pinMine'),
      onSelect: () => q.pin(card, q.mySurfaceId!),
    });
  }
  if (q.canEdit && card.pinnedFrom) {
    entries.push({
      kind: 'item',
      key: 'detach',
      icon: 'unlock',
      label: t('quick.menu.detach'),
      onSelect: () => q.detach(card),
    });
  }
  if (q.canEdit) {
    entries.push({ kind: 'sep', key: 'sep' });
    entries.push({
      kind: 'item',
      key: 'remove',
      icon: 'trash',
      label: t('quick.menu.remove'),
      shortcut: 'Del',
      danger: true,
      onSelect: () => q.remove(card),
    });
  }
  return entries;
}

function SizeRow({ card }: { card: Card }) {
  const { t } = useI18n();
  const q = useQuick();
  const sizes = presetSizes(card);
  return (
    <div className="flex min-h-[34px] items-center gap-2.5 px-2.5 text-[13.5px] font-medium">
      <span className="flex-1 text-fg">{t('quick.menu.size')}</span>
      {(['S', 'M', 'L'] as const).map((label, i) => {
        const [w, h] = sizes[i]!;
        const on = card.layout.w === w && card.layout.h === h;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={on}
            aria-label={t('quick.menu.sizeOption', { size: label, w, h })}
            onClick={() => q.resize(card, [w, h])}
            className={cn(
              'h-[26px] min-w-[30px] rounded-sm px-2 text-xs font-semibold',
              on ? 'bg-fg text-bg' : 'bg-bg2 text-fg hover:bg-capsule',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function CardContextMenu({ card, children }: { card: Card; children: ReactNode }) {
  const entries = useEntries(card);
  if (!entries.length) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-[260px]">
        {entries.map((e) =>
          e.kind === 'sep' ? (
            <ContextMenuSeparator key={e.key} />
          ) : e.kind === 'sizes' ? (
            <SizeRow key={e.key} card={card} />
          ) : (
            <ContextMenuItem
              key={e.key}
              icon={e.icon}
              shortcut={e.shortcut}
              danger={e.danger}
              onSelect={e.onSelect}
            >
              {e.label}
            </ContextMenuItem>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function CardDropdown({ card, children }: { card: Card; children: ReactNode }) {
  const entries = useEntries(card);
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align="end" className="w-[260px]">
        {entries.map((e) =>
          e.kind === 'sep' ? (
            <MenuSeparator key={e.key} />
          ) : e.kind === 'sizes' ? (
            <SizeRow key={e.key} card={card} />
          ) : (
            <MenuItem
              key={e.key}
              icon={e.icon}
              shortcut={e.shortcut}
              danger={e.danger}
              onSelect={e.onSelect}
            >
              {e.label}
            </MenuItem>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}
