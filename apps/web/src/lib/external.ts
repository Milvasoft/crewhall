/** Leaves the SPA for another app or scheme (crewhall://, exp://). Separate so tests can stub it. */
export function openExternal(url: string): void {
  window.location.assign(url);
}
