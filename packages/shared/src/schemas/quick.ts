import { z } from 'zod';
import { Id, Timestamp } from './common';
import { DriveNode } from './drive';
import { SpaceColor } from './space';

/**
 * Quick access (design 02; doc 17 §4 surfaces · surface_cards · links · link_checks, §10).
 * "Benim" is the person's surface; every shared space has one too, edited by its
 * owners, admins and editors (space.edit_surface).
 */

/* ----------------------------------- links ----------------------------------- */

export const LinkStatus = z.enum(['up', 'warn', 'down', 'unknown']);
export type LinkStatus = z.infer<typeof LinkStatus>;

/** Seconds between checks: 1, 5 or 15 minutes (doc 17 §10). */
export const LinkCheckInterval = z.union([z.literal(60), z.literal(300), z.literal(900)]);

export const LinkHealth = z.object({
  status: LinkStatus,
  /** When the current status started (2.12: "7 dakikadır"). */
  since: Timestamp.nullable(),
  checkedAt: Timestamp.nullable(),
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  tlsExpiresAt: Timestamp.nullable(),
  /** Short reason for warn/down: "timeout", "dns", "tls", "slow", "cert_expiring", "http_502". */
  reason: z.string().nullable(),
  lastUpAt: Timestamp.nullable(),
});
export type LinkHealth = z.infer<typeof LinkHealth>;

/** A URL known to the org; checked once however many cards show it. */
export const Link = z.object({
  id: Id,
  url: z.url(),
  host: z.string(),
  /** Title and favicon fetched once from the site (2.4); cards keep their own display name. */
  siteTitle: z.string().nullable(),
  faviconUrl: z.url().nullable(),
  checkEnabled: z.boolean(),
  intervalSeconds: LinkCheckInterval,
  health: LinkHealth,
  /** Opens in the last 30 days, for the "most opened" sort (2.5). */
  opens30d: z.number().int(),
});
export type Link = z.infer<typeof Link>;

export const LinkPreviewRequest = z.object({ url: z.url().max(2048) });

/**
 * The org-wide Link for a URL (created, with its title and favicon, or the existing one), for a
 * card that changes its address: the card then points its item at it with updateCard, keeping
 * its id. With `cardId` the caller must be able to edit that card.
 */
export const ResolveLink = z.object({
  url: z.url().max(2048),
  checkEnabled: z.boolean().optional(),
  intervalSeconds: LinkCheckInterval.optional(),
  cardId: Id.optional(),
});
export type ResolveLink = z.infer<typeof ResolveLink>;

/** Server-side fetch of a pasted URL (2.4); nulls when the site does not answer. */
export const LinkPreview = z.object({
  url: z.url(),
  host: z.string(),
  title: z.string().nullable(),
  faviconUrl: z.url().nullable(),
  /** The same URL already sits in this group / surface (2.x: "uyarı çıkar"). */
  existingCardIds: z.array(Id),
});

/**
 * A card's own icon instead of the site's favicon: an https image, or a file of this server
 * (Drive) on its own origin. Absent or null: the favicon.
 */
const LinkIconUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .nullable()
  .optional();

export const LinkInput = z.object({
  url: z.url().max(2048),
  /** Display name on the card; defaults to the site title or host. */
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(200).optional(),
  checkEnabled: z.boolean().default(true),
  intervalSeconds: LinkCheckInterval.default(60),
  iconUrl: LinkIconUrl,
});
export type LinkInput = z.infer<typeof LinkInput>;

export const LinkCheck = z.object({
  at: Timestamp,
  status: LinkStatus,
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});

export const LinkHistoryQuery = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
});

export const LinkHistory = z.object({
  items: z.array(LinkCheck),
  /** Share of `up`/`warn` checks in the window, 0-1 (2.12: "%97,9 erişilebilir"). */
  availability: z.number().min(0).max(1).nullable(),
});

export const UpdateLink = z.object({
  checkEnabled: z.boolean().optional(),
  intervalSeconds: LinkCheckInterval.optional(),
});

/* ----------------------------------- cards ----------------------------------- */

export const CardType = z.enum([
  'link',
  'link_group',
  'note',
  'todo',
  'node',
  'board_assigned',
  'page',
  'chat',
  'meeting',
  'vault_item',
]);
export type CardType = z.infer<typeof CardType>;

/** A link as it appears on a card: the shared Link plus this card's display text. */
export const LinkItem = z.object({
  /** Stable id within the card, for reorder and removal. */
  id: Id,
  linkId: Id,
  title: z.string(),
  description: z.string().nullable(),
  iconUrl: LinkIconUrl,
});

export const LinkCardConfig = z.object({
  item: LinkItem,
});

export const LinkGroupConfig = z.object({
  title: z.string().trim().min(1).max(60),
  /** Category dot (2.5 "Nokta"). */
  color: SpaceColor.nullable(),
  view: z.enum(['list', 'grid']),
  sort: z.enum(['manual', 'name', 'popular']),
  sectionsAsTabs: z.boolean(),
  showUrls: z.boolean(),
  showHealth: z.boolean(),
  /** Size of the rows and their text; absent means 'normal'. */
  density: z.enum(['compact', 'normal', 'large']).optional(),
  sections: z
    .array(
      z.object({
        id: Id,
        /** Empty for a group without sub-sections. */
        title: z.string().max(40),
        items: z.array(LinkItem).max(100),
      }),
    )
    .min(1)
    .max(12),
});

export const NoteConfig = z.object({
  /** Markdown (2.6), up to 20 000 characters. */
  text: z.string().max(20_000),
  color: SpaceColor,
  fontSize: z.enum(['normal', 'large']),
});

export const TodoConfig = z.object({
  title: z.string().trim().min(1).max(60),
  items: z
    .array(
      z.object({
        id: Id,
        text: z.string().trim().min(1).max(300),
        done: z.boolean(),
        doneAt: Timestamp.nullable(),
      }),
    )
    .max(200),
});

/** File or folder from Drive (2.1 "Logo ve sunumlar"). */
export const NodeCardConfig = z.object({
  nodeId: Id,
  /** Folders: how many children to list. */
  maxItems: z.number().int().min(1).max(20).optional(),
});

/**
 * "Bana atananlar" (design 06 · 6.9, doc 17 §4 "pano kartları"): open board cards assigned
 * to the viewer, read from the boards module (`listMyBoardCards`); nothing is stored here.
 */
export const BoardAssignedConfig = z.object({
  /** assigned: every open card; due: due within 3 days or overdue. */
  scope: z.enum(['assigned', 'due']),
  /** Only one space's boards; null = every space the viewer can see. */
  spaceId: Id.nullable(),
  limit: z.number().int().min(3).max(20),
});

/** A wiki page with a preview of its body (2.2 "Sayfa · Önizlemeli"); read through the wiki. */
export const PageCardConfig = z.object({
  nodeId: Id,
});

/**
 * One conversation's latest messages with a quick reply (2.2 "Sohbet · Son mesajlar"); read
 * and sent through the chat module, so a viewer who is not a member sees the card locked.
 */
export const ChatCardConfig = z.object({
  conversationId: Id,
  limit: z.number().int().min(3).max(20),
});

/** The meeting that is live now, else the next planned one (2.2 "Toplantı · Sıradaki, katıl"). */
export const MeetingCardConfig = z.object({
  /** Only one space's meetings; null = every space the viewer can see. */
  spaceId: Id.nullable(),
});

/**
 * One vault item with one-click copy (2.2 "Kasa öğesi"). Only ids are stored: the name and the
 * secret stay encrypted, so the card shows them only while the viewer's vault is unlocked.
 */
export const VaultItemCardConfig = z.object({
  vaultId: Id,
  itemId: Id,
});

export const CardConfig = z.discriminatedUnion('type', [
  z.object({ type: z.literal('link'), config: LinkCardConfig }),
  z.object({ type: z.literal('link_group'), config: LinkGroupConfig }),
  z.object({ type: z.literal('note'), config: NoteConfig }),
  z.object({ type: z.literal('todo'), config: TodoConfig }),
  z.object({ type: z.literal('node'), config: NodeCardConfig }),
  z.object({ type: z.literal('board_assigned'), config: BoardAssignedConfig }),
  z.object({ type: z.literal('page'), config: PageCardConfig }),
  z.object({ type: z.literal('chat'), config: ChatCardConfig }),
  z.object({ type: z.literal('meeting'), config: MeetingCardConfig }),
  z.object({ type: z.literal('vault_item'), config: VaultItemCardConfig }),
]);

/** Position on the 12-column, 84 px-row grid (2.2). */
export const CardLayout = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
});

/** Card width on the mobile home: half (two per row) or the full width. */
export const MobileCardWidth = z.enum(['half', 'full']);
export type MobileCardWidth = z.infer<typeof MobileCardWidth>;

export const Card = z.intersection(
  CardConfig,
  z.object({
    id: Id,
    surfaceId: Id,
    layout: CardLayout,
    /** Mobile order (2.14); null until reordered on mobile, then derived from the web layout. */
    mobileOrder: z.number().int().nullable(),
    /** Hidden on the mobile home (still on the web), the same on every phone. */
    mobileHidden: z.boolean().optional(),
    /** Width on the mobile home; null derives it from the web width. */
    mobileWidth: MobileCardWidth.nullable().optional(),
    /** Links referenced by link / link_group cards, keyed by id. */
    links: z.record(z.string(), Link),
    /**
     * Node cards: the node, or null when it was deleted or the caller cannot see it
     * (the card is shown locked and leaks nothing, 2.x "Yetkisi olmayan düğüm").
     */
    node: DriveNode.nullable(),
    /** Folder node cards: first children. */
    children: z.array(DriveNode),
    /**
     * Pinned from another surface (2.8): this card shows the source's content.
     * `sourceMissing` once the source card is removed ("Kaynak kaldırıldı").
     */
    pinnedFrom: z.object({ cardId: Id, surfaceId: Id }).nullable(),
    sourceMissing: z.boolean(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  }),
);
export type Card = z.infer<typeof Card>;

export const SurfaceOwner = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user') }),
  z.object({
    type: z.literal('space'),
    spaceId: Id,
    spaceName: z.string(),
    spaceColor: SpaceColor,
  }),
]);

export const SurfaceSummary = z.object({
  id: Id,
  owner: SurfaceOwner,
  canEdit: z.boolean(),
  cardCount: z.number().int(),
});
export type SurfaceSummary = z.infer<typeof SurfaceSummary>;

export const Surface = SurfaceSummary.extend({
  /** Optimistic lock for layout writes. */
  layoutRev: z.number().int(),
  cards: z.array(Card),
  updatedAt: Timestamp,
  updatedBy: z.object({ id: Id, name: z.string() }).nullable(),
});
export type Surface = z.infer<typeof Surface>;

/** New card. Link cards take a URL; the server creates or reuses the org-wide Link. */
export const CreateCard = z.intersection(
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('link'), link: LinkInput }),
    z.object({
      type: z.literal('link_group'),
      config: LinkGroupConfig.omit({ sections: true })
        .partial()
        .extend({
          title: z.string().trim().min(1).max(60),
          sections: z
            .array(z.object({ title: z.string().max(40) }))
            .max(12)
            .optional(),
        }),
    }),
    z.object({ type: z.literal('note'), config: NoteConfig.partial().optional() }),
    z.object({ type: z.literal('todo'), config: TodoConfig.partial().optional() }),
    z.object({ type: z.literal('node'), config: NodeCardConfig }),
    z.object({
      type: z.literal('board_assigned'),
      config: BoardAssignedConfig.partial().optional(),
    }),
    z.object({ type: z.literal('page'), config: PageCardConfig }),
    z.object({
      type: z.literal('chat'),
      config: ChatCardConfig.partial({ limit: true }),
    }),
    z.object({ type: z.literal('meeting'), config: MeetingCardConfig.partial().optional() }),
    z.object({ type: z.literal('vault_item'), config: VaultItemCardConfig }),
  ]),
  /** Omit to place the card in the first free spot. */
  z.object({ layout: CardLayout.optional() }),
);
export type CreateCard = z.infer<typeof CreateCard>;

/** Replace the config (same type) and/or move the card. */
export const UpdateCard = z.object({
  /** Must be the config of the card's own type; the server checks it against the type. */
  config: z
    .union([
      LinkCardConfig,
      LinkGroupConfig,
      NoteConfig,
      TodoConfig,
      NodeCardConfig,
      BoardAssignedConfig,
      ChatCardConfig,
      MeetingCardConfig,
      VaultItemCardConfig,
    ])
    .optional(),
  layout: CardLayout.optional(),
  /** Pinned cards: turn into an independent copy of the source (2.x). */
  detach: z.boolean().optional(),
});

export const UpdateLayout = z.object({
  /** Must match the surface's layoutRev, else 409 conflict. */
  layoutRev: z.number().int(),
  items: z
    .array(z.object({ cardId: Id, layout: CardLayout }))
    .max(200)
    .optional(),
  /** Full mobile order, card ids top to bottom. */
  mobileOrder: z.array(Id).max(200).optional(),
  /** Mobile home per card: hide it, or set its width (null: from the web width again). */
  mobile: z
    .array(
      z.object({
        cardId: Id,
        hidden: z.boolean().optional(),
        width: MobileCardWidth.nullable().optional(),
      }),
    )
    .max(200)
    .optional(),
});

export const LayoutResult = z.object({ layoutRev: z.number().int() });

export const TargetSurface = z.object({ surfaceId: Id });

/** "Başka space'e taşı": `layout` puts the card back where it was (undo); else at the bottom. */
export const MoveCard = TargetSurface.extend({ layout: CardLayout.optional() });

/**
 * A surface a card may move to. The content a card points to (page, board, file, conversation)
 * does not move and keeps its permissions, so the picker warns about who cannot open it.
 */
export const CardMoveTarget = z.object({
  surface: SurfaceSummary,
  /** People on the target who cannot open what the card points to; 0 when it points at nothing. */
  cannotOpen: z.number().int(),
});
export type CardMoveTarget = z.infer<typeof CardMoveTarget>;

/** A surface's cards changed; clients showing it refetch. */
export const SurfaceChangedEvent = z.object({ type: z.literal('surface.changed'), surfaceId: Id });

export const AddGroupLink = z.object({
  link: LinkInput,
  /** Defaults to the first section. */
  sectionId: Id.optional(),
});
