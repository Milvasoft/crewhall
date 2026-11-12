// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/registry/search.ts. See THIRD_PARTY.md.
import type { ToolDefinition } from '@/features/tools/lib/tool-sdk';
import { getCategory } from '@/features/tools/lib/tool-sdk';
import { getAllDefinitions } from './index';

export interface SearchResult {
  definition: ToolDefinition;
  score: number;
}

/**
 * Instant, fully local fuzzy-ish search over tool metadata. Matches name,
 * description, keywords and category so "token" -> JWT Decoder and
 * "env" / "appsettings" -> the env-var converter. No index build cost that
 * matters at this scale; recomputed per keystroke on the client.
 */
export function searchTools(query: string, defs = getAllDefinitions()): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return defs.map((definition) => ({ definition, score: 0 }));
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  for (const definition of defs) {
    const score = scoreTool(definition, terms);
    if (score > 0) results.push({ definition, score });
  }

  results.sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name));
  return results;
}

function scoreTool(def: ToolDefinition, terms: string[]): number {
  const name = def.name.toLowerCase();
  const desc = def.description.toLowerCase();
  const keywords = [...def.keywords, ...(def.tags ?? [])].map((k) => k.toLowerCase());
  const category = getCategory(def.category)?.name.toLowerCase() ?? '';

  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (name === term) best = Math.max(best, 100);
    else if (name.startsWith(term)) best = Math.max(best, 70);
    else if (name.includes(term)) best = Math.max(best, 45);

    if (keywords.some((k) => k === term)) best = Math.max(best, 60);
    else if (keywords.some((k) => k.startsWith(term))) best = Math.max(best, 40);
    else if (keywords.some((k) => k.includes(term))) best = Math.max(best, 25);

    if (desc.includes(term)) best = Math.max(best, 15);
    if (category.includes(term)) best = Math.max(best, 20);

    // All terms must match something, AND semantics.
    if (best === 0) return 0;
    total += best;
  }
  return total;
}
