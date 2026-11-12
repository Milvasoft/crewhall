/**
 * The tables formula language: a small, safe expression language (no eval). Field references are
 * written `{Alan adı}`; operators + - * / & (text join), = != <> < <= > >=; functions below.
 * Dates are ISO strings. Any error makes the result null.
 */

export type FormulaValue = number | string | boolean | null | FormulaValue[];

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; name: string }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'neg'; e: Node }
  | { k: 'bin'; op: string; a: Node; b: Node };

export class FormulaError extends Error {}

type Tok = { t: 'num' | 'str' | 'ref' | 'id' | 'op' | '(' | ')' | ','; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new FormulaError('unterminated reference');
      out.push({ t: 'ref', v: src.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    if (/[A-Za-zÇĞİÖŞÜçğıöşü_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9ÇĞİÖŞÜçğıöşü_]/.test(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>'].includes(two)) {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }
    if ('+-*/&=<>'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c, v: c });
      i++;
      continue;
    }
    throw new FormulaError(`unexpected ${c}`);
  }
  return out;
}

const LEVELS: string[][] = [['=', '!=', '<', '<=', '>', '>='], ['&'], ['+', '-'], ['*', '/']];

/** Parses a formula; throws FormulaError on bad syntax. */
export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const expect = (t: Tok['t']) => {
    const tok = take();
    if (!tok || tok.t !== t) throw new FormulaError(`expected ${t}`);
    return tok;
  };
  const level = (n: number): Node => {
    if (n === LEVELS.length) return unary();
    let left = level(n + 1);
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== 'op' || !LEVELS[n]!.includes(tok.v)) return left;
      take();
      left = { k: 'bin', op: tok.v, a: left, b: level(n + 1) };
    }
  };
  const unary = (): Node => {
    const tok = peek();
    if (tok?.t === 'op' && tok.v === '-') {
      take();
      return { k: 'neg', e: unary() };
    }
    return primary();
  };
  const primary = (): Node => {
    const tok = take();
    if (!tok) throw new FormulaError('unexpected end');
    switch (tok.t) {
      case 'num': {
        const v = Number(tok.v);
        if (!Number.isFinite(v)) throw new FormulaError('bad number');
        return { k: 'num', v };
      }
      case 'str':
        return { k: 'str', v: tok.v };
      case 'ref':
        return { k: 'ref', name: tok.v };
      case '(': {
        const e = level(0);
        expect(')');
        return e;
      }
      case 'id': {
        const name = tok.v.toLocaleUpperCase('en');
        if (name === 'TRUE') return { k: 'bool', v: true };
        if (name === 'FALSE') return { k: 'bool', v: false };
        expect('(');
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(level(0));
            if (peek()?.t === ',') {
              take();
              continue;
            }
            break;
          }
        }
        expect(')');
        if (!(name in FUNCTIONS)) throw new FormulaError(`unknown function ${name}`);
        return { k: 'call', fn: name, args };
      }
      default:
        throw new FormulaError(`unexpected ${tok.v}`);
    }
  };
  const node = level(0);
  if (p < toks.length) throw new FormulaError('unexpected input');
  return node;
}

/** Field names a formula refers to (for dependency order and validation). */
export function formulaRefs(src: string): string[] {
  try {
    return tokenize(src)
      .filter((t) => t.t === 'ref')
      .map((t) => t.v);
  } catch {
    return [];
  }
}

const flat = (args: FormulaValue[]): FormulaValue[] =>
  args.flatMap((a) => (Array.isArray(a) ? flat(a) : [a]));
const num = (v: FormulaValue): number => {
  if (Array.isArray(v)) return num(v[0] ?? null);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  if (Number.isNaN(n)) throw new FormulaError('not a number');
  return n;
};
const str = (v: FormulaValue): string =>
  v === null
    ? ''
    : Array.isArray(v)
      ? v.map(str).join(', ')
      : typeof v === 'boolean'
        ? v
          ? 'TRUE'
          : 'FALSE'
        : String(v);
const truthy = (v: FormulaValue): boolean =>
  Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v !== '' : Boolean(v);
const date = (v: FormulaValue): Date => {
  const d = new Date(str(v));
  if (Number.isNaN(d.getTime())) throw new FormulaError('not a date');
  return d;
};
const DAY = 86_400_000;

const FUNCTIONS: Record<string, (a: FormulaValue[], now: Date) => FormulaValue> = {
  IF: (a) => (truthy(a[0] ?? null) ? (a[1] ?? null) : (a[2] ?? null)),
  AND: (a) => flat(a).every(truthy),
  OR: (a) => flat(a).some(truthy),
  NOT: (a) => !truthy(a[0] ?? null),
  SUM: (a) => flat(a).reduce<number>((s, v) => s + num(v), 0),
  AVG: (a) => {
    const v = flat(a).filter((x) => x !== null && x !== '');
    return v.length ? v.reduce<number>((s, x) => s + num(x), 0) / v.length : null;
  },
  MIN: (a) => {
    const v = flat(a)
      .filter((x) => x !== null && x !== '')
      .map(num);
    return v.length ? Math.min(...v) : null;
  },
  MAX: (a) => {
    const v = flat(a)
      .filter((x) => x !== null && x !== '')
      .map(num);
    return v.length ? Math.max(...v) : null;
  },
  ROUND: (a) => {
    const p = 10 ** Math.max(0, Math.min(8, num(a[1] ?? 0)));
    return Math.round(num(a[0] ?? null) * p) / p;
  },
  ABS: (a) => Math.abs(num(a[0] ?? null)),
  COUNT: (a) => flat(a).filter((x) => x !== null && x !== '').length,
  CONCAT: (a) => flat(a).map(str).join(''),
  LEN: (a) => str(a[0] ?? null).length,
  UPPER: (a) => str(a[0] ?? null).toLocaleUpperCase('tr'),
  LOWER: (a) => str(a[0] ?? null).toLocaleLowerCase('tr'),
  TRIM: (a) => str(a[0] ?? null).trim(),
  TODAY: (_, now) => now.toISOString().slice(0, 10),
  NOW: (_, now) => now.toISOString(),
  YEAR: (a) => date(a[0] ?? null).getUTCFullYear(),
  MONTH: (a) => date(a[0] ?? null).getUTCMonth() + 1,
  DAY: (a) => date(a[0] ?? null).getUTCDate(),
  /** DATEDIFF(end, start, "days"|"hours"|"months") */
  DATEDIFF: (a) => {
    const ms = date(a[0] ?? null).getTime() - date(a[1] ?? null).getTime();
    const unit = str(a[2] ?? 'days').toLowerCase();
    if (unit.startsWith('hour')) return Math.floor(ms / 3_600_000);
    if (unit.startsWith('month')) return Math.round(ms / (30.44 * DAY));
    return Math.floor(ms / DAY);
  },
  /** DATEADD(date, n, "days"|"months") */
  DATEADD: (a) => {
    const d = date(a[0] ?? null);
    const n = num(a[1] ?? 0);
    if (
      str(a[2] ?? 'days')
        .toLowerCase()
        .startsWith('month')
    )
      d.setUTCMonth(d.getUTCMonth() + n);
    else d.setTime(d.getTime() + n * DAY);
    return d.toISOString().slice(0, 10);
  },
};

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

function compare(op: string, a: FormulaValue, b: FormulaValue): boolean {
  const bothNum =
    (typeof a === 'number' || typeof b === 'number') &&
    !Number.isNaN(Number(a)) &&
    !Number.isNaN(Number(b));
  const x = bothNum ? Number(a) : str(a);
  const y = bothNum ? Number(b) : str(b);
  switch (op) {
    case '=':
      return x === y;
    case '!=':
      return x !== y;
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    default:
      return x >= y;
  }
}

/** Evaluates a parsed formula; `lookup` returns a field's value by name (case-insensitive). */
export function evaluateFormula(
  node: Node,
  lookup: (name: string) => FormulaValue,
  now = new Date(),
): FormulaValue {
  const ev = (n: Node): FormulaValue => {
    switch (n.k) {
      case 'num':
      case 'str':
      case 'bool':
        return n.v;
      case 'ref':
        return lookup(n.name);
      case 'neg':
        return -num(ev(n.e));
      case 'call':
        return FUNCTIONS[n.fn]!(n.args.map(ev), now);
      case 'bin': {
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '+':
            return num(a) + num(b);
          case '-':
            return num(a) - num(b);
          case '*':
            return num(a) * num(b);
          case '/': {
            const d = num(b);
            if (d === 0) throw new FormulaError('division by zero');
            return num(a) / d;
          }
          case '&':
            return str(a) + str(b);
          default:
            return compare(n.op, a, b);
        }
      }
    }
  };
  const out = ev(node);
  if (typeof out === 'number' && !Number.isFinite(out)) throw new FormulaError('not finite');
  return out;
}

export type ParsedFormula = ReturnType<typeof parseFormula>;
