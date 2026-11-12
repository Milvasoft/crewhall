import type { SiteStrings } from '@/i18n';
import { CopyButton } from '@/render/client/CopyButton';
import { highlight } from '@/render/prism';

/** Parsed fence meta: `{1,3-5}` line ranges and `showLineNumbers[=n]`. */
export function parseMeta(meta: string | null | undefined): {
  lines: Set<number>;
  lineNumbersStart: number | null;
} {
  const lines = new Set<number>();
  let lineNumbersStart: number | null = null;
  if (!meta) return { lines, lineNumbersStart };
  const range = /\{([\d,\s-]+)\}/.exec(meta);
  if (range?.[1]) {
    for (const part of range[1].split(',')) {
      const [a, b] = part
        .trim()
        .split('-')
        .map((n) => Number(n));
      if (a === undefined || !Number.isInteger(a) || a < 1) continue;
      const end = b !== undefined && Number.isInteger(b) && b >= a ? Math.min(b, a + 10_000) : a;
      for (let i = a; i <= end; i++) lines.add(i - 1);
    }
  }
  const numbers = /\bshowLineNumbers(?:=(\d+))?/.exec(meta);
  if (numbers) lineNumbersStart = numbers[1] ? Number(numbers[1]) : 1;
  return { lines, lineNumbersStart };
}

const MAGIC = /^\s*(?:\/\/|#|<!--|\/\*|--)\s*highlight-(next-line|start|end)\s*(?:-->|\*\/)?\s*$/;

/** Removes Docusaurus magic comments and returns the highlighted line indexes they mark. */
export function applyMagicComments(code: string): { code: string; lines: Set<number> } {
  const out: string[] = [];
  const lines = new Set<number>();
  let next = false;
  let block = false;
  for (const line of code.split('\n')) {
    const m = MAGIC.exec(line);
    if (m) {
      if (m[1] === 'next-line') next = true;
      else block = m[1] === 'start';
      continue;
    }
    if (next || block) lines.add(out.length);
    next = false;
    out.push(line);
  }
  return { code: out.join('\n'), lines };
}

interface Props {
  code: string;
  language: string | null;
  title: string | null;
  meta: string | null;
  strings: SiteStrings;
}

/** Docusaurus code block: language class, title bar, line highlight and numbers, copy button. */
export function CodeBlock({ code: raw, language, title, meta, strings }: Props) {
  const source = raw.replace(/\n$/, '');
  const magic = applyMagicComments(source);
  const parsed = parseMeta(meta);
  const highlighted = new Set([...parsed.lines, ...magic.lines]);
  const numbered = parsed.lineNumbersStart !== null;
  const langClass = `language-${(language ?? 'text').replace(/[^\w-]/g, '')}`;
  const tokens = highlight(magic.code, language);

  return (
    <div className={`${langClass} codeBlockContainer_Ckt0 theme-code-block`}>
      {title && <div className="codeBlockTitle_OeMC">{title}</div>}
      <div className="codeBlockContent_QJqH">
        <pre tabIndex={0} className={`prism-code ${langClass} codeBlock_bY9V thin-scrollbar`}>
          <code
            className={`codeBlockLines_e6Vv${numbered ? ' codeBlockLinesWithNumbering_o6Pm' : ''}`}
            style={
              numbered && parsed.lineNumbersStart !== 1
                ? { counterReset: `line-count ${(parsed.lineNumbersStart ?? 1) - 1}` }
                : undefined
            }
          >
            {tokens.map((line, i) => {
              const parts = line.map((token, j) => (
                <span
                  key={j}
                  className={`token ${token.types.join(' ')}`}
                  style={token.empty ? { display: 'inline-block' } : undefined}
                >
                  {token.empty ? '' : token.content}
                </span>
              ));
              const cls = [
                'token-line',
                numbered ? 'codeLine_lJS_' : null,
                highlighted.has(i) ? 'theme-code-block-highlighted-line' : null,
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <span key={i} className={cls}>
                  {numbered ? (
                    <>
                      <span className="codeLineNumber_Tfdd" />
                      <span className="codeLineContent_feaV">{parts}</span>
                    </>
                  ) : (
                    parts
                  )}
                  <br />
                </span>
              );
            })}
          </code>
        </pre>
        <CopyButton
          code={magic.code}
          labels={{
            copy: strings.copyCode,
            copied: strings.copiedCode,
            aria: strings.copyCodeAria,
          }}
        />
      </div>
    </div>
  );
}
