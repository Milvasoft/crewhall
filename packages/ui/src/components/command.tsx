import { Command as CommandPrimitive } from 'cmdk';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../cn';
import { Icon } from '../icons/Icon';

/** cmdk primitives styled for the command palette (doc 02 · 2.9). */
export const Command = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn('flex h-full w-full flex-col overflow-hidden text-fg', className)}
      {...props}
    />
  );
});

export const CommandInput = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(function CommandInput({ className, ...props }, ref) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
      <Icon name="search" size={18} className="text-fg2" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg3 focus-visible:shadow-none',
          className,
        )}
        {...props}
      />
    </div>
  );
});

export const CommandList = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn('max-h-[420px] overflow-y-auto overscroll-contain p-2', className)}
      {...props}
    />
  );
});

export const CommandEmpty = CommandPrimitive.Empty;

export const CommandGroup = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn(
        '[&_[cmdk-group-heading]]:eyebrow [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1.5',
        className,
      )}
      {...props}
    />
  );
});

export const CommandItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2.5 text-sm text-fg outline-none select-none data-[disabled=true]:opacity-40 data-[selected=true]:bg-capsule',
        className,
      )}
      {...props}
    />
  );
});

export const CommandSeparator = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(function CommandSeparator({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Separator
      ref={ref}
      className={cn('mx-2 my-1 h-px bg-line', className)}
      {...props}
    />
  );
});
