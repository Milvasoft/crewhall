// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-encode/logic.ts. See THIRD_PARTY.md.
/**
 * URL percent-encoding. "component" escapes reserved characters (for a single
 * query value or path segment); "full" preserves URL structure (`:/?#` etc.).
 */
export type UrlEncodeScope = 'component' | 'full';

export function encodeUrl(input: string, scope: UrlEncodeScope): string {
  return scope === 'component' ? encodeURIComponent(input) : encodeURI(input);
}

export function decodeUrl(input: string, scope: UrlEncodeScope): string {
  return scope === 'component' ? decodeURIComponent(input) : decodeURI(input);
}
