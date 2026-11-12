import {
  checkAnswers,
  isFieldVisible,
  type FormAnswer,
  type FormAnswerError,
  type FormAnswers,
  type FormField,
  type FormFile,
} from '@crewhall/shared';
import { Button, EmptyState, Icon } from '@crewhall/ui';
import { useState, type ReactNode } from 'react';
import { isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { FieldInput } from './FieldInput';

const ERROR_KEY: Record<FormAnswerError, MessageKey> = {
  required: 'forms.fill.errors.required',
  invalid: 'forms.fill.errors.invalid',
  too_long: 'forms.fill.errors.too_long',
  too_small: 'forms.fill.errors.too_small',
  too_large: 'forms.fill.errors.too_large',
  unknown_choice: 'forms.fill.errors.invalid',
  too_many_files: 'forms.fill.errors.too_many_files',
};

export interface RenderableForm {
  title: string;
  description: string | null;
  fields: FormField[];
}

/**
 * A form to answer: visible fields only (simple conditions), checks on send with the same
 * rules as the server, then the confirmation. `onSubmit` returns the confirmation text.
 */
export function FormRenderer({
  form,
  onSubmit,
  onUpload,
  preview,
  allowAgain,
  afterDone,
  note,
  header,
}: {
  form: RenderableForm;
  onSubmit?: (answers: FormAnswers) => Promise<string | null>;
  onUpload?: (fieldId: string, file: File) => Promise<FormFile>;
  /** Builder preview: nothing is sent. */
  preview?: boolean;
  /** After sending: offer "Başka yanıt gönder" (forms without the one-answer limit). */
  allowAgain?: boolean;
  /** After sending: more ways on ("Formlara dön"). */
  afterDone?: ReactNode;
  /** Under the title: anonymous / one-answer hints. */
  note?: ReactNode;
  header?: ReactNode;
}) {
  const { t } = useI18n();
  const [answers, setAnswers] = useState<FormAnswers>({});
  const [errors, setErrors] = useState<Record<string, FormAnswerError>>({});
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [done, setDone] = useState<{ text: string | null } | null>(null);

  const visible = form.fields.filter((f) => isFieldVisible(f, answers, form.fields));
  const set = (id: string, v: FormAnswer) => {
    setAnswers((a) => ({ ...a, [id]: v }));
    setErrors((e) => {
      if (!e[id]) return e;
      const rest = { ...e };
      delete rest[id];
      return rest;
    });
  };

  async function send() {
    const check = checkAnswers(form.fields, answers);
    setErrors(check.errors);
    setFailure(null);
    const first = Object.keys(check.errors)[0];
    if (first) {
      document.getElementById(`field-${first}`)?.scrollIntoView?.({ block: 'center' });
      return;
    }
    if (preview || !onSubmit) {
      setDone({ text: null });
      return;
    }
    setSending(true);
    try {
      setDone({ text: await onSubmit(check.clean) });
    } catch (e) {
      if (isApiError(e, 'form_answers_invalid')) {
        const details = e.details as { fields?: Record<string, FormAnswerError> } | undefined;
        if (details?.fields) setErrors(details.fields);
      }
      setFailure(errorKey(e));
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <EmptyState
        className="m-auto"
        icon="checkC"
        title={t('forms.fill.thanksTitle')}
        description={done.text ?? t('forms.fill.thanksBody')}
      >
        <div className="flex flex-wrap justify-center gap-2">
          {preview || allowAgain ? (
            <Button
              variant="out"
              size="sm"
              onClick={() => {
                setDone(null);
                setAnswers({});
                setErrors({});
              }}
            >
              {preview ? t('forms.fill.again') : t('forms.fill.another')}
            </Button>
          ) : null}
          {afterDone}
        </div>
      </EmptyState>
    );
  }

  return (
    <form
      className="mx-auto flex w-full max-w-[680px] flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <header className="flex flex-col gap-2 rounded-2xl bg-surface p-5 shadow-[0_0_0_1px_var(--line)] md:p-6">
        {header}
        <h1 className="text-title font-bold break-words text-fg">{form.title}</h1>
        {form.description ? (
          <p className="text-[14.5px] whitespace-pre-line text-fg2">{form.description}</p>
        ) : null}
        {note}
      </header>
      {visible.map((f) => {
        const err = errors[f.id];
        const hintId = `field-${f.id}-hint`;
        return (
          <section
            key={f.id}
            id={`field-${f.id}`}
            aria-labelledby={`field-${f.id}-label`}
            className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-[0_0_0_1px_var(--line)] data-[invalid=true]:shadow-[0_0_0_1.5px_var(--danger)] md:p-6"
            data-invalid={Boolean(err)}
          >
            <div className="flex flex-col gap-1">
              <h2 id={`field-${f.id}-label`} className="text-sub font-semibold break-words text-fg">
                {f.label}
                {f.required ? (
                  <span className="ml-1 text-danger" aria-label={t('forms.fill.required')}>
                    *
                  </span>
                ) : null}
              </h2>
              {f.help ? (
                <p id={hintId} className="text-sm whitespace-pre-line text-fg2">
                  {f.help}
                </p>
              ) : null}
            </div>
            <FieldInput
              field={f}
              value={answers[f.id]}
              onChange={(v) => set(f.id, v)}
              invalid={Boolean(err)}
              describedBy={f.help ? hintId : undefined}
              onUpload={onUpload ? (file) => onUpload(f.id, file) : undefined}
            />
            {err ? (
              <span className="flex items-center gap-1.5 text-xs text-danger" role="alert">
                <Icon name="alert" size={14} />
                {t(ERROR_KEY[err])}
              </span>
            ) : null}
          </section>
        );
      })}
      {form.fields.length === 0 ? (
        <p className="rounded-2xl bg-surface p-6 text-center text-sm text-fg3 shadow-[0_0_0_1px_var(--line)]">
          {t('forms.fill.noFields')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 pb-6">
        <Button type="submit" variant="pri" loading={sending} disabled={form.fields.length === 0}>
          {t('forms.fill.send')}
        </Button>
        {failure ? (
          <span className="text-sm text-danger" role="alert">
            {t(failure)}
          </span>
        ) : null}
      </div>
    </form>
  );
}
