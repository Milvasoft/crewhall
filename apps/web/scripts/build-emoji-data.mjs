/**
 * Builds the emoji picker data and the animated emoji set (run by hand when updating):
 *   node scripts/build-emoji-data.mjs
 *
 * - src/lib/emoji/emoji-data.json: every emoji in Unicode order with its group, English
 *   keywords (emojibase-data, MIT) and Turkish ones (Unicode CLDR annotations, Unicode
 *   License v3), and skin tone variants. Loaded lazily when a picker opens.
 * - public/emoji/anim/<hex>.json: Google Noto Animated Emoji (CC BY 4.0) as Lottie, for the
 *   set in ANIMATED below. Played only on screen and without reduced motion.
 *
 * Nothing is fetched at run time: installs without internet access get the same emojis.
 */
/* global fetch, console, Buffer */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLDR =
  'https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-annotations-full/annotations/tr/annotations.json';
const CLDR_DERIVED =
  'https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-annotations-derived-full/annotationsDerived/tr/annotations.json';
const NOTO = (hex) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${hex}/lottie.json`;

/** The animated subset: the faces, hands, hearts and celebrations people send most. */
const ANIMATED = [
  '1f600',
  '1f603',
  '1f604',
  '1f601',
  '1f606',
  '1f605',
  '1f923',
  '1f602',
  '1f642',
  '1f643',
  '1f609',
  '1f60a',
  '1f607',
  '1f970',
  '1f60d',
  '1f929',
  '1f618',
  '1f617',
  '1f61a',
  '1f619',
  '1f60b',
  '1f61b',
  '1f61c',
  '1f92a',
  '1f61d',
  '1f911',
  '1f917',
  '1f92d',
  '1f92b',
  '1f914',
  '1f910',
  '1f928',
  '1f610',
  '1f611',
  '1f636',
  '1f60f',
  '1f612',
  '1f644',
  '1f62c',
  '1f925',
  '1f60c',
  '1f614',
  '1f62a',
  '1f924',
  '1f634',
  '1f637',
  '1f912',
  '1f915',
  '1f922',
  '1f92e',
  '1f927',
  '1f975',
  '1f976',
  '1f974',
  '1f635',
  '1f92f',
  '1f920',
  '1f973',
  '1f60e',
  '1f913',
  '1f9d0',
  '1f615',
  '1f61f',
  '1f641',
  '1f62e',
  '1f62f',
  '1f632',
  '1f633',
  '1f97a',
  '1f626',
  '1f627',
  '1f628',
  '1f630',
  '1f625',
  '1f622',
  '1f62d',
  '1f631',
  '1f616',
  '1f623',
  '1f61e',
  '1f613',
  '1f629',
  '1f62b',
  '1f971',
  '1f624',
  '1f621',
  '1f620',
  '1f92c',
  '1f608',
  '1f47f',
  '1f480',
  '1f4a9',
  '1f921',
  '1f47b',
  '1f47d',
  '1f916',
  '1f44b',
  '1f44c',
  '1f44d',
  '1f44e',
  '1f44f',
  '1f64c',
  '1f64f',
  '1f91d',
  '1f4aa',
  '270c_fe0f',
  '1f91e',
  '1f918',
  '1f919',
  '1f449',
  '2764_fe0f',
  '1f9e1',
  '1f49b',
  '1f49a',
  '1f499',
  '1f49c',
  '1f5a4',
  '1f494',
  '1f495',
  '1f496',
  '1f525',
  '2728',
  '1f389',
  '1f38a',
  '1f382',
  '1f381',
  '1f3c6',
  '1f947',
  '1f680',
  '1f4af',
  '2705',
  '274c',
  '1f440',
  '1f4a1',
  '1f4a5',
  '1f31f',
  '2b50',
  '1f308',
  '2600_fe0f',
  '1f319',
];

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const strip = (s) => s.replace(/️/g, '');

async function main() {
  const en = require('emojibase-data/en/compact.json');
  const tr = {
    ...(await json(CLDR)).annotations.annotations,
    ...(await json(CLDR_DERIVED)).annotationsDerived.annotations,
  };
  const trOf = (emoji) => tr[emoji] ?? tr[strip(emoji)];
  const out = en
    .filter((e) => e.group !== undefined && e.group !== 2 && e.order !== undefined)
    .sort((a, b) => a.order - b.order)
    .map((e) => {
      const t = trOf(e.unicode);
      const words = [e.label, ...(e.tags ?? []), t?.tts?.[0], ...(t?.default ?? [])].filter(
        Boolean,
      );
      return {
        e: e.unicode,
        g: e.group,
        n: t?.tts?.[0] ?? e.label,
        l: e.label,
        k: [...new Set(words.map((w) => w.toLocaleLowerCase('tr')))].join(' '),
        ...(e.skins ? { s: e.skins.map((s) => s.unicode) } : {}),
      };
    });
  await mkdir(join(root, 'src/lib/emoji'), { recursive: true });
  await writeFile(join(root, 'src/lib/emoji/emoji-data.json'), JSON.stringify(out));
  console.log(`emoji-data.json: ${out.length} emojis`);

  const dir = join(root, 'public/emoji/anim');
  await mkdir(dir, { recursive: true });
  const have = [];
  for (const hex of ANIMATED) {
    const file = join(dir, `${hex}.json`);
    if (
      await access(file).then(
        () => true,
        () => false,
      )
    ) {
      have.push(hex);
      continue;
    }
    const res = await fetch(NOTO(hex));
    if (!res.ok) {
      console.warn(`skip ${hex}: ${res.status}`);
      continue;
    }
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    have.push(hex);
  }
  await writeFile(join(root, 'src/lib/emoji/animated.json'), JSON.stringify(have));
  console.log(`animated: ${have.length} of ${ANIMATED.length}`);
}

await main();
