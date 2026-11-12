import { type MessageRef, type RefItemType, type ResolvedRef } from '@crewhall/shared';
import { cn, Icon, Skeleton, type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type MouseEvent } from 'react';
import { refsQuery } from '@/lib/chat/refs';
import { useI18n } from '@/lib/i18n/I18nContext';

export const REF_ICON: Record<RefItemType, IconName> = {
  folder: 'folder',
  file: 'file',
  page: 'page',
  board: 'board',
  drawing: 'vector',
  card: 'card',
};

const FRAME =
  'flex max-w-[420px] min-w-[220px] items-center gap-2.5 rounded-lg bg-bg px-2.5 py-2 shadow-line';

function RefCard({ r }: { r: ResolvedRef }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (r.state !== 'ok' || !r.item) {
    // Nothing about the item: no type, no title, for anyone the server did not answer `ok`.
    const gone = r.state === 'deleted';
    return (
      <div className={cn(FRAME, 'text-fg2')}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2">
          <Icon name={gone ? 'trash' : 'lock'} size={15} />
        </span>
        <span className="text-cap">{t(gone ? 'chat.refs.deleted' : 'chat.refs.noAccess')}</span>
      </div>
    );
  }
  const { item } = r;
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    // Ctrl/Cmd or middle click keep the browser's new tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    void navigate({ href: item.path });
  };
  return (
    <a
      href={item.path}
      onClick={open}
      className={cn(FRAME, 'text-fg no-underline transition-colors hover:bg-bg2')}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2">
        <Icon name={REF_ICON[item.type]} size={16} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-cap font-semibold">{item.title}</span>
        <span className="truncate text-xs text-fg2">
          {t(`chat.refs.types.${item.type}`)}
          {item.spaceName ? ` · ${item.spaceName}` : ''}
        </span>
      </span>
    </a>
  );
}

/** Cards of a message's references, as this viewer may see them. */
export function RefCards({ refs }: { refs: MessageRef[] }) {
  const { data, isError } = useQuery(refsQuery(refs));
  const items: ResolvedRef[] | undefined = isError
    ? refs.map((r) => ({ ...r, state: 'no_access', item: null }))
    : data?.items;
  return (
    <div className="flex flex-col gap-1.5" data-no-quick-react="">
      {items
        ? items.map((r) => <RefCard key={`${r.kind}:${r.id}`} r={r} />)
        : refs.map((r) => <Skeleton key={r.id} className="h-[50px] w-[260px] rounded-lg" />)}
    </div>
  );
}
