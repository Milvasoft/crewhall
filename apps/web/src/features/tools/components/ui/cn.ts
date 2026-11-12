// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/ui/cn.ts. See THIRD_PARTY.md.
/** Tiny class-name joiner. Avoids a dependency for a one-line utility. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
