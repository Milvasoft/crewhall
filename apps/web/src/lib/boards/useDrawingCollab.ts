import { HocuspocusProvider } from '@hocuspocus/provider';
import { resolveCollabUrl } from '@crewhall/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { api } from '@/lib/api';
import { changedSince, SceneSync, sortScene, type SceneElement } from './sceneSync';

/**
 * Live drawing session: Yjs over the collab server (`drawing:<nodeId>`) with awareness for
 * cursors and selections; when the server cannot be reached (or the mock), the editor saves
 * over HTTP (`saveDrawingScene`, merged per element version) and polls for others' changes.
 */

export type CollabStatus = 'connecting' | 'live' | 'fallback' | 'offline';

export interface Peer {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, true>;
  viewport?: { scrollX: number; scrollY: number; zoom: number };
}

/** Category tones for cursors: stable per person. */
const COLORS = ['#3b82f6', '#14b8a6', '#ec4899', '#8b5cf6', '#84cc16', '#f38424', '#0e7490'];
export const colorFor = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length]!;
};

export interface SceneTarget {
  getElements: () => readonly SceneElement[];
  setElements: (elements: SceneElement[]) => void;
  setPeers: (peers: Peer[]) => void;
  hasFile: (fileId: string) => boolean;
  addFile: (file: { id: string; dataURL: string; mimeType: string; created: number }) => void;
}

const CONNECT_TIMEOUT_MS = 6000;
const POLL_MS = 5000;
const SAVE_DEBOUNCE_MS = 800;

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function useDrawingCollab(opts: {
  nodeId: string;
  me: { id: string; name: string } | null;
  target: SceneTarget | null;
}) {
  const { nodeId, me, target } = opts;
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [readOnly, setReadOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [initial, setInitial] = useState<SceneElement[] | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const syncRef = useRef<SceneSync | null>(null);
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const modeRef = useRef<CollabStatus>('connecting');
  const lastSaved = useRef(new Map<string, number>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());

  const setMode = (m: CollabStatus) => {
    modeRef.current = m;
    setStatus(m);
  };

  /** Loads the images other people placed: file ids the editor does not hold yet. */
  const fetchMissingFiles = (elements: readonly SceneElement[]) => {
    const t = targetRef.current;
    if (!t) return;
    for (const el of elements) {
      const fileId = el.type === 'image' && typeof el.fileId === 'string' ? el.fileId : null;
      if (!fileId || el.isDeleted || t.hasFile(fileId) || requested.current.has(fileId)) continue;
      requested.current.add(fileId);
      void api
        .call('getDrawingFileUrl', { params: { nodeId, file: fileId } })
        .then(async (f) => {
          const res = await fetch(f.url);
          if (!res.ok) throw new Error(String(res.status));
          const dataURL = await blobToDataURL(await res.blob());
          uploaded.current.add(fileId);
          targetRef.current?.addFile({
            id: fileId,
            dataURL,
            mimeType: f.mime,
            created: Date.now(),
          });
        })
        .catch(() => requested.current.delete(fileId));
    }
  };

  // Connect once per drawing.
  useEffect(() => {
    let cancelled = false;
    let fellBack = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const doc = new Y.Doc();

    const startFallback = async () => {
      if (cancelled || fellBack) return;
      fellBack = true;
      if (timer) clearTimeout(timer);
      providerRef.current?.destroy();
      providerRef.current = null;
      setMode('fallback');
      try {
        const scene = await api.call('getDrawingScene', { params: { nodeId } });
        if (cancelled) return;
        lastSaved.current = new Map(scene.elements.map((e) => [e.id, e.version]));
        setInitial((cur) => cur ?? (scene.elements as SceneElement[]));
        fetchMissingFiles(scene.elements as SceneElement[]);
      } catch {
        setInitial((cur) => cur ?? []);
      }
      if (cancelled) return;
      poll = setInterval(async () => {
        try {
          const scene = await api.call('getDrawingScene', { params: { nodeId } });
          const t = targetRef.current;
          if (!t) return;
          const local = new Map(t.getElements().map((e) => [e.id, e]));
          let changed = false;
          for (const el of scene.elements as SceneElement[]) {
            const mine = local.get(el.id);
            if (!mine || el.version > mine.version) {
              local.set(el.id, el);
              changed = true;
            }
            lastSaved.current.set(el.id, Math.max(lastSaved.current.get(el.id) ?? 0, el.version));
          }
          if (changed) {
            t.setElements(sortScene([...local.values()]));
            fetchMissingFiles(scene.elements as SceneElement[]);
          }
        } catch {
          /* next round */
        }
      }, POLL_MS);
    };

    void (async () => {
      let token;
      try {
        token = await api.call('createBoardsCollabToken', {
          body: { document: `drawing:${nodeId}` },
        });
      } catch {
        void startFallback();
        return;
      }
      if (cancelled) return;
      setReadOnly(token.readOnly);
      // No collab server configured (mock, minimal installs): straight to HTTP saves.
      if (!token.url) {
        void startFallback();
        return;
      }
      timer = setTimeout(() => void startFallback(), CONNECT_TIMEOUT_MS);
      const provider = new HocuspocusProvider({
        url: resolveCollabUrl(token.url, window.location.href),
        name: token.document,
        document: doc,
        token: async () => {
          // Tokens are short-lived: a reconnect asks for a fresh one.
          const t = await api.call('createBoardsCollabToken', {
            body: { document: `drawing:${nodeId}` },
          });
          return t.token;
        },
        onAuthenticationFailed: () => void startFallback(),
        onSynced: () => {
          if (cancelled || modeRef.current === 'fallback') return;
          if (timer) clearTimeout(timer);
          const sync = new SceneSync(
            doc,
            () => targetRef.current?.getElements() ?? [],
            (elements) => {
              targetRef.current?.setElements(elements);
              fetchMissingFiles(elements);
            },
          );
          syncRef.current?.destroy();
          syncRef.current = sync;
          const els = sync.elements();
          setInitial((cur) => cur ?? els);
          fetchMissingFiles(els);
          setMode('live');
        },
        onStatus: ({ status: s }) => {
          if (modeRef.current === 'fallback') return;
          if (s === 'disconnected' && modeRef.current === 'live') setMode('offline');
          if (s === 'connected' && modeRef.current === 'offline') setMode('live');
        },
      });
      providerRef.current = provider;
      const awareness = provider.awareness;
      awareness?.on('change', () => {
        const states = awareness.getStates();
        const list: Peer[] = [];
        states.forEach((st, clientId) => {
          if (clientId === doc.clientID) return;
          const user = st.user as { id?: string; name?: string; color?: string } | undefined;
          if (!user?.id) return;
          list.push({
            clientId,
            userId: user.id,
            name: user.name ?? '',
            color: user.color ?? colorFor(user.id),
            pointer: st.pointer as Peer['pointer'],
            button: st.button as Peer['button'],
            selectedElementIds: st.selectedElementIds as Peer['selectedElementIds'],
            viewport: st.viewport as Peer['viewport'],
          });
        });
        setPeers(list);
        targetRef.current?.setPeers(list);
      });
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      syncRef.current?.destroy();
      syncRef.current = null;
      providerRef.current?.destroy();
      providerRef.current = null;
      doc.destroy();
      modeRef.current = 'connecting';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // Who I am for the others' cursors.
  useEffect(() => {
    if (!me || !providerRef.current?.awareness) return;
    providerRef.current.awareness.setLocalStateField('user', {
      id: me.id,
      name: me.name,
      color: colorFor(me.id),
    });
  }, [me, status]);

  const handlers = useMemo(
    () => ({
      /** Excalidraw onChange: elements to Yjs (or the HTTP save), new images to the server. */
      onChange(
        elements: readonly SceneElement[],
        files: Record<string, { id: string; dataURL: string; mimeType: string }>,
        selected?: Record<string, true>,
      ) {
        if (readOnly) return;
        for (const f of Object.values(files)) {
          if (uploaded.current.has(f.id) || requested.current.has(f.id)) continue;
          uploaded.current.add(f.id);
          void api
            .call('uploadDrawingFile', {
              params: { nodeId },
              body: { fileId: f.id, dataURL: f.dataURL },
            })
            .catch(() => uploaded.current.delete(f.id));
        }
        const awareness = providerRef.current?.awareness;
        if (awareness && selected) awareness.setLocalStateField('selectedElementIds', selected);
        if (modeRef.current === 'live' || modeRef.current === 'offline') {
          syncRef.current?.pushLocal(elements);
          return;
        }
        if (modeRef.current !== 'fallback') return;
        const changed = changedSince(elements, lastSaved.current);
        if (!changed.length) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
          const batch = changedSince(
            targetRef.current?.getElements() ?? elements,
            lastSaved.current,
          );
          if (!batch.length) return;
          setSaving(true);
          try {
            await api.call('saveDrawingScene', {
              params: { nodeId },
              body: { elements: batch as never },
            });
            for (const e of batch) lastSaved.current.set(e.id, e.version);
          } catch {
            /* retried on the next change */
          } finally {
            setSaving(false);
          }
        }, SAVE_DEBOUNCE_MS);
      },
      onPointer(
        pointer: { x: number; y: number; tool: 'pointer' | 'laser' },
        button: 'up' | 'down',
      ) {
        const awareness = providerRef.current?.awareness;
        if (!awareness) return;
        awareness.setLocalStateField('pointer', pointer);
        awareness.setLocalStateField('button', button);
      },
      onViewport(viewport: { scrollX: number; scrollY: number; zoom: number }) {
        providerRef.current?.awareness?.setLocalStateField('viewport', viewport);
      },
    }),
    [nodeId, readOnly],
  );

  return { status, readOnly, saving, peers, initial, ...handlers };
}
