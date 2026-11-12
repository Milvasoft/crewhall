// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/basic-auth-generator/logic.ts. See THIRD_PARTY.md.
/**
 * HTTP Basic Access Authentication header generation (RFC 7617). Pure and local.
 */

function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export interface BasicAuth {
  token: string;
  header: string;
  curl: string;
}

/** Build the base64 credential token and the full Authorization header. */
export function basicAuth(username: string, password: string): BasicAuth {
  const token = utf8ToBase64(`${username}:${password}`);
  return {
    token,
    header: `Authorization: Basic ${token}`,
    curl: `curl -u '${username}:${password}' https://example.com`,
  };
}
