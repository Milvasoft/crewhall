import {
  can,
  CardConfig,
  type Card,
  type Link,
  type LinkInput,
  type LinkStatus,
  type Surface,
  type SurfaceSummary,
} from '@crewhall/shared';
import { actorOf, MockApiError, myRole, orgCtx, requireUser, type Resolvers } from './core';
import { db, newId } from './db';
import { childrenForUser, driveState, nodeForUser } from './drive';
import {
  seedQuick,
  type MockCard,
  type MockLink,
  type MockSurface,
  type QuickState,
} from './quickSeed';
import { type MockState, type MockUser } from './seed';

/**
 * Quick access part of the contract mock (design 02): surfaces, cards on the 12-column grid,
 * org-wide links with a simulated health checker.
 */

const now = () => new Date().toISOString();
const GRID_COLS = 12;

export function quickState(s: MockState = db()): QuickState {
  s.quick ??= seedQuick();
  return s.quick;
}

// ---- surfaces ----

/** Benim exists for everyone; shared spaces get theirs on first listing. */
function ensureSurfaces(s: MockState, u: MockUser): MockSurface[] {
  const q = quickState(s);
  const mine = (ownerType: 'user' | 'space', ownerId: string) => {
    let sf = q.surfaces.find((x) => x.ownerType === ownerType && x.ownerId === ownerId);
    if (!sf) {
      sf = { id: newId(), ownerType, ownerId, layoutRev: 0, updatedAt: now(), updatedBy: null };
      q.surfaces.push(sf);
    }
    return sf;
  };
  const out = [mine('user', u.id)];
  for (const sm of s.spaceMembers.filter((x) => x.userId === u.id)) {
    const sp = s.spaces.find((x) => x.id === sm.spaceId);
    if (sp && sp.kind === 'shared' && !sp.archivedAt) out.push(mine('space', sp.id));
  }
  return out;
}

function canEdit(s: MockState, u: MockUser, sf: MockSurface): boolean {
  if (sf.ownerType === 'user') return sf.ownerId === u.id;
  return can(actorOf(s, u), 'space.edit_surface', {
    type: 'space',
    org: orgCtx(s),
    myRole: myRole(s, sf.ownerId, u.id),
  });
}

function surfaceFor(s: MockState, u: MockUser, id: string, edit = false): MockSurface {
  const sf = quickState(s).surfaces.find((x) => x.id === id);
  const visible =
    sf && (sf.ownerType === 'user' ? sf.ownerId === u.id : myRole(s, sf.ownerId, u.id) !== null);
  if (!sf || !visible) throw new MockApiError('not_found');
  if (edit && !canEdit(s, u, sf)) throw new MockApiError('forbidden');
  return sf;
}

function owner(s: MockState, sf: MockSurface): SurfaceSummary['owner'] {
  if (sf.ownerType === 'user') return { type: 'user' };
  const sp = s.spaces.find((x) => x.id === sf.ownerId)!;
  return { type: 'space', spaceId: sp.id, spaceName: sp.name, spaceColor: sp.color };
}

function liveCards(q: QuickState, surfaceId: string): MockCard[] {
  return q.cards.filter((c) => c.surfaceId === surfaceId && !c.deletedAt);
}

function toSummary(s: MockState, u: MockUser, sf: MockSurface): SurfaceSummary {
  return {
    id: sf.id,
    owner: owner(s, sf),
    canEdit: canEdit(s, u, sf),
    cardCount: liveCards(quickState(s), sf.id).length,
  };
}

function toSurface(s: MockState, u: MockUser, sf: MockSurface): Surface {
  const q = quickState(s);
  const by = sf.updatedBy ? s.users.find((x) => x.id === sf.updatedBy) : undefined;
  return {
    ...toSummary(s, u, sf),
    layoutRev: sf.layoutRev,
    cards: liveCards(q, sf.id).map((c) => toCard(s, u, c)),
    updatedAt: sf.updatedAt,
    updatedBy: by ? { id: by.id, name: by.name } : null,
  };
}

function bump(sf: MockSurface, u: MockUser) {
  sf.updatedAt = now();
  sf.updatedBy = u.id;
}

// ---- cards ----

function linkIdsOf(c: Pick<MockCard, 'type' | 'config'>): string[] {
  if (c.type === 'link') {
    const item = (c.config as { item?: { linkId: string } }).item;
    return item ? [item.linkId] : [];
  }
  if (c.type === 'link_group') {
    const sections = (c.config as { sections?: { items: { linkId: string }[] }[] }).sections ?? [];
    return sections.flatMap((x) => x.items.map((i) => i.linkId));
  }
  return [];
}

function toCard(s: MockState, u: MockUser, c: MockCard): Card {
  const q = quickState(s);
  const source = c.pinnedFrom ? q.cards.find((x) => x.id === c.pinnedFrom!.cardId) : undefined;
  const sourceMissing = Boolean(c.pinnedFrom && (!source || source.deletedAt));
  // A pinned card shows the source's content; the stored copy is the fallback.
  const shown = source && !sourceMissing ? source : c;
  const links: Record<string, Link> = {};
  for (const id of linkIdsOf(shown)) {
    const l = q.links.find((x) => x.id === id);
    if (l) links[id] = toLink(l);
  }
  const nodeId =
    shown.type === 'node' || shown.type === 'page'
      ? (shown.config as { nodeId: string }).nodeId
      : null;
  const node = nodeId ? nodeForUser(s, nodeId, u.id) : null;
  const maxItems = (shown.config as { maxItems?: number }).maxItems ?? 3;
  return {
    type: shown.type,
    config: shown.config,
    id: c.id,
    surfaceId: c.surfaceId,
    layout: c.layout,
    mobileOrder: c.mobileOrder,
    links,
    node,
    children: node && node.type === 'folder' ? childrenForUser(s, node.id, u.id, maxItems) : [],
    pinnedFrom: c.pinnedFrom,
    sourceMissing,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  } as Card;
}

function cardFor(s: MockState, u: MockUser, id: string, edit = true) {
  const c = quickState(s).cards.find((x) => x.id === id);
  if (!c) throw new MockApiError('not_found');
  const sf = surfaceFor(s, u, c.surfaceId, edit);
  return { c, sf };
}

const DEFAULT_SIZE: Record<MockCard['type'], [number, number]> = {
  link: [2, 1],
  link_group: [3, 4],
  note: [3, 2],
  todo: [3, 3],
  node: [3, 2],
  board_assigned: [4, 3],
  page: [3, 3],
  chat: [3, 3],
  meeting: [3, 2],
  vault_item: [3, 1],
};

/** First free spot, top to bottom, left to right (2.2: cards never overlap). */
function freeSpot(cards: MockCard[], w: number, h: number) {
  const hit = (x: number, y: number) =>
    cards.some(
      (c) =>
        x < c.layout.x + c.layout.w &&
        c.layout.x < x + w &&
        y < c.layout.y + c.layout.h &&
        c.layout.y < y + h,
    );
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= GRID_COLS; x++) if (!hit(x, y)) return { x, y, w, h };
  }
}

function checkConfig(type: MockCard['type'], config: unknown) {
  const parsed = CardConfig.safeParse({ type, config });
  if (!parsed.success) {
    throw new MockApiError(
      'validation_failed',
      'Config does not match the card type',
      parsed.error.issues,
    );
  }
  return parsed.data.config as Record<string, unknown>;
}

// ---- links ----

function toLink(l: MockLink): Link {
  return { ...l };
}

const KNOWN_TITLES: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'www.nuget.org': 'NuGet Gallery',
  'hub.docker.com': 'Docker Hub',
  'grafana.com': 'Grafana',
};

/** Simulated one-time fetch of the page (2.4): internal hosts do not answer. */
function fetchTitle(url: URL): string | null {
  if (/(^localhost$|\.local$|\.internal$|^10\.|^192\.168\.)/.test(url.hostname)) return null;
  const known = KNOWN_TITLES[url.host];
  if (known) return known;
  const first = url.hostname.replace(/^www\./, '').split('.')[0] ?? url.hostname;
  return first.charAt(0).toLocaleUpperCase('tr') + first.slice(1);
}

function upsertLink(
  q: QuickState,
  input: Pick<LinkInput, 'url' | 'checkEnabled' | 'intervalSeconds'>,
): MockLink {
  const existing = q.links.find((x) => x.url === input.url);
  if (existing) return existing;
  const url = new URL(input.url);
  const l: MockLink = {
    id: newId(),
    url: input.url,
    host: url.host,
    siteTitle: fetchTitle(url),
    faviconUrl: null,
    checkEnabled: input.checkEnabled,
    intervalSeconds: input.intervalSeconds,
    health: {
      status: input.checkEnabled ? 'up' : 'unknown',
      since: now(),
      checkedAt: input.checkEnabled ? now() : null,
      httpStatus: input.checkEnabled ? 200 : null,
      latencyMs: input.checkEnabled ? 140 : null,
      tlsExpiresAt: null,
      reason: null,
      lastUpAt: input.checkEnabled ? now() : null,
    },
    opens30d: 0,
  };
  q.links.push(l);
  return l;
}

function itemFor(l: MockLink, input: Pick<LinkInput, 'title' | 'description'>) {
  return {
    id: newId(),
    linkId: l.id,
    title: input.title ?? l.siteTitle ?? l.host,
    description: input.description ?? null,
  };
}

/** Deterministic 24 h of checks every 10 minutes ending with the current status (2.12). */
function history(l: MockLink, hours: number) {
  const step = 10 * 60_000;
  const count = Math.round((hours * 3_600_000) / step);
  const nowMs = Date.now();
  const since = l.health.since ? new Date(l.health.since).getTime() : 0;
  let seed = [...l.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed % 1000) / 1000;
  };
  const items = Array.from({ length: count }, (_, i) => {
    const t = nowMs - (count - 1 - i) * step;
    let status: LinkStatus = t >= since ? l.health.status : rnd() < 0.015 ? 'down' : 'up';
    if (!l.checkEnabled) status = 'unknown';
    const ok = status === 'up' || status === 'warn';
    return {
      at: new Date(t).toISOString(),
      status,
      httpStatus: ok ? 200 : status === 'down' ? (l.health.httpStatus ?? 502) : null,
      latencyMs: ok
        ? status === 'warn'
          ? 1500 + Math.round(rnd() * 500)
          : 80 + Math.round(rnd() * 120)
        : null,
      error: status === 'down' ? (l.health.reason ?? 'timeout') : null,
    };
  });
  const checked = items.filter((x) => x.status !== 'unknown');
  const okCount = checked.filter((x) => x.status === 'up' || x.status === 'warn').length;
  return { items, availability: checked.length ? okCount / checked.length : null };
}

/** A card's own link icon must be https (the server allows http only for its own origin). */
function checkIcons(config: unknown) {
  const c = config as {
    item?: { iconUrl?: string | null };
    sections?: { items: { iconUrl?: string | null }[] }[];
  };
  const items = [
    ...(c.item ? [{ path: ['config', 'item', 'iconUrl'], icon: c.item.iconUrl }] : []),
    ...(c.sections ?? []).flatMap((sec, i) =>
      sec.items.map((it, j) => ({
        path: ['config', 'sections', String(i), 'items', String(j), 'iconUrl'],
        icon: it.iconUrl,
      })),
    ),
  ];
  const bad = items.find((x) => x.icon && !x.icon.startsWith('https://'));
  if (bad) {
    throw new MockApiError('validation_failed', 'icon must be https', {
      in: 'body',
      issues: [{ path: bad.path, code: 'invalid', message: 'https only' }],
    });
  }
}

function linkFor(s: MockState, id: string): MockLink {
  const l = quickState(s).links.find((x) => x.id === id);
  if (!l) throw new MockApiError('not_found');
  return l;
}

// ---- resolvers ----

export const quickResolvers = {
  listSurfaces: ({ s }) => {
    const u = requireUser(s);
    return { items: ensureSurfaces(s, u).map((sf) => toSummary(s, u, sf)) };
  },

  getSurface: ({ s, params }) => {
    const u = requireUser(s);
    ensureSurfaces(s, u);
    return toSurface(s, u, surfaceFor(s, u, params.surfaceId ?? ''));
  },

  updateSurfaceLayout: ({ s, params, body }) => {
    const u = requireUser(s);
    const sf = surfaceFor(s, u, params.surfaceId ?? '', true);
    if (body.layoutRev !== sf.layoutRev) {
      throw new MockApiError('conflict', 'Layout changed elsewhere', { layoutRev: sf.layoutRev });
    }
    const q = quickState(s);
    for (const it of body.items ?? []) {
      const c = liveCards(q, sf.id).find((x) => x.id === it.cardId);
      if (c) c.layout = it.layout;
    }
    body.mobileOrder?.forEach((id, i) => {
      const c = liveCards(q, sf.id).find((x) => x.id === id);
      if (c) c.mobileOrder = i;
    });
    sf.layoutRev++;
    bump(sf, u);
    return { layoutRev: sf.layoutRev };
  },

  createCard: ({ s, params, body }) => {
    const u = requireUser(s);
    const sf = surfaceFor(s, u, params.surfaceId ?? '', true);
    const q = quickState(s);
    let config: Record<string, unknown>;
    if (body.type === 'link') {
      config = { item: itemFor(upsertLink(q, body.link), body.link) };
    } else if (body.type === 'link_group') {
      const c = body.config;
      config = {
        title: c.title,
        color: c.color ?? null,
        view: c.view ?? 'list',
        sort: c.sort ?? 'manual',
        sectionsAsTabs: c.sectionsAsTabs ?? false,
        showUrls: c.showUrls ?? true,
        showHealth: c.showHealth ?? true,
        sections: (c.sections?.length ? c.sections : [{ title: '' }]).map((x) => ({
          id: newId(),
          title: x.title,
          items: [],
        })),
      };
    } else if (body.type === 'note') {
      config = { text: '', color: 's6', fontSize: 'normal', ...body.config };
    } else if (body.type === 'todo') {
      config = { title: 'Yapılacaklar', items: [], ...body.config };
    } else if (body.type === 'board_assigned') {
      config = { scope: 'assigned', spaceId: null, limit: 6, ...body.config };
    } else if (body.type === 'page') {
      const page = nodeForUser(s, body.config.nodeId, u.id);
      if (!page || page.type !== 'page') throw new MockApiError('not_found');
      config = { nodeId: page.id };
    } else if (body.type === 'chat') {
      config = { limit: 5, ...body.config };
    } else if (body.type === 'meeting') {
      config = { spaceId: null, ...body.config };
    } else if (body.type === 'vault_item') {
      config = { ...body.config };
    } else {
      if (!nodeForUser(s, body.config.nodeId, u.id)) throw new MockApiError('not_found');
      config = { ...body.config };
    }
    const [w, h] = DEFAULT_SIZE[body.type];
    const c: MockCard = {
      id: newId(),
      surfaceId: sf.id,
      type: body.type,
      config: checkConfig(body.type, config),
      layout: body.layout ?? freeSpot(liveCards(q, sf.id), w, h),
      mobileOrder: null,
      pinnedFrom: null,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    };
    q.cards.push(c);
    bump(sf, u);
    return toCard(s, u, c);
  },

  updateCard: ({ s, params, body }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    const q = quickState(s);
    if (body.detach && c.pinnedFrom) {
      const src = q.cards.find((x) => x.id === c.pinnedFrom!.cardId);
      if (src && !src.deletedAt) {
        c.type = src.type;
        c.config = structuredClone(src.config);
      }
      c.pinnedFrom = null;
    }
    if (body.config) {
      // Editing a pinned card edits its source, when allowed there (2.8).
      const target = c.pinnedFrom ? q.cards.find((x) => x.id === c.pinnedFrom!.cardId) : c;
      if (!target || target.deletedAt) throw new MockApiError('not_found');
      if (target !== c) surfaceFor(s, u, target.surfaceId, true);
      target.config = checkConfig(target.type, body.config);
      checkIcons(target.config);
      target.updatedAt = now();
    }
    if (body.layout) c.layout = body.layout;
    c.updatedAt = now();
    bump(sf, u);
    return toCard(s, u, c);
  },

  deleteCard: ({ s, params }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    c.deletedAt = now();
    bump(sf, u);
    return {};
  },

  restoreCard: ({ s, params }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    const others = liveCards(quickState(s), sf.id);
    const free = freeSpot(others, c.layout.w, c.layout.h);
    const overlaps = others.some(
      (o) =>
        c.layout.x < o.layout.x + o.layout.w &&
        o.layout.x < c.layout.x + c.layout.w &&
        c.layout.y < o.layout.y + o.layout.h &&
        o.layout.y < c.layout.y + c.layout.h,
    );
    if (overlaps) c.layout = free;
    c.deletedAt = null;
    bump(sf, u);
    return toCard(s, u, c);
  },

  duplicateCard: ({ s, params }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    const q = quickState(s);
    const copy: MockCard = {
      ...structuredClone(c),
      id: newId(),
      layout: freeSpot(liveCards(q, sf.id), c.layout.w, c.layout.h),
      createdAt: now(),
      updatedAt: now(),
    };
    q.cards.push(copy);
    bump(sf, u);
    return toCard(s, u, copy);
  },

  listCardMoveTargets: ({ s, params }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    const nodeId = c.type === 'node' || c.type === 'page' ? (c.config as { nodeId: string }).nodeId : null;
    const nodeSpace = nodeId ? driveState(s).nodes.find((n) => n.id === nodeId)?.spaceId : undefined;
    const inSpace = (spaceId: string) => s.spaceMembers.filter((m) => m.spaceId === spaceId).map((m) => m.userId);
    return {
      items: ensureSurfaces(s, u)
        .filter((x) => x.id !== sf.id && canEdit(s, u, x) && (c.type !== 'vault_item' || x.ownerType === 'user'))
        .map((x) => ({
          surface: toSummary(s, u, x),
          // Space members of the node's space can open it; shares are not modelled here.
          cannotOpen: nodeSpace
            ? (x.ownerType === 'user' ? [u.id] : inSpace(x.ownerId)).filter((id) => !inSpace(nodeSpace).includes(id)).length
            : 0,
        })),
    };
  },

  moveCard: ({ s, params, body }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    const target = surfaceFor(s, u, body.surfaceId, true);
    if (target.id === sf.id) throw new MockApiError('invalid_target');
    if (c.type === 'vault_item' && target.ownerType !== 'user') {
      throw new MockApiError('quick_card_not_movable');
    }
    c.surfaceId = target.id;
    c.layout =
      body.layout ??
      freeSpot(
        liveCards(quickState(s), target.id).filter((x) => x !== c),
        c.layout.w,
        c.layout.h,
      );
    c.mobileOrder = null;
    bump(sf, u);
    bump(target, u);
    return toCard(s, u, c);
  },

  pinCard: ({ s, params, body }) => {
    const u = requireUser(s);
    // Viewers may pin from a surface they only see (2.8).
    const { c } = cardFor(s, u, params.cardId ?? '', false);
    const target = surfaceFor(s, u, body.surfaceId, true);
    if (c.type === 'vault_item' && target.ownerType !== 'user') {
      throw new MockApiError('quick_card_not_movable');
    }
    const q = quickState(s);
    const source = c.pinnedFrom ?? { cardId: c.id, surfaceId: c.surfaceId };
    const pin: MockCard = {
      id: newId(),
      surfaceId: target.id,
      type: c.type,
      config: structuredClone(c.config),
      layout: freeSpot(liveCards(q, target.id), c.layout.w, c.layout.h),
      mobileOrder: null,
      pinnedFrom: source,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
    };
    q.cards.push(pin);
    bump(target, u);
    return toCard(s, u, pin);
  },

  addGroupLink: ({ s, params, body }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    if (c.type !== 'link_group' || c.pinnedFrom) throw new MockApiError('invalid_target');
    const sections = (c.config as { sections: { id: string; items: unknown[] }[] }).sections;
    const section = body.sectionId ? sections.find((x) => x.id === body.sectionId) : sections[0];
    if (!section) throw new MockApiError('not_found');
    section.items.push(itemFor(upsertLink(quickState(s), body.link), body.link));
    c.updatedAt = now();
    bump(sf, u);
    return toCard(s, u, c);
  },

  removeGroupLink: ({ s, params }) => {
    const u = requireUser(s);
    const { c, sf } = cardFor(s, u, params.cardId ?? '');
    if (c.type !== 'link_group') throw new MockApiError('invalid_target');
    const sections = (c.config as { sections: { items: { id: string }[] }[] }).sections;
    for (const sec of sections) sec.items = sec.items.filter((x) => x.id !== params.itemId);
    c.updatedAt = now();
    bump(sf, u);
    return toCard(s, u, c);
  },

  previewLink: ({ s, body }) => {
    const u = requireUser(s);
    const q = quickState(s);
    const url = new URL(body.url);
    const visible = new Set(ensureSurfaces(s, u).map((x) => x.id));
    const known = q.links.find((x) => x.url === body.url);
    const existingCardIds = known
      ? q.cards
          .filter(
            (c) => !c.deletedAt && visible.has(c.surfaceId) && linkIdsOf(c).includes(known.id),
          )
          .map((c) => c.id)
      : [];
    return {
      url: body.url,
      host: url.host,
      title: known?.siteTitle ?? fetchTitle(url),
      faviconUrl: known?.faviconUrl ?? null,
      // What a page bookmark shows: a summary, and an image served by the app itself.
      description: `${url.host} sayfasının kısa özeti.`,
      imageUrl: typeof location === 'undefined' ? null : `${location.origin}/favicon.svg`,
      existingCardIds,
    };
  },

  resolveLink: ({ s, body }) => {
    const u = requireUser(s);
    // With a card: its editor asks, so the caller must be able to edit that card.
    if (body.cardId) cardFor(s, u, body.cardId);
    const l = upsertLink(quickState(s), {
      url: body.url,
      checkEnabled: body.checkEnabled ?? true,
      intervalSeconds: body.intervalSeconds ?? 60,
    });
    return toLink(l);
  },

  getLink: ({ s, params }) => {
    requireUser(s);
    return toLink(linkFor(s, params.linkId ?? ''));
  },

  updateLink: ({ s, params, body }) => {
    requireUser(s);
    const l = linkFor(s, params.linkId ?? '');
    if (body.checkEnabled !== undefined) {
      l.checkEnabled = body.checkEnabled;
      if (!body.checkEnabled) l.health = { ...l.health, status: 'unknown', since: now() };
    }
    if (body.intervalSeconds !== undefined) l.intervalSeconds = body.intervalSeconds;
    return toLink(l);
  },

  getLinkHistory: ({ s, params, query }) => {
    requireUser(s);
    return history(linkFor(s, params.linkId ?? ''), query.hours);
  },

  checkLinkNow: ({ s, params }) => {
    requireUser(s);
    const l = linkFor(s, params.linkId ?? '');
    // The mock site keeps its state: a down link stays down until someone fixes it.
    l.health = { ...l.health, checkedAt: now() };
    return toLink(l);
  },

  recordLinkOpen: ({ s, params }) => {
    requireUser(s);
    linkFor(s, params.linkId ?? '').opens30d++;
    return {};
  },
} satisfies Resolvers<
  | 'listSurfaces'
  | 'getSurface'
  | 'updateSurfaceLayout'
  | 'createCard'
  | 'updateCard'
  | 'deleteCard'
  | 'restoreCard'
  | 'duplicateCard'
  | 'listCardMoveTargets'
  | 'moveCard'
  | 'pinCard'
  | 'addGroupLink'
  | 'removeGroupLink'
  | 'previewLink'
  | 'resolveLink'
  | 'getLink'
  | 'updateLink'
  | 'getLinkHistory'
  | 'checkLinkNow'
  | 'recordLinkOpen'
>;
