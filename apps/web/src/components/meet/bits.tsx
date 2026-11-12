import { type Meeting, type UserSummary } from '@crewhall/shared';
import { Avatar, cn, Icon, Switch, toast } from '@crewhall/ui';
import { type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { errorKey } from '@/lib/errors';

/** Small pieces shared by the meet screens. */

export function AvatarStack({
  people,
  max = 4,
  size = 'sm',
}: {
  people: { name: string; user: UserSummary | null }[];
  max?: number;
  size?: 'sm' | 'md';
}) {
  const shown = people.slice(0, max);
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <Avatar
          key={`${p.name}-${i}`}
          name={p.name}
          src={p.user?.imageUrl}
          size={size}
          className={cn(i > 0 && '-ml-1.5', 'ring-2 ring-surface')}
        />
      ))}
      {people.length > max ? (
        <span className="-ml-1.5 flex size-6 items-center justify-center rounded-full bg-bg2 text-[11px] font-bold text-fg2 ring-2 ring-surface">
          +{people.length - max}
        </span>
      ) : null}
    </span>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2', className)}>
      <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
      <span className="relative size-2 rounded-full bg-success" />
    </span>
  );
}

export function RecDot({ className }: { className?: string }) {
  return (
    <span className={cn('inline-block size-2 animate-pulse rounded-full bg-danger', className)} />
  );
}

/** "23 dk", "1 sa 5 dk". */
export function useDuration() {
  const { t } = useI18n();
  return (seconds: number) => {
    const m = Math.max(0, Math.round(seconds / 60));
    if (m < 60) return t('meet.duration.minutes', { min: m });
    return t('meet.duration.hours', { h: Math.floor(m / 60), min: m % 60 });
  };
}

/** mm:ss or h:mm:ss for running clocks. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A call's length in the chat: "5:13", or "1:02:07" from an hour on. */
export function callLength(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function useCopyLink() {
  const { t } = useI18n();
  return async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast(t('meet.linkCopied'));
    } catch {
      toast(url);
    }
  };
}

export function useFail() {
  const { t } = useI18n();
  return (e: unknown) => toast(t(errorKey(e)));
}

export function meetingWhere(m: Meeting, t: ReturnType<typeof useI18n>['t']) {
  const parts: string[] = [];
  if (m.spaceName) parts.push(m.spaceName);
  if (m.kind === 'room') parts.push(t('meet.kind.room'));
  else if (m.conversationId) parts.push(t('meet.kind.chatRoom'));
  return parts.join(' · ');
}

export function Section({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-line', className)}
    >
      <header className="flex items-center gap-2">
        <h2 className="text-[15px] font-bold">{title}</h2>
        <span className="ml-auto text-xs text-fg3">{aside}</span>
      </header>
      {children}
    </section>
  );
}

export function MicOff({ size = 14 }: { size?: number }) {
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <Icon name="mic" size={size} />
      <span className="absolute top-1/2 left-1/2 h-[1.5px] w-[130%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded bg-current" />
    </span>
  );
}

export function CamOff({ size = 18 }: { size?: number }) {
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <Icon name="video" size={size} />
      <span className="absolute top-1/2 left-1/2 h-[1.5px] w-[120%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded bg-current" />
    </span>
  );
}

/** Label + hint on the left, switch on the right (design 7.2 toggles). */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn('flex items-center gap-3', disabled && 'opacity-50')}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">{label}</span>
        {hint ? <span className="text-xs text-fg3">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

/** A device's name for lists (some browsers leave the label empty until permission). */

/** Device lists (H12): never wider than this; long names end with … and show in full on hover. */
/**
 * The hung-up handset (kit `callEnd`) on every leave / end-call / decline control. Filled so it
 * reads on the red button at 18-24 px; nudged up a pixel to sit in the optical centre.
 */
export function EndCallIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <Icon name="callEnd" size={size} className={cn('-translate-y-px fill-current', className)} />
  );
}

export const DEVICE_LIST_CLASS = 'max-w-[min(420px,calc(100vw-32px))]';
