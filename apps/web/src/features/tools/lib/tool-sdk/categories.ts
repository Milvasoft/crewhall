// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/tool-sdk/categories.ts. See THIRD_PARTY.md.
import type { ToolCategory, ToolCategoryId } from './types';

/**
 * Category catalog. Order here is the display order on the homepage.
 */
export const CATEGORIES: ToolCategory[] = [
  { id: 'json', name: 'JSON', description: 'Inspect, convert and validate JSON.' },
  { id: 'dotnet', name: '.NET', description: 'C#, configuration and .NET workflows.' },
  {
    id: 'encoding',
    name: 'Encoding',
    description: 'Base64, URL and other encodings.',
  },
  {
    id: 'security',
    name: 'Security',
    description: 'Tokens, hashes, keys and generators.',
  },
  { id: 'text', name: 'Text', description: 'Compare, transform and inspect text.' },
  {
    id: 'devutils',
    name: 'Developer Utilities',
    description: 'Regex, cron, IDs and everyday helpers.',
  },
  { id: 'sql', name: 'SQL', description: 'Format and convert SQL.' },
  {
    id: 'datetime',
    name: 'Date & Time',
    description: 'Timestamps, cron and conversions.',
  },
  { id: 'data', name: 'Data', description: 'CSV, fake data and tabular tools.' },
  { id: 'images', name: 'Images', description: 'Compress, encode and generate images.' },
  {
    id: 'network',
    name: 'Network',
    description: 'IP addresses, subnets and MAC lookups.',
  },
  { id: 'web', name: 'Web', description: 'URLs, query strings and frontend helpers.' },
];

const CATEGORY_MAP = new Map<ToolCategoryId, ToolCategory>(CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: ToolCategoryId): ToolCategory | undefined {
  return CATEGORY_MAP.get(id);
}
