import type { PackageFile } from './importAssets';
import { htmlToPageMarkdown, titled } from './importHtml';

/** Word document to Markdown, with its images as package files the page links to. */

/** Word's own "Title" style names the page; other headings stay in the body. */
const TITLE_CLASS = 'word-title';
const STYLE_MAP = [
  `p[style-name='Title'] => h1.${TITLE_CLASS}:fresh`,
  "p[style-name='Subtitle'] => h2:fresh",
];

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

export async function convertWord(file: PackageFile): Promise<PackageFile[]> {
  const { default: mammoth } = await import('mammoth/mammoth.browser');
  const path = file.path.replace(/\.docx$/i, '');
  const base = path.split('/').at(-1)!;
  const images: PackageFile[] = [];

  const { value: html } = await mammoth.convertToHtml(
    { arrayBuffer: await file.blob!.arrayBuffer() },
    {
      styleMap: STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        const type = image.contentType;
        const extension = EXTENSION[type] ?? type.split('/').at(-1) ?? 'bin';
        const name = `${base}-${images.length + 1}.${extension}`;
        images.push({
          path: `${path}/${name}`,
          blob: new Blob([await image.readAsArrayBuffer()], { type }),
        });
        return { src: encodeURI(`${base}/${name}`) };
      }),
    },
  );

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.body.querySelector(`.${TITLE_CLASS}`);
  const name = title?.textContent?.trim() || base;
  title?.remove();
  // Footnote and bookmark links: their targets have no address on a page.
  doc.body.querySelectorAll('a[href^="#"]').forEach((link) => {
    if (link.textContent === '↑') link.remove();
    else link.replaceWith(...link.childNodes);
  });
  return [{ path: `${path}.md`, text: titled(name, htmlToPageMarkdown(doc.body)) }, ...images];
}
