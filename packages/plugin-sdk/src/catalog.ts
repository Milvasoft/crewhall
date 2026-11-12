import { z } from 'zod';
import { LocalizedText, PluginBrowserCapability, PluginHosting, PluginPermission } from './manifest';
import { RiskLevel } from './package';

/**
 * Who finds a listing: `public` in the catalog and search; `unlisted` only by its id or link;
 * `private` only for the installations on its allowlist (catalog, search and direct).
 */
export const PluginVisibility = z.enum(['public', 'unlisted', 'private']);
export type PluginVisibility = z.infer<typeof PluginVisibility>;

/**
 * The marketplace's public catalog API (docs/contracts/eklentiler.md › Katalog API'si), read by
 * every Crewhall installation. Packages themselves are fetched and verified separately.
 */

export const CatalogEntry = z.object({
  id: z.string(),
  version: z.string(),
  name: LocalizedText,
  description: LocalizedText,
  publisher: z.object({ name: z.string(), url: z.string().optional() }),
  homepage: z.string().nullable(),
  /** Absolute icon URL on the plugin origin, or null. */
  icon: z.string().nullable(),
  origin: z.string(),
  risk: RiskLevel,
  riskNote: LocalizedText.nullable(),
  permissions: z.array(PluginPermission),
  /** Browser features it asks for (older marketplaces leave it out: none). */
  browser: z.array(PluginBrowserCapability).default([]),
  entryPoints: z.object({
    tabs: z.number().int(),
    cards: z.number().int(),
    commands: z.number().int(),
    tools: z.number().int(),
    events: z.number().int(),
  }),
  /** Published for a list of installations only (in-house plugin). */
  restricted: z.boolean(),
  /** Older marketplaces leave these out: hosted and public. */
  hosting: PluginHosting.default('hosted'),
  visibility: PluginVisibility.default('public'),
  updatedAt: z.string(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const CatalogPage = z.object({ items: z.array(CatalogEntry) });
export type CatalogPage = z.infer<typeof CatalogPage>;

export const CatalogDetail = CatalogEntry.extend({
  versions: z.array(z.object({ version: z.string(), reviewedAt: z.string(), digest: z.string() })),
});
export type CatalogDetail = z.infer<typeof CatalogDetail>;

export const MarketplaceKeys = z.object({
  keys: z.array(z.object({ keyId: z.string(), publicKey: z.string() })),
});
