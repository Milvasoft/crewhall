import { type Form, type FormField, type FormSettings, type FormStatus } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formKeys, formQuery, setFormCache } from '@/lib/forms/api';
import { publishIssues, type PublishIssue } from '@/lib/forms/fields';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { FormBuilder } from './FormBuilder';
import { FormTabs, type BuilderTab } from './FormHeader';
import { FormRenderer } from './FormRenderer';
import { FormSettingsPanel, settingsReady } from './FormSettingsPanel';
import { FormsSidebar } from './FormsSidebar';
import { ConfirmDialog } from './parts';
import { ResultsView } from './ResultsView';

interface Draft {
  title: string;
  description: string | null;
  fields: FormField[];
  settings: FormSettings;
}

const draftOf = (f: Form): Draft => ({
  title: f.title,
  description: f.description,
  fields: f.fields,
  settings: f.settings,
});

/** Loads the form and frames a page of it (sidebar, crumbs, tabs); 404 reads as "not found". */
function FormFrame({
  formId,
  tools,
  children,
}: {
  formId: string;
  tools?: (form: Form) => ReactNode;
  children: (form: Form) => ReactNode;
}) {
  const { t } = useI18n();
  const form = useQuery(formQuery(formId));
  const { items } = useSpaces();
  const space = items.find((s) => s.id === form.data?.spaceId);
  return (
    <Workspace
      sidebar={<FormsSidebar space={space} activeFormId={formId} />}
      crumbs={[
        ...(space ? [{ label: spaceName(space, t) }] : []),
        {
          label: space ? (
            <Link
              to="/forms/$spaceSlug"
              params={{ spaceSlug: space.slug }}
              className="hover:underline"
            >
              {t('forms.title')}
            </Link>
          ) : (
            t('forms.title')
          ),
        },
        ...(form.data ? [{ label: form.data.title }] : []),
      ]}
      tools={form.data && tools ? tools(form.data) : null}
    >
      {form.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-48" />
        </div>
      ) : form.data ? (
        children(form.data)
      ) : (
        <EmptyState
          className="m-auto"
          icon="todo"
          title={t('forms.notFound.title')}
          description={t('forms.notFound.body')}
        />
      )}
    </Workspace>
  );
}

/** The builder (roadmap 16): fields, sharing and preview tabs; saving and publishing. */
export function FormEditorPage({ formId, tab }: { formId: string; tab: BuilderTab }) {
  return (
    <FormFrame formId={formId}>
      {(form) => <Editor key={form.id} form={form} tab={tab} />}
    </FormFrame>
  );
}

function Editor({ form, tab }: { form: Form; tab: BuilderTab }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const { items } = useSpaces();
  const space = items.find((s) => s.id === form.spaceId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(form));
  const [base, setBase] = useState<Draft>(() => draftOf(form));
  const [selected, setSelected] = useState<string | null>(form.fields[0]?.id ?? null);
  const [deleting, setDeleting] = useState(false);
  const [checking, setChecking] = useState<PublishIssue[] | null>(null);
  // Renamed elsewhere (the sidebar's menu): take the new title unless it is being edited here.
  const [seenTitle, setSeenTitle] = useState(form.title);
  if (form.title !== seenTitle) {
    setSeenTitle(form.title);
    if (draft.title === base.title) setDraft({ ...draft, title: form.title });
    setBase({ ...base, title: form.title });
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const valid =
    draft.title.trim() !== '' &&
    draft.fields.every(
      (f) => f.label.trim() !== '' && f.choices.every((c) => c.label.trim() !== ''),
    ) &&
    settingsReady(draft.settings);

  const save = useMutation({
    mutationFn: (status?: FormStatus) =>
      api.call('updateForm', {
        params: { formId: form.id },
        body: {
          title: draft.title.trim(),
          description: draft.description?.trim() || null,
          fields: draft.fields,
          settings: draft.settings,
          ...(status ? { status } : {}),
        },
      }),
    onSuccess: (saved, status) => {
      setFormCache(qc, saved);
      setBase(draftOf(saved));
      setDraft(draftOf(saved));
      toast(
        status === 'open'
          ? t('forms.editor.published')
          : status === 'closed'
            ? t('forms.editor.closedToast')
            : t('forms.editor.saved'),
      );
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const regenerate = useMutation({
    mutationFn: () => api.call('regenerateFormLink', { params: { formId: form.id } }),
    onSuccess: (saved) => {
      setFormCache(qc, saved);
      toast(t('forms.share.regenerated'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteForm', { params: { formId: form.id } }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: formKeys.form(form.id) });
      void qc.invalidateQueries({ queryKey: formKeys.list(form.spaceId) });
      toast(t('forms.editor.deleted'));
      void navigate(
        space ? { to: '/forms/$spaceSlug', params: { spaceSlug: space.slug } } : { to: '/' },
      );
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  // Ctrl/⌘ S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && valid && !save.isPending) save.mutate(undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, valid, save]);

  const statusAction =
    form.status === 'open'
      ? { status: 'closed' as const, label: t('forms.editor.close'), variant: 'out' as const }
      : {
          status: 'open' as const,
          label: form.status === 'closed' ? t('forms.editor.reopen') : t('forms.editor.publish'),
          variant: 'pri' as const,
        };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-2">
          <Input
            aria-label={t('forms.editor.title')}
            className="h-12 min-w-0 flex-1 text-title font-bold"
            value={draft.title}
            maxLength={200}
            invalid={draft.title.trim() === ''}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="out"
              size="sm"
              disabled={!dirty || !valid}
              loading={save.isPending && save.variables === undefined}
              onClick={() => save.mutate(undefined)}
            >
              {dirty ? t('forms.editor.save') : t('forms.editor.savedState')}
            </Button>
            <Button
              variant={statusAction.variant}
              size="sm"
              disabled={!valid || draft.fields.length === 0}
              loading={save.isPending && save.variables === statusAction.status}
              onClick={() => {
                // Publishing checks for unfinished questions first (test findings 2026-10-22).
                const issues =
                  statusAction.status === 'open'
                    ? publishIssues(
                        draft.fields,
                        (type) => t(`forms.types.${type}`),
                        (n) => t('forms.builder.choiceN', { n }),
                      )
                    : [];
                if (issues.length) setChecking(issues);
                else save.mutate(statusAction.status);
              }}
            >
              {statusAction.label}
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <IconButton size="sm" aria-label={t('forms.editor.more')}>
                  <Icon name="dots" size={16} />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="end">
                {form.status !== 'draft' ? (
                  <MenuItem
                    icon="ext"
                    onSelect={() =>
                      void navigate({ to: '/forms/edit/$formId', params: { formId: form.id } })
                    }
                  >
                    {t('forms.editor.openFill')}
                  </MenuItem>
                ) : null}
                <MenuItem icon="trash" danger onSelect={() => setDeleting(true)}>
                  {t('forms.editor.delete')}
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        <Textarea
          aria-label={t('forms.editor.description')}
          placeholder={t('forms.editor.descriptionPlaceholder')}
          rows={2}
          className="min-h-[56px]"
          value={draft.description ?? ''}
          maxLength={1000}
          onChange={(e) => setDraft({ ...draft, description: e.target.value || null })}
        />
        <FormTabs form={form} active={tab} />
      </div>
      {tab === 'fields' ? (
        <FormBuilder
          fields={draft.fields}
          onChange={(fields) => setDraft({ ...draft, fields })}
          selectedId={selected}
          onSelect={setSelected}
        />
      ) : tab === 'sharing' ? (
        <FormSettingsPanel
          form={{ ...form, fields: draft.fields }}
          settings={draft.settings}
          onChange={(settings) => setDraft({ ...draft, settings })}
          canPublic={space ? canSpace('space.share_link', space.myRole) : false}
          onRegenerate={() => regenerate.mutate()}
          regenerating={regenerate.isPending}
        />
      ) : (
        <div className="rounded-2xl bg-bg2 p-4 md:p-6">
          <p className="mb-4 flex items-center justify-center gap-1.5 text-xs font-semibold text-fg2">
            <Icon name="eye" size={14} />
            {t('forms.editor.previewNote')}
          </p>
          <FormRenderer form={draft} preview />
        </div>
      )}
      <PublishCheckDialog
        issues={checking}
        fields={draft.fields}
        onEdit={(fieldId) => {
          setChecking(null);
          setSelected(fieldId);
          void navigate({
            to: '/forms/f/$formId',
            params: { formId: form.id },
            search: { tab: 'fields' },
          });
        }}
        onPublish={() => {
          setChecking(null);
          save.mutate('open');
        }}
        onClose={() => setChecking(null)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('forms.editor.deleteTitle', { title: form.title })}
        body={t('forms.editor.deleteBody', { count: form.responseCount })}
        confirm={t('forms.editor.delete')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

/** Results page of a form. */
export function FormResultsPage({ formId }: { formId: string }) {
  const { canSpace } = usePermissions();
  const { items } = useSpaces();
  return (
    <FormFrame formId={formId}>
      {(form) => {
        const space = items.find((s) => s.id === form.spaceId);
        return (
          <div className="flex flex-col gap-5">
            <h1 className="text-title font-bold break-words">{form.title}</h1>
            <FormTabs form={form} active="results" />
            <ResultsView
              form={form}
              canDelete={space ? canSpace('forms.manage', space.myRole) : false}
            />
          </div>
        );
      }}
    </FormFrame>
  );
}

/** Before publishing: the questions that still look unfinished, with a way to each. */
function PublishCheckDialog({
  issues,
  fields,
  onEdit,
  onPublish,
  onClose,
}: {
  issues: PublishIssue[] | null;
  fields: FormField[];
  onEdit: (fieldId: string) => void;
  onPublish: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={issues !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={500}>
        <DialogHeader
          icon="alert"
          title={t('forms.publishCheck.title')}
          description={t('forms.publishCheck.body')}
        />
        <ul className="flex flex-col gap-1.5">
          {(issues ?? []).map((i) => {
            const f = fields.find((x) => x.id === i.fieldId);
            return (
              <li key={`${i.fieldId}-${i.kind}`}>
                <button
                  type="button"
                  onClick={() => onEdit(i.fieldId)}
                  className="flex w-full items-center gap-2.5 rounded-lg bg-bg2 px-3 py-2.5 text-left text-sm hover:bg-capsule"
                >
                  <Icon name="edit" size={15} className="shrink-0 text-fg2" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{f?.label}</span>
                    <span className="block text-xs text-fg2">
                      {t(`forms.publishCheck.${i.kind}`)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('forms.publishCheck.edit')}
          </Button>
          <Button variant="pri" onClick={onPublish}>
            {t('forms.publishCheck.publishAnyway')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
