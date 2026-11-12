// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/email-normalizer/logic.ts. See THIRD_PARTY.md.
/**
 * Normalize email addresses to a canonical form so duplicates collapse. Pure
 * and local. Gmail/Googlemail ignore dots and treat everything after `+` as a
 * tag; most other providers only ignore the `+` tag.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export interface NormalizedEmail {
  normalized: string;
  changed: boolean;
}

export function normalizeEmail(email: string): NormalizedEmail {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error('Enter a valid email address.');
  }

  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);

  // Drop subaddressing (+tag) for everyone.
  local = local.split('+')[0] ?? '';

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }

  const normalized = `${local}@${domain}`;
  return { normalized, changed: normalized !== email.trim() };
}
