// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/url-parser/logic.ts. See THIRD_PARTY.md.
export interface ParsedUrl {
  href: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  params: { key: string; value: string }[];
}

/**
 * Parse a URL using the platform URL API (WHATWG), returning its parts and a
 * flat list of query parameters (duplicates preserved, in order).
 */
export function parseUrl(input: string): ParsedUrl {
  const url = new URL(input.trim());
  const params: { key: string; value: string }[] = [];
  url.searchParams.forEach((value, key) => params.push({ key, value }));

  return {
    href: url.href,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    params,
  };
}

/** JSON representation used for "Send To" and the JSON output. */
export function parsedToJson(parsed: ParsedUrl): string {
  const { params, ...rest } = parsed;
  const query = params.reduce<Record<string, string | string[]>>((acc, p) => {
    if (p.key in acc) {
      const existing = acc[p.key]!;
      acc[p.key] = Array.isArray(existing) ? [...existing, p.value] : [existing, p.value];
    } else {
      acc[p.key] = p.value;
    }
    return acc;
  }, {});
  return JSON.stringify({ ...rest, query }, null, 2);
}
