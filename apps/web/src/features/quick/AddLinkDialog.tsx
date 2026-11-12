import { type Card, type Surface } from '@crewhall/shared';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { putCard } from './api';
import { Favicon } from './LinkBits';

/** "https://…" or a bare host the person pasted; null when it is not a web address. */
export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Link ekle (2.4): pasting a URL fetches the title and icon once on the server; the link
 * becomes its own 2×1 card or joins a group section. Paste on the surface opens this too.
 */
export function AddLinkDialog({
  open,
  onClose,
  surface,
  surfaceName,
  initialUrl,
  initialGroupId,
  initialSectionId,
}: {
  open: boolean;
  onClose: () => void;
  surface: Surface;
  surfaceName: string;
  initialUrl?: string;
  initialGroupId?: string;
  initialSectionId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      {open ? (
        <AddLinkBody
          onClose={onClose}
          surface={surface}
          surfaceName={surfaceName}
          initialUrl={initialUrl}
          initialGroupId={initialGroupId}
          initialSectionId={initialSectionId}
        />
      ) : null}
    </Dialog>
  );
}

function AddLinkBody({
  onClose,
  surface,
  surfaceName,
  initialUrl,
  initialGroupId,
  initialSectionId,
}: {
  onClose: () => void;
  surface: Surface;
  surfaceName: string;
  initialUrl?: string;
  initialGroupId?: string;
  initialSectionId?: string;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const groups = surface.cards.filter(
    (c): c is Extract<Card, { type: 'link_group' }> => c.type === 'link_group' && !c.pinnedFrom,
  );
  const [raw, setRaw] = useState(initialUrl ?? '');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState<'card' | 'group'>(initialGroupId ? 'group' : 'card');
  const [groupId, setGroupId] = useState(initialGroupId ?? groups[0]?.id ?? '');
  const group = groups.find((g) => g.id === groupId);
  // The sub-section the person came from ("Link ekle" under "Prod"), else the first one.
  const [sectionId, setSectionId] = useState(
    group?.config.sections.find((s) => s.id === initialSectionId)?.id ??
      group?.config.sections[0]?.id ??
      '',
  );
  const [check, setCheck] = useState(true);
  const url = normalizeUrl(useDebounced(raw, 350));

  const preview = useQuery({
    queryKey: ['links', 'preview', url],
    queryFn: ({ signal }) => api.call('previewLink', { body: { url: url ?? '' }, signal }),
    enabled: Boolean(url),
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Fill the display name from the site once, unless the person typed one.
  const fetched = preview.data?.title ?? preview.data?.host ?? '';
  const [filledFrom, setFilledFrom] = useState('');
  if (!titleTouched && preview.data && fetched !== filledFrom) {
    setFilledFrom(fetched);
    setTitle(fetched);
  }

  const duplicate =
    preview.data &&
    (target === 'group'
      ? preview.data.existingCardIds.includes(groupId)
      : preview.data.existingCardIds.length > 0);

  const add = useMutation({
    mutationFn: async () => {
      const link = {
        url: url ?? '',
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        checkEnabled: check,
        intervalSeconds: 60 as const,
      };
      if (target === 'group' && group) {
        return api.call('addGroupLink', {
          params: { cardId: group.id },
          body: { link, sectionId: sectionId || undefined },
        });
      }
      return api.call('createCard', {
        params: { surfaceId: surface.id },
        body: { type: 'link', link },
      });
    },
    onSuccess: (card) => {
      putCard(qc, card);
      toast(t('quick.addLink.added', { name: title.trim() || fetched }));
      onClose();
    },
  });

  const sections = group?.config.sections ?? [];
  const valid = Boolean(url) && (target === 'card' || Boolean(group));

  return (
    <DialogContent width={520}>
      <DialogHeader
        icon="link"
        title={t('quick.addLink.title')}
        description={t('quick.addLink.to', { name: surfaceName })}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) add.mutate();
        }}
      >
        <Field
          label={t('quick.addLink.url')}
          error={raw.trim() && !normalizeUrl(raw) ? t('quick.addLink.invalidUrl') : undefined}
        >
          <Input
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="https://"
            inputMode="url"
          />
        </Field>

        {url ? (
          <div className="flex items-center gap-3 rounded-lg bg-bg2 px-3 py-2.5">
            {preview.isLoading ? (
              <>
                <Skeleton className="size-9 rounded-[10px]" />
                <Skeleton className="h-3 w-40" />
              </>
            ) : (
              <>
                <Favicon
                  title={title || fetched}
                  url={preview.data?.faviconUrl}
                  className="bg-surface"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-cap font-semibold">
                    {preview.data?.title
                      ? t('quick.addLink.fetched', { title: preview.data.title })
                      : t('quick.addLink.notFetched')}
                  </span>
                  <span className="truncate text-xs text-fg3">{preview.data?.host}</span>
                </span>
              </>
            )}
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('quick.addLink.name')}>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleTouched(true);
              }}
              maxLength={120}
            />
          </Field>
          <Field label={t('quick.addLink.description')}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
            />
          </Field>
        </div>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 text-cap font-semibold">{t('quick.addLink.where')}</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(['card', 'group'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={target === v}
                disabled={v === 'group' && groups.length === 0}
                onClick={() => setTarget(v)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-lg px-3.5 py-2.5 text-left disabled:opacity-45',
                  target === v ? 'bg-bg2 shadow-[inset_0_0_0_1.5px_var(--fg)]' : 'shadow-line',
                )}
              >
                <span className="text-cap font-semibold">{t(`quick.addLink.target.${v}`)}</span>
                <span className="text-xs text-fg2">{t(`quick.addLink.target.${v}Hint`)}</span>
              </button>
            ))}
          </div>
          {target === 'group' && groups.length ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('quick.addLink.group')}>
                <Select
                  value={groupId}
                  onValueChange={(v) => {
                    setGroupId(v);
                    setSectionId(groups.find((g) => g.id === v)?.config.sections[0]?.id ?? '');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {t('quick.addLink.groupOption', {
                          name: g.config.title,
                          count: g.config.sections.reduce((a, s) => a + s.items.length, 0),
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {sections.length > 1 ? (
                <Field label={t('quick.addLink.section')}>
                  <Segmented
                    value={sectionId}
                    onValueChange={setSectionId}
                    options={sections.map((s) => ({ value: s.id, label: s.title || '—' }))}
                    className="h-11 items-center"
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <label className="flex items-center gap-3 rounded-lg bg-bg2 px-3.5 py-3">
          <Icon name="activity" size={18} className="shrink-0 text-fg2" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-cap font-semibold">{t('quick.addLink.health')}</span>
            <span className="text-xs text-fg2">{t('quick.addLink.healthHint')}</span>
          </span>
          <Switch
            checked={check}
            onCheckedChange={setCheck}
            aria-label={t('quick.addLink.health')}
          />
        </label>

        {duplicate ? <Notice tone="warn">{t('quick.addLink.duplicate')}</Notice> : null}
        {add.isError ? <Notice tone="error">{t(errorKey(add.error))}</Notice> : null}
        <p className="m-0 text-xs text-fg3">{t('quick.addLink.pasteTip')}</p>

        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" variant="pri" disabled={!valid} loading={add.isPending}>
            {t('quick.addLink.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
