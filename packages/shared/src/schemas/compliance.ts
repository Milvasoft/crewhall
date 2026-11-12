import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

/**
 * Corporate compliance (roadmap 25), Yönetim › Uyumluluk: retention rules, legal holds,
 * eDiscovery exports and simple DLP rules. Org owners and admins only.
 */

export const RetentionRules = z.object({
  /** Chat messages older than this are erased (text and body); null = keep. */
  chatDays: z.number().int().min(30).max(36500).nullable(),
  /** Audit log rows older than this are deleted; null = keep. At least a year. */
  auditDays: z.number().int().min(365).max(36500).nullable(),
});
export type RetentionRules = z.infer<typeof RetentionRules>;

/** Built-in detectors (checked with their checksums), or a custom regular expression. */
export const DlpDetector = z.enum(['card', 'tckn', 'iban', 'custom']);
export type DlpDetector = z.infer<typeof DlpDetector>;

export const DlpRule = z.object({
  id: z.string().min(1).max(40),
  detector: DlpDetector,
  /** custom only: JavaScript regular expression source (no flags; matched case-insensitively). */
  pattern: z.string().min(1).max(200).optional(),
  /** Shown to the person when the rule matches. */
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  /** warn: chat asks for confirmation, elsewhere it is only recorded; block: refused. */
  action: z.enum(['warn', 'block']),
});
export type DlpRule = z.infer<typeof DlpRule>;

export const CompliancePolicy = z.object({
  retention: RetentionRules,
  dlp: z.object({ rules: z.array(DlpRule).max(20) }),
});
export type CompliancePolicy = z.infer<typeof CompliancePolicy>;

export const LegalHold = z.object({
  id: Id,
  name: z.string(),
  reason: z.string().nullable(),
  users: z.array(UserSummary),
  spaces: z.array(z.object({ id: Id, name: z.string() })),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  releasedAt: Timestamp.nullable(),
});
export type LegalHold = z.infer<typeof LegalHold>;

export const CreateLegalHold = z
  .object({
    name: z.string().trim().min(1).max(120),
    reason: z.string().trim().max(2000).optional(),
    userIds: z.array(Id).max(200).default([]),
    spaceIds: z.array(Id).max(200).default([]),
  })
  .refine((v) => v.userIds.length + v.spaceIds.length > 0, {
    message: 'at least one person or space',
    path: ['userIds'],
  });
export type CreateLegalHold = z.infer<typeof CreateLegalHold>;

export const EdiscoveryContent = z.enum(['chat', 'pages', 'cards', 'files', 'audit']);
export type EdiscoveryContent = z.infer<typeof EdiscoveryContent>;

export const EdiscoveryScope = z
  .object({
    userIds: z.array(Id).max(200).default([]),
    spaceIds: z.array(Id).max(200).default([]),
    from: Timestamp.nullable().default(null),
    to: Timestamp.nullable().default(null),
    include: z.array(EdiscoveryContent).min(1),
  })
  .refine((v) => v.userIds.length + v.spaceIds.length > 0, {
    message: 'at least one person or space',
    path: ['userIds'],
  });
export type EdiscoveryScope = z.infer<typeof EdiscoveryScope>;

export const CreateEdiscoveryExport = z.object({
  name: z.string().trim().min(1).max(120),
  scope: EdiscoveryScope,
});
export type CreateEdiscoveryExport = z.infer<typeof CreateEdiscoveryExport>;

export const EdiscoveryExport = z.object({
  id: Id,
  name: z.string(),
  status: z.enum(['queued', 'running', 'ready', 'failed']),
  scope: z.object({
    userIds: z.array(Id),
    spaceIds: z.array(Id),
    from: Timestamp.nullable(),
    to: Timestamp.nullable(),
    include: z.array(EdiscoveryContent),
  }),
  sizeBytes: z.number().nullable(),
  counts: z.record(z.string(), z.number()).nullable(),
  error: z.string().nullable(),
  requestedBy: UserSummary.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
});
export type EdiscoveryExport = z.infer<typeof EdiscoveryExport>;

export const ComplianceOverview = z.object({
  policy: CompliancePolicy,
  holds: z.array(LegalHold),
  exports: z.array(EdiscoveryExport),
});
export type ComplianceOverview = z.infer<typeof ComplianceOverview>;

export const DownloadLink = z.object({ url: z.url(), expiresAt: Timestamp });

/** details of 422 dlp_blocked / 409 dlp_warning: the matched rules (names shown to the person). */
export const DlpMatch = z.object({
  ruleId: z.string(),
  name: z.string(),
  action: z.enum(['warn', 'block']),
});
export type DlpMatch = z.infer<typeof DlpMatch>;
