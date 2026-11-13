import { CaptureUpdateAction, Excalidraw, FONT_FAMILY } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type {
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { type Drawing } from '@crewhall/shared';
import { Avatar, Button, cn, Icon, IconButton, Kbd, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openDriveDialog } from '@/features/drive/actions';
import { invalidateDrive, nodeQuery } from '@/features/drive/api';
import { api } from '@/lib/api';
import { boardKeys, libraryQuery } from '@/lib/boards/api';
import { type SceneElement } from '@/lib/boards/sceneSync';
import { useDrawingCollab, type Peer } from '@/lib/boards/useDrawingCollab';
import { errorKey } from '@/lib/errors';
import { useTitleBarProps } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useMe } from '@/lib/session';
import { ExportDialog } from './ExportDialog';
import { LibraryPanel } from './LibraryPanel';
import { useDiscardEmpty } from './useDiscardEmpty';

/**
 * Whiteboard (design 6.10-6.15): Excalidraw with Crewhall's look (flat shapes, roughness 0,
 * Nunito), live with others over Yjs (cursors and selections via awareness), images stored
 * on the server, our own export, library, read-only mode and follow mode on top.
 */
export function DrawingEditor({ drawing, isNew }: { drawing: Drawing; isNew: boolean }) {
  const { t, locale } = useI18n();
  // In the desktop app this bar is the window's title bar (lib/desktop-titlebar).
  const titleBar = useTitleBarProps<HTMLElement>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const { scheme } = useTheme();
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [exporting, setExporting] = useState(false);
  const [library, setLibrary] = useState(false);
  const [followId, setFollowId] = useState<number | null>(null);
  const [count, setCount] = useState(drawing.elementCount);
  const [name, setName] = useState(drawing.name);
  const personal = useQuery(libraryQuery(drawing.spaceId));
  const libraryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedLibrary = useRef<string | null>(null);
  // Fixed after the first render: Excalidraw reads its initial data once.
  const [initialLibrary] = useState(() => personal.data?.personal ?? []);
  const meInfo = useMemo(() => (me ? { id: me.user.id, name: me.user.name } : null), [me]);

  const target = useMemo(
    () => ({
      getElements: () =>
        (apiRef.current?.getSceneElementsIncludingDeleted() ?? []) as unknown as SceneElement[],
      setElements: (elements: SceneElement[]) =>
        apiRef.current?.updateScene({
          elements: elements as unknown as ExcalidrawElement[],
          captureUpdate: CaptureUpdateAction.NEVER,
        }),
      setPeers: (peers: Peer[]) => {
        const collaborators = new Map<SocketId, Collaborator>();
        for (const p of peers) {
          collaborators.set(String(p.clientId) as SocketId, {
            id: p.userId,
            socketId: String(p.clientId) as SocketId,
            username: p.name,
            pointer: p.pointer,
            button: p.button,
            selectedElementIds: p.selectedElementIds,
            color: { background: p.color, stroke: p.color },
          });
        }
        apiRef.current?.updateScene({ collaborators });
      },
      hasFile: (id: string) => Boolean(apiRef.current?.getFiles()[id]),
      addFile: (f: { id: string; dataURL: string; mimeType: string; created: number }) =>
        apiRef.current?.addFiles([f as unknown as BinaryFileData]),
    }),
    [],
  );

  const collab = useDrawingCollab({
    nodeId: drawing.id,
    me: meInfo,
    target: excalidraw ? target : null,
  });
  const readOnly = drawing.myRole === 'viewer' || collab.readOnly;

  // Follow mode (6.15): my view locks to the followed person's scroll and zoom.
  const following =
    followId === null ? undefined : collab.peers.find((x) => x.clientId === followId);
  const followView = following?.viewport;
  useEffect(() => {
    if (!followView || !apiRef.current) return;
    apiRef.current.updateScene({
      appState: {
        scrollX: followView.scrollX,
        scrollY: followView.scrollY,
        zoom: { value: followView.zoom as never },
      },
    });
  }, [followView]);

  useDiscardEmpty(isNew, drawing, () => apiRef.current?.getSceneElements().length ?? 0);

  const onChange = useCallback(
    (
      elements: readonly ExcalidrawElement[],
      appState: {
        selectedElementIds: Record<string, true>;
        scrollX: number;
        scrollY: number;
        zoom: { value: number };
      },
      files: Record<string, BinaryFileData>,
    ) => {
      collab.onChange(
        elements as unknown as SceneElement[],
        files as unknown as Record<string, { id: string; dataURL: string; mimeType: string }>,
        appState.selectedElementIds,
      );
      collab.onViewport({
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom.value,
      });
      setCount(elements.filter((e) => !e.isDeleted).length);
    },
    [collab],
  );

  const rename = async () => {
    const v = name.trim();
    if (!v || v === drawing.name) return setName(drawing.name);
    try {
      await api.call('updateNode', { params: { nodeId: drawing.id }, body: { name: v } });
      void qc.invalidateQueries({ queryKey: boardKeys.drawing(drawing.id) });
      invalidateDrive(qc);
    } catch (e) {
      toast(t(errorKey(e)));
      setName(drawing.name);
    }
  };

  const status =
    collab.status === 'connecting'
      ? t('boards.drawings.connecting')
      : collab.status === 'offline'
        ? t('boards.drawings.offline')
        : collab.saving
          ? t('boards.drawings.saving')
          : t('boards.drawings.saved');

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        {...titleBar}
        className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg px-3"
      >
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('boards.drawings.back')}
          onClick={() =>
            void navigate({ to: '/drawings/$spaceSlug', params: { spaceSlug: drawing.space.slug } })
          }
        >
          <Icon name="arrowL" size={16} />
        </IconButton>
        <Link
          to="/drawings/$spaceSlug"
          params={{ spaceSlug: drawing.space.slug }}
          className="text-cap font-medium text-fg2 hover:text-fg"
        >
          {drawing.space.name}
        </Link>
        <Icon name="chevR" size={14} className="text-fg3" />
        <input
          value={name}
          readOnly={readOnly}
          aria-label={t('boards.drawings.rename')}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 max-w-[320px] bg-transparent text-cap font-semibold text-fg outline-none"
        />
        {readOnly ? (
          <span className="rounded-full bg-bg2 px-2 py-0.5 text-xs font-semibold text-fg2">
            {t('boards.drawings.readOnly')}
          </span>
        ) : (
          <span
            className={cn('text-xs', collab.status === 'offline' ? 'text-warning' : 'text-fg3')}
            title={collab.status === 'fallback' ? t('boards.drawings.fallback') : undefined}
          >
            {status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {collab.peers.length ? (
            <span
              className="flex -space-x-1.5"
              aria-label={t('boards.drawings.people', { count: collab.peers.length })}
            >
              {dedupe(collab.peers).map((p) => (
                <button
                  key={p.clientId}
                  type="button"
                  title={
                    following?.clientId === p.clientId
                      ? t('boards.drawings.unfollow')
                      : t('boards.drawings.follow', { name: p.name })
                  }
                  onClick={() => setFollowId((f) => (f === p.clientId ? null : p.clientId))}
                  className={cn(
                    'rounded-full ring-2',
                    following?.clientId === p.clientId ? 'ring-fg' : 'ring-bg',
                  )}
                  style={{ boxShadow: `0 0 0 2px ${p.color}` }}
                >
                  <Avatar name={p.name} size="sm" />
                </button>
              ))}
            </span>
          ) : null}
          {following ? (
            <Button size="xs" variant="out" onClick={() => setFollowId(null)}>
              {t('boards.drawings.following', { name: following.name.split(' ')[0] ?? '' })}
              <Icon name="x" size={12} />
            </Button>
          ) : null}
          <Button
            size="xs"
            variant={library ? 'inv' : 'default'}
            onClick={() => setLibrary((v) => !v)}
          >
            <Icon name="layers" size={14} />
            {t('boards.drawings.library')}
          </Button>
          <Button size="xs" variant="default" onClick={() => setExporting(true)}>
            <Icon name="download" size={14} />
            {t('boards.drawings.export')}
          </Button>
          <Button
            size="xs"
            variant="inv"
            onClick={() =>
              // The drawing is a Drive node: the same share dialog as Drive (people, link).
              void qc
                .fetchQuery(nodeQuery(drawing.id))
                .then((node) => openDriveDialog({ kind: 'share', node }))
                .catch((e: unknown) => toast.error(t(errorKey(e))))
            }
          >
            <Icon name="share" size={14} />
            {t('boards.toolbar.share')}
          </Button>
        </div>
      </header>
      <div className="crewhall-excalidraw relative min-h-0 flex-1">
        {/* Our library panel replaces Excalidraw's sidebar trigger (design 6.12). */}
        <style>{'.crewhall-excalidraw .default-sidebar-trigger{display:none}'}</style>
        {collab.initial ? (
          <Excalidraw
            excalidrawAPI={(a) => {
              apiRef.current = a;
              setExcalidraw(a);
            }}
            initialData={{
              elements: collab.initial as unknown as ExcalidrawElement[],
              appState: {
                currentItemFontFamily: FONT_FAMILY.Nunito,
                currentItemRoughness: 0,
                currentItemStrokeColor: '#141516',
                currentItemStrokeWidth: 2,
                viewBackgroundColor: '#ffffff',
              },
              libraryItems: initialLibrary as never,
              scrollToContent: true,
            }}
            theme={scheme}
            langCode={locale === 'tr' ? 'tr-TR' : 'en'}
            viewModeEnabled={readOnly}
            isCollaborating={collab.status === 'live'}
            onChange={onChange as never}
            onPointerUpdate={({ pointer, button }) => collab.onPointer(pointer, button)}
            onLibraryChange={(items) => {
              // Excalidraw also reports the library it was given: save real changes only.
              const sig = items.map((i) => `${i.id}:${i.elements.length}`).join(',');
              const known = (personal.data?.personal ?? [])
                .map((i) => `${i.id}:${i.elements.length}`)
                .join(',');
              if (sig === (savedLibrary.current ?? known)) return;
              savedLibrary.current = sig;
              if (libraryTimer.current) clearTimeout(libraryTimer.current);
              libraryTimer.current = setTimeout(() => {
                void api
                  .call('updateDrawingLibrary', {
                    body: { scope: 'personal', items: items as never },
                  })
                  .catch(() => undefined);
              }, 600);
            }}
            UIOptions={{
              canvasActions: {
                export: false,
                saveAsImage: false,
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
                changeViewBackgroundColor: true,
                clearCanvas: !readOnly,
              },
            }}
          />
        ) : null}
        {collab.initial && count === 0 && !readOnly ? <EmptyHint /> : null}
        {readOnly ? (
          <p className="pointer-events-none absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-full bg-fg px-3 py-1.5 text-xs font-semibold text-bg shadow-overlay">
            {t('boards.drawings.readOnlyHint')}
          </p>
        ) : null}
        {library ? (
          <LibraryPanel
            drawing={drawing}
            excalidraw={excalidraw}
            onClose={() => setLibrary(false)}
          />
        ) : null}
      </div>
      <ExportDialog
        open={exporting}
        api={excalidraw}
        drawing={drawing}
        onClose={() => setExporting(false)}
      />
    </div>
  );
}

function dedupe(peers: Peer[]) {
  const seen = new Set<string>();
  return peers.filter((p) => (seen.has(p.userId) ? false : (seen.add(p.userId), true)));
}

/** Empty canvas (design 6.14): disappears with the first shape. */
function EmptyHint() {
  const { t } = useI18n();
  const keys: [string, string][] = [
    ['R', t('boards.drawings.shortcuts.rect')],
    ['O', t('boards.drawings.shortcuts.ellipse')],
    ['A', t('boards.drawings.shortcuts.arrow')],
    ['T', t('boards.drawings.shortcuts.text')],
    ['P', t('boards.drawings.shortcuts.pen')],
  ];
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
      <div className="flex max-w-[460px] flex-col items-center gap-3 rounded-3xl bg-surface/90 px-8 py-6 text-center shadow-[0_0_0_1px_var(--line)] backdrop-blur">
        <Icon name="vector" size={28} className="text-fg2" />
        <span className="text-sub font-semibold text-fg">{t('boards.drawings.emptyCanvas')}</span>
        <p className="text-sm text-fg2">{t('boards.drawings.emptyCanvasBody')}</p>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-fg2">
          {keys.map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5">
              <Kbd>{k}</Kbd>
              {label}
            </span>
          ))}
        </div>
        <span className="text-xs text-fg3">{t('boards.drawings.pasteImage')}</span>
      </div>
    </div>
  );
}
