import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  Tooltip,
  type IconName,
} from '@crewhall/ui';
import { type ReactNode } from 'react';

export type ActionEntry =
  | {
      kind: 'item';
      key: string;
      icon: IconName;
      label: string;
      shortcut?: string;
      danger?: boolean;
      /** Why the action is not allowed: the item stays, greyed, with this as a tooltip (3.12). */
      disabledReason?: string;
      onSelect: () => void;
    }
  | { kind: 'sep'; key: string }
  | {
      kind: 'sub';
      key: string;
      icon: IconName;
      label: string;
      items: { key: string; label: string; onSelect: () => void }[];
    };

/** The same entries as a right-click menu or a dropdown, so both always match. */
export function ActionContextMenu({
  entries,
  children,
  onOpenChange,
  wrapTrigger = (trigger) => trigger,
}: {
  entries: ActionEntry[];
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** Puts the trigger inside another asChild wrapper (a Tooltip) so both act on one element. */
  wrapTrigger?: (trigger: ReactNode) => ReactNode;
}) {
  // Nothing to offer (no rights here): no menu, so the browser's own one is not taken away.
  if (!entries.length) return <>{wrapTrigger(children)}</>;
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      {wrapTrigger(<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>)}
      <ContextMenuContent className="w-[260px]">
        {entries.map((e) =>
          e.kind === 'sep' ? (
            <ContextMenuSeparator key={e.key} />
          ) : e.kind === 'sub' ? (
            <ContextMenuSub key={e.key}>
              <ContextMenuSubTrigger icon={e.icon}>{e.label}</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {e.items.map((it) => (
                  <ContextMenuItem key={it.key} onSelect={it.onSelect}>
                    {it.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : (
            <Reason key={e.key} reason={e.disabledReason}>
              <ContextMenuItem
                icon={e.icon}
                shortcut={e.shortcut}
                danger={e.danger}
                disabled={Boolean(e.disabledReason)}
                onSelect={e.onSelect}
              >
                {e.label}
              </ContextMenuItem>
            </Reason>
          ),
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ActionDropdown({
  entries,
  children,
}: {
  entries: ActionEntry[];
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align="end" className="w-[260px]">
        {entries.map((e) =>
          e.kind === 'sep' ? (
            <MenuSeparator key={e.key} />
          ) : e.kind === 'sub' ? (
            <MenuSub key={e.key}>
              <MenuSubTrigger icon={e.icon}>{e.label}</MenuSubTrigger>
              <MenuSubContent>
                {e.items.map((it) => (
                  <MenuItem key={it.key} onSelect={it.onSelect}>
                    {it.label}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          ) : (
            <Reason key={e.key} reason={e.disabledReason}>
              <MenuItem
                icon={e.icon}
                shortcut={e.shortcut}
                danger={e.danger}
                disabled={Boolean(e.disabledReason)}
                onSelect={e.onSelect}
              >
                {e.label}
              </MenuItem>
            </Reason>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}

function Reason({ reason, children }: { reason?: string; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip content={reason} side="right">
      <div>{children}</div>
    </Tooltip>
  );
}
