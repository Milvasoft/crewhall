import { type FormToFill } from '@crewhall/shared';
import { Button, CrewhallMark, EmptyState, Icon, Spinner } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';
import { LanguageMenu } from '@/components/auth/AuthLayout';
import { Workspace } from '@/components/shell/Workspace';
import { api, isApiError } from '@/lib/api';
import { fillQuery, publicFormQuery } from '@/lib/forms/api';
import { browserToken, readDataUrl } from '@/lib/forms/fields';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useBootstrap } from '@/lib/useBranding';
import { FormRenderer } from './FormRenderer';

function Notes({ form }: { form: FormToFill }) {
  const { t } = useI18n();
  const notes = [
    form.anonymous ? { icon: 'eyeOff' as const, text: t('forms.fill.anonymousNote') } : null,
    form.oneResponse ? { icon: 'user' as const, text: t('forms.fill.oneNote') } : null,
  ].filter((n) => n !== null);
  if (notes.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {notes.map((n) => (
        <li key={n.text} className="flex items-center gap-1.5 text-xs text-fg2">
          <Icon name={n.icon} size={13} />
          {n.text}
        </li>
      ))}
    </ul>
  );
}

/** Not taking answers or already answered: a message instead of the form. */
function Blocked({ form }: { form: FormToFill }) {
  const { t } = useI18n();
  if (form.alreadyResponded) {
    return (
      <EmptyState
        className="m-auto"
        icon="checkC"
        title={t('forms.fill.answeredTitle')}
        description={t('forms.fill.answeredBody')}
      />
    );
  }
  return (
    <EmptyState
      className="m-auto"
      icon="lock"
      title={t('forms.fill.closedTitle', { title: form.title })}
      description={t('forms.fill.closedBody')}
    />
  );
}

/** Answering inside the app: `/forms/edit/<id>`. */
export function FillPage({ formId }: { formId: string }) {
  const { t } = useI18n();
  const form = useQuery(fillQuery(formId));
  let body: ReactNode;
  if (form.isLoading) body = <Spinner className="m-auto" />;
  else if (!form.data) {
    body = (
      <EmptyState
        className="m-auto"
        icon="todo"
        title={t('forms.notFound.title')}
        description={t('forms.notFound.body')}
      />
    );
  } else if (!form.data.accepting || form.data.alreadyResponded) {
    body = <Blocked form={form.data} />;
  } else {
    body = (
      <FormRenderer
        form={form.data}
        note={<Notes form={form.data} />}
        allowAgain={!form.data.oneResponse}
        afterDone={
          <Button asChild variant="gh" size="sm">
            <Link to="/$module" params={{ module: 'forms' }}>
              {t('forms.fill.backToForms')}
            </Link>
          </Button>
        }
        onUpload={async (fieldId, file) =>
          api.call('uploadFormFile', {
            params: { formId },
            body: { fieldId, name: file.name, dataURL: await readDataUrl(file) },
          })
        }
        onSubmit={async (answers) => {
          const r = await api.call('submitForm', { params: { formId }, body: { answers } });
          // No refetch here: a one-answer form would swap the thank-you for "already answered".
          return r.confirmation;
        }}
      />
    );
  }
  return (
    <Workspace
      crumbs={[{ label: t('forms.title') }, ...(form.data ? [{ label: form.data.title }] : [])]}
    >
      {body}
    </Workspace>
  );
}

/** Public link `/f/<token>`: no shell, the org's brand, rate limited on the server. */
export function PublicFormPage({ token }: { token: string }) {
  const { t } = useI18n();
  const form = useQuery(publicFormQuery(token));
  let body: ReactNode;
  if (form.isLoading) body = <Spinner className="m-auto" />;
  else if (isApiError(form.error, 'module_disabled')) {
    body = (
      <EmptyState
        className="m-auto"
        icon="lock"
        title={t('forms.public.offTitle')}
        description={t('forms.public.offBody')}
      />
    );
  } else if (!form.data) {
    body = (
      <EmptyState
        className="m-auto"
        icon="alert"
        title={t('forms.public.invalidTitle')}
        description={t('forms.public.invalidBody')}
      />
    );
  } else if (!form.data.accepting) {
    body = <Blocked form={form.data} />;
  } else {
    body = (
      <FormRenderer
        form={form.data}
        note={<Notes form={form.data} />}
        header={<span className="text-xs font-semibold text-fg2">{form.data.orgName}</span>}
        allowAgain={!form.data.oneResponse}
        onUpload={async (fieldId, file) =>
          api.call('uploadPublicFormFile', {
            params: { token },
            body: {
              fieldId,
              name: file.name,
              dataURL: await readDataUrl(file),
              clientToken: browserToken(),
            },
          })
        }
        onSubmit={async (answers) => {
          const r = await api.call('submitPublicForm', {
            params: { token },
            body: { answers, clientToken: browserToken() },
          });
          return r.confirmation;
        }}
      />
    );
  }
  return <PublicFrame>{body}</PublicFrame>;
}

function PublicFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const logo = branding.logoLightUrl ?? branding.logoDarkUrl;
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 md:px-6">
        {logo ? (
          <img src={logo} alt={branding.orgName} className="h-7 max-w-[160px] object-contain" />
        ) : (
          <span className="flex items-center gap-2 text-sm font-bold">
            <CrewhallMark size={24} />
            {branding.orgName}
          </span>
        )}
        <span className="ml-auto">
          <Button size="sm" variant="gh" asChild>
            <Link to="/login">{t('forms.public.signIn')}</Link>
          </Button>
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-4 py-6 md:px-6">{children}</main>
      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-3 px-6 pb-5 text-xs text-fg3">
        {branding.showPoweredBy ? t('forms.public.poweredBy') : null}
        <LanguageMenu />
      </footer>
    </div>
  );
}
