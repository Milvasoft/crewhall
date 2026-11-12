/** Only same-app paths are allowed as post-login targets (no open redirect). */
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
  if (target.startsWith('/login')) return '/';
  return target;
}
