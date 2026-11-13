import type { PMDoc, PMMark, PMNode } from '../doc';
import type { ExportFile } from './collect';
import { columnWidth, imageWidth, isImageAlign } from '@crewhall/editor';
import katex from 'katex';

/**
 * A page as one standalone HTML file (roadmap 6, design 5.17 "HTML · tek dosya"): styles
 * inline, images embedded as data URIs, raw HTML blocks shown as code (never run).
 */

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Only web, mail, phone and relative links survive; `javascript:` and the like do not. */
const safeHref = (href: string) =>
  /^(https?:|mailto:|tel:|#)/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : '#';

function marks(text: string, list: PMMark[] | undefined) {
  let out = esc(text);
  for (const m of list ?? []) {
    if (m.type === 'bold') out = `<strong>${out}</strong>`;
    else if (m.type === 'italic') out = `<em>${out}</em>`;
    else if (m.type === 'strike') out = `<s>${out}</s>`;
    else if (m.type === 'code') out = `<code>${out}</code>`;
    else if (m.type === 'link')
      out = `<a href="${esc(safeHref(String(m.attrs?.href ?? '#')))}">${out}</a>`;
  }
  return out;
}

/** An image's stored layout as CSS; both values are checked, so they are safe in the attribute. */
function imageCss(attrs: Record<string, unknown> | undefined): string {
  const width = imageWidth(attrs?.width);
  const align = isImageAlign(attrs?.align) ? attrs?.align : null;
  if (!width && !align) return '';
  const margin =
    align === 'center' ? 'margin-inline:auto;' : align === 'right' ? 'margin-left:auto;' : '';
  return `display:block;${width ? `width:${width}%;` : ''}${margin}`;
}

/** MathML: a standalone file has no KaTeX stylesheet, and browsers draw this on their own. */
const math = (latex: unknown, displayMode: boolean) =>
  katex.renderToString(String(latex ?? ''), {
    displayMode,
    output: 'mathml',
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  });

export class HtmlRenderer {
  constructor(private readonly files: Map<string, ExportFile>) {}

  private src(src: string) {
    const id = /^asset:(.+)$/.exec(src)?.[1];
    const file = id ? this.files.get(id) : undefined;
    if (file) return `data:${file.mime};base64,${file.data.toString('base64')}`;
    return safeHref(src);
  }

  inline(nodes: PMNode[] | undefined): string {
    return (nodes ?? [])
      .map((n) => {
        if (n.type === 'text') return marks(n.text ?? '', n.marks);
        if (n.type === 'hardBreak') return '<br>';
        if (n.type === 'image') {
          const alt = esc(String(n.attrs?.alt ?? ''));
          const title = n.attrs?.title ? ` title="${esc(String(n.attrs.title))}"` : '';
          const layout = imageCss(n.attrs);
          const style = layout ? ` style="${layout}"` : '';
          return `<img src="${esc(this.src(String(n.attrs?.src ?? '')))}" alt="${alt}"${title}${style}>`;
        }
        if (n.type === 'htmlInline') return `<code>${esc(String(n.attrs?.html ?? ''))}</code>`;
        if (n.type === 'mathInline') return math(n.attrs?.latex, false);
        return esc(n.text ?? '');
      })
      .join('');
  }

  block(n: PMNode): string {
    const kids = () => (n.content ?? []).map((c) => this.block(c)).join('');
    const a = n.attrs ?? {};
    switch (n.type) {
      case 'paragraph':
        return `<p>${this.inline(n.content) || '<br>'}</p>`;
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(a.level ?? 1)));
        return `<h${level}>${this.inline(n.content)}</h${level}>`;
      }
      case 'blockquote':
        return `<blockquote>${kids()}</blockquote>`;
      case 'bulletList':
        return `<ul>${kids()}</ul>`;
      case 'orderedList':
        return `<ol${Number(a.start ?? 1) !== 1 ? ` start="${Number(a.start)}"` : ''}>${kids()}</ol>`;
      case 'listItem':
        return `<li>${kids()}</li>`;
      case 'taskList':
        return `<ul class="tasks">${kids()}</ul>`;
      case 'taskItem':
        return `<li class="task"><input type="checkbox" disabled${a.checked ? ' checked' : ''}> <div>${kids()}</div></li>`;
      case 'codeBlock':
      case 'mermaid': {
        const lang = n.type === 'mermaid' ? 'mermaid' : String(a.language ?? '');
        const title = a.title ? `<div class="code-title">${esc(String(a.title))}</div>` : '';
        const code = (n.content ?? []).map((c) => c.text ?? '').join('');
        return `${title}<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code)}</code></pre>`;
      }
      case 'horizontalRule':
        return '<hr>';
      case 'table':
        return `<table>${kids()}</table>`;
      case 'tableRow':
        return `<tr>${kids()}</tr>`;
      case 'tableHeader':
      case 'tableCell': {
        const tag = n.type === 'tableHeader' ? 'th' : 'td';
        const span = `${Number(a.colspan ?? 1) > 1 ? ` colspan="${Number(a.colspan)}"` : ''}${Number(a.rowspan ?? 1) > 1 ? ` rowspan="${Number(a.rowspan)}"` : ''}`;
        const align = a.align ? ` style="text-align:${esc(String(a.align))}"` : '';
        return `<${tag}${span}${align}>${kids()}</${tag}>`;
      }
      case 'admonition': {
        const type = esc(String(a.type ?? 'note'));
        const title = a.title ? `<div class="admonition-title">${esc(String(a.title))}</div>` : '';
        return `<div class="admonition admonition-${type}">${title}${kids()}</div>`;
      }
      case 'toggle': {
        const summary = esc(String(a.summary ?? ''));
        const level = [1, 2, 3].includes(Number(a.level)) ? Number(a.level) : null;
        const head = level ? `<h${level} style="display:inline">${summary}</h${level}>` : summary;
        return `<details open><summary>${head}</summary>${kids()}</details>`;
      }
      case 'mathBlock':
        return `<div class="math">${math(a.latex, true)}</div>`;
      case 'columns':
        return `<div class="columns">${kids()}</div>`;
      case 'column': {
        // A resized column keeps its share of the set (a number, so nothing to escape).
        const width = columnWidth(a.width);
        const style = width ? ` style="flex-grow:${width}"` : '';
        return `<div class="column"${style}>${kids()}</div>`;
      }
      case 'tabs':
        return `<div class="tabs">${kids()}</div>`;
      case 'tabItem':
        return `<section class="tab"><div class="tab-label">${esc(String(a.label ?? a.value ?? ''))}</div>${kids()}</section>`;
      case 'htmlBlock':
        return `<pre><code>${esc(String(a.html ?? ''))}</code></pre>`;
      case 'truncate':
        return '';
      default:
        return n.content ? kids() : '';
    }
  }

  body(doc: PMDoc) {
    return doc.content.map((n) => this.block(n)).join('\n');
  }
}

const STYLE = `body{font-family:Nunito,system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.65;color:#141516}
h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}h1.page-title{margin-top:0}
img{max-width:100%;height:auto;border-radius:6px}
a{color:#b97a00}
pre{background:#f4f4f2;padding:12px 14px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
p code,li code{background:#f4f4f2;padding:.1em .3em;border-radius:4px}
.code-title{font-size:.85em;color:#5b5f63;margin-bottom:-6px}
table{border-collapse:collapse;width:100%;margin:1em 0}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f4f4f2}
blockquote{border-left:3px solid #ccc;margin:1em 0;padding-left:1em;color:#555}
.admonition{background:#f4f4f2;padding:12px 14px;border-radius:10px;border-left:4px solid #FBC419;margin:1em 0}.admonition-title{font-weight:700;margin-bottom:4px}
.admonition-warning,.admonition-caution{border-left-color:#F38424}.admonition-danger{border-left-color:#e5484d}.admonition-tip,.admonition-success{border-left-color:#30a46c}.admonition-info{border-left-color:#2F80ED}
ul.tasks{list-style:none;padding-left:0}li.task{display:flex;gap:.5em;align-items:flex-start}li.task>input{margin-top:.45em}
.columns{display:flex;gap:24px;margin:1em 0}.column{flex:1;min-width:0}
details{margin:1em 0}summary{font-weight:700;cursor:pointer}
.tab{border:1px solid #e3e3e0;border-radius:8px;padding:8px 14px;margin:.5em 0}.tab-label{font-weight:700;color:#5b5f63}
.page-icon{font-size:40px;line-height:1}`;

export function htmlDocument(opts: {
  title: string;
  icon: string | null;
  body: string;
  lang: string;
}) {
  return `<!doctype html>
<html lang="${esc(opts.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>${STYLE}</style></head>
<body>
${opts.icon ? `<div class="page-icon">${esc(opts.icon)}</div>\n` : ''}<h1 class="page-title">${esc(opts.title)}</h1>
${opts.body}
</body></html>
`;
}
