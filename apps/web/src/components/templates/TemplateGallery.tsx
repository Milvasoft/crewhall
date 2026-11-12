import { pagePath, type Template, type TemplateKind } from '@crewhall/shared';
import {
  Button,
  cn,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Input,
  toast,
  type IconName,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n, type WebKey } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { templateKeys, templatesQuery } from './api';
import { PagePreview } from './PagePreview';

/**
 * Template gallery (roadmap 8, design 5.13): page, board and space templates, built-in and saved
 * (org, space, personal). "Kullan" creates the content under the target (a space and, for pages
 * and boards, a parent) and opens what was made.
 */

const KINDS: { id: TemplateKind | 'all'; key: WebKey; icon: IconName }[] = [
  { id: 'all', key: 'templates.kinds.all', icon: 'layers' },
  { id: 'page', key: 'templates.kinds.page', icon: 'page' },
  { id: 'board', key: 'templates.kinds.board', icon: 'board' },
  { id: 'space', key: 'templates.kinds.space', icon: 'folder' },
];
const SCOPES: Template['scope'][] = ['builtin', 'org', 'space', 'personal'];
const KIND_ICON: Record<TemplateKind, IconName> = { page: 'page', board: 'board', space: 'folder' };

function Preview({ t: x }: { t: Template }) {
  const { t } = useI18n();
  if (x.kind === 'board') {
    return (
      <span className="flex h-full gap-1">
        {(x.summary.columns ?? []).slice(0, 5).map((c, i) => (
          <span key={i} className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm bg-bg2 p-1">
            <span className="truncate text-[10px] font-semibold text-fg2">{c}</span>
            <span className="h-2 rounded-[2px] bg-line2" />
            {i === 0 && (x.summary.cards ?? 0) > 0 ? (
              <span className="h-2 rounded-[2px] bg-line2" />
            ) : null}
          </span>
        ))}
      </span>
    );
  }
  if (x.kind === 'space') {
    return (
      <span className="flex flex-col gap-1 text-[11.5px] text-fg2">
        {(x.summary.pages ?? []).slice(0, 3).map((p) => (
          <span key={`p-${p}`} className="flex items-center gap-1.5 truncate">
            <Icon name="page" size={12} /> {p}
          </span>
        ))}
        {(x.summary.boards ?? []).slice(0, 2).map((b) => (
          <span key={`b-${b}`} className="flex items-center gap-1.5 truncate">
            <Icon name="board" size={12} /> {b}
          </span>
        ))}
        {!x.summary.pages?.length && !x.summary.boards?.length ? t('templates.emptySpace') : null}
      </span>
    );
  }
  return <PagePreview markdown={x.preview} />;
}

export function TemplateGallery({
  spaceId,
  parentId,
  kind: initialKind = 'all',
  onClose,
  onSaveSpace,
}: {
  spaceId: string;
  parentId: string | null;
  kind?: TemplateKind | 'all';
  onClose: () => void;
  /** Shown to space admins: save the target space itself as a template. */
  onSaveSpace?: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { items: spaces } = useSpaces();
  const [kind, setKind] = useState<TemplateKind | 'all'>(initialKind);
  const [scope, setScope] = useState<Template['scope'] | 'all'>('all');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const q = useQuery(templatesQuery(spaceId));

  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const list = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('tr');
    return all.filter(
      (x) =>
        (kind === 'all' || x.kind === kind) &&
        (scope === 'all' || x.scope === scope) &&
        (!needle ||
          x.name.toLocaleLowerCase('tr').includes(needle) ||
          x.description.toLocaleLowerCase('tr').includes(needle)),
    );
  }, [all, kind, scope, search]);
  const current = list.find((x) => x.id === picked) ?? list[0];
  const space = spaces.find((s) => s.id === spaceId);

  const apply = useMutation({
    mutationFn: (x: Template) =>
      api.call('applyTemplate', {
        params: { templateRef: x.id },
        // Space templates always go to the space root.
        body: { spaceId, parentId: x.kind === 'space' ? null : parentId },
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['wiki'] });
      void qc.invalidateQueries({ queryKey: ['boards'] });
      invalidateDrive(qc);
      if (res.skipped.length) {
        toast(t('templates.skipped', { modules: res.skipped.join(', ') }));
      }
      onClose();
      const first = res.nodes[0];
      if (first?.type === 'page') {
        void navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(first).slice(3) } });
      } else if (first?.type === 'board') {
        void navigate({ to: '/b/$boardId', params: { boardId: first.id } });
      }
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const remove = useMutation({
    mutationFn: (x: Template) => api.call('deleteTemplate', { params: { templateRef: x.id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: templateKeys.all }),
    onError: (e) => toast(t(errorKey(e))),
  });

  const count = (s: Template['scope'] | 'all') =>
    all.filter((x) => (kind === 'all' || x.kind === kind) && (s === 'all' || x.scope === s)).length;

  return (
    <DialogContent width={960}>
      <DialogHeader icon="layers" title={t('templates.title')} description={t('templates.hint')} />
      <div className="grid min-h-[420px] grid-cols-[200px_1fr] gap-5">
        <nav aria-label={t('templates.filters')} className="flex flex-col gap-1">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-bg2',
                kind === k.id && 'bg-capsule font-semibold',
              )}
            >
              <Icon name={k.icon} size={16} />
              {t(k.key)}
            </button>
          ))}
          <span className="eyebrow mt-4 mb-1 px-2.5">{t('templates.source')}</span>
          {(['all', ...SCOPES] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
              className={cn(
                'flex items-center justify-between rounded-md px-2.5 py-1 text-left text-sm text-fg2 hover:bg-bg2',
                scope === s && 'bg-capsule font-semibold text-fg',
              )}
            >
              <span>{t(`templates.scopes.${s}`)}</span>
              <span className="text-cap text-fg3 tn">{count(s)}</span>
            </button>
          ))}
          {onSaveSpace && space && (space.myRole === 'owner' || space.myRole === 'admin') ? (
            <button
              type="button"
              onClick={onSaveSpace}
              className="mt-auto flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-fg2 hover:bg-bg2 hover:text-fg"
            >
              <Icon name="plus" size={16} />
              {t('templates.saveSpace')}
            </button>
          ) : null}
        </nav>
        <div className="flex min-w-0 flex-col gap-3">
          <Input
            placeholder={t('templates.search')}
            aria-label={t('templates.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div
            role="listbox"
            aria-label={t('templates.title')}
            className="grid max-h-[440px] grid-cols-3 gap-3 overflow-y-auto pr-1"
          >
            {list.map((x) => (
              <div
                key={x.id}
                role="option"
                aria-selected={current?.id === x.id}
                tabIndex={0}
                onClick={() => setPicked(x.id)}
                onDoubleClick={() => apply.mutate(x)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') apply.mutate(x);
                  else if (e.key === ' ') {
                    e.preventDefault();
                    setPicked(x.id);
                  }
                }}
                className={cn(
                  'group relative flex cursor-pointer flex-col gap-2 rounded-xl border p-2.5 text-left outline-none hover:bg-bg2 focus-visible:shadow-[0_0_0_2px_var(--accent)]',
                  current?.id === x.id
                    ? 'border-accent shadow-[inset_0_0_0_1px_var(--accent)]'
                    : 'border-line',
                )}
              >
                <span className="h-[92px] overflow-hidden rounded-lg bg-surface p-2 shadow-line">
                  <Preview t={x} />
                </span>
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon name={KIND_ICON[x.kind]} size={14} className="shrink-0 text-fg3" />
                  <span className="truncate">{x.name}</span>
                </span>
                <span className="line-clamp-2 text-cap text-fg3">{x.description}</span>
                <span className="text-[11px] text-fg3">{t(`templates.scopes.${x.scope}`)}</span>
                {x.canDelete ? (
                  <IconButton
                    size="xs"
                    tone="plain"
                    aria-label={t('templates.delete', { name: x.name })}
                    className="absolute top-1.5 right-1.5 hidden group-hover:flex"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove.mutate(x);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </IconButton>
                ) : null}
              </div>
            ))}
            {!q.isPending && list.length === 0 ? (
              <p className="col-span-3 py-6 text-center text-sm text-fg3">{t('templates.none')}</p>
            ) : null}
          </div>
        </div>
      </div>
      <DialogFooter>
        <span className="mr-auto truncate text-cap text-fg3">
          {current
            ? [
                t(`templates.kinds.${current.kind}`),
                current.kind === 'page' && current.summary.blocks !== undefined
                  ? t('templates.blocks', { count: current.summary.blocks })
                  : null,
                current.kind === 'board' && current.summary.cards
                  ? t('templates.cards', { count: current.summary.cards })
                  : null,
                current.kind === 'page' ? t('templates.placeholders') : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : null}
        </span>
        <Button variant="gh" onClick={onClose}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          variant="pri"
          disabled={!current}
          loading={apply.isPending}
          onClick={() => current && apply.mutate(current)}
        >
          {current?.kind === 'space' ? t('templates.useSpace') : t('templates.use')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
