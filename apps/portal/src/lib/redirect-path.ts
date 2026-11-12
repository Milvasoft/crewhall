const BACKSLASH = String.fromCharCode(92);

/** Only site-relative paths: no open redirects (//evil.com, /\evil.com, https://…). */
export function safeRedirectPath(path: string | null | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/' + BACKSLASH)) {
    return '/';
  }
  if (/[\r\n]/.test(path)) return '/';
  return path;
}
