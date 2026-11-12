import { FORM_LIMITS, paths, type FormSummary } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formKeys, formQuery, formsQuery, setFormCache } from '@/lib/forms/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { ConfirmDialog } from './parts';

/** Renames a form; the list shows the new title at once. */
export function useRenameForm() {
  const { t } = useI18n();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ form, title }: { form: FormSummary; title: string }) =>
      api.call('updateForm', { params: { formId: form.id }, body: { title } }),
    onMutate: ({ form, title }) => {
      qc.setQueryData(formsQuery(form.spaceId).queryKey, (old) =>
        old
          ? { ...old, items: old.items.map((f) => (f.id === form.id ? { ...f, title } : f)) }
          : old,
      );
    },
    onSuccess: (saved) => {
      setFormCache(qc, saved);
      toast(t('forms.menu.renamed'));
    },
    onError: (e, { form }) => {
      void qc.invalidateQueries({ queryKey: formKeys.list(form.spaceId) });
      toast(t(errorKey(e)));
    },
  });
}

/**
 * Right-click menu of a form in a list. Editors (forms.manage) get open, results, answer page,
 * link, rename, copy and delete; others only what they can do: answer and copy the link.
 */
export function FormContextMenu({
  form,
  editor,
  spaceSlug,
  onRename,
  children,
}: {
  form: FormSummary;
  editor: boolean;
  spaceSlug?: string;
  onRename?: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [deleting, setDeleting] = useState(false);

  const duplicate = useMutation({
    mutationFn: async () => {
      const full = await qc.fetchQuery(formQuery(form.id));
      return api.call('createForm', {
        params: { spaceId: form.spaceId },
        body: {
          title: t('forms.menu.copyTitle', { title: full.title }).slice(0, FORM_LIMITS.titleChars),
          description: full.description,
          fields: full.fields,
        },
      });
    },
    onSuccess: (created) => {
      setFormCache(qc, created);
      toast(t('forms.menu.duplicated'));
      void navigate({ to: '/forms/f/$formId', params: { formId: created.id } });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: () => api.call('deleteForm', { params: { formId: form.id } }),
    onSuccess: () => {
      setDeleting(false);
      // Leave the form's own pages before its data goes.
      if (pathname.includes(form.id)) {
        void navigate(spaceSlug ? { to: '/forms/$spaceSlug', params: { spaceSlug } } : { to: '/' });
      }
      qc.removeQueries({ queryKey: formKeys.form(form.id) });
      void qc.invalidateQueries({ queryKey: formKeys.list(form.spaceId) });
      toast(t('forms.editor.deleted'));
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const copyLink = async () => {
    try {
      // A public form's link is on the full form; everyone else shares the in-app answer page.
      let url = `${window.location.origin}${paths.formEdit(form.id)}`;
      if (editor && form.access === 'public') {
        const full = await qc.fetchQuery(formQuery(form.id));
        if (full.publicUrl) url = full.publicUrl;
      }
      await navigator.clipboard?.writeText(url);
      toast(t('forms.share.copied'));
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  const answerable = form.status !== 'draft';
  const openFill: ActionEntry = {
    kind: 'item',
    key: 'fill',
    icon: editor ? 'ext' : 'arrowUR',
    label: editor ? t('forms.editor.openFill') : t('forms.menu.open'),
    onSelect: () => void navigate({ to: '/forms/edit/$formId', params: { formId: form.id } }),
  };
  const link: ActionEntry = {
    kind: 'item',
    key: 'link',
    icon: 'link',
    label: t('forms.menu.copyLink'),
    onSelect: () => void copyLink(),
  };

  const entries: ActionEntry[] = editor
    ? [
        {
          kind: 'item',
          key: 'open',
          icon: 'arrowUR',
          label: t('forms.menu.open'),
          onSelect: () => void navigate({ to: '/forms/f/$formId', params: { formId: form.id } }),
        },
        {
          kind: 'item',
          key: 'results',
          icon: 'activity',
          label: t('forms.tabs.results', { count: form.responseCount }),
          onSelect: () =>
            void navigate({ to: '/forms/f/$formId/results', params: { formId: form.id } }),
        },
        ...(answerable ? [openFill, link] : []),
        { kind: 'sep', key: 's1' },
        ...(onRename
          ? [
              {
                kind: 'item',
                key: 'rename',
                icon: 'pencil',
                label: t('forms.menu.rename'),
                onSelect: onRename,
              } satisfies ActionEntry,
            ]
          : []),
        {
          kind: 'item',
          key: 'duplicate',
          icon: 'copy',
          label: t('forms.menu.duplicate'),
          disabledReason: duplicate.isPending ? t('forms.menu.duplicating') : undefined,
          onSelect: () => duplicate.mutate(),
        },
        { kind: 'sep', key: 's2' },
        {
          kind: 'item',
          key: 'delete',
          icon: 'trash',
          label: t('forms.editor.delete'),
          danger: true,
          onSelect: () => setDeleting(true),
        },
      ]
    : answerable
      ? [openFill, link]
      : [];

  // Nothing to offer: the browser keeps its own menu.
  if (entries.length === 0) return <>{children}</>;
  return (
    <>
      <ActionContextMenu entries={entries}>{children}</ActionContextMenu>
      {editor ? (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={t('forms.editor.deleteTitle', { title: form.title })}
          body={t('forms.editor.deleteBody', { count: form.responseCount })}
          confirm={t('forms.editor.delete')}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </>
  );
}
