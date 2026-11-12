// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/cron-viewer/logic.ts. See THIRD_PARTY.md.
import cronstrue from 'cronstrue';
import parser from 'cron-parser';

/**
 * Cron dialects differ. We surface the choice explicitly rather than pretending
 * one parser covers all of them:
 *  - unix:    5 fields (min hour dom mon dow)
 *  - quartz:  6-7 fields, leading SECONDS and a required '?' in one of dom/dow
 */
export type CronDialect = 'unix' | 'quartz';

export interface CronResult {
  description: string | null;
  nextRuns: Date[];
  error: string | null;
  fieldCount: number;
}

/**
 * `locale` is a cronstrue locale code; any other than "en" must be registered
 * first by importing `cronstrue/locales/<code>`.
 */
export function describeCron(expr: string, now: Date = new Date(), locale = 'en'): CronResult {
  const trimmed = expr.trim();
  if (!trimmed) {
    return { description: null, nextRuns: [], error: null, fieldCount: 0 };
  }

  const fieldCount = trimmed.split(/\s+/).length;
  let description: string | null = null;
  let error: string | null = null;

  try {
    description = cronstrue.toString(trimmed, {
      throwExceptionOnParseError: true,
      use24HourTimeFormat: true,
      locale,
      // cronstrue treats a 6-field expression as having seconds, matches Quartz.
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const nextRuns: Date[] = [];
  try {
    const interval = parser.parseExpression(trimmed, {
      currentDate: now,
    });
    for (let i = 0; i < 6; i++) nextRuns.push(interval.next().toDate());
  } catch (e) {
    // cron-parser does not accept Quartz '?'/'L'/'W'; keep the description but
    // report that upcoming runs are unavailable for this dialect/expression.
    if (!error) error = e instanceof Error ? e.message : String(e);
  }

  return { description, nextRuns, error: description ? null : error, fieldCount };
}

// ---------------------------------------------------------------------------
// Dialect conversion (best-effort)
// ---------------------------------------------------------------------------

export interface CronConversion {
  value: string;
  note?: string;
}

// Unix DOW is 0-6 (Sun=0); Quartz is 1-7 (Sun=1). Shift numeric tokens.
function shiftDowForQuartz(dow: string): string {
  return dow.replace(/\d+/g, (d) => {
    const n = Number(d);
    return String(n === 7 ? 1 : n + 1);
  });
}

/**
 * Convert a standard 5-field Unix cron to a Quartz 6-field expression
 * (`sec min hour day-of-month month day-of-week`). Quartz requires exactly one
 * of day-of-month / day-of-week to be `?`; best-effort with a note.
 */
export function cronToQuartz(expr: string): CronConversion {
  const f = expr.trim().split(/\s+/);
  if (f.length === 6 || f.length === 7) {
    return { value: expr.trim(), note: 'Already 6–7 fields; treated as Quartz-style.' };
  }
  if (f.length !== 5) {
    throw new Error('Expected a 5-field Unix cron expression.');
  }
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  let outDom = dom;
  const outDow = dow === '*' ? '?' : shiftDowForQuartz(dow);
  let note: string | undefined;

  if (outDow !== '?') {
    if (dom === '*') outDom = '?';
    else note = "Quartz can't specify both day-of-month and day-of-week; review manually.";
  }
  return { value: `0 ${min} ${hour} ${outDom} ${mon} ${outDow}`, note };
}

/**
 * Hangfire uses Cronos, which accepts standard Unix cron (5-field) and optional
 * 6-field with leading seconds, so the expression is unchanged.
 */
export function cronToHangfire(expr: string): CronConversion {
  return {
    value: expr.trim(),
    note: 'Hangfire uses standard Unix cron; unchanged. 6-field (seconds) also supported.',
  };
}
