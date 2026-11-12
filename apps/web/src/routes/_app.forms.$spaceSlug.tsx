import { Button, EmptyState, Icon, Skeleton, Tag } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { FormContextMenu } from '@/components/forms/FormMenu';
import { useEffect, useState } from 'react';
import { FormsSidebar } from '@/components/forms/FormsSidebar';
import { NewFormDialog } from '@/components/forms/NewFormDialog';
import { Workspace } from '@/components/shell/Workspace';
import { spaceName } from '@/components/spaces/spaceUtils';
import { formsQuery } from '@/lib/forms/api';
import { STATUS_KEY } from '@/lib/forms/fields';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { rememberSpace, useSpaces } from '@/lib/useSpaces';

/** Forms of a space (roadmap 16). */
export const Route = createFileRoute('/_app/forms/$spaceSlug')({
  beforeLoad: async ({ params, context: { queryClient } }) => {
    const { items } = await queryClient.ensureQueryData(spacesQuery());
    if (!items.some((s) => s.slug === params.spaceSlug)) throw notFound({ routeId: '/_app' });
  },
  component: FormsHome,
});

function FormsHome() {
  const { t, locale } = useI18n();
  const { spaceSlug } = Route.useParams();
  const { bySlug } = useSpaces();
  const { canSpace } = usePermissions();
  const space = bySlug(spaceSlug);
  const forms = useQuery({ ...formsQuery(space?.id ?? ''), enabled: Boolean(space) });
  const [creating, setCreating] = useState(false);
  useEffect(() => rememberSpace(spaceSlug), [spaceSlug]);
  if (!space) return null;
  const editor = canSpace('forms.manage', space.myRole);

  const newButton = editor ? (
    <Button size="sm" variant="inv" onClick={() => setCreating(true)}>
      <Icon name="plus" size={16} />
      {t('forms.nav.new')}
    </Button>
  ) : null;

  return (
    <Workspace
      sidebar={<FormsSidebar space={space} />}
      crumbs={[{ label: spaceName(space, t) }, { label: t('forms.title') }]}
      tools={newButton}
    >
      {/* Right click on the page's empty part: a new form (editors). */}
      <ActionContextMenu
        entries={
          editor
            ? [
                {
                  kind: 'item',
                  key: 'new',
                  icon: 'plus',
                  label: t('forms.nav.new'),
                  onSelect: () => setCreating(true),
                },
              ]
            : []
        }
      >
        <section className="flex min-h-full flex-col gap-4">
          <h1 className="text-title font-bold">
            {t('forms.home.title', { space: spaceName(space, t) })}
          </h1>
          {forms.isLoading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : forms.data?.items.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {forms.data.items.map((f) => (
                <FormContextMenu key={f.id} form={f} editor={editor} spaceSlug={space.slug}>
                  <Link
                    to={editor ? '/forms/f/$formId' : '/forms/edit/$formId'}
                    params={{ formId: f.id }}
                    className="flex flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--line2),var(--shSm)]"
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-bg2">
                        <Icon name="todo" size={18} />
                      </span>
                      <Tag className={f.status === 'open' ? 'bg-accent text-accent-fg' : undefined}>
                        {t(STATUS_KEY[f.status])}
                      </Tag>
                      {f.access === 'public' ? (
                        <Icon
                          name="globe"
                          size={15}
                          className="text-fg3"
                          aria-label={t('forms.share.public')}
                        />
                      ) : null}
                    </span>
                    <span className="text-sub font-semibold break-words text-fg">{f.title}</span>
                    <span className="text-xs text-fg3">
                      {editor
                        ? `${t('forms.home.responses', { count: f.responseCount })} · ${t('forms.home.fields', { count: f.fieldCount })}`
                        : t('forms.home.answer')}
                      {' · '}
                      {formatRelative(f.updatedAt, locale)}
                    </span>
                  </Link>
                </FormContextMenu>
              ))}
            </div>
          ) : (
            <EmptyState
              className="m-auto"
              icon="todo"
              title={t('forms.home.empty')}
              description={editor ? t('forms.home.emptyBody') : t('forms.home.emptyViewer')}
            >
              {newButton}
            </EmptyState>
          )}
        </section>
      </ActionContextMenu>
      <NewFormDialog space={space} open={creating} onClose={() => setCreating(false)} />
    </Workspace>
  );
}
