// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/escape/logic.ts. See THIRD_PARTY.md.
export type EscapeTarget = 'csharp' | 'json' | 'regex' | 'url' | 'html';

export const ESCAPE_TARGETS: { id: EscapeTarget; label: string }[] = [
  { id: 'csharp', label: 'C# string' },
  { id: 'json', label: 'JSON string' },
  { id: 'regex', label: 'Regex' },
  { id: 'url', label: 'URL' },
  { id: 'html', label: 'HTML' },
];

// --- C# string literal ------------------------------------------------------

function escapeCSharp(s: string): string {
  return s.replace(/[\\"\n\r\t\f\v\0]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\f':
        return '\\f';
      case '\v':
        return '\\v';
      case '\0':
        return '\\0';
      default:
        return c;
    }
  });
}

function unescapeCSharp(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,4}|.)/g, (_, seq: string) => {
    if (seq[0] === 'u' || seq[0] === 'x') {
      return String.fromCodePoint(parseInt(seq.slice(1), 16));
    }
    const map: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      f: '\f',
      v: '\v',
      '0': '\0',
      '\\': '\\',
      '"': '"',
      "'": "'",
    };
    return map[seq] ?? seq;
  });
}

// --- JSON string ------------------------------------------------------------

function escapeJson(s: string): string {
  const json = JSON.stringify(s);
  return json.slice(1, -1); // drop surrounding quotes
}

function unescapeJson(s: string): string {
  return JSON.parse(`"${s.replace(/\r?\n/g, '\\n')}"`) as string;
}

// --- Regex ------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unescapeRegex(s: string): string {
  return s.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}

// --- HTML -------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function escapeText(s: string, target: EscapeTarget): string {
  switch (target) {
    case 'csharp':
      return escapeCSharp(s);
    case 'json':
      return escapeJson(s);
    case 'regex':
      return escapeRegex(s);
    case 'url':
      return encodeURIComponent(s);
    case 'html':
      return escapeHtml(s);
  }
}

export function unescapeText(s: string, target: EscapeTarget): string {
  switch (target) {
    case 'csharp':
      return unescapeCSharp(s);
    case 'json':
      return unescapeJson(s);
    case 'regex':
      return unescapeRegex(s);
    case 'url':
      return decodeURIComponent(s);
    case 'html':
      return unescapeHtml(s);
  }
}
