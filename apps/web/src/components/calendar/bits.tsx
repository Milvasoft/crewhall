import { type CalendarOccurrence, type SpaceColor } from '@crewhall/shared';
import { cn, Icon, Switch, toast, type IconName } from '@crewhall/ui';
import { type ReactNode } from 'react';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Tinted chip colours per calendar colour (the six space colours of the design system). */
export const CHIP: Record<SpaceColor, string> = {
  s1: 'bg-s1/15 border-s1 text-fg',
  s2: 'bg-s2/15 border-s2 text-fg',
  s3: 'bg-s3/15 border-s3 text-fg',
  s4: 'bg-s4/15 border-s4 text-fg',
  s5: 'bg-s5/15 border-s5 text-fg',
  s6: 'bg-s6/15 border-s6 text-fg',
};

export const DOT: Record<SpaceColor, string> = {
  s1: 'bg-s1',
  s2: 'bg-s2',
  s3: 'bg-s3',
  s4: 'bg-s4',
  s5: 'bg-s5',
  s6: 'bg-s6',
};

/** Calendar checkboxes take the calendar's colour when on. */
export const CHECK: Record<SpaceColor, string> = {
  s1: 'data-[state=checked]:bg-s1',
  s2: 'data-[state=checked]:bg-s2',
  s3: 'data-[state=checked]:bg-s3',
  s4: 'data-[state=checked]:bg-s4',
  s5: 'data-[state=checked]:bg-s5',
  s6: 'data-[state=checked]:bg-s6',
};

export const COLORS: SpaceColor[] = ['s1', 's2', 's3', 's4', 's5', 's6'];

/** Chip look of an occurrence: declined and cancelled fade, tentative is dashed, free is hollow. */
export function chipClass(o: CalendarOccurrence) {
  return cn(
    'border-l-[3px]',
    CHIP[o.color],
    o.myResponse === 'declined' && 'line-through opacity-50',
    (o.myResponse === 'needs_action' || o.myResponse === 'tentative' || o.status === 'tentative') &&
      'border-dashed',
    !o.busy && o.source === 'event' && 'bg-transparent',
    o.flag === 'done' && 'opacity-60',
  );
}

export const SOURCE_ICON: Record<CalendarOccurrence['source'], IconName> = {
  event: 'calendar',
  meeting: 'video',
  card: 'board',
};

export function useFail() {
  const { t } = useI18n();
  return (e: unknown) => toast(t(errorKey(e)));
}

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

/** Title of an occurrence; private events of others read "Meşgul". */
export function useOccurrenceTitle() {
  const { t } = useI18n();
  return (o: CalendarOccurrence) => (o.hidden ? t('calendar.busy') : o.title);
}

export function SourceIcon({ o, size = 12 }: { o: CalendarOccurrence; size?: number }) {
  if (o.source === 'event' && !o.recurring) return null;
  return (
    <Icon
      name={o.source === 'event' ? 'refresh' : SOURCE_ICON[o.source]}
      size={size}
      className="shrink-0 opacity-70"
    />
  );
}
