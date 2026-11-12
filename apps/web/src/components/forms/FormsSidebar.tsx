import { FORM_LIMITS, type Space } from '@crewhall/shared';
import { cn, Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { SpaceSidebar } from '@/components/spaces/SpaceSidebar';
import { formsQuery } from '@/lib/forms/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { usePermissions } from '@/lib/session';
import { FormContextMenu, useRenameForm } from './FormMenu';
import { NewFormDialog } from './NewFormDialog';
import { RenameInput } from './parts';

/** Forms sidebar: the space's forms (editors see drafts too) and "new form". */
export function FormsSidebar({
  space,
  activeFormId,
}: {
  space: Space | undefined;
  activeFormId?: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { canSpace } = usePermissions();
  const forms = useQuery({ ...formsQuery(space?.id ?? ''), enabled: Boolean(space) });
  const canCreate = space ? canSpace('forms.manage', space.myRole) : false;
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rename = useRenameForm();
  // Right click on the list's empty area: "new form" for editors.
  const emptyArea = (list: ReactNode) =>
    canCreate ? (
      <ActionContextMenu
        entries={[
          {
            kind: 'item',
            key: 'new',
            icon: 'plus',
            label: t('forms.nav.new'),
            onSelect: () => setCreating(true),
          },
        ]}
      >
        {list}
      </ActionContextMenu>
    ) : (
      list
    );

  return (
    <SpaceSidebar
      space={space}
      onSelect={(s) => void navigate({ to: '/forms/$spaceSlug', params: { spaceSlug: s.slug } })}
    >
      {emptyArea(
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
          <span className="eyebrow mt-1 mb-1 px-2.5">{t('forms.nav.forms')}</span>
          {forms.data?.items.map((f) =>
            renaming === f.id ? (
              <RenameInput
                key={f.id}
                value={f.title}
                label={t('forms.new.name')}
                maxLength={FORM_LIMITS.titleChars}
                containerClassName="h-[var(--nv-h)] px-2.5 text-[13.5px]"
                onCommit={(title) => {
                  setRenaming(null);
                  rename.mutate({ form: f, title });
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <FormContextMenu
                key={f.id}
                form={f}
                editor={canCreate}
                spaceSlug={space?.slug}
                onRename={canCreate ? () => setRenaming(f.id) : undefined}
              >
                <Link
                  to={canCreate ? '/forms/f/$formId' : '/forms/edit/$formId'}
                  params={{ formId: f.id }}
                  className={cn(
                    'flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
                    f.id === activeFormId && 'bg-bg2 font-semibold text-fg',
                  )}
                >
                  <Icon name="todo" size={16} />
                  <span
                    className="min-w-0 flex-1 truncate"
                    // Double-click on the title renames (editors).
                    onDoubleClick={canCreate ? () => setRenaming(f.id) : undefined}
                  >
                    {f.title}
                  </span>
                  {canCreate && f.responseCount ? (
                    <span className="text-xs text-fg3 tabular-nums">{f.responseCount}</span>
                  ) : null}
                </Link>
              </FormContextMenu>
            ),
          )}
          {forms.data && forms.data.items.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-fg3">{t('forms.nav.none')}</p>
          ) : null}
          {canCreate ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-3 flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
            >
              <Icon name="plus" size={16} />
              {t('forms.nav.new')}
            </button>
          ) : null}
        </div>,
      )}
      {space ? (
        <NewFormDialog space={space} open={creating} onClose={() => setCreating(false)} />
      ) : null}
    </SpaceSidebar>
  );
}
