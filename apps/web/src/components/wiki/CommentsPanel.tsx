import { type CommentThread, type OrgMember, type Page } from '@crewhall/shared';
import { Avatar, Button, cn, Icon, IconButton, Segmented, Textarea, toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { wikiKeys } from '@/lib/wiki/api';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** Extracts @mentions written as "@Ad Soyad" against the directory. */
export function mentionsIn(body: string, people: OrgMember[]): string[] {
  const out = new Set<string>();
  for (const m of people) {
    if (body.includes(`@${m.user.name}`)) out.add(m.user.id);
  }
  return [...out];
}

/**
 * Comment panel (design 5.9, mobile 14.15): open and resolved threads; a thread anchored to
 * text, or "Sayfa geneli" when it has no anchor or its text is gone.
 */
export function CommentsPanel({
  page,
  threads,
  people,
  active,
  onActivate,
  pending,
  onPendingDone,
  isAnchored,
  onClose,
}: {
  page: Page;
  threads: CommentThread[];
  people: OrgMember[];
  active: string | null;
  onActivate: (id: string | null) => void;
  /** A selection waiting for its first comment. */
  pending: { start: string; end: string; quote: string } | null;
  onPendingDone: () => void;
  /** Whether a thread's range still exists in the document. */
  isAnchored: (t: CommentThread) => boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: wikiKeys.comments(page.id) });
    void qc.invalidateQueries({ queryKey: wikiKeys.page(page.id) });
  };
  const open = threads.filter((x) => !x.resolvedAt);
  const resolved = threads.filter((x) => x.resolvedAt);
  const list = tab === 'open' ? open : resolved;
  const anchored = list.filter((x) => x.anchorStart && isAnchored(x));
  const general = list.filter((x) => !(x.anchorStart && isAnchored(x)));

  return (
    <ResizablePane id="page-comments" side="right" defaultWidth={340} className="wk-noprint">
      <aside
        aria-label={t('wiki.comments.title')}
        className="wk-noprint flex w-full min-w-0 flex-col border-l border-line bg-bg"
      >
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <span className="font-semibold">{t('wiki.comments.title')}</span>
          <Segmented
            className="ml-auto"
            size="sm"
            value={tab}
            onValueChange={(v) => setTab(v)}
            options={[
              { value: 'open', label: t('wiki.comments.open', { count: open.length }) },
              { value: 'resolved', label: t('wiki.comments.resolved', { count: resolved.length }) },
            ]}
          />
          <IconButton
            aria-label={t('common.actions.close')}
            size="sm"
            tone="plain"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {pending ? (
            <Composer
              page={page}
              people={people}
              quote={pending.quote}
              autoFocus
              placeholder={t('wiki.comments.first')}
              onCancel={onPendingDone}
              onSend={async (body, mentions) => {
                const th = await api.call('createPageComment', {
                  params: { nodeId: page.id },
                  body: {
                    body,
                    mentions,
                    anchorStart: pending.start,
                    anchorEnd: pending.end,
                    quote: pending.quote,
                  },
                });
                onPendingDone();
                refresh();
                onActivate(th.id);
              }}
            />
          ) : null}
          {anchored.map((th) => (
            <Thread
              key={th.id}
              th={th}
              page={page}
              people={people}
              active={active === th.id}
              onActivate={onActivate}
              refresh={refresh}
            />
          ))}
          {general.length || tab === 'open' ? (
            <span className="eyebrow mt-1 px-1">{t('wiki.comments.general')}</span>
          ) : null}
          {general.map((th) => (
            <Thread
              key={th.id}
              th={th}
              page={page}
              people={people}
              active={active === th.id}
              onActivate={onActivate}
              refresh={refresh}
              orphan={Boolean(th.anchorStart)}
            />
          ))}
          {tab === 'open' && page.canComment ? (
            <Composer
              page={page}
              people={people}
              placeholder={t('wiki.comments.newGeneral')}
              onSend={async (body, mentions) => {
                await api.call('createPageComment', {
                  params: { nodeId: page.id },
                  body: { body, mentions },
                });
                refresh();
              }}
            />
          ) : null}
          {list.length === 0 && !pending ? (
            <p className="px-1 text-cap text-fg3">
              {t(tab === 'open' ? 'wiki.comments.noneOpen' : 'wiki.comments.noneResolved')}
            </p>
          ) : null}
        </div>
      </aside>
    </ResizablePane>
  );
}

function Thread({
  th,
  page,
  people,
  active,
  onActivate,
  refresh,
  orphan,
}: {
  th: CommentThread;
  page: Page;
  people: OrgMember[];
  active: boolean;
  onActivate: (id: string | null) => void;
  refresh: () => void;
  orphan?: boolean;
}) {
  const { t, locale } = useI18n();
  const me = useMe();
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);
  const canAdmin = page.myRole === 'owner' || page.myRole === 'admin';
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border border-line bg-surface p-3 transition-shadow',
        active && 'shadow-[0_0_0_2px_var(--fg)]',
      )}
      onClick={() => onActivate(th.id)}
    >
      {th.quote ? (
        <p
          className={cn(
            'mb-2 truncate border-l-2 border-line2 pl-2 text-cap text-fg2',
            orphan && 'line-through',
          )}
        >
          “{th.quote}”
        </p>
      ) : null}
      <div className="flex flex-col gap-2.5">
        {th.comments.map((c) => (
          <div key={c.id} className="group flex gap-2">
            <Avatar size="sm" name={c.author?.name ?? '?'} src={c.author?.imageUrl ?? undefined} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-cap">
                <b className="font-semibold text-fg">
                  {c.author?.name ?? t('wiki.comments.unknown')}
                </b>
                <span className="text-fg3">{formatRelative(c.createdAt, locale)}</span>
                {c.editedAt ? (
                  <span className="text-fg3">· {t('wiki.comments.edited')}</span>
                ) : null}
                {c.author?.id === me?.user.id || canAdmin ? (
                  <button
                    type="button"
                    className="ml-auto hidden text-fg3 group-hover:block hover:text-danger"
                    aria-label={t('wiki.comments.delete')}
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.call('deletePageComment', { params: { commentId: c.id } });
                        refresh();
                      } catch (err) {
                        toast(t(errorKey(err)));
                      }
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                ) : null}
              </div>
              <p className="text-[13.5px] whitespace-pre-wrap text-fg">
                <Highlighted text={c.body} people={people} />
              </p>
            </div>
          </div>
        ))}
      </div>
      {active && page.canComment ? (
        <div className="mt-3 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <Composer
              page={page}
              people={people}
              autoFocus
              placeholder={t('wiki.comments.reply')}
              onCancel={() => setReplying(false)}
              onSend={async (body, mentions) => {
                await api.call('createPageComment', {
                  params: { nodeId: page.id },
                  body: { body, mentions, threadId: th.id },
                });
                setReplying(false);
                refresh();
              }}
            />
          ) : (
            <div className="flex gap-2">
              <Button size="xs" variant="default" onClick={() => setReplying(true)}>
                <Icon name="reply" size={14} /> {t('wiki.comments.replyButton')}
              </Button>
              <Button
                size="xs"
                variant="gh"
                onClick={async () => {
                  try {
                    await api.call('resolvePageThread', {
                      params: { threadId: th.id },
                      body: { resolved: !th.resolvedAt },
                    });
                    onActivate(null);
                    refresh();
                  } catch (err) {
                    toast(t(errorKey(err)));
                  }
                }}
              >
                <Icon name={th.resolvedAt ? 'refresh' : 'check'} size={14} />
                {t(th.resolvedAt ? 'wiki.comments.reopen' : 'wiki.comments.resolve')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** "@Ad" of known people in yellow (mobile 14.15). */
function Highlighted({ text, people }: { text: string; people: OrgMember[] }) {
  const names = people
    .map((p) => p.user.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return <>{text}</>;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g'));
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') && names.includes(p.slice(1)) ? (
          <span key={i} className="wk-mention wk-mention-user">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

function Composer({
  page,
  people,
  placeholder,
  quote,
  autoFocus,
  onSend,
  onCancel,
}: {
  page: Page;
  people: OrgMember[];
  placeholder: string;
  quote?: string;
  autoFocus?: boolean;
  onSend: (body: string, mentions: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const at = /@([\p{L}\p{N}.]*)$/u.exec(body);
  const suggestions = at
    ? people
        .filter((p) =>
          p.user.name.toLocaleLowerCase('tr').startsWith(at[1]!.toLocaleLowerCase('tr')),
        )
        .slice(0, 5)
    : [];
  void page;
  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await onSend(text, mentionsIn(text, people));
      setBody('');
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      {quote ? (
        <p className="truncate border-l-2 border-accent pl-2 text-cap text-fg2">“{quote}”</p>
      ) : null}
      <Textarea
        value={body}
        autoFocus={autoFocus}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape') onCancel?.();
        }}
      />
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((p) => (
            <button
              key={p.user.id}
              type="button"
              className="rounded-full bg-bg2 px-2 py-0.5 text-xs hover:bg-capsule"
              onClick={() => setBody(body.replace(/@[\p{L}\p{N}.]*$/u, `@${p.user.name} `))}
            >
              @{p.user.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button size="xs" variant="gh" onClick={onCancel}>
            {t('common.actions.cancel')}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="pri"
          loading={busy}
          disabled={!body.trim()}
          onClick={() => void send()}
        >
          {t('wiki.comments.send')}
        </Button>
      </div>
    </div>
  );
}
