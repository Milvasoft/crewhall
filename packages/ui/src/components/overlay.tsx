import {
  ContextMenu as ContextMenuPrimitive,
  Dialog as DialogPrimitive,
  DropdownMenu as MenuPrimitive,
  HoverCard as HoverCardPrimitive,
  Popover as PopoverPrimitive,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';
import { cn } from '../cn';
import { Icon, type IconName } from '../icons/Icon';

// ---- Dialog (.dim + .dlg) ----

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export const DialogContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    width?: number;
    overlayClassName?: string;
  }
>(function DialogContent(
  { className, children, width = 480, style, overlayClassName, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 animate-fade-in bg-scrim data-[state=closed]:animate-fade-out',
          overlayClassName,
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        style={{ '--dlg-w': `${width}px`, ...style } as CSSProperties}
        className={cn(
          // Desktop defaults stay unprefixed so a caller's classes (top, radius) still win there.
          'fixed top-[calc(var(--vv-top,0px)+var(--window-bar,0px)+(var(--vvh,100dvh)-var(--window-bar,0px))/2)] left-1/2 z-50 flex max-h-[calc(var(--vvh,100dvh)-var(--window-bar,0px)-48px)] w-[var(--dlg-w)] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 animate-dialog-in flex-col gap-4 overflow-y-auto overscroll-contain rounded-4xl bg-surface p-6 text-fg shadow-overlay outline-none data-[state=closed]:animate-dialog-out',
          // Phones: a small dialog rises as a bottom sheet, a larger one fills the screen.
          width <= 480 ? PHONE_SHEET : PHONE_FULL,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

const PHONE_BASE =
  'max-md:left-0 max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:animate-sheet-in max-md:data-[state=closed]:animate-sheet-out';
const PHONE_SHEET =
  PHONE_BASE +
  ' max-md:top-auto max-md:inset-x-0 max-md:bottom-[var(--kb,0px)] max-md:max-h-[calc(var(--vvh,100dvh)-var(--window-bar,0px)-24px)] max-md:rounded-t-4xl max-md:pb-[max(24px,env(safe-area-inset-bottom))]';
const PHONE_FULL =
  PHONE_BASE +
  ' max-md:inset-x-0 max-md:top-[calc(var(--vv-top,0px)+var(--window-bar,0px))] max-md:h-[calc(var(--vvh,100dvh)-var(--window-bar,0px))] max-md:max-h-none max-md:rounded-none max-md:pt-[max(20px,env(safe-area-inset-top))] max-md:pb-[max(20px,env(safe-area-inset-bottom))]';

export function DialogHeader({
  title,
  description,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-3', className)}>
      {icon ? (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg2 text-fg">
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-col gap-1">
        <DialogPrimitive.Title className="text-h font-semibold text-fg">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="text-sm text-fg2">
            {description}
          </DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        )}
      </div>
    </div>
  );
}

export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex items-center justify-end gap-2', className)}>{children}</div>;
}

// ---- Drawer: navigation from the left, or a bottom sheet (narrow screens) ----

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

export const DrawerContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: 'left' | 'bottom';
    /** Accessible name; shown only when `showTitle`. */
    title: string;
    showTitle?: boolean;
  }
>(function DrawerContent(
  { className, children, side = 'left', title, showTitle = false, ...props },
  ref,
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-scrim data-[state=closed]:animate-fade-out" />
      <DialogPrimitive.Content
        ref={ref}
        aria-describedby={undefined}
        className={cn(
          'fixed z-50 flex flex-col overflow-y-auto overscroll-contain bg-bg text-fg shadow-overlay outline-none',
          side === 'left'
            ? 'inset-y-0 left-0 h-[var(--vvh,100dvh)] w-[min(304px,86vw)] animate-drawer-in-left pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] data-[state=closed]:animate-drawer-out-left'
            : 'inset-x-0 bottom-[var(--kb,0px)] max-h-[calc(var(--vvh,100dvh)-var(--window-bar,0px)-24px)] animate-sheet-in rounded-t-4xl bg-surface px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] data-[state=closed]:animate-sheet-out',
          className,
        )}
        {...props}
      >
        {side === 'bottom' ? (
          <span
            aria-hidden="true"
            className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-line2"
          />
        ) : null}
        <DialogPrimitive.Title className={showTitle ? 'px-2 pb-2 text-sub font-bold' : 'sr-only'}>
          {title}
        </DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

// ---- Dropdown menu (.menu.glass + .mi) ----

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;
export const MenuSub = MenuPrimitive.Sub;

export const menuSurface =
  'z-[60] flex max-w-[calc(100vw-16px)] min-w-[min(220px,calc(100vw-16px))] flex-col gap-px overflow-y-auto overscroll-contain rounded-xl border border-glass-line bg-glass p-1.5 text-fg shadow-overlay backdrop-blur-[24px] backdrop-saturate-[180%]';

/**
 * Every floating panel keeps this distance from the viewport edges (doc 02 · "Açılır paneller":
 * portal to body, flip/shift on collision, height fits the space left and scrolls inside).
 */
export const COLLISION_PADDING = 8;

export const MenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
>(function MenuContent(
  { className, sideOffset = 6, collisionPadding = COLLISION_PADDING, ...props },
  ref,
) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          menuSurface,
          'popper-motion max-h-[var(--radix-dropdown-menu-content-available-height)] origin-(--radix-dropdown-menu-content-transform-origin)',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
});

export const menuItemClass =
  'flex min-h-[34px] cursor-pointer pointer-coarse:min-h-11 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium whitespace-nowrap text-fg outline-none select-none data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-capsule';

/**
 * Icon, text and shortcut of a menu item on one line. An icon given as a child (`<Icon>` next to
 * the text, instead of the `icon` prop) is lifted out of the text span: inside it the svg is a
 * block and would sit on a line of its own.
 */
function ItemBody({
  icon,
  shortcut,
  danger,
  children,
}: {
  icon?: IconName;
  shortcut?: ReactNode;
  danger?: boolean;
  children: ReactNode;
}) {
  const parts = Children.toArray(children);
  const lead = parts.filter((p) => isValidElement(p) && p.type === Icon);
  const text = parts.filter((p) => !(isValidElement(p) && p.type === Icon));
  const tone = danger ? 'text-danger' : 'text-fg2';
  return (
    <>
      {icon ? <Icon name={icon} size={16} className={cn('shrink-0', tone)} /> : null}
      {lead.map((el, i) => (
        <span key={i} className={cn('flex shrink-0', tone)}>
          {el}
        </span>
      ))}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {shortcut ? (
        <kbd
          className={cn(
            'ml-auto rounded-xs px-1.5 py-[3px] font-mono text-[11px] leading-[14px] text-fg2 shadow-line2',
            // A key combination is noise on touch; other content (a check mark) stays.
            typeof shortcut === 'string' && 'pointer-coarse:hidden',
          )}
        >
          {shortcut}
        </kbd>
      ) : null}
    </>
  );
}

export const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
    icon?: IconName;
    shortcut?: ReactNode;
    danger?: boolean;
  }
>(function MenuItem({ className, icon, shortcut, danger, children, ...props }, ref) {
  return (
    <MenuPrimitive.Item
      ref={ref}
      className={cn(menuItemClass, danger && 'text-danger', className)}
      {...props}
    >
      <ItemBody icon={icon} shortcut={shortcut} danger={danger}>
        {children}
      </ItemBody>
    </MenuPrimitive.Item>
  );
});

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="mx-1.5 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Label className="eyebrow px-2.5 pt-1.5 pb-1">{children}</MenuPrimitive.Label>
  );
}

// ---- Context menu (right click; same surface and items as the dropdown menu) ----

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export const ContextMenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextMenuContent({ className, collisionPadding = COLLISION_PADDING, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        collisionPadding={collisionPadding}
        className={cn(
          menuSurface,
          'popper-motion max-h-[var(--radix-context-menu-content-available-height)] origin-(--radix-context-menu-content-transform-origin)',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});

export const ContextMenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
    icon?: IconName;
    shortcut?: ReactNode;
    danger?: boolean;
  }
>(function ContextMenuItem({ className, icon, shortcut, danger, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(menuItemClass, danger && 'text-danger', className)}
      {...props}
    >
      <ItemBody icon={icon} shortcut={shortcut} danger={danger}>
        {children}
      </ItemBody>
    </ContextMenuPrimitive.Item>
  );
});

export const ContextMenuSubTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & { icon?: IconName }
>(function ContextMenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubTrigger ref={ref} className={cn(menuItemClass, className)} {...props}>
      {icon ? <Icon name={icon} size={16} className="text-fg2" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Icon name="chevR" size={14} className="text-fg3" />
    </ContextMenuPrimitive.SubTrigger>
  );
});

export const ContextMenuSubContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(function ContextMenuSubContent(
  { className, collisionPadding = COLLISION_PADDING, ...props },
  ref,
) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        ref={ref}
        collisionPadding={collisionPadding}
        className={cn(
          menuSurface,
          'popper-motion max-h-[var(--radix-context-menu-content-available-height)] origin-(--radix-context-menu-content-transform-origin)',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});

export function ContextMenuSeparator() {
  return <ContextMenuPrimitive.Separator className="mx-1.5 my-1 h-px bg-line" />;
}

export function ContextMenuLabel({ children }: { children: ReactNode }) {
  return (
    <ContextMenuPrimitive.Label className="eyebrow px-2.5 pt-1.5 pb-1">
      {children}
    </ContextMenuPrimitive.Label>
  );
}

export const MenuSubTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubTrigger> & { icon?: IconName }
>(function MenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <MenuPrimitive.SubTrigger ref={ref} className={cn(menuItemClass, className)} {...props}>
      {icon ? <Icon name={icon} size={16} className="text-fg2" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Icon name="chevR" size={14} className="text-fg3" />
    </MenuPrimitive.SubTrigger>
  );
});

export const MenuSubContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof MenuPrimitive.SubContent>
>(function MenuSubContent({ className, collisionPadding = COLLISION_PADDING, ...props }, ref) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        ref={ref}
        collisionPadding={collisionPadding}
        className={cn(
          menuSurface,
          'popper-motion max-h-[var(--radix-dropdown-menu-content-available-height)] origin-(--radix-dropdown-menu-content-transform-origin)',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
});

// ---- Hover card (link health details, person card) ----

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export const HoverCardContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(function HoverCardContent(
  { className, sideOffset = 8, collisionPadding = COLLISION_PADDING, ...props },
  ref,
) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'popper-motion z-[60] max-h-[var(--radix-hover-card-content-available-height)] max-w-[calc(100vw-16px)] origin-(--radix-hover-card-content-transform-origin) overflow-y-auto rounded-2xl border border-glass-line bg-surface p-4 text-fg shadow-overlay outline-none',
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
});

// ---- Popover ----

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent(
  { className, sideOffset = 6, align = 'start', collisionPadding = COLLISION_PADDING, ...props },
  ref,
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(
          'popper-motion z-[60] max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-16px)] origin-(--radix-popover-content-transform-origin) overflow-y-auto overscroll-contain rounded-2xl border border-glass-line bg-surface text-fg shadow-overlay outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});

// ---- Suggestion panel (autocomplete under a text field; focus stays in the field) ----

export function SuggestionPanel({
  open,
  onDismiss,
  anchor,
  anchorRect,
  children,
  className,
  side = 'bottom',
  'aria-label': ariaLabel,
}: {
  open: boolean;
  /** Outside click or Escape. */
  onDismiss?: () => void;
  children: ReactNode;
  className?: string;
  side?: 'top' | 'bottom';
  'aria-label'?: string;
} & (
  | {
      /** The field box the panel lines up with (same width). */
      anchor: ReactElement;
      anchorRect?: never;
    }
  | {
      anchor?: never;
      /**
       * A caret or selection box instead of a field (editor menus); read on every position
       * update, so it can follow the text. Give the panel a width through `className`.
       */
      anchorRect: () => DOMRect | null;
    }
)) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const rectRef = useRef(anchorRect);
  useLayoutEffect(() => {
    rectRef.current = anchorRect;
  });
  const virtualRef = useRef({
    getBoundingClientRect: () => rectRef.current?.() ?? new DOMRect(),
  });
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => (o ? undefined : onDismiss?.())}>
      {anchor ? (
        <PopoverPrimitive.Anchor asChild ref={anchorRef}>
          {anchor}
        </PopoverPrimitive.Anchor>
      ) : (
        <PopoverPrimitive.Anchor virtualRef={virtualRef} />
      )}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align="start"
          sideOffset={6}
          collisionPadding={COLLISION_PADDING}
          aria-label={ariaLabel}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
          // At a caret the text being typed lives elsewhere (an editor that may take focus
          // after the panel opens); only a click outside or Escape closes it.
          onFocusOutside={anchor ? undefined : (e) => e.preventDefault()}
          className={cn(
            'popper-motion z-[60] flex max-h-[min(360px,var(--radix-popover-content-available-height))] origin-(--radix-popover-content-transform-origin) w-[var(--radix-popover-trigger-width)] flex-col overflow-y-auto overscroll-contain rounded-xl border border-glass-line bg-surface p-1.5 text-fg shadow-overlay outline-none',
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ---- Tooltip (.tip, 600 ms delay) ----

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={600} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={COLLISION_PADDING}
          className="popper-motion z-[65] origin-(--radix-tooltip-content-transform-origin) rounded-[7px] bg-fg px-[9px] py-1.5 text-xs font-medium whitespace-nowrap text-bg"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---- Tabs (.tabs, accent underline) ----

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export const TabsList = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn('flex shrink-0 gap-5 border-b border-line', className)}
      {...props}
    />
  );
});

export const tabTriggerClass =
  "relative flex h-[38px] cursor-pointer items-center gap-1.5 text-nav font-medium whitespace-nowrap text-fg2 outline-none hover:text-fg data-[state=active]:font-semibold data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-[2px] data-[state=active]:after:animate-[ch-tab-in_var(--t-base)_var(--ease-out-std)_both] data-[state=active]:after:bg-accent data-[state=active]:after:content-['']";

export const TabsTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} className={cn(tabTriggerClass, className)} {...props} />;
});

// ---- Toast (.toast: inverted, bottom center, 5 s) ----

/**
 * A click on a toast closes it; its action button and links keep their own click. Sonner has no
 * click option, so the click goes to its close button, which stays out of sight (and is absent
 * on a toast marked not dismissible).
 */
function closeClickedToast(e: MouseEvent) {
  const el = e.target;
  if (!(el instanceof Element)) return;
  const toastEl = el.closest('[data-sonner-toast]');
  if (!toastEl || el.closest('button, a, input, textarea, select, [role="button"]')) return;
  toastEl.querySelector<HTMLButtonElement>('[data-close-button]')?.click();
}

export function Toaster() {
  useEffect(() => {
    document.addEventListener('click', closeClickedToast);
    return () => document.removeEventListener('click', closeClickedToast);
  }, []);
  return (
    <SonnerToaster
      position="bottom-center"
      duration={5000}
      offset={24}
      closeButton
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg bg-fg py-1.5 pr-1.5 pl-4 text-[13.5px] leading-[18px] font-medium text-bg shadow-overlay',
          closeButton: 'hidden',
          title: 'whitespace-nowrap',
          actionButton:
            'ml-auto h-[34px] cursor-pointer rounded-md bg-transparent px-3 text-[13px] font-semibold text-bg hover:bg-white/10',
          icon: 'text-bg',
        },
      }}
    />
  );
}

export { toast };
