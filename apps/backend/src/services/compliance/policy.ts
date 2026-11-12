import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  auditLogs,
  compliancePolicies,
  messages,
  organizations,
  type Db,
  type DbOrTx,
} from '@crewhall/db';
import { CompliancePolicy, type DlpMatch, type DlpRule } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Logger } from '../../logger';
import { identityAudit } from '../identity/audit';
import { notHeld } from './holds';

/**
 * Retention and DLP rules of an org (roadmap 25). A missing row means: keep everything, and
 * the three built-in DLP rules listed but off, so the admin only has to switch them on.
 */

export const BUILT_IN_RULES: DlpRule[] = [
  { id: 'card', detector: 'card', name: 'Kart numarası', enabled: false, action: 'warn' },
  { id: 'tckn', detector: 'tckn', name: 'TC kimlik numarası', enabled: false, action: 'warn' },
  { id: 'iban', detector: 'iban', name: 'IBAN', enabled: false, action: 'warn' },
];

export const DEFAULT_COMPLIANCE: CompliancePolicy = {
  retention: { chatDays: null, auditDays: null },
  dlp: { rules: BUILT_IN_RULES },
};

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; policy: CompliancePolicy }>();

export async function getCompliancePolicy(db: DbOrTx, orgId: string): Promise<CompliancePolicy> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.policy;
  const [row] = await db
    .select()
    .from(compliancePolicies)
    .where(eq(compliancePolicies.orgId, orgId));
  const parsed = row
    ? CompliancePolicy.safeParse({ retention: row.retention, dlp: row.dlp })
    : null;
  const policy = parsed?.success ? parsed.data : DEFAULT_COMPLIANCE;
  cache.set(orgId, { at: Date.now(), policy });
  return policy;
}

export function forgetCompliancePolicy(orgId?: string) {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

export async function updateCompliancePolicy(
  db: DbOrTx,
  actor: { orgId: string; userId: string },
  input: CompliancePolicy,
  req?: RequestInfo,
) {
  for (const r of input.dlp.rules) {
    if (r.detector !== 'custom') continue;
    try {
      new RegExp(r.pattern ?? '', 'iu');
    } catch {
      throw new AppError('validation_failed', {
        field: 'dlp.rules',
        ruleId: r.id,
        reason: 'pattern',
      });
    }
    if (!r.pattern) throw new AppError('validation_failed', { field: 'dlp.rules', ruleId: r.id });
  }
  const before = await getCompliancePolicy(db, actor.orgId);
  await db
    .insert(compliancePolicies)
    .values({
      orgId: actor.orgId,
      retention: input.retention,
      dlp: input.dlp,
      updatedBy: actor.userId,
    })
    .onConflictDoUpdate({
      target: compliancePolicies.orgId,
      set: {
        retention: input.retention,
        dlp: input.dlp,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      },
    });
  forgetCompliancePolicy(actor.orgId);
  await identityAudit(
    db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'compliance.policy.update',
      targetType: 'compliance_policy',
      meta: { from: before, to: input },
    },
    req,
  );
}

// ---- DLP -------------------------------------------------------------------------------

const MAX_SCAN = 20_000;

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function validTckn(d: string) {
  if (!/^[1-9]\d{10}$/.test(d)) return false;
  const n = [...d].map(Number);
  const odd = n[0]! + n[2]! + n[4]! + n[6]! + n[8]!;
  const even = n[1]! + n[3]! + n[5]! + n[7]!;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== n[9]) return false;
  return n.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === n[10];
}

function validIban(raw: string) {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}

/** Built-in detectors look for the shape and check the checksum, so ordinary numbers pass. */
export function detects(rule: DlpRule, text: string): boolean {
  const t = text.slice(0, MAX_SCAN);
  switch (rule.detector) {
    case 'card':
      return [...t.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)].some((m) =>
        luhn(m[0].replace(/[ -]/g, '')),
      );
    case 'tckn':
      return [...t.matchAll(/(?<!\d)\d{11}(?!\d)/g)].some((m) => validTckn(m[0]));
    case 'iban':
      return [
        ...t.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi),
      ].some((m) => validIban(m[0]));
    case 'custom':
      try {
        if (!rule.pattern) return false;
        // "i" does not fold Turkish İ/ı; the Turkish lower-cased text covers them.
        const re = new RegExp(rule.pattern, 'iu');
        return re.test(t) || re.test(t.toLocaleLowerCase('tr-TR'));
      } catch {
        return false;
      }
  }
}

export interface DlpContext {
  orgId: string;
  actorId: string;
  /** chat asks for confirmation on "warn"; other surfaces only record it. */
  surface: 'chat' | 'page_comment' | 'board_card' | 'board_comment';
  ack?: boolean | undefined;
  targetType?: string;
  targetId?: string;
}

/**
 * Checks text against the org's enabled DLP rules before it is saved. "block" refuses
 * (422 dlp_blocked); "warn" refuses chat once (409 dlp_warning) until sent with dlpAck.
 * Every match is audited, without the text itself.
 */
export async function checkDlp(db: DbOrTx, ctx: DlpContext, text: string) {
  if (!text.trim()) return;
  const policy = await getCompliancePolicy(db, ctx.orgId);
  const matches: DlpMatch[] = policy.dlp.rules
    .filter((r) => r.enabled && detects(r, text))
    .map((r) => ({ ruleId: r.id, name: r.name, action: r.action }));
  if (!matches.length) return;
  const blocked = matches.some((m) => m.action === 'block');
  const ask = !blocked && ctx.surface === 'chat' && !ctx.ack;
  await identityAudit(db, {
    orgId: ctx.orgId,
    actorId: ctx.actorId,
    action: blocked
      ? 'compliance.dlp.blocked'
      : ask
        ? 'compliance.dlp.warned'
        : 'compliance.dlp.sent',
    targetType: ctx.targetType ?? ctx.surface,
    ...(ctx.targetId ? { targetId: ctx.targetId } : {}),
    meta: { surface: ctx.surface, rules: matches.map((m) => m.ruleId) },
  });
  if (blocked) throw new AppError('dlp_blocked', { matches });
  if (ask) throw new AppError('dlp_warning', { matches });
}

// ---- retention rules (nightly) ----------------------------------------------------------

/**
 * compliance.retention (nightly): per org, chat messages past `chatDays` lose their text and
 * body (like "Herkes için sil"), audit rows past `auditDays` go; held content stays.
 */
export async function applyRetention(deps: { db: Db; logger: Logger }, now = new Date()) {
  const orgs = await deps.db.select({ id: organizations.id }).from(organizations);
  let erased = 0;
  let audits = 0;
  for (const { id: orgId } of orgs) {
    const policy = await getCompliancePolicy(deps.db, orgId);
    const { chatDays, auditDays } = policy.retention;
    if (chatDays) {
      const res = await deps.db
        .update(messages)
        .set({ text: '', body: {}, deletedAt: now })
        .where(
          and(
            eq(messages.orgId, orgId),
            isNull(messages.deletedAt),
            lt(messages.createdAt, new Date(now.getTime() - chatDays * 86_400_000)),
            notHeld.message(),
          ),
        );
      erased += res.rowCount ?? 0;
    }
    if (auditDays) {
      const res = await deps.db.delete(auditLogs).where(
        and(
          eq(auditLogs.orgId, orgId),
          lt(auditLogs.at, new Date(now.getTime() - auditDays * 86_400_000)),
          // Custodians' audit trail stays while they are held.
          sql`not exists (select 1 from legal_holds h where h.org_id = ${orgId}::uuid
            and h.released_at is null and "audit_logs"."actor_id" = any(h.user_ids))`,
        ),
      );
      audits += res.rowCount ?? 0;
    }
  }
  if (erased || audits) deps.logger.info({ erased, audits }, 'retention rules applied');
  return { erased, audits };
}
