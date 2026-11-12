import type { PackageFile } from './importAssets';
import { htmlToPageMarkdown, pathSegment, titled } from './importHtml';

/**
 * A Confluence "Export space > HTML" package: `index.html`, one HTML file per page and the files
 * under `attachments/<page id>/<file id>.<ext>`. Breadcrumbs give the page tree. Only the page
 * body and its attachment list are read; comments and page details are left out.
 */

const HTML = /\.html?$/i;
const INDEX = /(^|\/)index\.html?$/i;

const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const textOf = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** How a page refers to a file of the export, without its size parameters. */
const fileRef = (ref: string) => {
  const bare = ref.replace(/[?#].*$/, '');
  try {
    return decodeURI(bare);
  } catch {
    return bare;
  }
};

/** Confluence's macro name to our block type. */
const INFO_TYPES: Record<string, string> = {
  information: 'info',
  note: 'warning',
  warning: 'danger',
  tip: 'tip',
};

function markBlock(block: Element, directive: string, title: Element | null) {
  block.setAttribute('data-directive', directive);
  const text = textOf(title);
  if (text) block.setAttribute('data-title', text);
  title?.remove();
}

function unwrap(node: Element) {
  node.replaceWith(...node.childNodes);
}

/** Where a link of the export leads, when that is a page of the export. */
function pageLink(href: string, links: Map<string, string>) {
  const id = /[?&]pageId=(\d+)|\/spaces\/[^/]+\/pages\/(\d+)/.exec(href);
  const file = id ? `${id[1] ?? id[2]}.html` : fileRef(href).split('/').at(-1)!;
  return links.get(file.toLowerCase()) ?? null;
}

/** Rewrites the page body in place into what the Markdown conversion understands. */
function prepareBody(body: Element, names: Map<string, string>, links: Map<string, string>) {
  // The page's outline is built in; icons and macro chrome carry no content.
  body
    .querySelectorAll('.toc-macro, .aui-icon, .expand-icon, .plugin_pagetree')
    .forEach((n) => n.remove());

  body.querySelectorAll('.confluence-information-macro').forEach((macro) => {
    const kind = [...macro.classList]
      .map((c) => /^confluence-information-macro-(\w+)$/.exec(c)?.[1])
      .find((c) => c && INFO_TYPES[c]);
    markBlock(macro, INFO_TYPES[kind ?? 'information']!, macro.querySelector(':scope > .title'));
  });
  body.querySelectorAll('.panel:not(.code):not(.preformatted)').forEach((panel) => {
    markBlock(panel, 'note', panel.querySelector(':scope > .panelHeader'));
  });
  body.querySelectorAll('.expand-container').forEach((expand) => {
    const control = expand.querySelector(':scope > .expand-control');
    markBlock(expand, 'toggle', control);
  });

  body.querySelectorAll('pre[data-syntaxhighlighter-params]').forEach((pre) => {
    const params = pre.getAttribute('data-syntaxhighlighter-params') ?? '';
    const brush = /brush:\s*([\w+#-]+)/.exec(params)?.[1];
    if (brush && brush !== 'none' && brush !== 'text') pre.setAttribute('data-lang', brush);
  });

  body.querySelectorAll('ul.inline-task-list > li').forEach((li) => {
    li.setAttribute('data-task', li.classList.contains('checked') ? 'x' : ' ');
  });

  body.querySelectorAll('img').forEach((img) => {
    if (img.classList.contains('emoticon')) {
      const emoji = img.getAttribute('data-emoji-fallback') ?? img.getAttribute('alt') ?? '';
      img.replaceWith(/^[:(]/.test(emoji) ? '' : emoji);
      return;
    }
    const src = fileRef(img.getAttribute('data-image-src') ?? img.getAttribute('src') ?? '');
    if (src.startsWith('images/')) {
      img.remove();
      return;
    }
    const file = src.replace(/^thumbnails\//, 'attachments/');
    const name = img.getAttribute('data-linked-resource-default-alias');
    if (name) names.set(file, name);
    img.setAttribute('src', encodeURI(file));
  });

  body.querySelectorAll('a').forEach((link) => {
    const href = link.getAttribute('href') ?? '';
    const page = pageLink(href, links);
    if (page) {
      link.setAttribute('href', page);
      return;
    }
    if (/^(https?:|mailto:|tel:|#)/i.test(href)) return;
    const file = fileRef(href);
    if (file.startsWith('attachments/')) {
      const name = link.getAttribute('data-linked-resource-default-alias');
      if (name) names.set(file, name);
      link.setAttribute('href', encodeURI(file));
      return;
    }
    // An address on the old site, or a page left out of the export: nothing to point at here.
    unwrap(link);
  });
}

/** Files of the page's attachment list that the body does not already show. */
function attachmentList(doc: Document, body: Element, names: Map<string, string>) {
  const section = doc.querySelector('h2#attachments')?.closest('.pageSection');
  if (!section) return '';
  const shown = new Set(
    [...body.querySelectorAll('img[src], a[href]')].map((n) =>
      fileRef(n.getAttribute('src') ?? n.getAttribute('href') ?? ''),
    ),
  );
  const lines: string[] = [];
  section.querySelectorAll('a[href]').forEach((link) => {
    const file = fileRef(link.getAttribute('href')!);
    if (!file.startsWith('attachments/')) return;
    const name = textOf(link) || file.split('/').at(-1)!;
    names.set(file, name);
    if (!shown.has(file)) lines.push(`- [${name.replace(/[[\]]/g, '')}](${encodeURI(file)})`);
  });
  if (!lines.length) return '';
  const heading = textOf(section.querySelector('h2')).replace(/\s*:\s*$/, '');
  return `\n\n## ${heading}\n\n${lines.join('\n')}`;
}

function readPage(html: string) {
  const doc = parse(html);
  const body = doc.querySelector('#main-content');
  // Other sites call their content "main-content" too; the breadcrumbs are Confluence's.
  if (!body || !doc.querySelector('#breadcrumbs')) return null;
  const crumbs = [...doc.querySelectorAll('#breadcrumbs li a')];
  const space = textOf(crumbs.find((a) => /index\.html?$/i.test(a.getAttribute('href') ?? '')));
  const heading = textOf(doc.querySelector('#title-text')) || textOf(doc.querySelector('title'));
  const title =
    space && heading.startsWith(`${space} : `) ? heading.slice(space.length + 3) : heading;
  const parents = crumbs
    .filter((a) => !/index\.html?$/i.test(a.getAttribute('href') ?? ''))
    .map((a) => pathSegment(textOf(a)));

  return { doc, body, title, path: [...parents, `${pathSegment(title)}.md`].join('/') };
}

/**
 * Replaces each Confluence export in the package with its pages. Files of the export keep their
 * paths under its folder, so the links resolve; attachments get their real names.
 */
export async function convertConfluence(files: PackageFile[]): Promise<PackageFile[]> {
  const roots = files.filter((f) => f.blob && INDEX.test(f.path)).map((f) => dirOf(f.path));
  let out = files;
  for (const root of roots) {
    const inRoot = (f: PackageFile) => f.blob && HTML.test(f.path) && dirOf(f.path) === root;
    const names = new Map<string, string>();
    const read: { path: string; page: NonNullable<ReturnType<typeof readPage>> }[] = [];
    const links = new Map<string, string>();
    const used = new Set<PackageFile>();
    for (const file of out.filter(inRoot)) {
      if (INDEX.test(file.path)) continue;
      const page = readPage(await file.blob!.text());
      if (!page) continue;
      used.add(file);
      // The folder of an export is only its space key; it names pages when there are several.
      const path = roots.length > 1 ? `${root}/${page.path}` : page.path;
      read.push({ path, page });
      // From the root of the import, as the page's folder is not the file's in the export.
      const link = `/${path.split('/').map(encodeURIComponent).join('/')}`;
      const name = file.path.split('/').at(-1)!.toLowerCase();
      links.set(name, link);
      // `Page-Title_200.html`: other pages may refer to it by its id.
      const id = /(?:^|_)(\d+)\.html?$/.exec(name)?.[1];
      if (id) links.set(`${id}.html`, link);
    }
    // Plain HTML files next to an index.html are not an export.
    if (!read.length) continue;
    const pages = read.map(({ path, page: { doc, body, title } }): PackageFile => {
      prepareBody(body, names, links);
      const list = attachmentList(doc, body, names);
      return { path, text: titled(title, `${htmlToPageMarkdown(body as HTMLElement)}${list}`) };
    });
    const prefix = root ? `${root}/` : '';
    out = [
      ...pages,
      ...out
        .filter((f) => !used.has(f) && !(inRoot(f) && INDEX.test(f.path)))
        .map((f) => {
          const name = f.path.startsWith(prefix) ? names.get(f.path.slice(prefix.length)) : null;
          return name ? { ...f, name } : f;
        }),
    ];
  }
  return out;
}
