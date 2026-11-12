import {
  can,
  type EndpointName,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type CommentThread,
  type DriveNode,
  type Page,
  type PageTemplate,
  type PageTreeItem,
  type PageExportJob,
  type BoardTemplateContent,
  type PageTemplateContent,
  type SpaceTemplateContent,
  type Template,
  type TemplateKind,
  type PageVersion,
} from '@crewhall/shared';
import {
  actorOf,
  MockApiError,
  orgCtx,
  paginate,
  requireUser,
  summary,
  type Resolvers,
} from './core';
import { newId } from './db';
import { mockBoardContent, mockBoardFromTemplate } from './boards';
import { driveState, mockPublicNode, nodeForUser } from './drive';
import { type MockNode } from './driveSeed';
import { type MockState, type MockUser } from './seed';

/**
 * Wiki part of the contract mock (design 05). Pages are Drive nodes of type `page`; their
 * body, versions and comments live in a separate store in localStorage. There is no collab
 * server in mock mode: `createCollabToken` returns an empty URL and the editor runs locally
 * from `getPageContent` (edits are not kept).
 */

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}
interface MockVersion {
  id: string;
  version: number;
  label: string | null;
  createdBy: string;
  createdAt: string;
  markdown: string;
  restoredFrom: number | null;
}
interface MockComment {
  id: string;
  rootId: string | null;
  authorId: string;
  body: string;
  mentions: string[];
  quote: string | null;
  anchorStart: string | null;
  anchorEnd: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  editedAt: string | null;
}
interface MockPage {
  markdown: string;
  icon: string | null;
  cover: string | null;
  fullWidth: boolean;
  smallText: boolean;
  locked: boolean;
  editedAt: string;
  editedBy: string;
  versions: MockVersion[];
  comments: MockComment[];
  /** Who follows the page. */
  followers?: string[];
  /** Followers who also hear about the sub-pages. */
  subFollowers?: string[];
  /** Set by movePage; otherwise pages sort by creation time. */
  position?: string;
}
/** Template gallery (roadmap 8): saved templates of every kind. */
interface MockTemplate {
  id: string;
  kind: TemplateKind;
  scope: 'org' | 'space' | 'personal';
  spaceId: string | null;
  ownerUserId: string | null;
  name: string;
  description: string;
  category: string;
  content: PageTemplateContent | BoardTemplateContent | SpaceTemplateContent;
  createdBy: string;
}
interface WikiState {
  gallery?: MockTemplate[];
  pages: Record<string, MockPage>;
  templates: (PageTemplate & { markdown: string })[];
  /** Sample bodies were added to the Drive seed pages. */
  seeded?: boolean;
}

const KEY = 'crewhall.mock.wiki';
/** Page exports of this session (mock: always ready). */
const mockExports = new Map<string, PageExportJob & { userId: string }>();
let memory: WikiState | null = null;
const now = () => new Date().toISOString();

/** Tests start every case from an empty wiki store. */
export function resetWikiMock() {
  memory = { pages: {}, templates: [] };
}

function load(): WikiState {
  if (memory) return memory;
  try {
    const raw =
      import.meta.env.MODE !== 'test' && typeof localStorage !== 'undefined'
        ? localStorage.getItem(KEY)
        : null;
    if (raw) memory = JSON.parse(raw) as WikiState;
  } catch {
    memory = null;
  }
  memory ??= { pages: {}, templates: [] };
  return memory;
}
function persist() {
  try {
    if (import.meta.env.MODE !== 'test' && typeof localStorage !== 'undefined' && memory) {
      localStorage.setItem(KEY, JSON.stringify(memory));
    }
  } catch {
    /* best effort */
  }
}

/** Minimal markdown → page JSON for the mock (headings, tasks, lists, paragraphs). */
export function mockMarkdownToDoc(md: string): { type: 'doc'; content: PMNode[] } {
  const content: PMNode[] = [];
  const text = (s: string): PMNode[] => (s ? [{ type: 'text', text: s }] : []);
  let list: PMNode | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const task = /^- \[( |x)\]\s*(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (task) {
      if (list?.type !== 'taskList') content.push((list = { type: 'taskList', content: [] }));
      list.content!.push({
        type: 'taskItem',
        attrs: { checked: task[1] === 'x' },
        content: [{ type: 'paragraph', content: text(task[2]!) }],
      });
      continue;
    }
    if (bullet) {
      if (list?.type !== 'bulletList') content.push((list = { type: 'bulletList', content: [] }));
      list.content!.push({
        type: 'listItem',
        content: [{ type: 'paragraph', content: text(bullet[1]!) }],
      });
      continue;
    }
    list = null;
    if (h) content.push({ type: 'heading', attrs: { level: h[1]!.length }, content: text(h[2]!) });
    else if (line.trim()) content.push({ type: 'paragraph', content: text(line) });
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

const words = (md: string) => (md.match(/[\p{L}\p{N}]+/gu) ?? []).length;

function pageOf(id: string): MockPage {
  const w = load();
  w.pages[id] ??= {
    markdown: '',
    icon: null,
    cover: null,
    fullWidth: false,
    smallText: false,
    locked: false,
    editedAt: now(),
    editedBy: '',
    versions: [],
    comments: [],
  };
  return w.pages[id];
}

function nodeOf(s: MockState, u: MockUser, id: string): { node: MockNode; drive: DriveNode } {
  const d = driveState(s);
  const node = d.nodes.find((n) => n.id === id && n.type === 'page');
  const drive = node ? nodeForUser(s, id, u.id) : null;
  if (!node || !drive) throw new MockApiError('not_found');
  return { node, drive };
}

/** A page as "Portal'a gönder" reads it: the caller must be able to see it. */
export function mockPageSource(s: MockState, nodeId: string): { name: string; markdown: string } {
  const { node } = nodeOf(s, requireUser(s), nodeId);
  return { name: node.name, markdown: pageOf(node.id).markdown };
}

const canDo = (
  s: MockState,
  u: MockUser,
  role: DriveNode['myRole'] | null,
  action: 'space.edit_content' | 'space.comment' | 'space.purge',
) => can(actorOf(s, u), action, { type: 'space', org: orgCtx(s), myRole: role });

/** Sample bodies for the Drive seed's pages (design 05 / 14.13). */
const SAMPLE: Record<string, { markdown: string; icon: string | null }> = {
  Onboarding: {
    markdown: [
      'Ekibe hoş geldin.',
      '',
      '## İlk hafta',
      '',
      "- [x] Hub hesabını aç ve 2FA'yı kur",
      '- [ ] Geliştirme ortamını kur',
    ].join('\n'),
    icon: '👋',
  },
  'Kod standartları': {
    markdown: ['- Conventional Commits', '- Her değişiklik testle gelir'].join('\n'),
    icon: null,
  },
  Milvaion: { markdown: 'Dağıtık iş zamanlayıcısı.', icon: '🧭' },
  Mimari: {
    markdown: [
      '## Genel bakış',
      '',
      'Sistem üç süreçten oluşur: API, Scheduler ve Worker sunucuları.',
      '',
      '## Açık işler',
      '',
      "- [ ] Lider seçimini PostgreSQL advisory lock'a taşı",
    ].join('\n'),
    icon: '🏗️',
  },
};

function ensureSeed(s: MockState, u: MockUser) {
  const w = load();
  if (w.seeded) return;
  for (const n of driveState(s).nodes) {
    if (n.type !== 'page') continue;
    const sample = SAMPLE[n.name];
    const p = pageOf(n.id);
    if (sample) Object.assign(p, sample);
    p.editedBy = n.updatedBy;
    p.editedAt = n.updatedAt;
    if (!p.versions.length) {
      p.versions.push({
        id: newId(),
        version: 1,
        label: null,
        createdBy: n.createdBy,
        createdAt: n.createdAt,
        markdown: p.markdown,
        restoredFrom: null,
      });
    }
  }
  w.seeded = true;
  void u;
  persist();
}

const ONBOARDING_BOARD: BoardTemplateContent = {
  columns: [
    { name: 'Yapılacak', wipLimit: null, isDone: false },
    { name: 'Bu hafta', wipLimit: null, isDone: false },
    { name: 'Tamamlandı', wipLimit: null, isDone: true },
  ],
  labels: [{ id: 'l1', name: 'Hesaplar', color: 's1' }],
  fields: { points: false, priority: false },
  cards: [
    { column: 0, title: "Hesabını aç ve 2FA'yı kur", labels: ['l1'], description: '' },
    { column: 0, title: 'Ekip sohbetine katıl, kendini tanıt', labels: [], description: '' },
  ],
};

/** A board and a space built-in of the gallery (the server has the full set). */
const MOCK_BUILTINS: MockTemplate[] = [
  {
    id: 'builtin:board:onboarding',
    kind: 'board',
    scope: 'org',
    spaceId: null,
    ownerUserId: null,
    name: 'Oryantasyon görevleri',
    description: 'Yeni gelenin ilk haftası, hazır kartlarla',
    category: 'team',
    content: ONBOARDING_BOARD,
    createdBy: '',
  },
  {
    id: 'builtin:space:onboarding',
    kind: 'space',
    scope: 'org',
    spaceId: null,
    ownerUserId: null,
    name: 'Oryantasyon',
    description: 'Hoş geldin sayfası, araçlar ve görev panosu',
    category: 'team',
    content: {
      pages: [
        {
          key: 'welcome',
          parent: null,
          name: 'Hoş geldin',
          icon: '👋',
          markdown: 'Ekibe hoş geldin.',
        },
        { key: 'tools', parent: 'welcome', name: 'Araçlar ve erişimler', icon: null, markdown: '' },
      ],
      boards: [{ name: 'Oryantasyon görevleri', board: ONBOARDING_BOARD }],
    },
    createdBy: '',
  },
];

function galleryItem(t: MockTemplate, scope: Template['scope'], canDelete: boolean): Template {
  const summary: Template['summary'] = {};
  let preview: string;
  if (t.kind === 'page') {
    const c = t.content as PageTemplateContent;
    preview = c.markdown.slice(0, 600);
    summary.blocks = mockMarkdownToDoc(c.markdown).content.length;
  } else if (t.kind === 'board') {
    const c = t.content as BoardTemplateContent;
    summary.columns = c.columns.map((x) => x.name);
    summary.cards = c.cards.length;
    preview = summary.columns.join(' · ');
  } else {
    const c = t.content as SpaceTemplateContent;
    summary.pages = c.pages.map((x) => x.name);
    summary.boards = c.boards.map((x) => x.name);
    preview = [...summary.pages, ...summary.boards].join(' · ');
  }
  return {
    id: t.id,
    kind: t.kind,
    scope,
    spaceId: t.spaceId,
    name: t.name,
    description: t.description,
    category: t.category,
    preview,
    summary,
    createdBy: null,
    canDelete,
  };
}

function toTreeItem(s: MockState, u: MockUser, n: MockNode, ids: Set<string>): PageTreeItem {
  const d = driveState(s);
  const drive = nodeForUser(s, n.id, u.id)!;
  let parent = n.parentId;
  while (parent && !ids.has(parent)) {
    parent = d.nodes.find((x) => x.id === parent)?.parentId ?? null;
  }
  return {
    id: n.id,
    parentId: parent,
    name: n.name,
    icon: pageOf(n.id).icon,
    position: pageOf(n.id).position ?? n.createdAt,
    hasChildren: d.nodes.some((x) => x.parentId === n.id && x.type === 'page' && !x.deletedAt),
    myRole: drive.myRole,
    favorite: drive.favorite,
    updatedAt: n.updatedAt,
  };
}

function toPage(s: MockState, u: MockUser, id: string): Page {
  const { node, drive } = nodeOf(s, u, id);
  const p = pageOf(id);
  const d = driveState(s);
  const path: { id: string; name: string }[] = [];
  let cur = node.parentId;
  while (cur) {
    const parent = d.nodes.find((x) => x.id === cur);
    if (!parent) break;
    path.unshift({ id: parent.id, name: parent.name });
    cur = parent.parentId;
  }
  const space = s.spaces.find((x) => x.id === node.spaceId)!;
  const w = words(p.markdown);
  const editor = s.users.find((x) => x.id === p.editedBy);
  return {
    id,
    spaceId: node.spaceId,
    parentId: node.parentId,
    name: node.name,
    icon: p.icon,
    cover: p.cover,
    fullWidth: p.fullWidth,
    smallText: p.smallText,
    locked: p.locked,
    empty: !p.markdown.trim(),
    myRole: drive.myRole,
    canEdit: canDo(s, u, drive.myRole, 'space.edit_content') && !p.locked,
    canComment: canDo(s, u, drive.myRole, 'space.comment'),
    favorite: drive.favorite,
    following: (p.followers ?? []).includes(u.id),
    followingDescendants: (p.subFollowers ?? []).includes(u.id),
    shared: drive.shared,
    wordCount: w,
    readingMinutes: w ? Math.max(1, Math.round(w / 200)) : 0,
    openCommentCount: p.comments.filter((c) => !c.rootId && !c.resolvedAt).length,
    editedAt: p.editedAt,
    editedBy: editor ? summary(editor) : drive.updatedBy,
    lastSource: 'web',
    createdBy: drive.createdBy,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    deletedAt: node.deletedAt,
    path,
    space: { id: space.id, name: space.name, slug: space.slug, color: space.color },
  };
}

function toVersions(s: MockState, p: MockPage): PageVersion[] {
  const newest = Math.max(0, ...p.versions.map((v) => v.version));
  return [...p.versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => {
      const by = s.users.find((x) => x.id === v.createdBy);
      return {
        id: v.id,
        version: v.version,
        label: v.label,
        source: 'web',
        createdBy: by ? summary(by) : null,
        editors: by ? [summary(by)] : [],
        restoredFrom: v.restoredFrom,
        current: v.version === newest,
        createdAt: v.createdAt,
      };
    });
}

function addVersion(p: MockPage, userId: string, extra: Partial<MockVersion> = {}) {
  const v: MockVersion = {
    id: newId(),
    version: Math.max(0, ...p.versions.map((x) => x.version)) + 1,
    label: null,
    createdBy: userId,
    createdAt: now(),
    markdown: p.markdown,
    restoredFrom: null,
    ...extra,
  };
  p.versions.push(v);
  return v;
}

function toThreads(s: MockState, nodeId: string): CommentThread[] {
  const p = pageOf(nodeId);
  const who = (id: string | null) => {
    const x = s.users.find((y) => y.id === id);
    return x ? summary(x) : null;
  };
  return p.comments
    .filter((c) => !c.rootId)
    .map((root) => {
      const all = [root, ...p.comments.filter((c) => c.rootId === root.id)];
      return {
        id: root.id,
        nodeId,
        anchorStart: root.anchorStart,
        anchorEnd: root.anchorEnd,
        quote: root.quote,
        resolvedAt: root.resolvedAt,
        resolvedBy: who(root.resolvedBy),
        comments: all.map((c) => ({
          id: c.id,
          author: who(c.authorId),
          body: c.body,
          mentions: c.mentions,
          createdAt: c.createdAt,
          editedAt: c.editedAt,
        })),
        createdAt: root.createdAt,
        updatedAt: all.at(-1)!.createdAt,
      };
    });
}

function createNode(
  s: MockState,
  u: MockUser,
  spaceId: string,
  parentId: string | null,
  name: string,
): MockNode {
  const d = driveState(s);
  const role = s.spaceMembers.find((x) => x.spaceId === spaceId && x.userId === u.id)?.role ?? null;
  if (!canDo(s, u, role, 'space.edit_content')) {
    throw new MockApiError(role ? 'forbidden' : 'not_found');
  }
  let final = name;
  for (
    let i = 2;
    d.nodes.some(
      (n) => n.spaceId === spaceId && n.parentId === parentId && n.name === final && !n.deletedAt,
    );
    i++
  ) {
    final = `${name} (${i})`;
  }
  const node: MockNode = {
    id: newId(),
    spaceId,
    parentId,
    type: 'page',
    name: final,
    createdBy: u.id,
    updatedBy: u.id,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    deletedBy: null,
    trashedWith: null,
  };
  d.nodes.push(node);
  return node;
}

const withoutMarkdown = (t: PageTemplate & { markdown: string }): PageTemplate => ({
  id: t.id,
  scope: t.scope,
  spaceId: t.spaceId,
  name: t.name,
  description: t.description,
  category: t.category,
  blockCount: t.blockCount,
  preview: t.preview,
  createdBy: t.createdBy,
});

const BUILTIN: (PageTemplate & { markdown: string })[] = [
  {
    id: 'builtin:meeting',
    scope: 'builtin',
    spaceId: null,
    name: 'Toplantı notu',
    description: 'Gündem, kararlar, aksiyonlar',
    category: 'team',
    blockCount: 5,
    preview: '## Gündem\n\n## Kararlar\n\n## Aksiyonlar',
    createdBy: null,
    markdown: '## Gündem\n\n- \n\n## Kararlar\n\n## Aksiyonlar\n\n- [ ] ',
  },
  {
    id: 'builtin:rfc',
    scope: 'builtin',
    spaceId: null,
    name: 'Teknik tasarım',
    description: 'Bağlam, öneri, alternatifler, riskler',
    category: 'engineering',
    blockCount: 4,
    preview: '## Bağlam\n\n## Öneri',
    createdBy: null,
    markdown: '## Bağlam\n\n## Öneri\n\n## Alternatifler\n\n## Riskler',
  },
];

export const wikiResolvers = {
  listPageTree: ({ s, params }) => {
    const u = requireUser(s);
    ensureSeed(s, u);
    const d = driveState(s);
    const role =
      s.spaceMembers.find((x) => x.spaceId === params.spaceId && x.userId === u.id)?.role ?? null;
    if (!role) throw new MockApiError('not_found');
    const nodes = d.nodes.filter(
      (n) =>
        n.spaceId === params.spaceId &&
        n.type === 'page' &&
        !n.deletedAt &&
        nodeForUser(s, n.id, u.id),
    );
    const ids = new Set(nodes.map((n) => n.id));
    return {
      items: nodes.map((n) => toTreeItem(s, u, n, ids)),
      canCreate: canDo(s, u, role, 'space.edit_content'),
    };
  },
  createPage: ({ s, params, body }) => {
    const u = requireUser(s);
    const node = createNode(s, u, params.spaceId!, body.parentId, body.name);
    const p = pageOf(node.id);
    const tpl = body.templateId
      ? [...BUILTIN, ...load().templates].find((x) => x.id === body.templateId)
      : undefined;
    Object.assign(p, {
      markdown: tpl?.markdown ?? body.markdown ?? '',
      icon: body.icon ?? null,
      editedBy: u.id,
    });
    addVersion(p, u.id);
    persist();
    return toPage(s, u, node.id);
  },
  importPages: ({ s, params, body }) => {
    const u = requireUser(s);
    const pages: PageTreeItem[] = [];
    for (const f of body.files.filter((x) => /\.md$/i.test(x.path))) {
      const name = f.path.split('/').at(-1)!.replace(/\.md$/i, '');
      const node = createNode(s, u, params.spaceId!, body.parentId, name);
      Object.assign(pageOf(node.id), { markdown: f.content, editedBy: u.id });
      pages.push(toTreeItem(s, u, node, new Set()));
    }
    if (!pages.length) throw new MockApiError('import_invalid');
    persist();
    return { pages, warnings: [] };
  },
  getPage: ({ s, params }) => toPage(s, requireUser(s), params.nodeId!),
  updatePage: ({ s, params, body }) => {
    const u = requireUser(s);
    const { node, drive } = nodeOf(s, u, params.nodeId!);
    if (!canDo(s, u, drive.myRole, 'space.edit_content')) throw new MockApiError('forbidden');
    const p = pageOf(node.id);
    if (p.locked && body.locked !== false && Object.keys(body).some((k) => k !== 'locked')) {
      throw new MockApiError('page_locked');
    }
    if (body.name !== undefined) node.name = body.name;
    for (const k of ['icon', 'cover', 'fullWidth', 'smallText', 'locked'] as const) {
      if (body[k] !== undefined) (p as unknown as Record<string, unknown>)[k] = body[k];
    }
    node.updatedAt = now();
    persist();
    return toPage(s, u, node.id);
  },
  listTemplates: ({ s, query }) => {
    const u = requireUser(s);
    const w = load();
    const isAdmin = ['admin', 'owner'].includes(actorOf(s, u).orgRole);
    const saved = (w.gallery ?? []).filter(
      (x) =>
        x.scope === 'org' ||
        (x.scope === 'personal' && x.ownerUserId === u.id) ||
        (x.scope === 'space' &&
          s.spaceMembers.some((m) => m.spaceId === x.spaceId && m.userId === u.id)),
    );
    const items = [
      ...[...BUILTIN, ...w.templates].map((t) =>
        galleryItem(
          {
            id: t.id,
            kind: 'page',
            scope: t.scope === 'builtin' ? 'org' : t.scope,
            spaceId: t.spaceId,
            ownerUserId: null,
            name: t.name,
            description: t.description,
            category: t.category,
            content: { markdown: t.markdown, icon: null },
            createdBy: '',
          },
          t.scope === 'builtin' ? 'builtin' : t.scope,
          false,
        ),
      ),
      ...MOCK_BUILTINS.map((t) => galleryItem(t, 'builtin', false)),
      ...saved.map((t) =>
        galleryItem(t, t.scope, t.scope === 'org' ? isAdmin : t.ownerUserId === u.id || isAdmin),
      ),
    ].filter((x) => !query.kind || x.kind === query.kind);
    return { items, canCreateOrg: isAdmin };
  },
  createTemplate: ({ s, body }) => {
    const u = requireUser(s);
    const isAdmin = ['admin', 'owner'].includes(actorOf(s, u).orgRole);
    if (body.scope === 'org' && !isAdmin) throw new MockApiError('forbidden');
    let content: MockTemplate['content'];
    let spaceId: string | null = body.spaceId ?? null;
    if (body.kind === 'page') {
      const { node } = nodeOf(s, u, body.nodeId!);
      content = { markdown: pageOf(node.id).markdown, icon: pageOf(node.id).icon };
      spaceId = node.spaceId;
    } else if (body.kind === 'board') {
      content = mockBoardContent(s, body.nodeId!);
      spaceId = driveState(s).nodes.find((n) => n.id === body.nodeId)?.spaceId ?? null;
    } else {
      const pages = driveState(s).nodes.filter(
        (n) => n.spaceId === body.spaceId && n.type === 'page' && !n.deletedAt,
      );
      const ids = new Set(pages.map((n) => n.id));
      content = {
        pages: pages.slice(0, 50).map((n) => ({
          key: n.id,
          parent: n.parentId && ids.has(n.parentId) ? n.parentId : null,
          name: n.name,
          icon: pageOf(n.id).icon,
          markdown: pageOf(n.id).markdown,
        })),
        boards: [],
      };
    }
    const t: MockTemplate = {
      id: newId(),
      kind: body.kind,
      scope: body.scope,
      spaceId: body.scope === 'space' ? spaceId : null,
      ownerUserId: body.scope === 'personal' ? u.id : null,
      name: body.name,
      description: body.description ?? '',
      category: body.category ?? 'team',
      content,
      createdBy: u.id,
    };
    const w = load();
    w.gallery = [...(w.gallery ?? []), t];
    persist();
    return galleryItem(t, t.scope, true);
  },
  deleteTemplate: ({ s, params }) => {
    requireUser(s);
    const w = load();
    w.gallery = (w.gallery ?? []).filter((x) => x.id !== params.templateRef);
    persist();
    return {};
  },
  applyTemplate: ({ s, params, body }) => {
    const u = requireUser(s);
    const ref = decodeURIComponent(params.templateRef ?? '');
    const w = load();
    const builtinPage = BUILTIN.find((x) => x.id === ref);
    const t: MockTemplate | undefined = builtinPage
      ? {
          id: ref,
          kind: 'page',
          scope: 'org',
          spaceId: null,
          ownerUserId: null,
          name: builtinPage.name,
          description: '',
          category: builtinPage.category,
          content: { markdown: builtinPage.markdown, icon: null },
          createdBy: '',
        }
      : (MOCK_BUILTINS.find((x) => x.id === ref) ?? (w.gallery ?? []).find((x) => x.id === ref));
    if (!t) throw new MockApiError('not_found');
    const made: { id: string; type: 'page' | 'board'; name: string }[] = [];
    const page = (parentId: string | null, name: string, c: PageTemplateContent) => {
      const node = createNode(s, u, body.spaceId, parentId, name);
      Object.assign(pageOf(node.id), { markdown: c.markdown, icon: c.icon, editedBy: u.id });
      return node;
    };
    if (t.kind === 'page') {
      const node = page(body.parentId ?? null, t.name, t.content as PageTemplateContent);
      made.push({ id: node.id, type: 'page', name: node.name });
    } else if (t.kind === 'board') {
      const b = mockBoardFromTemplate(
        s,
        u,
        body.spaceId,
        body.parentId ?? null,
        t.name,
        t.content as BoardTemplateContent,
      );
      made.push({ ...b, type: 'board' });
    } else {
      const c = t.content as SpaceTemplateContent;
      const ids = new Map<string, string>();
      for (const p of c.pages) {
        const node = page(p.parent ? (ids.get(p.parent) ?? null) : null, p.name, p);
        ids.set(p.key, node.id);
        if (!p.parent) made.push({ id: node.id, type: 'page', name: node.name });
      }
      for (const b of c.boards) {
        made.push({
          ...mockBoardFromTemplate(s, u, body.spaceId, null, b.name, b.board),
          type: 'board',
        });
      }
    }
    persist();
    return { nodes: made, skipped: [] };
  },
  getPublicPage: ({ s, params, query }) => {
    const { node } = mockPublicNode(s, params.token ?? '', query.grant, query.nodeId);
    if (node.type !== 'page') throw new MockApiError('bad_request');
    const p = pageOf(node.id);
    return {
      id: node.id,
      name: node.name,
      icon: p.icon,
      cover: p.cover?.startsWith('preset:') ? p.cover : null,
      fullWidth: p.fullWidth,
      smallText: p.smallText,
      doc: mockMarkdownToDoc(p.markdown),
      // The mock has no signed URLs for node: images.
      files: {},
      updatedAt: p.editedAt,
    };
  },
  createPageExport: ({ s, params, body }) => {
    const u = requireUser(s);
    const { node } = nodeOf(s, u, params.nodeId!);
    const ext = { md: '.md', html: '.html', docx: '.docx', pdf: '.pdf' }[body.format];
    const job = {
      id: newId(),
      nodeId: node.id,
      format: body.format,
      children: body.children ?? false,
      // The mock builds nothing: the export is ready at once (there is no file to download).
      status: 'ready' as const,
      fileName: body.children ? `${node.name}.zip` : `${node.name}${ext}`,
      sizeBytes: 0,
      pageCount: 1,
      skipped: [],
      error: null,
      createdAt: now(),
      finishedAt: now(),
      expiresAt: null,
    };
    mockExports.set(job.id, { ...job, userId: u.id });
    return job;
  },
  getPageExport: ({ s, params }) => {
    const u = requireUser(s);
    const job = mockExports.get(params.exportId!);
    if (!job || job.userId !== u.id) throw new MockApiError('not_found');
    const { userId: _owner, ...out } = job;
    void _owner;
    return out;
  },
  movePage: ({ s, params, body }) => {
    const u = requireUser(s);
    const { node, drive } = nodeOf(s, u, params.nodeId!);
    if (!canDo(s, u, drive.myRole, 'space.edit_content')) throw new MockApiError('forbidden');
    const d = driveState(s);
    const siblingId = body.afterId ?? body.beforeId ?? null;
    let parentId = body.parentId ?? null;
    if (siblingId) {
      const sibling = d.nodes.find((x) => x.id === siblingId && x.spaceId === node.spaceId);
      if (!sibling || sibling.id === node.id) throw new MockApiError('invalid_target');
      parentId = sibling.parentId;
    }
    for (let cur = parentId; cur; cur = d.nodes.find((x) => x.id === cur)?.parentId ?? null) {
      if (cur === node.id) throw new MockApiError('invalid_target');
    }
    const pos = (n: MockNode) => pageOf(n.id).position ?? n.createdAt;
    // The tree orders pages under their nearest page ancestor (folders are skipped), so the
    // new order is written for those siblings, as the tree shows them.
    const pageAbove = (id: string | null): string | null => {
      let cur = id;
      while (cur) {
        const n = d.nodes.find((x) => x.id === cur);
        if (!n || n.type === 'page') return cur;
        cur = n.parentId;
      }
      return null;
    };
    const treeParent = pageAbove(parentId);
    const siblings = d.nodes
      .filter(
        (x) =>
          x.spaceId === node.spaceId &&
          x.type === 'page' &&
          !x.deletedAt &&
          x.id !== node.id &&
          pageAbove(x.parentId) === treeParent,
      )
      .sort((a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0));
    const at = siblingId ? siblings.findIndex((x) => x.id === siblingId) : siblings.length;
    siblings.splice(body.afterId ? at + 1 : at, 0, node);
    siblings.forEach((x, i) => (pageOf(x.id).position = `0${String(i).padStart(4, '0')}`));
    node.parentId = parentId;
    node.updatedAt = now();
    persist();
    return toPage(s, u, node.id);
  },
  duplicatePage: ({ s, params, body }) => {
    const u = requireUser(s);
    const { node } = nodeOf(s, u, params.nodeId!);
    const copy = createNode(s, u, node.spaceId, node.parentId, body.name);
    Object.assign(pageOf(copy.id), { ...pageOf(node.id), versions: [], comments: [] });
    persist();
    return toPage(s, u, copy.id);
  },
  getPageContent: ({ s, params, query }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const p = pageOf(params.nodeId!);
    return {
      markdown: p.markdown,
      ...(query.format === 'json' ? { doc: mockMarkdownToDoc(p.markdown) } : {}),
      updatedAt: p.editedAt,
    };
  },
  setPageFollow: ({ s, params, body }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const p = pageOf(params.nodeId!);
    const others = (p.followers ?? []).filter((id) => id !== u.id);
    p.followers = body.following ? [...others, u.id] : others;
    const sub = (p.subFollowers ?? []).filter((id) => id !== u.id);
    const keep = (p.subFollowers ?? []).includes(u.id);
    p.subFollowers = body.following && (body.descendants ?? keep) ? [...sub, u.id] : sub;
    return {};
  },
  setPageTask: ({ s, params, body }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const p = pageOf(params.nodeId!);
    let at = 0;
    let found = false;
    p.markdown = p.markdown
      .split('\n')
      .map((line) => {
        const task = /^(\s*- \[)( |x)(\]\s*)(.*)$/.exec(line);
        if (!task) return line;
        const here = at++;
        if (here !== body.index || task[4]!.trim() !== body.text.trim()) return line;
        found = true;
        return `${task[1]}${body.checked ? 'x' : ' '}${task[3]}${task[4]}`;
      })
      .join('\n');
    if (!found) throw new MockApiError('page_task_changed');
    persist();
    return {};
  },
  createCollabToken: ({ s, params }) => {
    const u = requireUser(s);
    const page = toPage(s, u, params.nodeId!);
    return {
      token: 'mock',
      url: '',
      documentName: `page:${page.id}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      readOnly: !page.canEdit,
    };
  },
  listPageVersions: ({ s, params }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    return { items: toVersions(s, pageOf(params.nodeId!)) };
  },
  savePageVersion: ({ s, params, body }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const v = addVersion(pageOf(params.nodeId!), u.id, { label: body.label ?? null });
    persist();
    return toVersions(s, pageOf(params.nodeId!)).find((x) => x.id === v.id)!;
  },
  getPageVersion: ({ s, params }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const p = pageOf(params.nodeId!);
    const v = p.versions.find((x) => x.id === params.versionId);
    if (!v) throw new MockApiError('not_found');
    const prev = [...p.versions]
      .filter((x) => x.version < v.version)
      .sort((a, b) => b.version - a.version)[0];
    return {
      ...toVersions(s, p).find((x) => x.id === v.id)!,
      markdown: v.markdown,
      doc: mockMarkdownToDoc(v.markdown),
      previous: prev
        ? {
            id: prev.id,
            version: prev.version,
            markdown: prev.markdown,
            doc: mockMarkdownToDoc(prev.markdown),
          }
        : null,
    };
  },
  updatePageVersion: ({ s, params, body }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const p = pageOf(params.nodeId!);
    const v = p.versions.find((x) => x.id === params.versionId);
    if (!v) throw new MockApiError('not_found');
    v.label = body.label;
    persist();
    return toVersions(s, p).find((x) => x.id === v.id)!;
  },
  restorePageVersion: ({ s, params }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const p = pageOf(params.nodeId!);
    const v = p.versions.find((x) => x.id === params.versionId);
    if (!v) throw new MockApiError('not_found');
    p.markdown = v.markdown;
    const created = addVersion(p, u.id, { restoredFrom: v.version });
    persist();
    return toVersions(s, p).find((x) => x.id === created.id)!;
  },
  listPageComments: ({ s, params, query }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const all = toThreads(s, params.nodeId!);
    return {
      items:
        query.status === 'all'
          ? all
          : all.filter((t) => (query.status === 'open') === !t.resolvedAt),
    };
  },
  createPageComment: ({ s, params, body }) => {
    const u = requireUser(s);
    const { drive } = nodeOf(s, u, params.nodeId!);
    if (!canDo(s, u, drive.myRole, 'space.comment')) throw new MockApiError('forbidden');
    const p = pageOf(params.nodeId!);
    const c: MockComment = {
      id: newId(),
      rootId: body.threadId ?? null,
      authorId: u.id,
      body: body.body,
      mentions: body.mentions,
      quote: body.quote ?? null,
      anchorStart: body.anchorStart ?? null,
      anchorEnd: body.anchorEnd ?? null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: now(),
      editedAt: null,
    };
    p.comments.push(c);
    persist();
    return toThreads(s, params.nodeId!).find((t) => t.id === (c.rootId ?? c.id))!;
  },
  updatePageComment: ({ s, params, body }) => {
    const u = requireUser(s);
    for (const [nodeId, p] of Object.entries(load().pages)) {
      const c = p.comments.find((x) => x.id === params.commentId);
      if (!c) continue;
      if (c.authorId !== u.id) throw new MockApiError('forbidden');
      Object.assign(c, { body: body.body, mentions: body.mentions, editedAt: now() });
      persist();
      return toThreads(s, nodeId).find((t) => t.id === (c.rootId ?? c.id))!;
    }
    throw new MockApiError('not_found');
  },
  deletePageComment: ({ s, params }) => {
    requireUser(s);
    for (const p of Object.values(load().pages)) {
      if (!p.comments.some((x) => x.id === params.commentId)) continue;
      p.comments = p.comments.filter(
        (x) => x.id !== params.commentId && x.rootId !== params.commentId,
      );
      persist();
      return {};
    }
    throw new MockApiError('not_found');
  },
  resolvePageThread: ({ s, params, body }) => {
    const u = requireUser(s);
    for (const [nodeId, p] of Object.entries(load().pages)) {
      const c = p.comments.find((x) => x.id === params.threadId && !x.rootId);
      if (!c) continue;
      Object.assign(
        c,
        body.resolved
          ? { resolvedAt: now(), resolvedBy: u.id }
          : { resolvedAt: null, resolvedBy: null },
      );
      persist();
      return toThreads(s, nodeId).find((t) => t.id === c.id)!;
    }
    throw new MockApiError('not_found');
  },
  listPageBacklinks: ({ s, params }) => {
    const u = requireUser(s);
    nodeOf(s, u, params.nodeId!);
    const d = driveState(s);
    const items = Object.entries(load().pages)
      .filter(([id, p]) => id !== params.nodeId && p.markdown.includes(params.nodeId!))
      .map(([id]) => d.nodes.find((n) => n.id === id))
      .filter((n): n is MockNode => Boolean(n && !n.deletedAt && nodeForUser(s, n.id, u.id)))
      .map((n) => ({
        node: { id: n.id, name: n.name, type: n.type, icon: pageOf(n.id).icon, spaceId: n.spaceId },
        kinds: ['link' as const],
        updatedAt: n.updatedAt,
      }));
    return { items };
  },
  exportPage: ({ s, params }) => {
    const page = toPage(s, requireUser(s), params.nodeId!);
    return {
      files: [
        { path: `${page.name}.md`, markdown: `# ${page.name}\n\n${pageOf(page.id).markdown}\n` },
      ],
    };
  },
  searchPages: ({ s, query }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const q = query.q.toLocaleLowerCase('tr');
    const hits = d.nodes
      .filter(
        (n) =>
          n.type === 'page' &&
          !n.deletedAt &&
          (!query.spaceId || n.spaceId === query.spaceId) &&
          nodeForUser(s, n.id, u.id),
      )
      .flatMap((n) => {
        const p = pageOf(n.id);
        const body = p.markdown.toLocaleLowerCase('tr');
        const at = body.indexOf(q);
        const inTitle = n.name.toLocaleLowerCase('tr').includes(q);
        if (at < 0 && !inTitle) return [];
        const space = s.spaces.find((x) => x.id === n.spaceId)!;
        const snippet =
          at < 0
            ? ''
            : `${p.markdown.slice(Math.max(0, at - 40), at)}${SNIPPET_MARK_START}${p.markdown.slice(at, at + q.length)}${SNIPPET_MARK_END}${p.markdown.slice(at + q.length, at + q.length + 80)}`;
        return [
          {
            node: { id: n.id, name: n.name, icon: p.icon },
            space: { id: space.id, name: space.name, slug: space.slug, color: space.color },
            path: '',
            matchedIn: inTitle && at < 0 ? ('title' as const) : ('body' as const),
            snippet,
            author: null,
            updatedAt: n.updatedAt,
            updatedBy: null,
          },
        ];
      });
    return paginate(hits, query.cursor, query.limit);
  },
  listPageTemplates: ({ s }) => {
    requireUser(s);
    return { items: [...BUILTIN, ...load().templates].map((x) => withoutMarkdown(x)) };
  },
  createPageTemplate: ({ s, body }) => {
    const u = requireUser(s);
    const { node } = nodeOf(s, u, body.nodeId);
    const t = {
      id: newId(),
      scope: body.scope,
      spaceId: body.scope === 'space' ? node.spaceId : null,
      name: body.name,
      description: body.description,
      category: body.category,
      blockCount: mockMarkdownToDoc(pageOf(node.id).markdown).content.length,
      preview: pageOf(node.id).markdown.slice(0, 600),
      createdBy: summary(u),
      markdown: pageOf(node.id).markdown,
    };
    load().templates.push(t);
    persist();
    const out = withoutMarkdown(t);
    return out;
  },
  deletePageTemplate: ({ s, params }) => {
    requireUser(s);
    const w = load();
    w.templates = w.templates.filter((x) => x.id !== params.templateId);
    persist();
    return {};
  },
} satisfies Partial<Resolvers<EndpointName>>;
