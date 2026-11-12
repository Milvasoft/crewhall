/** The build this page came from: the meta tag buildInfoPlugin.ts writes into index.html. */

export interface BuildInfo {
  id: string | null;
  commit: string | null;
  builtAt: string | null;
}

/** Null on a page without the tag (a bundle older than the tag, tests). */
export function readBuildInfo(root: ParentNode = document): BuildInfo | null {
  const el = root.querySelector<HTMLMetaElement>('meta[name="crewhall-build"]');
  if (!el) return null;
  return {
    id: el.content || null,
    commit: el.dataset.commit || null,
    builtAt: el.dataset.builtAt || null,
  };
}

export function isSameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.id === b.id && a.commit === b.commit && a.builtAt === b.builtAt;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}
