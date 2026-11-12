import { type OfficeSession } from '@crewhall/shared';
import { Button, EmptyState, Icon, Spinner, Tag } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';

type DocsApiSession = Extract<OfficeSession, { kind: 'onlyoffice' }>;
type WopiSession = Extract<OfficeSession, { kind: 'wopi' }>;

/** The global the Document Server's api.js defines. */
interface DocsApi {
  DocEditor: new (
    elementId: string,
    config: Record<string, unknown>,
  ) => { destroyEditor?: () => void };
}
declare global {
  interface Window {
    DocsAPI?: DocsApi;
  }
}

/**
 * The office editor page. Euro-Office / ONLYOFFICE servers run their api.js on this page with the
 * config Crewhall signed; WOPI servers run in an iframe the access token is POSTed to (never in
 * the URL, so it stays out of logs and history).
 */
export function OfficeEditor({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { t } = useI18n();
  const session = useQuery({
    queryKey: ['office', 'session', nodeId],
    queryFn: () => api.call('openOfficeSession', { params: { nodeId }, body: { mode: 'edit' } }),
    // A token per opening: never reuse an old one from the cache.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  if (session.isError) {
    return (
      <EmptyState className="m-auto" icon="alert" title={t('office.editor.unavailable')}>
        <Button variant="out" onClick={() => void session.refetch()}>
          {t('office.editor.retry')}
        </Button>
      </EmptyState>
    );
  }
  if (!session.data) {
    return (
      <div className="m-auto">
        <Spinner />
      </div>
    );
  }
  const s = session.data;
  return (
    <div className="relative flex size-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <Button variant="gh" size="sm" onClick={onClose}>
          <Icon name="arrowL" size={15} />
          {t('office.editor.back')}
        </Button>
        <span className="truncate text-sm font-semibold">{s.fileName}</span>
        {s.mode === 'view' ? <Tag>{t('office.editor.readOnly')}</Tag> : null}
        <span className="ml-auto hidden truncate text-cap text-fg3 md:block">
          {t('office.editor.savedToDrive')}
        </span>
      </header>
      <div className="relative min-h-0 flex-1">
        {s.kind === 'onlyoffice' ? (
          <DocsApiEditor session={s} onClose={onClose} />
        ) : (
          <WopiFrame session={s} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-fg2">
      <Spinner />
      {children}
    </div>
  );
}

/** Loads the server's api.js once per address. */
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string) {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scripts.delete(src);
        reject(new Error(`could not load ${src}`));
      };
      document.head.appendChild(el);
    });
    scripts.set(src, p);
  }
  return p;
}

function DocsApiEditor({ session, onClose }: { session: DocsApiSession; onClose: () => void }) {
  const { t } = useI18n();
  const id = `office-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    let editor: { destroyEditor?: () => void } | null = null;
    let cancelled = false;
    loadScript(session.apiUrl)
      .then(() => {
        if (cancelled || !window.DocsAPI) return;
        editor = new window.DocsAPI.DocEditor(id, {
          ...session.config,
          type: 'desktop',
          width: '100%',
          height: '100%',
          events: {
            onAppReady: () => setState('ready'),
            onRequestClose: () => close.current(),
          },
        });
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
      editor?.destroyEditor?.();
    };
  }, [id, session]);

  if (state === 'failed') {
    return (
      <EmptyState className="m-auto mt-16" icon="alert" title={t('office.editor.unavailable')} />
    );
  }
  return (
    <>
      {state === 'loading' ? <Loading>{t('office.editor.loading')}</Loading> : null}
      <div className="absolute inset-0">
        <div id={id} />
      </div>
    </>
  );
}

function WopiFrame({ session, onClose }: { session: WopiSession; onClose: () => void }) {
  const { t } = useI18n();
  const form = useRef<HTMLFormElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const target = `office-${session.nodeId}`;

  useEffect(() => {
    form.current?.submit();
  }, [session.accessToken]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== session.editorOrigin || e.source !== frame.current?.contentWindow) return;
      let msg: { MessageId?: string; Values?: { Status?: string } };
      try {
        msg = (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as typeof msg;
      } catch {
        return;
      }
      if (msg.MessageId === 'App_LoadingStatus') {
        if (msg.Values?.Status === 'Frame_Ready') {
          frame.current?.contentWindow?.postMessage(
            JSON.stringify({ MessageId: 'Host_PostmessageReady', SendTime: Date.now() }),
            session.editorOrigin,
          );
        }
        if (msg.Values?.Status === 'Document_Loaded') setLoaded(true);
      }
      if (msg.MessageId === 'UI_Close') onClose();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session.editorOrigin, onClose]);

  return (
    <>
      <form ref={form} action={session.actionUrl} method="post" target={target} className="hidden">
        <input type="hidden" name="access_token" value={session.accessToken} />
        <input type="hidden" name="access_token_ttl" value={String(session.accessTokenTtl)} />
      </form>
      {!loaded ? <Loading>{t('office.editor.loading')}</Loading> : null}
      <iframe
        ref={frame}
        name={target}
        title={t('office.editor.title', { name: session.fileName })}
        allow="clipboard-read; clipboard-write; fullscreen"
        allowFullScreen
        className="absolute inset-0 size-full border-0 bg-white"
        onLoad={() => {
          // Servers that send no loading status: show the frame once it has a page.
          if (frame.current?.contentWindow) setTimeout(() => setLoaded(true), 4000);
        }}
      />
    </>
  );
}
