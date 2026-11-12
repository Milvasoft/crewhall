import { paths } from '@crewhall/shared';
import { Button, Field, Icon, Input, Segmented, Spinner, Textarea } from '@crewhall/ui';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../shared/api';
import { findDate, toLocalInput } from '../../shared/dates';
import { errorText, t } from '../../shared/i18n';
import { htmlToMarkdown, sourceLine } from '../../shared/markdown';
import {
  dropDraft,
  getDriveTarget,
  setDriveTarget,
  takeDraft,
  type Connection,
  type Draft,
} from '../../shared/storage';
import { fetchSource, fileNameFor, NeedsPermissionError, uploadBlob } from '../../shared/upload';
import { Brand, mount, NeedsConnection, Notice, SelectBox, useConnection, useLoad } from '../shell';

type Destination = 'drive' | 'page' | 'chat' | 'board' | 'calendar' | 'quick';

const BY_KIND: Record<Draft['kind'], Destination[]> = {
  image: ['drive', 'chat'],
  link: ['drive', 'quick', 'chat'],
  selection: ['page', 'chat', 'board', 'calendar'],
  page: ['page', 'quick', 'chat', 'board'],
  screenshot: ['drive', 'chat'],
};

const newUuid = () => crypto.randomUUID();

/** The bytes of an image, file or screenshot, asking for the site when the browser needs it. */
async function blobOf(draft: Draft): Promise<Blob> {
  if (draft.dataUrl) return (await fetch(draft.dataUrl)).blob();
  if (draft.srcUrl) return fetchSource(draft.srcUrl);
  throw new Error('nothing to send');
}

const nameOf = (draft: Draft, blob: Blob) =>
  draft.dataUrl
    ? `${t('send.screenshotName')} ${new Date().toLocaleString('sv').replace(/:/g, '.')}.png`
    : fileNameFor(draft.srcUrl ?? '', blob.type, draft.title || t('send.fileName'));

function markdownOf(draft: Draft): string {
  const body = draft.html ? htmlToMarkdown(draft.html, draft.pageUrl) : (draft.text ?? '');
  const source = sourceLine(draft.title, draft.pageUrl, t('send.source'));
  return [source, body].filter(Boolean).join('\n\n');
}

interface DestinationProps {
  draft: Draft;
  connection: Connection;
  run: (work: () => Promise<string | null | void>) => void;
  busy: boolean;
}

function useSpaces() {
  return useLoad(async () => {
    const { items } = await (await api()).call('listSpaces');
    return items.filter((s) => !s.archivedAt);
  }, []);
}

function ToDrive({ draft, run, busy }: DestinationProps) {
  const spaces = useSpaces();
  const [spaceId, setSpaceId] = useState('');
  const [stack, setStack] = useState<{ id: string; name: string }[]>([]);
  const parentId = stack[stack.length - 1]?.id ?? null;
  const [name, setName] = useState('');

  useEffect(() => {
    void getDriveTarget().then((target) => {
      if (target) setSpaceId(target.spaceId);
    });
  }, []);
  const space = spaces.data?.find((s) => s.id === spaceId) ?? spaces.data?.[0];
  const folders = useLoad(async () => {
    if (!space) return [];
    const { items } = await (
      await api()
    ).call('listNodes', {
      params: { spaceId: space.id },
      query: { type: 'folder', limit: 100, ...(parentId ? { parentId } : {}) },
    });
    return items;
  }, [space?.id, parentId]);

  const save = () =>
    run(async () => {
      if (!space) return;
      const client = await api();
      const blob = await blobOf(draft);
      await uploadBlob(client, blob, { spaceId: space.id, parentId, name: name.trim() || nameOf(draft, blob) });
      await setDriveTarget({ spaceId: space.id, parentId, label: space.name });
      return paths.driveSpace(space.slug);
    });

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('send.fileNameLabel')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('send.fileNameAuto')} />
      </Field>
      <Field label={t('send.space')}>
        <SelectBox
          label={t('send.space')}
          value={space?.id ?? ''}
          onChange={(v) => {
            setSpaceId(v);
            setStack([]);
          }}
          options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
        />
      </Field>
      <div className="flex flex-col gap-1 rounded-lg border border-line p-2">
        <div className="flex items-center gap-1 text-xs font-semibold text-fg2">
          <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-fg2" onClick={() => setStack([])}>
            {space?.name ?? ''}
          </button>
          {stack.map((f, i) => (
            <span key={f.id} className="flex items-center gap-1">
              <span aria-hidden="true">›</span>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-fg2"
                onClick={() => setStack(stack.slice(0, i + 1))}
              >
                {f.name}
              </button>
            </span>
          ))}
        </div>
        <ul className="m-0 max-h-40 list-none overflow-y-auto p-0">
          {(folders.data ?? []).map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => setStack([...stack, { id: f.id, name: f.name }])}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-sm text-fg hover:bg-bg2"
              >
                <Icon name="folder" size={15} />
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))}
          {folders.data && !folders.data.length ? (
            <li className="px-1.5 py-1 text-xs text-fg3">{t('send.noFolders')}</li>
          ) : null}
        </ul>
      </div>
      <Button variant="pri" loading={busy} disabled={!space} onClick={save}>
        {t('send.saveHere')}
      </Button>
    </div>
  );
}

function ToPage({ draft, run, busy }: DestinationProps) {
  const spaces = useSpaces();
  const [mode, setMode] = useState<'new' | 'append'>('new');
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState(draft.title);
  const [q, setQ] = useState('');
  const [pageId, setPageId] = useState('');
  const results = useLoad(async () => {
    if (mode !== 'append' || q.trim().length < 2) return [];
    const { items } = await (
      await api()
    ).call('searchContent', { query: { q: q.trim(), kinds: 'page', limit: 8 } });
    return items.filter((h) => h.nodeId);
  }, [mode, q]);
  const space = spaces.data?.find((s) => s.id === spaceId) ?? spaces.data?.[0];
  const markdown = useMemo(() => markdownOf(draft), [draft]);

  const save = () =>
    run(async () => {
      const client = await api();
      if (mode === 'append') {
        await client.call('appendPage', { params: { nodeId: pageId }, body: { markdown } });
        return paths.page(pageId);
      }
      if (!space) return;
      const page = await client.call('createPage', {
        params: { spaceId: space.id },
        body: { parentId: null, name: name.trim().slice(0, 255) || t('send.untitled'), markdown },
      });
      return paths.page(page.id);
    });

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={mode}
        onValueChange={(v) => setMode(v as 'new' | 'append')}
        options={[
          { value: 'new', label: t('send.newPage') },
          { value: 'append', label: t('send.appendPage') },
        ]}
      />
      {mode === 'new' ? (
        <>
          <Field label={t('send.pageName')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('send.space')}>
            <SelectBox
              label={t('send.space')}
              value={space?.id ?? ''}
              onChange={setSpaceId}
              options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        </>
      ) : (
        <>
          <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('send.findPage')} aria-label={t('send.findPage')} />
          <ul className="m-0 max-h-40 list-none overflow-y-auto p-0">
            {(results.data ?? []).map((h) => (
              <li key={h.refId}>
                <button
                  type="button"
                  onClick={() => setPageId(h.nodeId!)}
                  className={`w-full cursor-pointer truncate rounded-md border-0 px-2 py-1.5 text-left text-sm text-fg ${pageId === h.nodeId ? 'bg-bg2 font-bold' : 'bg-transparent hover:bg-bg2'}`}
                >
                  {h.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <pre className="m-0 max-h-32 overflow-auto rounded-lg bg-bg2 p-2 text-[11px] whitespace-pre-wrap text-fg2">{markdown.slice(0, 1200)}</pre>
      <Button variant="pri" loading={busy} disabled={mode === 'append' ? !pageId : !space} onClick={save}>
        {t('send.save')}
      </Button>
    </div>
  );
}

function ToChat({ draft, run, busy }: DestinationProps) {
  const hasFile = Boolean(draft.dataUrl) || draft.kind === 'image';
  const initial = [draft.kind === 'selection' ? (draft.text ?? '') : '', draft.srcUrl && !hasFile ? draft.srcUrl : draft.pageUrl]
    .filter(Boolean)
    .join('\n\n');
  const [text, setText] = useState(initial);
  const [q, setQ] = useState('');
  const [conversationId, setConversationId] = useState('');
  const conversations = useLoad(async () => {
    const { items } = await (await api()).call('listConversations', { query: { limit: 50 } });
    return items;
  }, []);
  const shown = (conversations.data ?? []).filter((c) =>
    c.title.toLocaleLowerCase('tr').includes(q.trim().toLocaleLowerCase('tr')),
  );

  const save = () =>
    run(async () => {
      const client = await api();
      const attachmentNodeIds: string[] = [];
      if (hasFile) {
        const blob = await blobOf(draft);
        const folder = await client.call('getChatAttachmentFolder', { params: { conversationId } });
        const node = await uploadBlob(client, blob, {
          spaceId: folder.spaceId,
          parentId: folder.folderId,
          name: nameOf(draft, blob),
        });
        attachmentNodeIds.push(node.id);
      }
      await client.call('sendMessage', {
        params: { conversationId },
        body: { clientMsgId: newUuid(), text, attachmentNodeIds },
      });
      return paths.chatConversation(conversationId);
    });

  return (
    <div className="flex flex-col gap-3">
      <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('send.message')} />
      <Input icon="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('send.findChat')} aria-label={t('send.findChat')} />
      <ul className="m-0 max-h-44 list-none overflow-y-auto p-0">
        {shown.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => setConversationId(c.id)}
              className={`w-full cursor-pointer truncate rounded-md border-0 px-2 py-1.5 text-left text-sm text-fg ${conversationId === c.id ? 'bg-bg2 font-bold' : 'bg-transparent hover:bg-bg2'}`}
            >
              {c.title}
            </button>
          </li>
        ))}
      </ul>
      <Button variant="pri" loading={busy} disabled={!conversationId} onClick={save}>
        {t('send.sendMessage')}
      </Button>
    </div>
  );
}

function ToBoard({ draft, run, busy }: DestinationProps) {
  const spaces = useSpaces();
  const [spaceId, setSpaceId] = useState('');
  const [boardId, setBoardId] = useState('');
  const [columnId, setColumnId] = useState('');
  const [title, setTitle] = useState((draft.text ?? draft.title).slice(0, 200));
  const space = spaces.data?.find((s) => s.id === spaceId) ?? spaces.data?.[0];
  const boards = useLoad(async () => {
    if (!space) return [];
    return (await (await api()).call('listBoards', { params: { spaceId: space.id } })).items;
  }, [space?.id]);
  const board = boards.data?.find((b) => b.id === boardId) ?? boards.data?.[0];
  const detail = useLoad(async () => {
    if (!board) return null;
    return (await api()).call('getBoard', { params: { boardId: board.id } });
  }, [board?.id]);
  const column = detail.data?.columns.find((c) => c.id === columnId) ?? detail.data?.columns[0];

  const save = () =>
    run(async () => {
      if (!board || !column) return;
      const card = await (
        await api()
      ).call('createBoardCard', {
        params: { boardId: board.id },
        body: {
          columnId: column.id,
          title: title.trim().slice(0, 200),
          description: draft.text && draft.text !== title ? `${draft.text}\n\n${draft.pageUrl}` : draft.pageUrl,
          top: false,
          labels: [],
          assigneeIds: [],
          dueAt: null,
        },
      });
      return paths.boardCard(board.id, String(card.number));
    });

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('send.cardTitle')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t('send.space')}>
        <SelectBox label={t('send.space')} value={space?.id ?? ''} onChange={(v) => { setSpaceId(v); setBoardId(''); setColumnId(''); }} options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
      </Field>
      <Field label={t('send.to.board')}>
        <SelectBox label={t('send.to.board')} value={board?.id ?? ''} onChange={(v) => { setBoardId(v); setColumnId(''); }} options={(boards.data ?? []).map((b) => ({ value: b.id, label: b.name }))} />
      </Field>
      <Field label={t('send.column')}>
        <SelectBox label={t('send.column')} value={column?.id ?? ''} onChange={setColumnId} options={(detail.data?.columns ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      {boards.data && !boards.data.length ? <p className="m-0 text-xs text-fg3">{t('send.noBoards')}</p> : null}
      <Button variant="pri" loading={busy} disabled={!column || !title.trim()} onClick={save}>
        {t('send.createCard')}
      </Button>
    </div>
  );
}

function ToCalendar({ draft, run, busy }: DestinationProps) {
  const found = useMemo(() => findDate(draft.text ?? ''), [draft.text]);
  const startDefault = useMemo(() => {
    if (found?.hasTime) return found.date;
    const d = found?.date ?? new Date(Date.now() + 86_400_000);
    d.setHours(9, 0, 0, 0);
    return d;
  }, [found]);
  const [title, setTitle] = useState((draft.text ?? draft.title).split('\n')[0]!.slice(0, 200));
  const [start, setStart] = useState(toLocalInput(startDefault));
  const [end, setEnd] = useState(toLocalInput(new Date(startDefault.getTime() + 3_600_000)));
  const [calendarId, setCalendarId] = useState('');
  const calendars = useLoad(async () => {
    const { items } = await (await api()).call('listCalendars');
    return items.filter((c) => c.myRole !== 'viewer');
  }, []);
  const calendar = calendars.data?.find((c) => c.id === calendarId) ?? calendars.data?.find((c) => c.isDefault) ?? calendars.data?.[0];

  const save = () =>
    run(async () => {
      if (!calendar) return;
      await (
        await api()
      ).call('createCalendarEvent', {
        body: {
          calendarId: calendar.id,
          title: title.trim(),
          description: `${draft.text ?? ''}\n\n${draft.pageUrl}`.trim(),
          allDay: false,
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      });
      return paths.calendar();
    });

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('send.eventTitle')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t('send.start')}>
        <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
      </Field>
      <Field label={t('send.end')}>
        <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
      </Field>
      <Field label={t('send.to.calendar')}>
        <SelectBox label={t('send.to.calendar')} value={calendar?.id ?? ''} onChange={setCalendarId} options={(calendars.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </Field>
      <Button variant="pri" loading={busy} disabled={!calendar || !title.trim() || end <= start} onClick={save}>
        {t('send.createEvent')}
      </Button>
    </div>
  );
}

function ToQuick({ draft, run, busy }: DestinationProps) {
  const [surfaceId, setSurfaceId] = useState('');
  const url = draft.srcUrl ?? draft.pageUrl;
  const [title, setTitle] = useState(draft.title.slice(0, 120));
  const surfaces = useLoad(async () => {
    const { items } = await (await api()).call('listSurfaces');
    return items.filter((s) => s.canEdit);
  }, []);
  const surface = surfaces.data?.find((s) => s.id === surfaceId) ?? surfaces.data?.[0];
  const isWebAddress = /^https?:\/\//i.test(url);

  const save = () =>
    run(async () => {
      if (!surface || !isWebAddress) return;
      await (
        await api()
      ).call('createCard', {
        params: { surfaceId: surface.id },
        body: { type: 'link', link: { url, title: title.trim().slice(0, 120) || undefined } },
      });
      return paths.home();
    });

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 truncate text-xs text-fg3">{url}</p>
      <Field label={t('send.linkTitle')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t('send.surface')}>
        <SelectBox
          label={t('send.surface')}
          value={surface?.id ?? ''}
          onChange={setSurfaceId}
          options={(surfaces.data ?? []).map((s) => ({
            value: s.id,
            label: s.owner.type === 'space' ? s.owner.spaceName : t('send.myQuickAccess'),
          }))}
        />
      </Field>
      <Button variant="pri" loading={busy} disabled={!surface || !isWebAddress} onClick={save}>
        {t('send.addLink')}
      </Button>
    </div>
  );
}

function Preview({ draft }: { draft: Draft }) {
  const src = draft.dataUrl ?? (draft.kind === 'image' ? draft.srcUrl : undefined);
  return (
    <div className="flex items-center gap-3 border-b border-line p-3">
      {src ? <img src={src} alt="" className="size-14 shrink-0 rounded-lg bg-bg2 object-cover" /> : null}
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm font-bold">{draft.title || draft.pageUrl}</p>
        <p className="m-0 truncate text-xs text-fg3">{draft.srcUrl ?? draft.pageUrl}</p>
      </div>
    </div>
  );
}

function Sender({ connection }: { connection: Connection }) {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const draftId = query.get('d') ?? '';
  const { data: draft, loading } = useLoad(() => takeDraft(draftId), [draftId]);
  const [picked, setPicked] = useState<Destination | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<{ origin: string; retry: () => void } | null>(null);
  const [done, setDone] = useState<{ path: string | null } | null>(null);

  // A screenshot can be megabytes and session storage is small: closing the window frees it.
  useEffect(() => {
    const free = () => void dropDraft(draftId);
    window.addEventListener('pagehide', free);
    return () => window.removeEventListener('pagehide', free);
  }, [draftId]);

  if (loading) return <Spinner className="m-auto my-10 block" />;
  if (!draft) return <p className="p-4 text-sm text-fg3">{t('send.expired')}</p>;

  const options = BY_KIND[draft.kind];
  const wanted = query.get('to') as Destination | null;
  const destination = picked ?? (wanted && options.includes(wanted) ? wanted : options[0]!);

  const run: DestinationProps['run'] = (work) => {
    setBusy(true);
    setError(null);
    setNeeds(null);
    work()
      .then(async (path) => {
        await dropDraft(draftId);
        setDone({ path: path ?? null });
      })
      .catch((e: unknown) => {
        if (e instanceof NeedsPermissionError) setNeeds({ origin: e.origin, retry: () => run(work) });
        else setError((e as { code?: string }).code ? errorText(e) : t('send.failed'));
      })
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <Icon name="check" size={28} />
        <p className="m-0 text-sm font-bold">{t('send.done')}</p>
        <div className="flex gap-2">
          {done.path ? (
            <Button variant="pri" size="sm" onClick={() => void chrome.tabs.create({ url: new URL(done.path!, connection.origin).href })}>
              {t('send.open')}
            </Button>
          ) : null}
          <Button variant="out" size="sm" onClick={() => window.close()}>
            {t('send.close')}
          </Button>
        </div>
      </div>
    );
  }

  const props: DestinationProps = { draft, connection, run, busy };

  return (
    <>
      <Preview draft={draft} />
      <div className="flex flex-col gap-3 p-3">
        {options.length > 1 ? (
          <Segmented
            value={destination}
            onValueChange={(v) => setPicked(v as Destination)}
            options={options.map((o) => ({ value: o, label: t(`send.to.${o}`) }))}
          />
        ) : null}
        {needs ? (
          <Notice tone="info">
            <span className="block">{t('send.needsSite', { site: new URL(needs.origin).host })}</span>
            <Button
              variant="out"
              size="sm"
              onClick={() => {
                void chrome.permissions.request({ origins: [`${needs.origin}/*`] }).then((ok) => {
                  if (ok) needs.retry();
                });
              }}
            >
              {t('send.allowSite')}
            </Button>
          </Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {destination === 'drive' ? <ToDrive {...props} /> : null}
        {destination === 'page' ? <ToPage {...props} /> : null}
        {destination === 'chat' ? <ToChat {...props} /> : null}
        {destination === 'board' ? <ToBoard {...props} /> : null}
        {destination === 'calendar' ? <ToCalendar {...props} /> : null}
        {destination === 'quick' ? <ToQuick {...props} /> : null}
      </div>
    </>
  );
}

function Send() {
  const connection = useConnection();
  if (connection === undefined) return null;
  return (
    <div className="flex min-h-screen flex-col">
      <Brand />
      {connection ? <Sender connection={connection} /> : <NeedsConnection />}
    </div>
  );
}

mount(<Send />);
