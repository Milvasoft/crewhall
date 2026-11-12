import { z } from 'zod';
import { BoardLabel, BOARD_LIMITS } from './boards';
import { Id } from './common';
import { NodeType } from './drive';
import { UserSummary } from './org';
import { PAGE_MARKDOWN_MAX } from './wiki';

/**
 * Template gallery (roadmap 8; design 5.13, 6.7): page, board and space templates. Built-in ones
 * ship with Crewhall in both languages; the organisation, a space or a person can save their
 * own. A template kind is a content shape; more kinds (forms, roadmap 16) are added as a new
 * `kind` with its own content schema.
 */

export const TemplateKind = z.enum(['page', 'board', 'space']);
export type TemplateKind = z.infer<typeof TemplateKind>;

/** `builtin` ships with Crewhall; `org` is managed by org admins, `space` by space admins. */
export const TemplateScope = z.enum(['builtin', 'org', 'space', 'personal']);
export type TemplateScope = z.infer<typeof TemplateScope>;

/** A page: its body as Markdown (placeholders «tarih», «yazar» are filled on use). */
export const PageTemplateContent = z.object({
  markdown: z.string().max(PAGE_MARKDOWN_MAX),
  icon: z.string().max(16).nullable().default(null),
});
export type PageTemplateContent = z.infer<typeof PageTemplateContent>;

/** A board: columns, labels, fields and starter cards (titles, labels, descriptions only). */
export const BoardTemplateContent = z.object({
  columns: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        wipLimit: z.number().int().min(1).max(999).nullable().default(null),
        isDone: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(BOARD_LIMITS.columns),
  labels: z.array(BoardLabel).max(BOARD_LIMITS.labels).default([]),
  fields: z.object({ points: z.boolean(), priority: z.boolean() }).default({
    points: false,
    priority: false,
  }),
  cards: z
    .array(
      z.object({
        /** Index into `columns`. */
        column: z.number().int().min(0),
        title: z.string().trim().min(1).max(BOARD_LIMITS.titleLength),
        /** Label ids of `labels`. */
        labels: z.array(z.string()).max(10).default([]),
        description: z.string().max(10_000).default(''),
      }),
    )
    .max(200)
    .default([]),
});
export type BoardTemplateContent = z.infer<typeof BoardTemplateContent>;

/** A space: a page tree and boards, created in the space root. */
export const SpaceTemplateContent = z.object({
  pages: z
    .array(
      z.object({
        /** Unique within the template; `parent` points at another page's key. */
        key: z.string().min(1).max(40),
        parent: z.string().max(40).nullable().default(null),
        name: z.string().trim().min(1).max(255),
        icon: z.string().max(16).nullable().default(null),
        markdown: z.string().max(PAGE_MARKDOWN_MAX),
      }),
    )
    .max(50),
  boards: z
    .array(z.object({ name: z.string().trim().min(1).max(255), board: BoardTemplateContent }))
    .max(10),
});
export type SpaceTemplateContent = z.infer<typeof SpaceTemplateContent>;

export const Template = z.object({
  /** `builtin:<key>` for pages, `builtin:<kind>:<key>` otherwise, or the saved template's id. */
  id: z.string(),
  kind: TemplateKind,
  scope: TemplateScope,
  spaceId: Id.nullable(),
  name: z.string(),
  description: z.string(),
  /** Gallery filter: team, engineering, product, project… or free text. */
  category: z.string(),
  /** What the card shows: the first blocks of a page, a board's columns, a space's pages. */
  preview: z.string(),
  summary: z.object({
    blocks: z.number().int().optional(),
    columns: z.array(z.string()).optional(),
    cards: z.number().int().optional(),
    pages: z.array(z.string()).optional(),
    boards: z.array(z.string()).optional(),
  }),
  createdBy: UserSummary.nullable(),
  /** The caller may delete it. */
  canDelete: z.boolean(),
});
export type Template = z.infer<typeof Template>;

export const TemplateListQuery = z.object({
  kind: TemplateKind.optional(),
  /** Space templates of this space only (default: every space the caller can reach). */
  spaceId: Id.optional(),
});

/**
 * "Şablon olarak kaydet": a page (`nodeId`), a board (`nodeId`) or a whole space (`spaceId`)
 * becomes a template. Org scope needs an org admin, space scope a space admin or owner.
 */
export const CreateTemplate = z
  .object({
    kind: TemplateKind,
    scope: z.enum(['org', 'space', 'personal']),
    /** The source page or board. */
    nodeId: Id.optional(),
    /** The source space (kind space), and the owner space of a space-scoped template. */
    spaceId: Id.optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).default(''),
    category: z.string().trim().min(1).max(40).default('team'),
  })
  .refine((v) => (v.kind === 'space' ? Boolean(v.spaceId) : Boolean(v.nodeId)), {
    message: 'a page or board template needs nodeId, a space template spaceId',
  })
  .refine((v) => v.scope !== 'space' || Boolean(v.spaceId), {
    message: 'space scope needs spaceId',
  });

/** Where a template's content is created: a space, and for pages and boards a parent. */
export const ApplyTemplate = z.object({
  spaceId: Id,
  /** A page or folder; null = space root. Space templates always go to the root. */
  parentId: Id.nullable().default(null),
});

export const ApplyTemplateResult = z.object({
  /** What was created, top level first; the first page or board is what to open. */
  nodes: z.array(z.object({ id: Id, type: NodeType, name: z.string() })),
  /** Parts left out because their module is off (`wiki`, `boards`). */
  skipped: z.array(z.string()),
});
export type ApplyTemplateResult = z.infer<typeof ApplyTemplateResult>;

export const TemplateList = z.object({
  items: z.array(Template),
  /** Org templates may be added by the caller. */
  canCreateOrg: z.boolean(),
});
