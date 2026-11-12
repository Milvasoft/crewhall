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
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  type IconName,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { normalizeUrl } from './AddLinkDialog';
import { putCard } from './api';
import { useQuick } from './context';
import { Favicon } from './LinkBits';
import { LinkIconField, useLinkEditCapability, useLinkIcon } from './LinkIcon';

type Of<T extends Card['type']> = Extract<Card, { type: T }>;

/** How many items a list card may show (folder children, assigned board cards, messages). */
const COUNTS = [3, 5, 8, 10, 15, 20] as const;

/**
 * Whether "Düzenle" has something to change on this card. A pinned card mirrors its source and
 * is edited there; file, page and vault item cards only point at something.
 */
export function canEditCard(card: Card): boolean {
  if (card.pinnedFrom) return false;
  switch (card.type) {
    case 'link':
      return Boolean(card.links[card.config.item.linkId]);
    case 'node':
      return card.node?.type === 'folder';
    case 'link_group':
    case 'todo':
    case 'board_assigned':
    case 'chat':
    case 'meeting':
      return true;
    default:
      return false;
  }
}

/** "Düzenle" (menu, gear, E or F2) for every card type that has something to change. */
export function EditCardDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(card)} onOpenChange={(v) => (v ? null : onClose())}>
      {card ? <EditBody key={card.id} card={card} onClose={onClose} /> : null}
    </Dialog>
  );
}

function EditBody({ card, onClose }: { card: Card; onClose: () => void }) {
  switch (card.type) {
    case 'link':
      return <LinkForm card={card} onClose={onClose} />;
    case 'todo':
      return <TodoForm card={card} onClose={onClose} />;
    case 'node':
      return <FolderForm card={card} onClose={onClose} />;
    case 'board_assigned':
      return <AssignedForm card={card} onClose={onClose} />;
    case 'chat':
      return <ChatForm card={card} onClose={onClose} />;
    case 'meeting':
      return <MeetingForm card={card} onClose={onClose} />;
    default:
      return null;
  }
}

function Frame({
  icon,
  title,
  description,
  onSubmit,
  onClose,
  pending,
  disabled,
  error,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  onSubmit: () => void;
  onClose: () => void;
  pending?: boolean;
  disabled?: boolean;
  error?: unknown;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <DialogContent width={480}>
      <DialogHeader icon={icon} title={title} description={description} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!disabled) onSubmit();
        }}
      >
        {children}
        {error ? <Notice tone="error">{t(errorKey(error))}</Notice> : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" variant="pri" disabled={disabled} loading={pending}>
            {t('common.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** A count picker (3 to 20) for list cards. */
function CountField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const options = [...new Set([...COUNTS, value])].sort((a, b) => a - b);
  return (
    <Field label={label}>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Every space, or one (meetings and assigned board cards filter by it). */
function SpaceField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const { items } = useSpaces();
  const label = t('quick.editCard.space');
  return (
    <Field label={label}>
      <Select value={value ?? 'all'} onValueChange={(v) => onChange(v === 'all' ? null : v)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('quick.editCard.allSpaces')}</SelectItem>
          {items.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {spaceName(s, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function LinkForm({ card, onClose }: { card: Of<'link'>; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const qc = useQueryClient();
  const item = card.config.item;
  const link = card.links[item.linkId];
  // A server without the capability cannot move a card to another address or store an icon.
  const full = useLinkEditCapability();
  const [raw, setRaw] = useState(link?.url ?? '');
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [check, setCheck] = useState(link?.checkEnabled ?? true);
  const iconState = useLinkIcon(item.iconUrl);
  const { icon, ok: iconOk } = iconState;
  const url = normalizeUrl(raw);
  const moved = full && url !== null && url !== link?.url;

  const save = useMutation({
    mutationFn: async () => {
      let linkId = item.linkId;
      if (moved && url) {
        // A new address: the org-wide Link for it (favicon and health come with it); the card
        // keeps its id and points at it.
        const next = await api.call('resolveLink', {
          body: {
            url,
            checkEnabled: check,
            intervalSeconds: link?.intervalSeconds,
            cardId: card.id,
          },
        });
        linkId = next.id;
        putCard(qc, { ...card, links: { ...card.links, [next.id]: next } });
      } else if (link && check !== link.checkEnabled) {
        await api.call('updateLink', {
          params: { linkId: link.id },
          body: { checkEnabled: check },
        });
        void qc.invalidateQueries({ queryKey: ['surfaces'] });
      }
      q.updateConfig(card, (prev) => ({
        ...prev,
        item: {
          ...prev.item,
          linkId,
          title: title.trim() || prev.item.title,
          description: description.trim() || null,
          ...(full ? { iconUrl: icon || null } : {}),
        },
      }));
    },
    onSuccess: onClose,
  });

  return (
    <Frame
      icon="link"
      title={t('quick.editLink.title')}
      onSubmit={() => save.mutate()}
      onClose={onClose}
      pending={save.isPending}
      disabled={!url || !iconOk}
      error={save.error}
    >
      <div className="flex items-center gap-3 rounded-lg bg-bg2 px-3 py-2.5">
        <Favicon
          title={title || item.title}
          url={icon && iconOk ? icon : moved ? null : link?.faviconUrl}
          className="bg-surface"
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-cap font-semibold">{title || item.title}</span>
          <span className="truncate text-xs text-fg3">{url ?? link?.url}</span>
        </span>
      </div>
      {full ? (
        <Field
          label={t('quick.addLink.url')}
          hint={moved ? t('quick.editLink.movedHint') : undefined}
          error={raw.trim() && !url ? t('quick.addLink.invalidUrl') : undefined}
        >
          <Input value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="url" />
        </Field>
      ) : null}
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
      {full ? <LinkIconField state={iconState} /> : null}
      <label className="flex items-center gap-3 rounded-lg bg-bg2 px-3.5 py-3">
        <Icon name="activity" size={18} className="shrink-0 text-fg2" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-cap font-semibold">{t('quick.addLink.health')}</span>
          <span className="text-xs text-fg2">{t('quick.editLink.healthHint')}</span>
        </span>
        <Switch checked={check} onCheckedChange={setCheck} aria-label={t('quick.addLink.health')} />
      </label>
    </Frame>
  );
}

function TodoForm({ card, onClose }: { card: Of<'todo'>; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const [title, setTitle] = useState(card.config.title);
  return (
    <Frame
      icon="todo"
      title={t('quick.editCard.title')}
      onSubmit={() => {
        q.updateConfig(card, { ...card.config, title: title.trim() });
        onClose();
      }}
      onClose={onClose}
      disabled={!title.trim()}
    >
      <Field label={t('quick.editCard.name')}>
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} />
      </Field>
    </Frame>
  );
}

function FolderForm({ card, onClose }: { card: Of<'node'>; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const [count, setCount] = useState(card.config.maxItems ?? 8);
  return (
    <Frame
      icon="folder"
      title={t('quick.editCard.title')}
      description={card.node?.name}
      onSubmit={() => {
        q.updateConfig(card, { ...card.config, maxItems: count });
        onClose();
      }}
      onClose={onClose}
    >
      <CountField label={t('quick.editCard.folderItems')} value={count} onChange={setCount} />
    </Frame>
  );
}

function AssignedForm({ card, onClose }: { card: Of<'board_assigned'>; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const [scope, setScope] = useState(card.config.scope);
  const [spaceId, setSpaceId] = useState(card.config.spaceId);
  const [limit, setLimit] = useState(card.config.limit);
  return (
    <Frame
      icon="board"
      title={t('quick.editCard.title')}
      onSubmit={() => {
        q.updateConfig(card, { scope, spaceId, limit });
        onClose();
      }}
      onClose={onClose}
    >
      <Field label={t('quick.editCard.show')}>
        <Segmented
          aria-label={t('quick.editCard.show')}
          value={scope}
          onValueChange={setScope}
          options={[
            { value: 'assigned', label: t('boards.assigned.card') },
            { value: 'due', label: t('boards.assigned.dueTitle') },
          ]}
        />
      </Field>
      <SpaceField value={spaceId} onChange={setSpaceId} />
      <CountField label={t('quick.editCard.boardCards')} value={limit} onChange={setLimit} />
    </Frame>
  );
}

function ChatForm({ card, onClose }: { card: Of<'chat'>; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const [limit, setLimit] = useState(card.config.limit);
  return (
    <Frame
      icon="chat"
      title={t('quick.editCard.title')}
      onSubmit={() => {
        q.updateConfig(card, { ...card.config, limit });
        onClose();
      }}
      onClose={onClose}
    >
      <CountField label={t('quick.editCard.messages')} value={limit} onChange={setLimit} />
    </Frame>
  );
}

function MeetingForm({ card, onClose }: { card: Of<'meeting'>; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const [spaceId, setSpaceId] = useState(card.config.spaceId);
  return (
    <Frame
      icon="video"
      title={t('quick.editCard.title')}
      onSubmit={() => {
        q.updateConfig(card, { spaceId });
        onClose();
      }}
      onClose={onClose}
    >
      <SpaceField value={spaceId} onChange={setSpaceId} />
    </Frame>
  );
}
