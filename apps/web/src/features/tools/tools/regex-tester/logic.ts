// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/regex-tester/logic.ts. See THIRD_PARTY.md.
/**
 * Regex evaluation. This uses the JavaScript engine (RegExp), semantics differ
 * from .NET/PCRE, so the UI must label the engine and never imply parity.
 */

export interface RegexMatch {
  index: number;
  match: string;
  groups: string[];
  namedGroups: Record<string, string>;
}

export interface RegexResult {
  matches: RegexMatch[];
  error: string | null;
  replacement?: string;
}

const MAX_MATCHES = 10000; // guardrail against runaway global matches

export type RegexEngine = 'js' | 'dotnet';

/**
 * Best-effort translation of a few .NET-only constructs to their JavaScript
 * equivalents. This does NOT make the JS engine behave like .NET, it only
 * lets common .NET patterns run. The UI clearly labels ".NET (approximated)".
 */
export function translateDotNet(pattern: string): string {
  return pattern
    .replace(/\(\?'([^']+)'/g, '(?<$1>') // (?'name'…) → (?<name>…)
    .replace(/\\A/g, '^') // start of string
    .replace(/\\[Zz]/g, '$'); // end of string
}

export function runRegex(
  pattern: string,
  flags: string,
  input: string,
  replacement?: string,
  engine: RegexEngine = 'js',
): RegexResult {
  if (!pattern) return { matches: [], error: null };

  const effective = engine === 'dotnet' ? translateDotNet(pattern) : pattern;

  let re: RegExp;
  try {
    re = new RegExp(effective, flags);
  } catch (e) {
    return { matches: [], error: e instanceof Error ? e.message : 'Invalid regex' };
  }

  const matches: RegexMatch[] = [];
  const global = flags.includes('g');

  try {
    if (global) {
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(input)) !== null) {
        matches.push(toMatch(m));
        if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-length loop
        if (++guard > MAX_MATCHES) break;
      }
    } else {
      const m = re.exec(input);
      if (m) matches.push(toMatch(m));
    }
  } catch (e) {
    return { matches, error: e instanceof Error ? e.message : 'Match failed' };
  }

  const result: RegexResult = { matches, error: null };
  if (replacement !== undefined) {
    try {
      result.replacement = input.replace(re, replacement);
    } catch {
      // ignore replace-only errors; matches are still useful
    }
  }
  return result;
}

function toMatch(m: RegExpExecArray): RegexMatch {
  return {
    index: m.index,
    match: m[0],
    groups: m.slice(1).map((g) => g ?? ''),
    namedGroups: { ...(m.groups ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Explanation, a best-effort token-by-token breakdown of the pattern.
// ---------------------------------------------------------------------------

export interface RegexToken {
  token: string;
  description: string;
}

const ESCAPES: Record<string, string> = {
  d: 'Any digit (0–9)',
  D: 'Any non-digit',
  w: 'Any word character (a–z, A–Z, 0–9, _)',
  W: 'Any non-word character',
  s: 'Any whitespace',
  S: 'Any non-whitespace',
  b: 'Word boundary',
  B: 'Non-word boundary',
  n: 'Newline',
  r: 'Carriage return',
  t: 'Tab',
  f: 'Form feed',
  v: 'Vertical tab',
  '0': 'Null character',
  A: 'Start of string',
  Z: 'End of string',
  z: 'End of string',
};

function classifyGroup(rest: string): { desc: string; advance: number } {
  if (rest.startsWith('(?:')) return { desc: 'Non-capturing group', advance: 3 };
  if (rest.startsWith('(?=')) return { desc: 'Positive lookahead', advance: 3 };
  if (rest.startsWith('(?!')) return { desc: 'Negative lookahead', advance: 3 };
  if (rest.startsWith('(?<=')) return { desc: 'Positive lookbehind', advance: 4 };
  if (rest.startsWith('(?<!')) return { desc: 'Negative lookbehind', advance: 4 };
  const named = rest.match(/^\(\?<([A-Za-z_]\w*)>/);
  if (named) {
    return { desc: `Named capturing group “${named[1]}”`, advance: named[0].length };
  }
  return { desc: 'Capturing group', advance: 1 };
}

/** Break a pattern into a readable list of tokens and descriptions. */
export function explainRegex(pattern: string): RegexToken[] {
  const out: RegexToken[] = [];
  let literal = '';
  const flush = () => {
    if (literal) {
      out.push({ token: literal, description: `Literal text “${literal}”` });
      literal = '';
    }
  };

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '\\') {
      flush();
      const next = pattern[i + 1] ?? '';
      if (next === 'u' && /^[0-9a-fA-F]{4}/.test(pattern.slice(i + 2))) {
        const hex = pattern.slice(i + 2, i + 6);
        out.push({ token: `\\u${hex}`, description: `Unicode code point U+${hex}` });
        i += 6;
      } else if (next === 'x' && /^[0-9a-fA-F]{2}/.test(pattern.slice(i + 2))) {
        const hex = pattern.slice(i + 2, i + 4);
        out.push({ token: `\\x${hex}`, description: `Character 0x${hex}` });
        i += 4;
      } else if (/[1-9]/.test(next)) {
        out.push({ token: `\\${next}`, description: `Back-reference to group ${next}` });
        i += 2;
      } else {
        out.push({
          token: `\\${next}`,
          description: ESCAPES[next] ?? `Literal “${next}”`,
        });
        i += 2;
      }
      continue;
    }

    if (c === '[') {
      flush();
      let j = i + 1;
      const negate = pattern[j] === '^';
      if (negate) j++;
      let body = '';
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') {
          body += pattern.slice(j, j + 2);
          j += 2;
        } else {
          body += pattern[j];
          j++;
        }
      }
      out.push({
        token: pattern.slice(i, j + 1),
        description: `${negate ? 'Any character NOT' : 'Any single character'} in the set: ${body}`,
      });
      i = j + 1;
      continue;
    }

    if (c === '(') {
      flush();
      const { desc, advance } = classifyGroup(pattern.slice(i));
      out.push({ token: pattern.slice(i, i + advance), description: `${desc}, start` });
      i += advance;
      continue;
    }

    if (c === ')') {
      flush();
      out.push({ token: ')', description: 'End of group' });
      i++;
      continue;
    }

    if (c === '|') {
      flush();
      out.push({ token: '|', description: 'Alternation (OR)' });
      i++;
      continue;
    }

    if (c === '^') {
      flush();
      out.push({ token: '^', description: 'Start of line/string' });
      i++;
      continue;
    }
    if (c === '$') {
      flush();
      out.push({ token: '$', description: 'End of line/string' });
      i++;
      continue;
    }
    if (c === '.') {
      flush();
      out.push({ token: '.', description: 'Any character (except newline)' });
      i++;
      continue;
    }

    if (c === '*' || c === '+' || c === '?') {
      flush();
      const base =
        c === '*' ? 'Zero or more' : c === '+' ? 'One or more' : 'Optional (zero or one)';
      const lazy = pattern[i + 1] === '?';
      out.push({
        token: lazy ? c + '?' : c,
        description: `${base}${lazy ? ' (lazy)' : ' (greedy)'} of the preceding`,
      });
      i += lazy ? 2 : 1;
      continue;
    }

    if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end !== -1) {
        flush();
        const inner = pattern.slice(i + 1, end);
        const m = inner.match(/^(\d+)(,(\d*)?)?$/);
        let desc = `Repeat {${inner}} times`;
        if (m) {
          if (!m[2]) desc = `Exactly ${m[1]} times`;
          else if (m[3] === '' || m[3] === undefined) desc = `${m[1]} or more times`;
          else desc = `Between ${m[1]} and ${m[3]} times`;
        }
        out.push({ token: pattern.slice(i, end + 1), description: desc });
        i = end + 1;
        continue;
      }
    }

    literal += c;
    i++;
  }
  flush();
  return out;
}
