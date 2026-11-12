import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { type LibraryItem } from '@crewhall/shared';

/** Shape library helpers (design 6.12): built-in sets and inserting items into the scene. */

type Skeleton = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];

const STROKE = '#141516';

function shape(
  type: 'rectangle' | 'ellipse' | 'diamond',
  text: string,
  w: number,
  h: number,
  bg: string,
): Skeleton {
  return {
    type,
    x: 0,
    y: 0,
    width: w,
    height: h,
    strokeColor: STROKE,
    backgroundColor: bg,
    fillStyle: 'solid',
    roughness: 0,
    strokeWidth: 2,
    roundness: type === 'rectangle' ? { type: 3 } : null,
    label: { text, fontSize: 18, fontFamily: 6 },
  } as Skeleton;
}

export type BuiltinKey =
  | 'server'
  | 'database'
  | 'queue'
  | 'storage'
  | 'user'
  | 'phone'
  | 'startEnd'
  | 'process'
  | 'decision'
  | 'document'
  | 'data'
  | 'connector';

export const BUILTIN_SETS: { set: 'infra' | 'flow'; items: BuiltinKey[] }[] = [
  { set: 'infra', items: ['server', 'database', 'queue', 'storage', 'user', 'phone'] },
  { set: 'flow', items: ['startEnd', 'process', 'decision', 'document', 'data', 'connector'] },
];

/** A built-in item with its (translated) label. */
export function builtinItem(key: BuiltinKey, label: string): LibraryItem {
  const sk: Record<BuiltinKey, () => Skeleton[]> = {
    server: () => [shape('rectangle', label, 160, 80, '#bfdbfe')],
    database: () => [shape('ellipse', label, 160, 90, '#99f6e4')],
    queue: () => [shape('rectangle', label, 200, 56, '#ddd6fe')],
    storage: () => [shape('rectangle', label, 140, 100, '#fde68a')],
    user: () => [shape('ellipse', label, 100, 100, '#fbcfe8')],
    phone: () => [shape('rectangle', label, 80, 140, '#e5e7eb')],
    startEnd: () => [shape('ellipse', label, 160, 70, '#bbf7d0')],
    process: () => [shape('rectangle', label, 160, 80, '#e0f2fe')],
    decision: () => [shape('diamond', label, 160, 120, '#fef3c7')],
    document: () => [shape('rectangle', label, 140, 100, '#ffffff')],
    data: () => [shape('rectangle', label, 160, 70, '#ede9fe')],
    connector: () => [
      {
        type: 'arrow',
        x: 0,
        y: 0,
        width: 200,
        height: 0,
        strokeColor: STROKE,
        roughness: 0,
        strokeWidth: 2,
        points: [
          [0, 0],
          [200, 0],
        ],
      } as Skeleton,
    ],
  };
  const elements = convertToExcalidrawElements(sk[key]()) as unknown as LibraryItem['elements'];
  return { id: `builtin-${key}`, status: 'published', elements, name: label, created: 0 };
}

const rid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);

/**
 * Drops a library item into the middle of the view: fresh ids (groups and bindings remapped),
 * version 1, a new index so it sorts on top; the item is a group, editable on its own.
 */
export function insertItem(api: ExcalidrawImperativeAPI, item: LibraryItem) {
  const src = item.elements as unknown as ExcalidrawElement[];
  if (!src.length) return;
  const ids = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const el of src) ids.set(el.id, rid());
  const groupId = rid();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of src) {
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  const st = api.getAppState();
  const zoom = st.zoom.value;
  const cx = -st.scrollX + st.width / 2 / zoom;
  const cy = -st.scrollY + st.height / 2 / zoom;
  const dx = cx - (minX + maxX) / 2;
  const dy = cy - (minY + maxY) / 2;
  const map = (id: string | null | undefined) => (id ? (ids.get(id) ?? id) : id);
  const now = Date.now();
  const copies = src.map((el) => {
    const e = el as ExcalidrawElement & {
      containerId?: string | null;
      boundElements?: { id: string; type: string }[] | null;
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
    };
    return {
      ...e,
      id: ids.get(e.id)!,
      x: e.x + dx,
      y: e.y + dy,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      seed: Math.floor(Math.random() * 2 ** 31),
      updated: now,
      index: null,
      isDeleted: false,
      groupIds: [
        ...e.groupIds.map((g) => {
          if (!groups.has(g)) groups.set(g, rid());
          return groups.get(g)!;
        }),
        groupId,
      ],
      containerId: map(e.containerId) ?? null,
      boundElements: e.boundElements?.map((b) => ({ ...b, id: map(b.id)! })) ?? null,
      startBinding: e.startBinding
        ? { ...e.startBinding, elementId: map(e.startBinding.elementId)! }
        : e.startBinding,
      endBinding: e.endBinding
        ? { ...e.endBinding, elementId: map(e.endBinding.elementId)! }
        : e.endBinding,
    };
  });
  api.updateScene({
    elements: [
      ...api.getSceneElementsIncludingDeleted(),
      ...(copies as unknown as ExcalidrawElement[]),
    ],
    appState: {
      selectedElementIds: Object.fromEntries(copies.map((c) => [c.id, true])),
    },
  });
}

/** The current selection as a new library item. */
export function selectionItem(api: ExcalidrawImperativeAPI, name?: string): LibraryItem | null {
  const ids = api.getAppState().selectedElementIds;
  const picked = api.getSceneElements().filter((e) => ids[e.id]);
  if (!picked.length) return null;
  return {
    id: rid(),
    status: 'unpublished',
    elements: JSON.parse(JSON.stringify(picked)) as LibraryItem['elements'],
    created: Date.now(),
    ...(name ? { name } : {}),
  };
}
