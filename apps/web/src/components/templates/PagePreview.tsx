import { markdownToDoc, type JSONNode } from '@crewhall/editor';
import { cn } from '@crewhall/ui';
import { useMemo } from 'react';

/**
 * Gallery card preview of a page template (B4): the template's markdown is parsed like the
 * editor does, so directives (`:::info[RFC]`), headings and lists show as small formatted
 * lines instead of raw markers.
 */

type Line =
  | { kind: 'heading' | 'text' | 'item' | 'code'; text: string }
  | { kind: 'callout'; tone: Tone; title: string; text: string };

type Tone = 'info' | 'warning' | 'danger' | 'success' | 'note';

const MAX_LINES = 7;

const TONE: Record<string, Tone> = {
  info: 'info',
  important: 'info',
  warning: 'warning',
  caution: 'warning',
  danger: 'danger',
  tip: 'success',
  success: 'success',
};

const TONE_CLASS: Record<Tone, string> = {
  info: 'border-info',
  warning: 'border-warning',
  danger: 'border-danger',
  success: 'border-success',
  note: 'border-line2',
};

function textOf(n: JSONNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return ' ';
  if (n.type === 'mention') {
    const label = n.attrs?.label;
    return typeof label === 'string' ? `@${label}` : '';
  }
  return (n.content ?? []).map(textOf).join(n.type === 'tableRow' ? ' · ' : '');
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Flattens the first blocks of the document into preview lines. */
export function previewLines(markdown: string): Line[] {
  const lines: Line[] = [];
  const push = (l: Line) => {
    if (lines.length < MAX_LINES) lines.push(l);
  };
  const walk = (blocks: JSONNode[]) => {
    for (const b of blocks) {
      if (lines.length >= MAX_LINES) return;
      switch (b.type) {
        case 'heading': {
          const text = clean(textOf(b));
          if (text) push({ kind: 'heading', text });
          break;
        }
        case 'paragraph': {
          const text = clean(textOf(b));
          if (text) push({ kind: 'text', text });
          break;
        }
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
          for (const item of b.content ?? []) {
            // Template lists are often blank slots ("- ", "- [ ] "); those add nothing here.
            const text = clean(textOf(item)).replace(/^\[[ xX]?\]\s*/, '');
            if (text) push({ kind: 'item', text });
          }
          break;
        case 'admonition': {
          const type = typeof b.attrs?.type === 'string' ? b.attrs.type : 'note';
          const title = typeof b.attrs?.title === 'string' ? b.attrs.title : '';
          push({
            kind: 'callout',
            tone: TONE[type] ?? 'note',
            title,
            text: clean((b.content ?? []).map(textOf).join(' ')),
          });
          break;
        }
        case 'table': {
          // The header row says what the table is about.
          const head = b.content?.[0];
          if (head) push({ kind: 'text', text: clean(textOf(head)) });
          break;
        }
        case 'codeBlock':
        case 'mermaid': {
          const text = clean(textOf(b));
          if (text) push({ kind: 'code', text });
          break;
        }
        case 'blockquote':
        case 'toggle':
        case 'tabs':
        case 'tabItem':
          walk(b.content ?? []);
          break;
        default:
          break;
      }
    }
  };
  try {
    walk(markdownToDoc(markdown).doc.content ?? []);
  } catch {
    // A template the parser rejects still gets a plain preview.
    push({ kind: 'text', text: clean(markdown.replace(/[#*>|`_:[\]-]+/g, ' ')) });
  }
  return lines;
}

export function PagePreview({ markdown }: { markdown: string }) {
  const lines = useMemo(() => previewLines(markdown), [markdown]);
  return (
    <span className="flex flex-col gap-1 text-[11px] leading-[15px] text-fg3">
      {lines.map((l, i) =>
        l.kind === 'callout' ? (
          <span
            key={i}
            data-preview="callout"
            className={cn(
              'flex flex-col rounded-[3px] border-l-2 bg-bg2 px-1.5 py-0.5',
              TONE_CLASS[l.tone],
            )}
          >
            {l.title ? <span className="truncate font-semibold text-fg2">{l.title}</span> : null}
            {l.text ? <span className="truncate">{l.text}</span> : null}
          </span>
        ) : (
          <span
            key={i}
            data-preview={l.kind}
            className={cn(
              'truncate',
              l.kind === 'heading' && 'font-semibold text-fg2',
              l.kind === 'code' && 'font-mono',
            )}
          >
            {l.kind === 'item' ? `• ${l.text}` : l.text}
          </span>
        ),
      )}
    </span>
  );
}
