import { z } from 'zod';
import { Id, Timestamp } from './common';
import { NodeName } from './drive';

/*
 * Office module (sonraki-isler "Crewhall Office"): Word, Excel and PowerPoint files (and their
 * OpenDocument forms) open, are edited and co-edited inside Crewhall through a separate document
 * server the org points to. Two kinds of server:
 * - `onlyoffice`: Euro-Office or ONLYOFFICE Docs, through the Document Server API (editor config
 *   signed with the shared JWT secret, the server downloads the file and calls back to save);
 * - `wopi`: any WOPI client (e.g. Collabora Online); Crewhall is the WOPI host.
 * Either way the editor gets a short-lived token per file and person, every save becomes a new
 * Drive version, and rights are checked with `can()` on every call from the server.
 */

export const OfficeServerType = z.enum(['onlyoffice', 'wopi']);
export type OfficeServerType = z.infer<typeof OfficeServerType>;

/** File types the office editor handles, by extension. */
export const OFFICE_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'] as const;
export const OfficeExtension = z.enum(OFFICE_EXTENSIONS);
export type OfficeExtension = z.infer<typeof OfficeExtension>;

/** Extension of a file name in lower case, or null. */
export function officeExtensionOf(name: string): OfficeExtension | null {
  const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
  return (OFFICE_EXTENSIONS as readonly string[]).includes(ext) ? (ext as OfficeExtension) : null;
}

export const OfficeTestResult = z.object({
  ok: z.boolean(),
  /** Why the server could not be used (message from the server or the network). */
  error: z.string().nullable(),
  /** Extensions the server can edit and only view, from its WOPI discovery. */
  edit: z.array(z.string()),
  view: z.array(z.string()),
  checkedAt: Timestamp,
});
export type OfficeTestResult = z.infer<typeof OfficeTestResult>;

/** Yönetim › Entegrasyonlar › Office (org.update_settings). */
export const OfficeSettings = z.object({
  enabled: z.boolean(),
  serverType: OfficeServerType,
  /** Public address of the document server (the browser loads the editor from here). */
  serverUrl: z.string().nullable(),
  /** Optional address the Crewhall server uses to reach it (e.g. inside Docker). */
  internalUrl: z.string().nullable(),
  /** Shared JWT secret of an onlyoffice server; written only, never returned. */
  jwtSecret: z.object({ set: z.boolean(), hint: z.string().nullable() }),
  lastTest: OfficeTestResult.nullable(),
  updatedAt: Timestamp.nullable(),
});
export type OfficeSettings = z.infer<typeof OfficeSettings>;

const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((u) => u.replace(/\/+$/, ''));

export const UpdateOfficeSettings = z.object({
  enabled: z.boolean().optional(),
  serverType: OfficeServerType.optional(),
  /** The server's JWT_SECRET; null removes it. */
  jwtSecret: z.string().min(16).max(500).nullable().optional(),
  serverUrl: HttpUrl.nullable().optional(),
  internalUrl: HttpUrl.nullable().optional(),
});
export type UpdateOfficeSettings = z.infer<typeof UpdateOfficeSettings>;

/** What a client may offer: editing exists when the module and the server are on and working. */
export const OfficeCapabilities = z.object({
  available: z.boolean(),
  edit: z.array(OfficeExtension),
  view: z.array(OfficeExtension),
});
export type OfficeCapabilities = z.infer<typeof OfficeCapabilities>;

export const OfficeMode = z.enum(['edit', 'view']);
export type OfficeMode = z.infer<typeof OfficeMode>;

export const OpenOfficeSession = z.object({
  /** `edit` falls back to `view` without edit rights. */
  mode: OfficeMode.default('edit'),
});

const SessionBase = z.object({
  nodeId: Id,
  fileName: z.string(),
  mode: OfficeMode,
  /** Origin the editor runs on (postMessage checks, CSP). */
  editorOrigin: z.string(),
});

/**
 * Opening the editor.
 * - `onlyoffice`: load `apiUrl` (DocsAPI) and start `new DocsAPI.DocEditor(el, config)`; the
 *   config is already signed (`config.token`), add only events and size.
 * - `wopi`: POST `access_token` and `access_token_ttl` as a form to `actionUrl` inside an iframe.
 * The tokens work for this file and person only.
 */
export const OfficeSession = z.discriminatedUnion('kind', [
  SessionBase.extend({
    kind: z.literal('onlyoffice'),
    apiUrl: z.string(),
    config: z.record(z.string(), z.unknown()),
  }),
  SessionBase.extend({
    kind: z.literal('wopi'),
    actionUrl: z.string(),
    accessToken: z.string(),
    /** Expiry as milliseconds since the epoch (WOPI `access_token_ttl`). */
    accessTokenTtl: z.number().int(),
  }),
]);
export type OfficeSession = z.infer<typeof OfficeSession>;

export const OfficeDocumentKind = z.enum(['document', 'spreadsheet', 'presentation']);
export type OfficeDocumentKind = z.infer<typeof OfficeDocumentKind>;

export const CreateOfficeDocument = z.object({
  spaceId: Id,
  parentId: Id.nullable().default(null),
  kind: OfficeDocumentKind,
  /** ooxml: docx, xlsx, pptx; odf: odt, ods, odp. */
  format: z.enum(['ooxml', 'odf']).default('ooxml'),
  /** Without an extension; the server adds it and picks a free name. */
  name: NodeName.optional(),
});
export type CreateOfficeDocument = z.infer<typeof CreateOfficeDocument>;
