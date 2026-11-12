import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from 'radix-ui';
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { cn } from '../cn';
import {
  addMonths,
  clampDay,
  DATE_RANGE_PRESETS,
  dayOf,
  dayParts,
  daysInMonth,
  formatDay,
  formatDayLong,
  formatMonthYear,
  formatTimeOfDay,
  monthGrid,
  monthNames,
  parseIsoDate,
  parseIsoTime,
  presetRange,
  startOfWeek,
  toIsoDate,
  toIsoTime,
  todayIso,
  weekdayNames,
  weekStartOf,
  type DateRangePreset,
} from '../date';
import { Icon, type IconName } from '../icons/Icon';
import { NARROW_QUERY, useMediaQuery } from '../viewport';
import { IconButton } from './button';
import { inputShell, useFieldProps } from './form';

// ---- Locale and labels (set once by the app, doc 02 · 9.4 "Tarih seçici") ----

export interface PickerLabels {
  datePlaceholder: string;
  rangePlaceholder: string;
  timePlaceholder: string;
  chooseDate: string;
  chooseRange: string;
  chooseTime: string;
  clear: string;
  previousMonth: string;
  nextMonth: string;
  previousYear: string;
  nextYear: string;
  previousYears: string;
  nextYears: string;
  chooseMonthYear: string;
  chooseYear: string;
  hours: string;
  minutes: string;
  /** Announced after the first click of a range: "{from}: choose the end date". */
  pickEnd: (from: string) => string;
  presets: Record<DateRangePreset | 'custom', string>;
}

const EN_LABELS: PickerLabels = {
  datePlaceholder: 'Select date',
  rangePlaceholder: 'Select range',
  timePlaceholder: '--:--',
  chooseDate: 'Choose date',
  chooseRange: 'Choose date range',
  chooseTime: 'Choose time',
  clear: 'Clear',
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  previousYear: 'Previous year',
  nextYear: 'Next year',
  previousYears: 'Previous years',
  nextYears: 'Next years',
  chooseMonthYear: 'Choose month and year',
  chooseYear: 'Choose year',
  hours: 'Hour',
  minutes: 'Minute',
  pickEnd: (from) => `Start ${from}, choose the end date`,
  presets: {
    today: 'Today',
    yesterday: 'Yesterday',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    thisMonth: 'This month',
    lastMonth: 'Last month',
    custom: 'Custom',
  },
};

interface PickerLocale {
  locale: string;
  labels: PickerLabels;
  weekStart: number;
}

const PickerLocaleContext = createContext<PickerLocale>({
  locale: 'en-US',
  labels: EN_LABELS,
  weekStart: weekStartOf('en-US'),
});

export function PickerLocaleProvider({
  locale,
  labels,
  children,
}: {
  /** BCP 47 tag ("tr-TR"); decides the date format and the first day of the week. */
  locale: string;
  labels: PickerLabels;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, labels, weekStart: weekStartOf(locale) }),
    [locale, labels],
  );
  return <PickerLocaleContext.Provider value={value}>{children}</PickerLocaleContext.Provider>;
}

function usePickerLocale(): PickerLocale {
  return useContext(PickerLocaleContext);
}

// ---- Surface: anchored panel on wide screens, bottom sheet on narrow ones ----

function PickerSurface({
  open,
  onOpenChange,
  anchor,
  returnFocusRef,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: ReactElement;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const narrow = useMediaQuery(NARROW_QUERY);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const interactedOutside = useRef(false);

  // First focus goes to the element marked `data-picker-initial` (selected day, hour). It must
  // happen here, once Radix has registered this panel's focus scope: focusing earlier, from a
  // layout effect, lets a surrounding dialog's focus trap pull focus back to the trigger.
  const openFocus = (e: Event) => {
    e.preventDefault();
    const panel = e.currentTarget as HTMLElement;
    panel.querySelector<HTMLElement>('[data-picker-initial]')?.focus({ preventScroll: true });
  };

  const closeFocus = (e: Event) => {
    e.preventDefault();
    if (!interactedOutside.current) returnFocusRef.current?.focus();
    interactedOutside.current = false;
  };

  if (narrow) {
    return (
      <>
        {anchor}
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-scrim" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onOpenAutoFocus={openFocus}
              onCloseAutoFocus={closeFocus}
              data-picker-sheet=""
              className={cn(
                'fixed inset-x-0 bottom-[var(--kb,0px)] z-[60] flex max-h-[calc(var(--vvh,100dvh)-var(--window-bar,0px)-24px)] flex-col overflow-y-auto overscroll-contain rounded-t-4xl bg-surface px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] text-fg shadow-overlay outline-none',
                className,
              )}
            >
              <span
                aria-hidden="true"
                className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-line2"
              />
              <DialogPrimitive.Title className="mb-2 text-sub font-bold">
                {title}
              </DialogPrimitive.Title>
              {children}
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </>
    );
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Anchor asChild ref={anchorRef}>
        {anchor}
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={title}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={openFocus}
          onCloseAutoFocus={closeFocus}
          onInteractOutside={(e) => {
            // The trigger toggles by itself; a pointer-down there must not close first.
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
            else interactedOutside.current = true;
          }}
          className={cn(
            'popper-motion z-[60] max-h-[var(--radix-popover-content-available-height)] origin-(--radix-popover-content-transform-origin) overflow-y-auto overscroll-contain rounded-2xl border border-glass-line bg-surface p-3 text-fg shadow-overlay outline-none',
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// ---- Trigger (same box as Input: height, radius, background) ----

interface TriggerProps {
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  invalid?: boolean;
  disabled?: boolean;
  size?: 'md' | 'sm';
  className?: string;
}

function PickerTrigger({
  icon,
  text,
  placeholder,
  open,
  onToggle,
  onClear,
  clearLabel,
  buttonRef,
  props,
  ref,
}: {
  ref?: Ref<HTMLDivElement>;
  icon: IconName;
  text: string | null;
  placeholder: string;
  open: boolean;
  onToggle: () => void;
  onClear?: () => void;
  clearLabel: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  props: TriggerProps;
}) {
  const f = useFieldProps(props);
  const valueId = useId();
  const describedBy = [text ? valueId : null, f['aria-describedby']].filter(Boolean).join(' ');
  return (
    <div
      ref={ref}
      data-state={open ? 'open' : 'closed'}
      className={cn(
        inputShell,
        'relative',
        props.size === 'sm' && 'h-9 gap-2 rounded-md px-3 text-[13.5px]',
        open && 'bg-surface shadow-[inset_0_0_0_1.5px_var(--fg)]',
        f.invalid &&
          'shadow-[inset_0_0_0_1.5px_var(--danger)] focus-within:shadow-[inset_0_0_0_1.5px_var(--danger)]',
        props.disabled && 'opacity-60',
        onClear && text && !props.disabled && 'pr-1.5',
        props.className,
      )}
    >
      <button
        ref={buttonRef}
        type="button"
        id={f.id}
        aria-label={props['aria-label']}
        aria-describedby={describedBy || undefined}
        aria-invalid={f['aria-invalid']}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-[inherit] text-left outline-none focus-visible:shadow-none disabled:cursor-default"
      >
        <Icon name={icon} size={props.size === 'sm' ? 16 : 18} className="shrink-0 text-fg2" />
        <span className={cn('min-w-0 flex-1 truncate tn', !text && 'text-fg3')}>
          {text ?? placeholder}
        </span>
        {text ? (
          <span id={valueId} className="sr-only">
            {text}
          </span>
        ) : null}
      </button>
      {onClear && text && !props.disabled ? (
        <IconButton
          size="xs"
          tone="plain"
          className="size-7"
          aria-label={clearLabel}
          onClick={() => {
            onClear();
            buttonRef.current?.focus();
          }}
        >
          <Icon name="x" size={14} />
        </IconButton>
      ) : null}
    </div>
  );
}

// ---- Calendar (days / months / years) ----

const navButton = 'size-8 rounded-md';

function CalendarHeader({
  title,
  titleLabel,
  onTitle,
  prev,
  next,
}: {
  title: string;
  titleLabel?: string;
  onTitle?: () => void;
  prev: { label: string; onClick: () => void; disabled?: boolean };
  next: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div className="mb-2 flex items-center gap-1">
      {onTitle ? (
        <button
          type="button"
          onClick={onTitle}
          aria-label={titleLabel ? `${title}, ${titleLabel}` : undefined}
          className="flex h-8 min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[14.5px] font-bold capitalize hover:bg-bg2"
        >
          <span aria-live="polite" className="truncate">
            {title}
          </span>
          <Icon name="chevD" size={14} className="text-fg2" />
        </button>
      ) : (
        <span aria-live="polite" className="px-2 text-[14.5px] font-bold">
          {title}
        </span>
      )}
      <span className="flex-1" />
      <IconButton
        size="sm"
        tone="plain"
        shape="sq"
        className={navButton}
        aria-label={prev.label}
        disabled={prev.disabled}
        onClick={prev.onClick}
      >
        <Icon name="chevL" size={16} />
      </IconButton>
      <IconButton
        size="sm"
        tone="plain"
        shape="sq"
        className={navButton}
        aria-label={next.label}
        disabled={next.disabled}
        onClick={next.onClick}
      >
        <Icon name="chevR" size={16} />
      </IconButton>
    </div>
  );
}

interface CalendarProps {
  /** Single selection, or the start of a range. */
  selected: number | null;
  /** End of a range (range mode only). */
  rangeEnd?: number | null;
  range?: boolean;
  min: number | null;
  max: number | null;
  today: number;
  onSelect: (day: number) => void;
  /** Focus the active day on mount (the panel focuses it itself when it opens). */
  autoFocus?: boolean;
}

const GRID_KEYS: Record<string, true> = {
  ArrowLeft: true,
  ArrowRight: true,
  ArrowUp: true,
  ArrowDown: true,
  PageUp: true,
  PageDown: true,
  Home: true,
  End: true,
  Enter: true,
  ' ': true,
};

export function Calendar({
  selected,
  rangeEnd = null,
  range = false,
  min,
  max,
  today,
  onSelect,
  autoFocus = false,
}: CalendarProps) {
  const { locale, labels, weekStart } = usePickerLocale();
  const [focused, setFocused] = useState(() => clampDay(selected ?? today, min, max));
  const [view, setView] = useState<'days' | 'months' | 'years'>('days');
  const [pageYear, setPageYear] = useState(() => dayParts(focused).year);
  const [hover, setHover] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // DOM focus follows `focused` only after keyboard use in the grid.
  const moveFocus = useRef(autoFocus);

  useLayoutEffect(() => {
    if (view !== 'days' || !moveFocus.current) return;
    moveFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-day="${focused}"]`)
      ?.focus({ preventScroll: true });
  }, [focused, view]);

  const disabled = (d: number) => (min !== null && d < min) || (max !== null && d > max);
  const { year, month } = dayParts(focused);

  const go = (d: number, viaKeyboard: boolean) => {
    moveFocus.current = viaKeyboard;
    setFocused(clampDay(d, min, max));
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!GRID_KEYS[e.key]) return;
    e.preventDefault();
    switch (e.key) {
      case 'ArrowLeft':
        return go(focused - 1, true);
      case 'ArrowRight':
        return go(focused + 1, true);
      case 'ArrowUp':
        return go(focused - 7, true);
      case 'ArrowDown':
        return go(focused + 7, true);
      case 'PageUp':
        return go(addMonths(focused, e.shiftKey ? -12 : -1), true);
      case 'PageDown':
        return go(addMonths(focused, e.shiftKey ? 12 : 1), true);
      case 'Home':
        return go(startOfWeek(focused, weekStart), true);
      case 'End':
        return go(startOfWeek(focused, weekStart) + 6, true);
      default:
        if (!disabled(focused)) onSelect(focused);
    }
  };

  if (view === 'months' || view === 'years') {
    return (
      <MonthYearView
        key={view}
        view={view}
        year={pageYear}
        onYear={setPageYear}
        focused={focused}
        min={min}
        max={max}
        onView={setView}
        onPick={(d) => {
          moveFocus.current = true;
          setFocused(clampDay(d, min, max));
          setView('days');
        }}
      />
    );
  }

  const weeks = monthGrid(focused, weekStart);
  const shortDays = weekdayNames(locale, weekStart, 'short');
  const longDays = weekdayNames(locale, weekStart, 'long');
  const preview = range && selected !== null && rangeEnd === null ? hover : rangeEnd;
  const lo = selected !== null && preview !== null ? Math.min(selected, preview) : selected;
  const hi = selected !== null && preview !== null ? Math.max(selected, preview) : selected;
  const firstOfMonth = dayOf(year, month, 1);
  const lastOfMonth = dayOf(year, month, daysInMonth(year, month));

  return (
    <div className="flex w-full flex-col sm:w-[280px]">
      <CalendarHeader
        title={formatMonthYear(focused, locale)}
        titleLabel={labels.chooseMonthYear}
        onTitle={() => {
          setPageYear(year);
          setView('months');
        }}
        prev={{
          label: labels.previousMonth,
          disabled: min !== null && firstOfMonth <= min,
          onClick: () => go(addMonths(focused, -1), false),
        }}
        next={{
          label: labels.nextMonth,
          disabled: max !== null && lastOfMonth >= max,
          onClick: () => go(addMonths(focused, 1), false),
        }}
      />
      <div
        ref={gridRef}
        role="grid"
        aria-label={formatMonthYear(focused, locale)}
        onKeyDown={onGridKey}
        onMouseLeave={() => setHover(null)}
        className="flex flex-col gap-0.5"
      >
        <div role="row" className="grid grid-cols-7">
          {shortDays.map((d, i) => (
            <span
              key={i}
              role="columnheader"
              aria-label={longDays[i]}
              className="flex h-7 items-center justify-center text-[11.5px] font-semibold text-fg3 capitalize"
            >
              {d}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div role="row" key={week[0]} className="grid grid-cols-7">
            {week.map((d) => {
              const off = disabled(d);
              const outside = d < firstOfMonth || d > lastOfMonth;
              const isEnd = d === lo || d === hi;
              const inRange = range && lo !== null && hi !== null && d > lo && d < hi;
              const band =
                range && lo !== null && hi !== null && lo !== hi
                  ? d === lo
                    ? 'bg-[linear-gradient(to_right,transparent_50%,var(--accent10)_50%)]'
                    : d === hi
                      ? 'bg-[linear-gradient(to_left,transparent_50%,var(--accent10)_50%)]'
                      : inRange
                        ? 'bg-accent10'
                        : ''
                  : '';
              return (
                <div
                  role="gridcell"
                  key={d}
                  aria-selected={isEnd || inRange || undefined}
                  className={cn('flex justify-center', band)}
                >
                  <button
                    type="button"
                    data-day={d}
                    tabIndex={d === focused ? 0 : -1}
                    data-picker-initial={d === focused ? '' : undefined}
                    aria-label={formatDayLong(d, locale)}
                    aria-current={d === today ? 'date' : undefined}
                    aria-disabled={off || undefined}
                    onClick={() => {
                      if (off) return;
                      setFocused(d);
                      onSelect(d);
                    }}
                    onMouseEnter={() => {
                      if (range && !off) setHover(d);
                    }}
                    onFocus={() => {
                      if (range && selected !== null && rangeEnd === null && !off) setHover(d);
                    }}
                    className={cn(
                      'flex h-10 w-full max-w-11 cursor-pointer items-center justify-center rounded-md text-[13.5px] font-medium tn transition-colors duration-[var(--t-fast)] sm:h-9 sm:max-w-9',
                      outside && 'text-fg3',
                      !isEnd && !off && 'hover:bg-bg2',
                      d === today && !isEnd && 'shadow-[inset_0_0_0_1.5px_var(--accent-text)]',
                      isEnd && 'bg-accent font-bold text-accent-fg',
                      off && 'cursor-default text-fg3 line-through opacity-40',
                    )}
                  >
                    {dayParts(d).date}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthYearView({
  view,
  year,
  onYear: setYear,
  focused,
  min,
  max,
  onView,
  onPick,
}: {
  view: 'months' | 'years';
  year: number;
  onYear: (year: number) => void;
  focused: number;
  min: number | null;
  max: number | null;
  onView: (v: 'days' | 'months' | 'years') => void;
  onPick: (day: number) => void;
}) {
  const { locale, labels } = usePickerLocale();
  const focusedParts = dayParts(focused);
  const [cursor, setCursor] = useState(() =>
    view === 'months' ? (year === focusedParts.year ? focusedParts.month : 0) : year,
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const minYear = min !== null ? dayParts(min).year : null;
  const maxYear = max !== null ? dayParts(max).year : null;

  useLayoutEffect(() => {
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
  }, [cursor, year]);

  if (view === 'months') {
    const names = monthNames(locale, 'short');
    const offMonth = (m: number) =>
      (min !== null && dayOf(year, m, daysInMonth(year, m)) < min) ||
      (max !== null && dayOf(year, m, 1) > max);
    const pick = (m: number) => {
      if (offMonth(m)) return;
      onPick(dayOf(year, m, Math.min(focusedParts.date, daysInMonth(year, m))));
    };
    return (
      <div className="flex w-full flex-col sm:w-[280px]">
        <CalendarHeader
          title={String(year)}
          titleLabel={labels.chooseYear}
          onTitle={() => onView('years')}
          prev={{
            label: labels.previousYear,
            disabled: minYear !== null && year <= minYear,
            onClick: () => setYear(year - 1),
          }}
          next={{
            label: labels.nextYear,
            disabled: maxYear !== null && year >= maxYear,
            onClick: () => setYear(year + 1),
          }}
        />
        <div
          ref={gridRef}
          role="grid"
          aria-label={String(year)}
          className="grid grid-cols-3 gap-1"
          onKeyDown={(e) => {
            const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
            if (step !== undefined) {
              e.preventDefault();
              setCursor(Math.min(11, Math.max(0, cursor + step)));
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onView('days');
            }
          }}
        >
          {names.map((name, m) => (
            <MonthYearCell
              key={m}
              label={name}
              fullLabel={formatMonthYear(dayOf(year, m, 1), locale)}
              active={year === focusedParts.year && m === focusedParts.month}
              tabbable={m === cursor}
              disabled={offMonth(m)}
              onClick={() => pick(m)}
            />
          ))}
        </div>
      </div>
    );
  }

  const first = year - (((year % 12) + 12) % 12);
  const years = Array.from({ length: 12 }, (_, i) => first + i);
  const offYear = (y: number) =>
    (minYear !== null && y < minYear) || (maxYear !== null && y > maxYear);
  return (
    <div className="flex w-full flex-col sm:w-[280px]">
      <CalendarHeader
        title={`${first} – ${first + 11}`}
        prev={{
          label: labels.previousYears,
          disabled: minYear !== null && first <= minYear,
          onClick: () => {
            setYear(year - 12);
            setCursor(cursor - 12);
          },
        }}
        next={{
          label: labels.nextYears,
          disabled: maxYear !== null && first + 11 >= maxYear,
          onClick: () => {
            setYear(year + 12);
            setCursor(cursor + 12);
          },
        }}
      />
      <div
        ref={gridRef}
        role="grid"
        aria-label={`${first} – ${first + 11}`}
        className="grid grid-cols-3 gap-1"
        onKeyDown={(e) => {
          const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
          if (step !== undefined) {
            e.preventDefault();
            const next = cursor + step;
            setCursor(next);
            if (next < first || next > first + 11) setYear(next);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onView('months');
          }
        }}
      >
        {years.map((y) => (
          <MonthYearCell
            key={y}
            label={String(y)}
            active={y === focusedParts.year}
            tabbable={y === cursor}
            disabled={offYear(y)}
            onClick={() => {
              if (offYear(y)) return;
              setYear(y);
              onView('months');
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MonthYearCell({
  label,
  fullLabel,
  active,
  tabbable,
  disabled,
  onClick,
}: {
  label: string;
  fullLabel?: string;
  active: boolean;
  tabbable: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div role="gridcell" aria-selected={active || undefined}>
      <button
        type="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={fullLabel}
        aria-disabled={disabled || undefined}
        onClick={onClick}
        className={cn(
          'flex h-11 w-full cursor-pointer items-center justify-center rounded-md text-[13.5px] font-semibold capitalize tn hover:bg-bg2',
          active && 'bg-accent font-bold text-accent-fg hover:bg-accent',
          disabled && 'cursor-default opacity-40 hover:bg-transparent',
        )}
      >
        {label}
      </button>
    </div>
  );
}

// ---- DatePicker ----

export interface DatePickerProps extends TriggerProps {
  /** "yyyy-MM-dd" or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  min?: string | null;
  max?: string | null;
  placeholder?: string;
  /** Shows the clear button when there is a value (default true). */
  clearable?: boolean;
  /** "yyyy-MM-dd"; defaults to the local today. */
  today?: string;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder,
  clearable = true,
  today,
  ...props
}: DatePickerProps) {
  const { locale, labels } = usePickerLocale();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const day = parseIsoDate(value);
  const minDay = parseIsoDate(min);
  const maxDay = parseIsoDate(max);
  const todayDay = parseIsoDate(today ?? todayIso()) ?? 0;

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      returnFocusRef={buttonRef}
      title={labels.chooseDate}
      anchor={
        <PickerTrigger
          icon="calendar"
          text={day !== null ? formatDay(day, locale) : null}
          placeholder={placeholder ?? labels.datePlaceholder}
          open={open}
          onToggle={() => setOpen((o) => !o)}
          onClear={clearable ? () => onChange(null) : undefined}
          clearLabel={labels.clear}
          buttonRef={buttonRef}
          props={props}
        />
      }
    >
      <Calendar
        selected={day}
        min={minDay}
        max={maxDay}
        today={todayDay}
        onSelect={(d) => {
          onChange(toIsoDate(d));
          setOpen(false);
        }}
      />
    </PickerSurface>
  );
}

// ---- DateRangePicker ----

export interface DateRange {
  from: string;
  to: string;
}

export interface DateRangePickerProps extends TriggerProps {
  value: DateRange | null;
  onChange: (value: DateRange | null) => void;
  min?: string | null;
  max?: string | null;
  placeholder?: string;
  clearable?: boolean;
  /** Quick ranges (Today, Yesterday, Last 7 days, …); default true. */
  presets?: boolean;
  today?: string;
}

export function DateRangePicker({
  value,
  onChange,
  min,
  max,
  placeholder,
  clearable = true,
  presets = true,
  today,
  ...props
}: DateRangePickerProps) {
  const { locale, labels } = usePickerLocale();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const [custom, setCustom] = useState(false);
  const [calendarKey, setCalendarKey] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const from = parseIsoDate(value?.from);
  const to = parseIsoDate(value?.to);
  const minDay = parseIsoDate(min);
  const maxDay = parseIsoDate(max);
  const todayDay = parseIsoDate(today ?? todayIso()) ?? 0;

  const presetDisabled = (p: DateRangePreset) => {
    const [a, b] = presetRange(p, todayDay);
    return (minDay !== null && a < minDay) || (maxDay !== null && b > maxDay);
  };
  const activePreset: DateRangePreset | 'custom' | null =
    draft !== null || custom
      ? 'custom'
      : from !== null && to !== null
        ? (DATE_RANGE_PRESETS.find((p) => {
            const [a, b] = presetRange(p, todayDay);
            return a === from && b === to;
          }) ?? 'custom')
        : null;

  const setOpenState = (o: boolean) => {
    setOpen(o);
    setDraft(null);
    setCustom(false);
  };
  const text =
    from !== null && to !== null
      ? from === to
        ? formatDay(from, locale)
        : `${formatDay(from, locale)} – ${formatDay(to, locale)}`
      : null;

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpenState}
      returnFocusRef={buttonRef}
      title={labels.chooseRange}
      anchor={
        <PickerTrigger
          icon="calendar"
          text={text}
          placeholder={placeholder ?? labels.rangePlaceholder}
          open={open}
          onToggle={() => setOpenState(!open)}
          onClear={clearable ? () => onChange(null) : undefined}
          clearLabel={labels.clear}
          buttonRef={buttonRef}
          props={props}
        />
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        {presets ? (
          <div
            role="group"
            aria-label={labels.chooseRange}
            className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 sm:mx-0 sm:w-[132px] sm:flex-col sm:overflow-visible sm:border-r sm:border-line sm:px-0 sm:pr-3 sm:pb-0"
          >
            {[...DATE_RANGE_PRESETS, 'custom' as const].map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={activePreset === p}
                disabled={p !== 'custom' && presetDisabled(p)}
                onClick={() => {
                  if (p === 'custom') {
                    setDraft(null);
                    setCustom(true);
                    setCalendarKey((k) => k + 1);
                    return;
                  }
                  const [a, b] = presetRange(p, todayDay);
                  onChange({ from: toIsoDate(a), to: toIsoDate(b) });
                  setOpenState(false);
                }}
                className={cn(
                  'flex h-9 shrink-0 cursor-pointer items-center rounded-md px-3 text-[13.5px] font-medium whitespace-nowrap text-fg2 hover:bg-bg2 hover:text-fg disabled:cursor-default disabled:opacity-40 sm:h-8 sm:px-2.5',
                  'max-sm:bg-bg2',
                  activePreset === p && 'bg-accent10 font-bold text-fg max-sm:bg-accent10',
                )}
              >
                {labels.presets[p]}
              </button>
            ))}
          </div>
        ) : null}
        <Calendar
          key={calendarKey}
          autoFocus={calendarKey > 0}
          range
          selected={draft ?? from}
          rangeEnd={draft !== null ? null : to}
          min={minDay}
          max={maxDay}
          today={todayDay}
          onSelect={(d) => {
            if (draft === null) {
              setDraft(d);
              return;
            }
            const a = Math.min(draft, d);
            const b = Math.max(draft, d);
            onChange({ from: toIsoDate(a), to: toIsoDate(b) });
            setOpenState(false);
          }}
        />
      </div>
      <span role="status" className="sr-only">
        {draft !== null ? labels.pickEnd(formatDay(draft, locale)) : ''}
      </span>
    </PickerSurface>
  );
}

// ---- TimePicker ("HH:mm") ----

export interface TimePickerProps extends TriggerProps {
  /** "HH:mm" (24 h) or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Minute list step (default 5). */
  minuteStep?: number;
  placeholder?: string;
  clearable?: boolean;
}

export function TimePicker({
  value,
  onChange,
  minuteStep = 5,
  placeholder,
  clearable = false,
  ...props
}: TimePickerProps) {
  const { locale, labels } = usePickerLocale();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const minutes = parseIsoTime(value);
  const hour = minutes !== null ? Math.floor(minutes / 60) : null;
  const minute = minutes !== null ? minutes % 60 : null;

  const minuteOptions = useMemo(() => {
    const step = Math.max(1, Math.min(30, Math.floor(minuteStep)));
    const list = Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step);
    if (minute !== null && !list.includes(minute)) list.push(minute);
    return list.sort((a, b) => a - b);
  }, [minuteStep, minute]);

  return (
    <PickerSurface
      open={open}
      onOpenChange={setOpen}
      returnFocusRef={buttonRef}
      title={labels.chooseTime}
      className="sm:p-1.5"
      anchor={
        <PickerTrigger
          icon="clock"
          text={minutes !== null ? formatTimeOfDay(minutes, locale) : null}
          placeholder={placeholder ?? labels.timePlaceholder}
          open={open}
          onToggle={() => setOpen((o) => !o)}
          onClear={clearable ? () => onChange(null) : undefined}
          clearLabel={labels.clear}
          buttonRef={buttonRef}
          props={props}
        />
      }
    >
      <div className="flex gap-1.5">
        <TimeColumn
          label={labels.hours}
          options={Array.from({ length: 24 }, (_, h) => h)}
          selected={hour}
          initial
          onPick={(h) => onChange(toIsoTime(h * 60 + (minute ?? 0)))}
        />
        <TimeColumn
          label={labels.minutes}
          options={minuteOptions}
          selected={minute}
          onPick={(m) => {
            onChange(toIsoTime((hour ?? 0) * 60 + m));
            setOpen(false);
          }}
        />
      </div>
    </PickerSurface>
  );
}

function TimeColumn({
  label,
  options,
  selected,
  initial,
  onPick,
}: {
  label: string;
  options: number[];
  selected: number | null;
  /** Holds the panel's first focus. */
  initial?: boolean;
  onPick: (v: number) => void;
}) {
  const [cursor, setCursor] = useState(() =>
    Math.max(0, selected !== null ? options.indexOf(selected) : 0),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list?.children[cursor] as HTMLElement | undefined;
    if (!list || !el) return;
    // Keep the active option in view without scrolling the page.
    const top = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
    if (
      el.offsetTop < list.scrollTop ||
      el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight
    ) {
      list.scrollTop = Math.max(0, top);
    }
    if (moveFocus.current) {
      moveFocus.current = false;
      el.focus({ preventScroll: true });
    }
  }, [cursor]);

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      className="flex max-h-[min(232px,calc(var(--radix-popover-content-available-height,232px)-16px))] w-full flex-col gap-px overflow-y-auto overscroll-contain [scrollbar-width:none] sm:w-[68px] [&::-webkit-scrollbar]:hidden max-sm:max-h-[40vh]"
      onKeyDown={(e) => {
        const n = options.length;
        const next =
          e.key === 'ArrowDown'
            ? Math.min(n - 1, cursor + 1)
            : e.key === 'ArrowUp'
              ? Math.max(0, cursor - 1)
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? n - 1
                  : null;
        if (next !== null) {
          e.preventDefault();
          moveFocus.current = true;
          setCursor(next);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          // Jump to the neighbouring column's active option.
          const lists =
            e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="listbox"]');
          const all = lists ? Array.from(lists) : [];
          const other = all[all.indexOf(e.currentTarget) + (e.key === 'ArrowRight' ? 1 : -1)];
          other?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
          e.preventDefault();
        }
      }}
    >
      {options.map((v, i) => (
        <button
          key={v}
          type="button"
          role="option"
          aria-selected={v === selected}
          tabIndex={i === cursor ? 0 : -1}
          data-picker-initial={initial && i === cursor ? '' : undefined}
          onClick={() => {
            setCursor(i);
            onPick(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onPick(v);
            }
          }}
          className={cn(
            'flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[14px] font-medium tn hover:bg-bg2',
            v === selected && 'bg-accent font-bold text-accent-fg hover:bg-accent',
          )}
        >
          {String(v).padStart(2, '0')}
        </button>
      ))}
    </div>
  );
}
