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
