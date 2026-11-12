import { cva, type VariantProps } from 'class-variance-authority';
import { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';
import { Icon, type IconName } from '../icons/Icon';

export type SpaceColorSlot = 's1' | 's2' | 's3' | 's4' | 's5' | 's6';

const SPACE_BG: Record<SpaceColorSlot, string> = {
  s1: 'bg-s1',
  s2: 'bg-s2',
  s3: 'bg-s3',
  s4: 'bg-s4',
  s5: 'bg-s5',
  s6: 'bg-s6',
};

/**
 * First letter(s) for avatars and space badges, locale aware (i -> İ in Turkish). Leading
 * punctuation is skipped so "SSO (OIDC)" gives "SO", not "S(".
 */
export function initials(name: string, max = 2, locale = 'tr'): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const clean = words.map((w) => w.replace(/^[^\p{L}\p{N}]+/u, '')).filter(Boolean);
  const parts = clean.length > 0 ? clean : words;
  const pick = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return pick
    .slice(0, max)
    .map((p) => (p ?? '').charAt(0))
    .join('')
    .toLocaleUpperCase(locale);
}

// ---- Space badge and dot (category color, not accent) ----

const spaceBadge = cva(
  'flex shrink-0 items-center justify-center font-bold text-white select-none',
  {
    variants: {
      size: {
        sm: 'size-5 rounded-[6px] text-[10px] leading-3',
        md: 'size-7 rounded-sm text-[12.5px] leading-[14px]',
        lg: 'size-9 rounded-md text-[15px] leading-[18px]',
        xl: 'size-14 rounded-2xl text-[22px] leading-6',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export function SpaceBadge({
  color,
  name,
  size,
  className,
  children,
}: VariantProps<typeof spaceBadge> & {
  color: SpaceColorSlot;
  name: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span aria-hidden="true" className={cn(spaceBadge({ size }), SPACE_BG[color], className)}>
      {children ?? initials(name, 1)}
    </span>
  );
}

export function SpaceDot({ color, className }: { color: SpaceColorSlot; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 shrink-0 rounded-full', SPACE_BG[color], className)}
    />
  );
}

// ---- Avatar ----

const avatar = cva(
  'relative flex shrink-0 items-center justify-center rounded-full bg-bg2 font-semibold text-fg select-none',
  {
    variants: {
      size: {
        sm: 'size-6 text-[10px]',
        md: 'size-8 text-xs',
        base: 'size-9 text-[13px]',
        lg: 'size-14 text-[19px]',
        xl: 'size-[88px] text-[30px]',
      },
    },
    defaultVariants: { size: 'base' },
  },
);

export interface AvatarProps extends VariantProps<typeof avatar> {
  name: string;
  src?: string | null;
  /** Presence dot (doc 16): online green, away amber, busy red, do-not-disturb red with a bar. */
  presence?: 'online' | 'away' | 'busy' | 'dnd' | null;
  /** Extra classes for the presence dot (e.g. a pop when the state just changed). */
  presenceClassName?: string;
  className?: string;
}

export function Avatar({ name, src, size, presence, presenceClassName, className }: AvatarProps) {
  return (
    <span className={cn(avatar({ size }), className)} title={name}>
      {src ? (
        <img src={src} alt="" className="size-full rounded-full object-cover" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
      {presence ? (
        <span
          className={cn(
            'absolute -right-px -bottom-px flex size-[9px] items-center justify-center rounded-full shadow-[0_0_0_2px_var(--bg)] transition-colors duration-(--t-base)',
            presence === 'online' ? 'bg-success' : presence === 'away' ? 'bg-warning' : 'bg-danger',
            presenceClassName,
          )}
        >
          {presence === 'dnd' ? <span className="h-px w-[5px] bg-bg" /> : null}
        </span>
      ) : null}
    </span>
  );
}

// ---- Tag, badge, count, kbd, status dot ----

const tag = cva(
  'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-xs px-2 text-tag font-semibold whitespace-nowrap',
  {
    variants: {
      tone: {
        default: 'bg-bg2 text-fg2',
        inv: 'bg-fg text-bg',
        out: 'bg-transparent text-fg2 shadow-line2',
        test: 'bg-[color-mix(in_srgb,var(--info)_12%,transparent)] text-info',
        prod: 'bg-[color-mix(in_srgb,var(--danger)_11%,transparent)] text-danger',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);

export function Tag({
  tone,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof tag>) {
  return <span className={cn(tag({ tone }), className)} {...props} />;
}

const badge = cva(
  'inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full px-2 text-tag font-semibold whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current',
  {
    variants: {
      tone: {
        default: 'bg-bg2 text-fg2',
        ok: 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-success',
        warn: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-warning',
        danger: 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger',
        info: 'bg-[color-mix(in_srgb,var(--info)_12%,transparent)] text-info',
        accent: 'bg-accent10 text-accent-text',
      },
      plain: { true: 'before:hidden', false: '' },
    },
    defaultVariants: { tone: 'default', plain: false },
  },
);

export function Badge({
  tone,
  plain,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone, plain }), className)} {...props} />;
}

const count = cva(
  'h-5 min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] leading-5 font-bold',
  {
    variants: {
      tone: {
        default: 'bg-fg text-bg',
        accent: 'bg-accent text-accent-fg',
        mute: 'bg-bg2 text-fg2',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);

export function Count({
  tone,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof count>) {
  return <span className={cn(count({ tone }), className)} {...props} />;
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        // Keyboard hints mean nothing on a touch screen (W9).
        'shrink-0 rounded-xs px-1.5 py-[3px] font-mono text-[11px] leading-[14px] font-medium text-fg2 shadow-line2 pointer-coarse:hidden',
        className,
      )}
      {...props}
    />
  );
}

export function StatusDot({
  status,
  className,
}: {
  status: 'up' | 'down' | 'warn' | 'none';
  className?: string;
}) {
  const tone = { up: 'bg-success', down: 'bg-danger', warn: 'bg-warning', none: 'bg-fg3' }[status];
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', tone, className)} />;
}

// ---- Chip (filter, view choice: inverted when on, never accent) ----

export function Chip({
  on,
  size = 'md',
  className,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { on?: boolean; size?: 'md' | 'sm' }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn(
        'press inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        size === 'sm' ? 'h-[26px] px-[9px] text-xs' : 'h-8 px-3 text-[13.5px] leading-[18px]',
        on ? 'bg-fg text-bg' : 'bg-bg2 text-fg hover:bg-capsule',
        className,
      )}
      {...props}
    />
  );
}

// ---- Loading ----

/**
 * Loading placeholder. It stays invisible for the first 180 ms, so a quick load (or data from
 * the cache) never flashes a skeleton; only a real wait shows it.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn('skeleton block h-3 rounded-xs bg-bg2', className)} />
  );
}

export function Spinner({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        'inline-block shrink-0 animate-[crewhall-spin_.8s_linear_infinite] rounded-full border-[2.5px] border-line2 border-t-fg',
        className,
      )}
    />
  );
}

export function Progress({
  value,
  neutral,
  large,
  className,
  label,
}: {
  value: number;
  neutral?: boolean;
  large?: boolean;
  className?: string;
  label?: string;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={label}
      className={cn('overflow-hidden rounded-full bg-bg2', large ? 'h-2' : 'h-1.5', className)}
    >
      <i
        className={cn('block h-full rounded-full', neutral ? 'bg-fg' : 'bg-accent')}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

// ---- Empty state ----

export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2.5 px-6 py-8 text-center', className)}>
      <span className="flex size-16 items-center justify-center rounded-4xl bg-bg2 text-fg2">
        <Icon name={icon} size={32} />
      </span>
      <span className="mt-1 text-sub font-semibold text-fg">{title}</span>
      {description ? <p className="max-w-[360px] text-sm text-fg2">{description}</p> : null}
      {children ? <div className="mt-2 flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** Kit `.ibox`: neutral square icon holder. */
export function IconBox({
  icon,
  size = 'md',
  className,
}: {
  icon: IconName;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const s = { sm: 'size-7 rounded-sm', md: 'size-9 rounded-md', lg: 'size-11 rounded-lg' }[size];
  return (
    <span className={cn('flex shrink-0 items-center justify-center bg-bg2 text-fg', s, className)}>
      <Icon name={icon} size={size === 'sm' ? 16 : 18} />
    </span>
  );
}
