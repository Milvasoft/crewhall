import fs from 'node:fs';
import path from 'node:path';

/** The Docusaurus site next to the repo (../milva-portal); tests skip without it. */
export function findCorpus(): string | null {
  if (process.env.PORTAL_CORPUS) return process.env.PORTAL_CORPUS;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '..', 'milva-portal');
    if (fs.existsSync(path.join(candidate, 'docusaurus.config.js'))) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      if (f === 'node_modules' || f.startsWith('.')) continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/.test(f)) out.push(p);
    }
  };
  for (const sub of ['docs', 'versioned_docs', 'blog', 'i18n']) {
    if (fs.existsSync(path.join(root, sub))) walk(path.join(root, sub));
  }
  return out;
}
