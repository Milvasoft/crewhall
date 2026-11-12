// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/tool-sdk/types.ts. See THIRD_PARTY.md.
import type { ComponentType } from 'react';

/**
 * Data types that flow in and out of tools. Declaring these lets the registry
 * compute valid "Send To" destinations without any tool knowing about another.
 * Keep this list intentionally small; add types only when a real tool needs one.
 */
export type ToolDataType =
  | 'text'
  | 'json'
  | 'xml'
  | 'yaml'
  | 'toml'
  | 'sql'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'base64'
  | 'jwt'
  | 'url'
  | 'image'
  | 'binary';

/**
 * Where a tool actually executes.
 * - local:  runs entirely in the browser; input never leaves the device.
 * - server: requires server processing.
 * - hybrid: primarily local, but may optionally use the server.
 *
 * `local` is the default and strongly preferred for privacy.
 */
export type ToolExecution = 'local' | 'server' | 'hybrid';

export type ToolCategoryId =
  | 'json'
  | 'dotnet'
  | 'encoding'
  | 'security'
  | 'text'
  | 'devutils'
  | 'sql'
  | 'datetime'
  | 'data'
  | 'images'
  | 'network'
  | 'web';

export interface ToolCategory {
  id: ToolCategoryId;
  name: string;
  /** Short blurb used on the homepage / category pages. */
  description: string;
}

/**
 * The metadata contract every tool must satisfy. This object is intentionally
 * lightweight, it must NOT import heavy libraries or the tool's React
 * component, so the registry can load every definition eagerly for search,
 * categories and the command palette without shipping tool code.
 */
export interface ToolDefinition {
  /** URL-safe, stable identifier. Also the route: /tools/<id>. */
  id: string;
  name: string;
  /** One sentence, no marketing. Drives SEO description + tool header. */
  description: string;

  category: ToolCategoryId;

  /** Extra search terms / aliases so "token" finds the JWT decoder, etc. */
  keywords: string[];

  /**
   * Optional cross-cutting tags for finer categorization than the single
   * `category`. Unlike `category` (one primary bucket), a tool can carry many
   * tags (e.g. "converter", "generator", "dotnet", "clipboard"). Surfaced in
   * search today; can drive tag-based browsing/filtering later.
   */
  tags?: string[];

  execution: ToolExecution;

  /** What the tool can receive from a "Send To" and what it emits. */
  inputType?: ToolDataType;
  outputType?: ToolDataType;

  /** Optional short label used in dense lists; falls back to `name`. */
  shortName?: string;

  /** Marks tools surfaced in the "Popular" section of the homepage. */
  popular?: boolean;
}

/**
 * A tool's React component receives an optional initial input, which is how a
 * "Send To" hands data to the destination tool. Components must treat this as
 * ephemeral seed state, never persist it.
 */
export interface ToolComponentProps {
  initialInput?: string;
}

export type ToolComponent = ComponentType<ToolComponentProps>;

/**
 * A registry entry pairs light metadata with a lazy loader for the (heavy)
 * component. The loader enables per-tool code splitting: opening one tool does
 * not download every other tool's JavaScript.
 */
export interface ToolEntry {
  definition: ToolDefinition;
  load: () => Promise<{ default: ToolComponent }>;
}

/** One question/answer pair. Rendered on the page and as FAQPage JSON-LD. */
export interface ToolFaqItem {
  question: string;
  answer: string;
}

/**
 * The written, server-rendered half of a tool page: the prose a search engine
 * (and a first-time visitor) can actually read, since the tool UI itself is
 * client-only (`ssr: false`) and renders nothing in the initial HTML.
 *
 * Lives in `src/tools/<id>/content.ts`, NOT in `definition.ts`: definitions are
 * imported eagerly by the client bundle for search and the command palette,
 * while content is imported only by the Server Component that renders the page,
 * so none of this text ships as JavaScript.
 *
 * Write it honestly. Everything here is a claim about what the tool does, so it
 * should match `logic.ts`, not marketing copy.
 */
export interface ToolContent {
  /**
   * `<title>` for the page, without the site name (the layout template appends
   * it). Lead with the term people search for; 30-45 characters.
   */
  title: string;

  /**
   * `<meta name="description">`, 140-160 characters. One concrete sentence
   * about what the tool does plus what the user gets, not a slogan.
   */
  metaDescription: string;

  /** H2 that opens the written section. Unique per tool, not "About". */
  heading: string;

  /**
   * The opening paragraph, 60-90 words: what the tool does, who reaches for it
   * and what "local" means for this particular kind of input.
   */
  intro: string;

  /** "How to use it" steps, 3-5 imperative sentences in order. */
  steps: string[];

  /** Optional extra paragraphs: format notes, limits, gotchas. */
  notes?: string[];

  /** 3-5 questions people actually type into a search box. */
  faq: ToolFaqItem[];

  /**
   * Ids of genuinely related tools, for internal linking. Falls back to other
   * tools in the same category when omitted.
   */
  related?: string[];
}
