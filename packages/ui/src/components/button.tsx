import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';
import { Spinner } from './display';

/** Kit `.btn`. At most one `pri` per screen (doc 16 §7.1). */
export const buttonVariants = cva(
  'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-semibold pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 transition-[background-color,box-shadow,opacity,filter,scale] duration-[var(--t-fast)] ease-(--ease-out-std) not-disabled:not-aria-disabled:active:scale-[.97] disabled:cursor-default disabled:opacity-40 aria-disabled:opacity-40',
  {
    variants: {
      variant: {
        default: 'bg-bg2 text-fg enabled:hover:bg-capsule',
        pri: 'bg-accent text-accent-fg enabled:hover:brightness-[.96]',
        inv: 'bg-fg text-bg enabled:hover:opacity-90',
        out: 'bg-transparent text-fg shadow-line2 enabled:hover:bg-bg2',
        gh: 'bg-transparent text-fg2 enabled:hover:bg-bg2 enabled:hover:text-fg',
        dng: 'bg-transparent text-danger enabled:hover:bg-bg2',
        dngf: 'bg-danger text-white enabled:hover:brightness-95',
      },
      size: {
        lg: 'h-[52px] rounded-full px-[22px] text-base',
        md: 'h-11 rounded-lg px-[18px] text-btn',
        sm: 'h-9 rounded-md px-3.5 text-[13.5px] leading-[18px]',
        xs: 'h-[30px] gap-1.5 rounded-sm px-2.5 text-[12.5px] leading-4',
        icon: 'size-9 rounded-md p-0',
      },
      full: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'default', size: 'md', full: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, full, asChild, loading, disabled, children, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size, full }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && !asChild ? (
        <>
          <Spinner size={16} className="border-current/30 border-t-current" />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

/** Kit `.ib`: round icon button. */
export const iconButtonVariants = cva(
  'relative inline-flex shrink-0 cursor-pointer items-center justify-center text-fg pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 transition-[color,background-color,scale] duration-[var(--t-fast)] ease-(--ease-out-std) not-disabled:active:scale-[.92] disabled:opacity-40',
  {
    variants: {
      size: { md: 'size-10', sm: 'size-8', xs: 'size-7' },
      shape: { round: 'rounded-full', sq: 'rounded-md' },
      tone: {
        filled: 'bg-bg2 hover:bg-capsule',
        plain: 'bg-transparent text-fg2 hover:bg-bg2 hover:text-fg',
      },
    },
    defaultVariants: { size: 'md', shape: 'round', tone: 'filled' },
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof iconButtonVariants> {
  /** Required: icon buttons have no visible text. */
  'aria-label': string;
  asChild?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, size, shape, tone, asChild, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(iconButtonVariants({ size, shape, tone }), className)}
      {...props}
    />
  );
});
