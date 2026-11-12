// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/safelink-decoder/logic.ts. See THIRD_PARTY.md.
/**
 * Decode "safe link" wrapper URLs back to their original destination. Pure and
 * local. Supports Outlook ATP SafeLinks and generic `?url=`/`?u=` redirect
 * wrappers.
 */

export function decodeSafelink(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('Paste a wrapped link.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a URL.");
  }

  // Outlook SafeLinks and most wrappers expose the target in a query param.
  for (const key of ['url', 'u', 'q', 'target']) {
    const value = url.searchParams.get(key);
    if (value) {
      const decoded = decodeURIComponent(value);
      // Only accept it if it actually looks like a URL.
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  }

  throw new Error('No wrapped URL found (expected a `url=` style parameter).');
}
