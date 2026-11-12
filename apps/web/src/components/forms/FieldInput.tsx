import {
  FORM_LIMITS,
  ratingScale,
  type FormAnswer,
  type FormField,
  type FormFile,
} from '@crewhall/shared';
import {
  Button,
  Checkbox,
  cn,
  DatePicker,
  Icon,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Spinner,
  Textarea,
} from '@crewhall/ui';
import { useId, useRef, useState } from 'react';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * One answer control per field type (roadmap 16): text, choice, date (kit DatePicker),
 * number, file and rating. Used by the in-app and public answer pages and the builder preview.
 */
export function FieldInput({
  field,
  value,
  onChange,
  invalid,
  disabled,
  onUpload,
  describedBy,
}: {
  field: FormField;
  value: FormAnswer | undefined;
  onChange: (v: FormAnswer) => void;
  invalid?: boolean;
  disabled?: boolean;
  /** Stores a file and returns it; absent in the builder preview. */
  onUpload?: (file: File) => Promise<FormFile>;
  describedBy?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const aria = { 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined };

  switch (field.type) {
    case 'short_text':
      return (
        <Input
          {...aria}
          aria-label={field.label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={FORM_LIMITS.shortTextChars}
          disabled={disabled}
          invalid={invalid}
          placeholder={t('forms.fill.textPlaceholder')}
        />
      );
    case 'long_text':
      return (
        <Textarea
          {...aria}
          aria-label={field.label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={FORM_LIMITS.longTextChars}
          disabled={disabled}
          invalid={invalid}
          rows={4}
          placeholder={t('forms.fill.textPlaceholder')}
        />
      );
    case 'number':
      return (
        <Input
          {...aria}
          aria-label={field.label}
          type="number"
          inputMode="decimal"
          className="max-w-[220px]"
          value={typeof value === 'number' ? String(value) : ''}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          onChange={(e) => {
            const raw = e.target.value.replace(',', '.');
            onChange(raw === '' ? null : Number(raw));
          }}
          disabled={disabled}
          invalid={invalid}
        />
      );
    case 'date':
      return (
        <DatePicker
          {...aria}
          aria-label={field.label}
          className="max-w-[260px]"
          value={typeof value === 'string' ? value : null}
          onChange={(v) => onChange(v)}
          disabled={disabled}
        />
      );
    case 'single_choice':
      return (
        <RadioGroup
          {...aria}
          aria-label={field.label}
          value={typeof value === 'string' ? value : ''}
          onValueChange={(v) => onChange(v)}
          disabled={disabled}
          className="flex flex-col gap-1"
        >
          {field.choices.map((c) => (
            <label
              key={c.id}
              htmlFor={`${id}-${c.id}`}
              className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg2"
            >
              <Radio id={`${id}-${c.id}`} value={c.id} />
              <span className="text-[14.5px] text-fg">{c.label}</span>
            </label>
          ))}
          {value && !field.required ? (
            <button
              type="button"
              className="self-start px-3 text-xs font-semibold text-fg2 hover:text-fg"
              onClick={() => onChange(null)}
            >
              {t('forms.fill.clearChoice')}
            </button>
          ) : null}
        </RadioGroup>
      );
    case 'multi_choice': {
      const picked = Array.isArray(value)
        ? (value as unknown[]).filter((x) => typeof x === 'string')
        : [];
      return (
        <div role="group" aria-label={field.label} {...aria} className="flex flex-col gap-1">
          {field.choices.map((c) => (
            <label
              key={c.id}
              htmlFor={`${id}-${c.id}`}
              className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-bg2"
            >
              <Checkbox
                id={`${id}-${c.id}`}
                checked={picked.includes(c.id)}
                disabled={disabled}
                onCheckedChange={(on) =>
                  onChange(
                    on === true
                      ? [...picked, c.id]
                      : (picked as string[]).filter((x) => x !== c.id),
                  )
                }
              />
              <span className="text-[14.5px] text-fg">{c.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case 'rating':
      return (
        <Rating
          label={field.label}
          scale={ratingScale(field)}
          value={typeof value === 'number' ? value : null}
          onChange={onChange}
          disabled={disabled}
          describedBy={describedBy}
        />
      );
    case 'file':
      return (
        <FileAnswer
          field={field}
          value={Array.isArray(value) ? (value as FormFile[]) : []}
          onChange={onChange}
          onUpload={onUpload}
          disabled={disabled}
          describedBy={describedBy}
        />
      );
  }
}

function Rating({
  label,
  scale,
  value,
  onChange,
  disabled,
  describedBy,
}: {
  label: string;
  scale: number;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex flex-wrap items-center gap-1"
      onMouseLeave={() => setHover(null)}
    >
      {Array.from({ length: scale }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t('forms.fill.ratingValue', { value: n, total: scale })}
          disabled={disabled}
          onMouseEnter={() => setHover(n)}
          onFocus={() => setHover(n)}
          onBlur={() => setHover(null)}
          onClick={() => onChange(value === n ? null : n)}
          className={cn(
            'flex size-10 items-center justify-center rounded-lg transition-colors hover:bg-bg2 disabled:cursor-default',
            n <= shown ? 'text-accent' : 'text-fg3',
          )}
        >
          <Icon name="star" size={24} className={n <= shown ? 'fill-current' : undefined} />
        </button>
      ))}
      {value ? (
        <span className="ml-2 text-sm text-fg2" aria-hidden>
          {value}/{scale}
        </span>
      ) : null}
    </div>
  );
}

function FileAnswer({
  field,
  value,
  onChange,
  onUpload,
  disabled,
  describedBy,
}: {
  field: FormField;
  value: FormFile[];
  onChange: (v: FormFile[]) => void;
  onUpload?: (file: File) => Promise<FormFile>;
  disabled?: boolean;
  describedBy?: string;
}) {
  const { t, locale } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = value.length >= field.maxFiles;

  async function pick(files: FileList | null) {
    if (!files?.length || !onUpload) return;
    setError(null);
    const room = field.maxFiles - value.length;
    const list = [...files].slice(0, room);
    const tooBig = list.find((f) => f.size > FORM_LIMITS.fileBytes);
    if (tooBig) {
      setError(t('errors.form_file_too_large'));
      return;
    }
    setBusy(true);
    try {
      const done: FormFile[] = [];
      for (const f of list) done.push(await onUpload(f));
      onChange([...value, ...done]);
    } catch {
      setError(t('errors.form_file_invalid'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-2" aria-describedby={describedBy}>
      {value.map((f) => (
        <div key={f.fileId} className="flex items-center gap-2 rounded-lg bg-bg2 px-3 py-2">
          <Icon name="file" size={16} className="text-fg2" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg">{f.name}</span>
          <span className="text-xs text-fg3">{formatBytes(f.sizeBytes, locale)}</span>
          <IconButton
            size="sm"
            aria-label={t('forms.fill.removeFile', { name: f.name })}
            disabled={disabled}
            onClick={() => onChange(value.filter((x) => x.fileId !== f.fileId))}
          >
            <Icon name="x" size={14} />
          </IconButton>
        </div>
      ))}
      {!full ? (
        <div className="flex items-center gap-3">
          <input
            ref={input}
            type="file"
            className="hidden"
            multiple={field.maxFiles - value.length > 1}
            aria-label={field.label}
            onChange={(e) => void pick(e.target.files)}
          />
          <Button
            type="button"
            variant="out"
            size="sm"
            disabled={disabled || busy || !onUpload}
            onClick={() => input.current?.click()}
          >
            {busy ? <Spinner size={14} /> : <Icon name="upload" size={15} />}
            {t('forms.fill.chooseFile')}
          </Button>
          <span className="text-xs text-fg3">
            {t('forms.fill.fileHint', {
              count: field.maxFiles,
              size: formatBytes(FORM_LIMITS.fileBytes, locale),
            })}
          </span>
        </div>
      ) : null}
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
