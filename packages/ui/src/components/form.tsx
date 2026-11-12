import {
  Checkbox as CheckboxPrimitive,
  Label as LabelPrimitive,
  RadioGroup as RadioGroupPrimitive,
  Select as SelectPrimitive,
  Switch as SwitchPrimitive,
  ToggleGroup as ToggleGroupPrimitive,
} from 'radix-ui';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ComponentPropsWithoutRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../cn';
import { Icon, type IconName } from '../icons/Icon';

// ---- Field: label + control + hint/error, wires ids for a11y ----

interface FieldCtx {
  id: string;
  hintId: string;
  errorId: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldCtx | null>(null);

export interface FieldProps {
  label?: ReactNode;
  /** Right side of the label row (e.g. "Şifremi unuttum" link). */
  labelAside?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
  id?: string;
}

export function Field({ label, labelAside, hint, error, className, children, id }: FieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  const ctx: FieldCtx = {
    id: fid,
    hintId: `${fid}-hint`,
    errorId: `${fid}-error`,
    invalid: Boolean(error),
  };
  return (
    <FieldContext.Provider value={ctx}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        {label || labelAside ? (
          <div className="flex items-center justify-between gap-2">
            {label ? <Label htmlFor={fid}>{label}</Label> : <span />}
            {labelAside}
          </div>
        ) : null}
        {children}
        {error ? (
          <span id={ctx.errorId} className="text-xs text-danger" role="alert">
            {error}
          </span>
        ) : hint ? (
          <span id={ctx.hintId} className="text-xs text-fg2">
            {hint}
          </span>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** Wires a custom control (date picker, time picker) into the surrounding `Field`. */
export function useFieldProps(props: {
  id?: string;
  'aria-describedby'?: string;
  invalid?: boolean;
}) {
  const ctx = useContext(FieldContext);
  const invalid = props.invalid ?? ctx?.invalid ?? false;
  return {
    id: props.id ?? ctx?.id,
    'aria-invalid': invalid || undefined,
    'aria-describedby':
      props['aria-describedby'] ?? (ctx ? (ctx.invalid ? ctx.errorId : ctx.hintId) : undefined),
    invalid,
  };
}

export const Label = forwardRef<
  HTMLLabelElement,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn('text-cap font-medium text-fg2', className)}
      {...props}
    />
  );
});

// ---- Input (.inp) ----

/** Kit `.inp` box shared by Input and the picker triggers. */
export const inputShell =
  'flex h-11 items-center gap-2.5 rounded-lg bg-bg2 px-3.5 text-[14.5px] leading-5 text-fg transition-[background-color,box-shadow] duration-[var(--t-fast)] focus-within:bg-surface focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)] has-[input:disabled]:opacity-60';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  icon?: IconName;
  /** Trailing content inside the box (button, tag). */
  trailing?: ReactNode;
  size?: 'md' | 'lg';
  invalid?: boolean;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, trailing, size = 'md', invalid, className, containerClassName, ...props },
  ref,
) {
  const f = useFieldProps({ ...props, invalid });
  return (
    <div
      className={cn(
        inputShell,
        size === 'lg' && 'h-[52px] rounded-2xl text-base',
        f.invalid &&
          'shadow-[inset_0_0_0_1.5px_var(--danger)] focus-within:shadow-[inset_0_0_0_1.5px_var(--danger)]',
        containerClassName,
      )}
    >
      {icon ? <Icon name={icon} size={18} className="text-fg2" /> : null}
      <input
        ref={ref}
        {...props}
        id={f.id}
        aria-invalid={f['aria-invalid']}
        aria-describedby={f['aria-describedby']}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg3 focus-visible:shadow-none',
          className,
        )}
      />
      {trailing}
    </div>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...props }, ref) {
  const f = useFieldProps({ ...props, invalid });
  return (
    <textarea
      ref={ref}
      {...props}
      id={f.id}
      aria-invalid={f['aria-invalid']}
      aria-describedby={f['aria-describedby']}
      className={cn(
        'min-h-[88px] w-full resize-y rounded-lg bg-bg2 px-3.5 py-3 text-[14.5px] leading-5 text-fg outline-none placeholder:text-fg3 focus:bg-surface focus:shadow-[inset_0_0_0_1.5px_var(--fg)] focus-visible:shadow-[inset_0_0_0_1.5px_var(--fg)]',
        f.invalid && 'shadow-[inset_0_0_0_1.5px_var(--danger)]',
        className,
      )}
    />
  );
});

// ---- Checkbox (.cb), Switch (.sw), Radio (.rd) ----

export const Checkbox = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'group flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-accent-fg shadow-[inset_0_0_0_1.5px_var(--fg3)] transition-colors data-[state=checked]:bg-accent data-[state=checked]:shadow-none data-[state=indeterminate]:bg-accent data-[state=indeterminate]:shadow-none disabled:cursor-default disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Icon
          name="check"
          size={12}
          strokeWidth={3}
          className="group-data-[state=indeterminate]:hidden"
        />
        <Icon
          name="minus"
          size={12}
          strokeWidth={3}
          className="hidden group-data-[state=indeterminate]:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

/**
 * Header box of a list with row checkboxes ("tümünü seç"): empty when nothing is selected, a
 * dash when some rows are, a tick when all are; a click selects or clears every shown row.
 */
export function SelectAllCheckbox({
  state,
  onChange,
  label,
  className,
}: {
  state: 'none' | 'some' | 'all';
  onChange: (all: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <Checkbox
      checked={state === 'all' ? true : state === 'some' ? 'indeterminate' : false}
      onCheckedChange={() => onChange(state !== 'all')}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className={className}
    />
  );
}

/** Checkbox with a clickable text label. */
export function CheckboxRow({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & { children: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-2 text-cap text-fg2', className)}>
      <Checkbox id={id} {...props} />
      <label htmlFor={id} className="cursor-pointer select-none">
        {children}
      </label>
    </div>
  );
}

export const Switch = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'flex h-6 w-10 shrink-0 cursor-pointer rounded-full bg-line2 p-[3px] transition-colors duration-[var(--t-fast)] data-[state=checked]:bg-accent disabled:cursor-default disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform duration-[var(--t-fast)] data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
});

export const RadioGroup = RadioGroupPrimitive.Root;

export const Radio = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(function Radio({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full shadow-[inset_0_0_0_1.5px_var(--fg3)] data-[state=checked]:shadow-[inset_0_0_0_2px_var(--accent)]',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-[9px] rounded-full bg-accent" />
    </RadioGroupPrimitive.Item>
  );
});

// ---- Segmented control (.seg) ----

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
}

export function Segmented<V extends string>({
  value,
  onValueChange,
  options,
  className,
  'aria-label': ariaLabel,
  size = 'md',
}: {
  value: V;
  onValueChange: (v: V) => void;
  options: SegmentedOption<V>[];
  className?: string;
  'aria-label'?: string;
  size?: 'md' | 'sm';
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(v: string) => {
        if (v) onValueChange(v as V);
      }}
      className={cn('flex gap-0.5 rounded-md bg-bg2 p-[3px]', className)}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            'flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-3 text-cap font-medium whitespace-nowrap text-fg2 transition-colors disabled:cursor-default disabled:opacity-50 data-[state=on]:bg-surface data-[state=on]:font-semibold data-[state=on]:text-fg data-[state=on]:shadow-sm dark:data-[state=on]:bg-capsule',
            size === 'sm' ? 'h-[26px]' : 'h-[30px]',
          )}
        >
          {o.icon ? <Icon name={o.icon} size={15} /> : null}
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

// ---- Select (.inp + chevD) ----

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { size?: 'md' | 'sm' }
>(function SelectTrigger({ className, children, size = 'md', ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex cursor-pointer items-center justify-between gap-2.5 rounded-lg bg-bg2 px-3.5 text-left whitespace-nowrap [&>span]:truncate text-[14.5px] leading-5 text-fg outline-none data-[placeholder]:text-fg3 disabled:cursor-default disabled:opacity-50',
        size === 'sm' ? 'h-9 rounded-md px-3 text-[13.5px]' : 'h-11',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <Icon name="chevD" size={16} className="text-fg2" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent(
  { className, children, position = 'popper', collisionPadding = 8, ...props },
  ref,
) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={6}
        collisionPadding={collisionPadding}
        className={cn(
          'z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-glass-line bg-surface p-1.5 text-fg shadow-overlay',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="flex flex-col gap-px">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    /**
     * "start": the check sits in a fixed column before the text (kept empty on other rows so they
     * line up) and long text ends with … (pass `title` for the full text). Device lists use it.
     */
    check?: 'start' | 'end';
  }
>(function SelectItem({ className, children, check = 'end', ...props }, ref) {
  if (check === 'start') {
    return (
      <SelectPrimitive.Item
        ref={ref}
        className={cn(
          'flex min-h-[34px] cursor-pointer items-center gap-2 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium text-fg outline-none select-none data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-capsule data-[state=checked]:font-semibold',
          className,
        )}
        {...props}
      >
        <span className="flex w-3.5 shrink-0 justify-center">
          <SelectPrimitive.ItemIndicator>
            <Icon name="check" size={14} />
          </SelectPrimitive.ItemIndicator>
        </span>
        <SelectPrimitive.ItemText asChild>
          <span className="min-w-0 flex-1 truncate">{children}</span>
        </SelectPrimitive.ItemText>
      </SelectPrimitive.Item>
    );
  }
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'flex min-h-[34px] cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium text-fg outline-none select-none pointer-coarse:min-h-11 data-[disabled]:cursor-default data-[disabled]:opacity-40 data-[highlighted]:bg-capsule data-[state=checked]:font-semibold',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto">
        <Icon name="check" size={14} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});
