// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/registry/compatibility.ts. See THIRD_PARTY.md.
import type { ToolDataType, ToolDefinition } from '@/features/tools/lib/tool-sdk';
import { getAllDefinitions } from './index';

/**
 * Whether a tool that accepts `target` should receive an output of type
 * `source`. Kept intentionally strict so the "Send To" menu only lists
 * meaningful destinations, no nonsensical entries.
 *
 * Rules:
 *  - exact type match (json → json tools, sql → sql tools, …);
 *  - a small set of curated, genuinely useful coercions.
 *
 * We deliberately do NOT treat every text-input tool as a universal target:
 * many tools share `inputType: "text"` but expect a *specific* kind of text
 * (a password to hash, words to case-convert), so a blanket "anything → text"
 * rule produced a lot of noise.
 */
const COERCIONS: Partial<Record<ToolDataType, ToolDataType[]>> = {
  // target : acceptable source types (besides the exact match)
  json: ['jwt'], // a decoded JWT payload is JSON
  markdown: ['html'], // HTML can be converted to Markdown en route
  text: ['markdown', 'url', 'base64', 'jwt'], // plain-text views of textual outputs
};

function accepts(target: ToolDataType, source: ToolDataType): boolean {
  if (target === source) return true;
  return COERCIONS[target]?.includes(source) ?? false;
}

/** The single most obvious destination for each data type, floated to the top. */
const PRIMARY_TARGET: Partial<Record<ToolDataType, string>> = {
  json: 'json-viewer',
  csv: 'csv-viewer',
  sql: 'sql-formatter',
  xml: 'xml-formatter',
  yaml: 'yaml-viewer',
  markdown: 'markdown-viewer',
};

/**
 * Return the tools that can meaningfully receive an output of the given type.
 * By default this is the source tool's static `outputType`, but callers whose
 * output type varies at runtime (e.g. the Fake Data generator switching between
 * JSON/CSV/SQL) can pass an explicit `outputType` override. The source tool is
 * excluded; server tools stay eligible (compatibility is about data, not
 * execution). The primary destination for the type is listed first.
 */
export function getSendToTargets(
  source: ToolDefinition,
  outputType: ToolDataType | undefined = source.outputType,
): ToolDefinition[] {
  if (!outputType) return [];
  const primary = PRIMARY_TARGET[outputType];

  return getAllDefinitions()
    .filter((d) => d.id !== source.id)
    .filter((d) => d.inputType !== undefined && accepts(d.inputType, outputType))
    .sort((a, b) => {
      if (a.id === primary) return -1;
      if (b.id === primary) return 1;
      return a.name.localeCompare(b.name);
    });
}
