import {
  type BoardCardDetail,
  type CardLink,
  type CardLinkType,
  type LinkedCard,
} from '@crewhall/shared';
import {
  Button,
  cn,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { boardKeys, invalidateBoard } from '@/lib/boards/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

const TYPES: CardLinkType[] = ['blocked_by', 'blocks', 'relates', 'duplicates', 'duplicated_by'];

/**
 * Card dependencies (kararlar 2026-10-29): what blocks the card, what it blocks, related
 * and duplicate cards, on this board or another one. Adding searches cards by title or key.
 */
export function CardLinks({ card, canEdit }: { card: BoardCardDetail; canEdit: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const links = card.links ?? [];

  const refresh = (items: CardLink[] | null) => {
    qc.setQueryData<BoardCardDetail>(boardKeys.card(card.id), (d) =>
      d && items ? { ...d, links: items } : d,
    );
    void qc.invalidateQueries({ queryKey: boardKeys.card(card.id) });
    invalidateBoard(qc, card.boardId);
  };

  const remove = async (link: CardLink) => {
    try {
      await api.call('removeBoardCardLink', { params: { linkId: link.id } });
      refresh(links.filter((l) => l.id !== link.id));
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  const open = (c: LinkedCard) =>
    void navigate({ to: '/b/$boardId/$cardRef', params: { boardId: c.boardId, cardRef: c.key } });

  return (
    <section className="flex flex-col gap-2" aria-label={t('boards.links.title')}>
      <div className="flex items-center gap-2">
        <h4 className="text-[13.5px] font-bold text-fg">{t('boards.links.title')}</h4>
        {card.blockedBy ? (
          <span className="flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] px-2 py-0.5 text-[11.5px] font-bold text-warning">
            <Icon name="lock" size={12} />
            {t('boards.links.blockedHint', { count: card.blockedBy })}
          </span>
        ) : null}
        {canEdit ? <AddLink card={card} onAdded={refresh} className="ml-auto" /> : null}
      </div>
      {links.length === 0 ? (
        <p className="text-[13px] text-fg3">{t('boards.links.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {TYPES.filter((type) => links.some((l) => l.type === type)).map((type) => (
            <div key={type} className="flex flex-col gap-1">
              <span className="eyebrow">{t(`boards.links.types.${type}`)}</span>
              <ul className="flex flex-col gap-px">
                {links
                  .filter((l) => l.type === type)
                  .map((l) => (
                    <li
                      key={l.id}
                      className="group flex items-center gap-2.5 rounded-md bg-bg2 px-2.5 py-1.5"
                    >
                      <span className="font-mono text-[11.5px] text-fg3">{l.card.key}</span>
                      <button
                        type="button"
                        onClick={() => open(l.card)}
                        className={cn(
                          'min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-fg hover:underline',
                          l.card.done && 'text-fg3 line-through',
                        )}
                      >
                        {l.card.title}
                      </button>
                      {l.card.boardId !== card.boardId ? (
                        <span className="max-w-[140px] truncate text-[11.5px] text-fg3">
                          {l.card.boardName}
                        </span>
                      ) : null}
                      <span className="rounded-full bg-bg px-2 py-0.5 text-[11px] font-semibold text-fg2">
                        {l.card.done ? t('boards.links.done') : l.card.columnName}
                      </span>
                      {canEdit ? (
                        <IconButton
                          size="xs"
                          tone="plain"
                          aria-label={t('boards.links.remove', { key: l.card.key })}
                          onClick={() => void remove(l)}
                        >
                          <Icon name="x" size={13} />
                        </IconButton>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AddLink({
  card,
  onAdded,
  className,
}: {
  card: BoardCardDetail;
  onAdded: (items: CardLink[]) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CardLinkType>('blocked_by');
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const term = q.trim();
  const found = useQuery({
    queryKey: ['boards', 'card-search', term, card.boardId],
    queryFn: ({ signal }) =>
      api.call('searchBoardCards', { query: { q: term, boardId: card.boardId }, signal }),
    enabled: open && term.length > 0,
    staleTime: 10_000,
  });
  const taken = new Set([card.id, ...(card.links ?? []).map((l) => l.card.id)]);
  const results = (found.data?.items ?? []).filter((c) => !taken.has(c.id));

  const add = async (target: LinkedCard) => {
    try {
      const out = await api.call('addBoardCardLink', {
        params: { cardId: card.id },
        body: { cardId: target.id, type },
      });
      onAdded(out.items);
      setOpen(false);
      setQ('');
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="out" className={className}>
          <Icon name="link" size={14} />
          {t('boards.links.add')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-[380px] flex-col gap-2 p-3"
        // Typing the card is the main step; the type keeps its last choice.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
      >
        <Select value={type} onValueChange={(v) => setType(v as CardLinkType)}>
          <SelectTrigger aria-label={t('boards.links.kind')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((x) => (
              <SelectItem key={x} value={x}>
                {t(`boards.links.pick.${x}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('boards.links.search')}
          aria-label={t('boards.links.search')}
          className="h-9 rounded-md bg-bg2 px-2.5 text-[13.5px] outline-none placeholder:text-fg3"
        />
        <ul className="flex max-h-[260px] flex-col overflow-y-auto" role="listbox">
          {results.map((c) => (
            <li key={c.id} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => void add(c)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
              >
                <span className="font-mono text-[11.5px] text-fg3">{c.key}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.title}</span>
                {c.boardId !== card.boardId ? (
                  <span className="max-w-[110px] truncate text-[11px] text-fg3">{c.boardName}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {term && found.data && results.length === 0 ? (
          <p className="px-1 py-2 text-[13px] text-fg3">{t('boards.links.noResults')}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
