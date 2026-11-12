// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/registry/index.ts. See THIRD_PARTY.md.
import type { ToolCategoryId, ToolDefinition, ToolEntry } from '@/features/tools/lib/tool-sdk';
import { TOOL_ENTRIES } from '@/features/tools/tools/registry';

const BY_ID = new Map<string, ToolEntry>(TOOL_ENTRIES.map((entry) => [entry.definition.id, entry]));

/** Every registered tool entry (metadata + lazy loader). */
export function getAllEntries(): ToolEntry[] {
  return TOOL_ENTRIES;
}

/** Every tool definition (metadata only). */
export function getAllDefinitions(): ToolDefinition[] {
  return TOOL_ENTRIES.map((e) => e.definition);
}

export function getEntry(id: string): ToolEntry | undefined {
  return BY_ID.get(id);
}

export function getDefinition(id: string): ToolDefinition | undefined {
  return BY_ID.get(id)?.definition;
}

export function getDefinitionsByCategory(category: ToolCategoryId): ToolDefinition[] {
  return getAllDefinitions().filter((d) => d.category === category);
}

export function getPopularDefinitions(): ToolDefinition[] {
  return getAllDefinitions().filter((d) => d.popular);
}

export function getToolIds(): string[] {
  return TOOL_ENTRIES.map((e) => e.definition.id);
}

export * from './search';
export * from './compatibility';
