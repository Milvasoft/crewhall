import { type Card } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { normalizeUrl } from './AddLinkDialog';
import { putCard } from './api';
import { type CardConfigOf, useQuick } from './context';
import { Favicon } from './LinkBits';
import { LinkIconField, useLinkEditCapability, useLinkIcon } from './LinkIcon';

type Group = Extract<Card, { type: 'link_group' }>;
type Config = CardConfigOf<'link_group'>;
type Item = Config['sections'][number]['items'][number];

export interface EditTarget {
  sectionId: string;
  itemId: string;
}

/**
 * Edit a link of a group (title, description, address, health check, sub-section). The display
 * text lives on the card; the address and the check belong to the org-wide link, so a new
 * address adds that link and takes the old item's place.
 */
export function EditLinkDialog({
  card,
  target,
  onClose,
}: {
  card: Group;
  target: EditTarget | null;
  onClose: () => void;
}) {
  const section = target ? card.config.sections.find((s) => s.id === target.sectionId) : null;
  const item = section?.items.find((i) => i.id === target?.itemId);
  return (
    <Dialog open={Boolean(item)} onOpenChange={(v) => (v ? null : onClose())}>
      {item && section ? (
        <EditBody key={item.id} card={card} sectionId={section.id} item={item} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}

function EditBody({
  card,
  sectionId,
  item,
  onClose,
}: {
  card: Group;
  sectionId: string;
  item: Item;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const q = useQuick();
  const qc = useQueryClient();
  const link = card.links[item.linkId];
  const [raw, setRaw] = useState(link?.url ?? '');
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [section, setSection] = useState(sectionId);
  const [check, setCheck] = useState(link?.checkEnabled ?? true);
  const full = useLinkEditCapability();
  const iconState = useLinkIcon(item.iconUrl);
  const url = normalizeUrl(raw);
  const sections = card.config.sections;

  const save = useMutation({
    mutationFn: async () => {
      const text = {
        title: title.trim() || item.title,
        description: description.trim() || null,
        // The row's own icon (server with quick.linkEdit); empty means the site's favicon.
        ...(full ? { iconUrl: iconState.icon || null } : {}),
      };
      if (url && link && url !== link.url) {
        // New address: add it to the chosen section, then put it where the old item was.
        const before = new Set(sections.flatMap((s) => s.items.map((i) => i.id)));
        const saved = await api.call('addGroupLink', {
          params: { cardId: card.id },
          body: {
            link: {
              url,
              title: text.title,
              description: text.description ?? undefined,
              checkEnabled: check,
              intervalSeconds: link.intervalSeconds,
            },
            sectionId: section,
          },
        });
        putCard(qc, saved);
        const added = (saved as Group).config.sections
          .flatMap((s) => s.items)
          .find((i) => !before.has(i.id));
        q.updateConfig(saved as Group, (prev) => ({
          ...prev,
          sections: prev.sections.map((s) => {
            const items = s.items.filter((i) => i.id !== item.id && i.id !== added?.id);
            if (s.id !== section || !added) return { ...s, items };
            const at = s.id === sectionId ? s.items.findIndex((i) => i.id === item.id) : -1;
            if (at < 0) return { ...s, items: [...items, { ...added, ...text }] };
            items.splice(at, 0, { ...added, ...text });
            return { ...s, items };
          }),
        }));
        return;
      }
      if (link && check !== link.checkEnabled) {
        await api.call('updateLink', {
          params: { linkId: link.id },
          body: { checkEnabled: check },
        });
        void qc.invalidateQueries({ queryKey: ['surfaces'] });
      }
      q.updateConfig(card, (prev) => ({
        ...prev,
        sections: prev.sections.map((s) => {
          const items = s.items.filter((i) => i.id !== item.id || s.id === section);
          if (s.id !== section) return { ...s, items };
          // Same section: edit in place; another one: it joins at the end.
          return s.id === sectionId
            ? { ...s, items: s.items.map((i) => (i.id === item.id ? { ...i, ...text } : i)) }
            : { ...s, items: [...items, { ...item, ...text }] };
        }),
      }));
    },
    onSuccess: onClose,
  });

  return (
    <DialogContent width={520}>
      <DialogHeader icon="link" title={t('quick.editLink.title')} description={card.config.title} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (url && iconState.ok) save.mutate();
        }}
      >
        <div className="flex items-center gap-3 rounded-lg bg-bg2 px-3 py-2.5">
          <Favicon
            title={title || item.title}
            url={iconState.icon && iconState.ok ? iconState.icon : link?.faviconUrl}
            className="bg-surface"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-cap font-semibold">{title || item.title}</span>
            <span className="truncate text-xs text-fg3">{link?.host}</span>
          </span>
        </div>
        <Field
          label={t('quick.addLink.url')}
          error={raw.trim() && !url ? t('quick.addLink.invalidUrl') : undefined}
        >
          <Input value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="url" />
        </Field>
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <Field label={t('quick.addLink.name')}>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
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
        {sections.length > 1 ? (
          <Field label={t('quick.addLink.section')}>
            <Select value={section} onValueChange={setSection}>
              <SelectTrigger aria-label={t('quick.addLink.section')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sections.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title || t('quick.settings.untitled')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        {full ? <LinkIconField state={iconState} /> : null}
        <label className="flex items-center gap-3 rounded-lg bg-bg2 px-3.5 py-3">
          <Icon name="activity" size={18} className="shrink-0 text-fg2" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-cap font-semibold">{t('quick.addLink.health')}</span>
            <span className="text-xs text-fg2">{t('quick.editLink.healthHint')}</span>
          </span>
          <Switch
            checked={check}
            onCheckedChange={setCheck}
            aria-label={t('quick.addLink.health')}
          />
        </label>
        {save.isError ? <Notice tone="error">{t(errorKey(save.error))}</Notice> : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="pri"
            disabled={!url || !iconState.ok}
            loading={save.isPending}
          >
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
