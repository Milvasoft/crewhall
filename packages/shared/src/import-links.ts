/**
 * Links between the files of one page import. The client uses this to tell a link to another
 * imported page from a missing attachment; the server, to turn it into a link to that page.
 */

const PAGE_FILE = /\.(md|markdown)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const pathKey = (path: string) => {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/').toLowerCase();
};

/**
 * Returns a function from a link in one file (`from`) to the imported file it points at, or null.
 * A link starting with `/` counts from the root of the import; any other from the linking file's
 * folder, then from the root. Last, a file name that exists only once in the import.
 */
export function importLinkResolver(paths: readonly string[]) {
  const byKey = new Map(paths.map((path) => [pathKey(path), path]));
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = pathKey(path).split('/').at(-1)!;
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }

  return (target: string, from: string): string | null => {
    const raw = target.replace(/^<|>$/g, '').trim();
    if (SCHEME.test(raw)) return null;
    const file = decode(raw.replace(/[?#].*$/, ''));
    if (!PAGE_FILE.test(file)) return null;
    const dir = from.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const tries = file.startsWith('/') ? [file] : [`${dir}/${file}`, file];
    for (const path of tries) {
      const hit = byKey.get(pathKey(path));
      if (hit !== undefined) return hit;
    }
    const same = byName.get(pathKey(file).split('/').at(-1)!);
    return same?.length === 1 ? same[0]! : null;
  };
}
