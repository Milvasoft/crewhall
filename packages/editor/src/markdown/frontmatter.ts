import { parse, stringify } from 'yaml';

export interface SplitMarkdown {
  frontMatter: Record<string, unknown>;
  body: string;
  /** YAML that failed to parse; the block is then kept out of the body and reported. */
  error: string | null;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits Docusaurus front matter (`---` YAML block at the very top) from the body. */
export function splitFrontMatter(markdown: string): SplitMarkdown {
  const text = markdown.replace(/^\uFEFF/, '');
  const match = FENCE.exec(text);
  if (!match) return { frontMatter: {}, body: text, error: null };
  const body = text.slice(match[0].length);
  try {
    const data: unknown = parse(match[1] ?? '');
    const frontMatter =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return { frontMatter, body, error: null };
  } catch (err) {
    return { frontMatter: {}, body, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `---\n<yaml>---\n\n<body>`; empty front matter writes the body only. */
export function joinFrontMatter(frontMatter: Record<string, unknown>, body: string): string {
  const entries = Object.entries(frontMatter).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return body;
  const yaml = stringify(Object.fromEntries(entries), { lineWidth: 0 });
  return `---\n${yaml}---\n\n${body}`;
}
