// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/tool-sdk/index.ts. See THIRD_PARTY.md.
export * from './types';
export * from './categories';

import type { ToolContent, ToolDefinition } from './types';

/**
 * Helper for authoring a tool definition. Provides no runtime magic today, but
 * gives a single choke point for defaults/validation as the contract evolves,
 * and keeps `definition.ts` files terse and type-checked.
 */
export function defineTool(def: ToolDefinition): ToolDefinition {
  return def;
}

/**
 * Helper for authoring a tool's page content (`src/tools/<id>/content.ts`).
 * Same idea as `defineTool`: type-checking and one place to evolve the shape.
 */
export function defineContent(content: ToolContent): ToolContent {
  return content;
}
