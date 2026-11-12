// Requests every URL of the old Docusaurus sitemaps against a running portal and counts the
// status codes. Usage: node scripts/check-urls.mjs [baseUrl=http://localhost:4221]
import { readFileSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:4221').replace(/\/+$/, '');
const files = ['old-sitemap-en.txt', 'old-sitemap-tr.txt'];
const urls = files.flatMap((f) =>
  readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean),
);

const counts = new Map();
const failures = [];
const queue = [...urls];
async function worker() {
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    let status = 0;
    let location;
    try {
      const res = await fetch(base + encodeURI(path), { redirect: 'manual' });
      status = res.status;
      location = res.headers.get('location') ?? '';
      await res.arrayBuffer();
    } catch (err) {
      location = String(err);
    }
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (status !== 200 && status !== 301 && status !== 308)
      failures.push(`${status} ${path} ${location}`);
    else if (status !== 200) console.log(`${status} ${path} → ${location}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`\n${urls.length} URLs:`, Object.fromEntries([...counts.entries()].sort()));
if (failures.length) {
  console.log('Failures:\n' + failures.join('\n'));
  process.exitCode = 1;
}
