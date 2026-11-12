// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/math-evaluator/logic.ts. See THIRD_PARTY.md.
/**
 * A small, safe arithmetic expression evaluator (recursive descent — no `eval`).
 * Supports + - * / % ^, parentheses, unary minus, common functions and
 * constants. Pure and local.
 *
 * Precedence (low → high): + −  ·  * / %  ·  unary ±  ·  ^ (right-assoc).
 */

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'punct'; v: string };

/** Missing arguments read as NaN, as Math does with `undefined`. */
const arg = (a: number[], i: number): number => a[i] ?? NaN;

const FUNCTIONS: Record<string, (a: number[]) => number> = {
  sqrt: (a) => Math.sqrt(arg(a, 0)),
  cbrt: (a) => Math.cbrt(arg(a, 0)),
  abs: (a) => Math.abs(arg(a, 0)),
  round: (a) => Math.round(arg(a, 0)),
  floor: (a) => Math.floor(arg(a, 0)),
  ceil: (a) => Math.ceil(arg(a, 0)),
  sign: (a) => Math.sign(arg(a, 0)),
  exp: (a) => Math.exp(arg(a, 0)),
  ln: (a) => Math.log(arg(a, 0)),
  log: (a) => (a.length > 1 ? Math.log(arg(a, 0)) / Math.log(arg(a, 1)) : Math.log10(arg(a, 0))),
  log2: (a) => Math.log2(arg(a, 0)),
  sin: (a) => Math.sin(arg(a, 0)),
  cos: (a) => Math.cos(arg(a, 0)),
  tan: (a) => Math.tan(arg(a, 0)),
  asin: (a) => Math.asin(arg(a, 0)),
  acos: (a) => Math.acos(arg(a, 0)),
  atan: (a) => Math.atan(arg(a, 0)),
  atan2: (a) => Math.atan2(arg(a, 0), arg(a, 1)),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  pow: (a) => Math.pow(arg(a, 0), arg(a, 1)),
  hypot: (a) => Math.hypot(...a),
  root: (a) => Math.pow(arg(a, 0), 1 / arg(a, 1)),
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
};

function tokenize(input: string): Tok[] {
  const s = input;
  const tokens: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let num = '';
      while (i < s.length && /[0-9.]/.test(s[i]!)) num += s[i++]!;
      if ((s[i] === 'e' || s[i] === 'E') && /[0-9+-]/.test(s[i + 1] ?? '')) {
        num += s[i++]!;
        if (s[i] === '+' || s[i] === '-') num += s[i++]!;
        while (i < s.length && /[0-9]/.test(s[i]!)) num += s[i++]!;
      }
      const value = Number(num);
      if (!Number.isFinite(value)) throw new Error(`Invalid number "${num}".`);
      tokens.push({ t: 'num', v: value });
    } else if (/[a-zA-Z_]/.test(c)) {
      let id = '';
      while (i < s.length && /[a-zA-Z0-9_]/.test(s[i]!)) id += s[i++]!;
      tokens.push({ t: 'id', v: id.toLowerCase() });
    } else if ('+-*/%^(),'.includes(c)) {
      tokens.push({ t: 'punct', v: c });
      i++;
    } else {
      throw new Error(`Unexpected character "${c}".`);
    }
  }
  return tokens;
}

export function evaluateExpression(input: string): number {
  if (!input.trim()) throw new Error('Enter an expression.');
  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (v?: string): Tok => {
    const tok = tokens[pos];
    if (!tok) throw new Error('Unexpected end of expression.');
    if (v && !(tok.t === 'punct' && tok.v === v)) {
      throw new Error(`Expected "${v}".`);
    }
    pos++;
    return tok;
  };
  const isPunct = (v: string) => {
    const tok = peek();
    return tok && tok.t === 'punct' && tok.v === v;
  };

  function parseExpr(): number {
    let value = parseTerm();
    while (isPunct('+') || isPunct('-')) {
      const op = eat().v;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseUnary();
    while (isPunct('*') || isPunct('/') || isPunct('%')) {
      const op = eat().v;
      const rhs = parseUnary();
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  }

  function parseUnary(): number {
    if (isPunct('+')) {
      eat();
      return parseUnary();
    }
    if (isPunct('-')) {
      eat();
      return -parseUnary();
    }
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    if (isPunct('^')) {
      eat();
      return Math.pow(base, parseUnary()); // right-associative
    }
    return base;
  }

  function parsePrimary(): number {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression.');

    if (tok.t === 'num') {
      eat();
      return tok.v;
    }
    if (isPunct('(')) {
      eat('(');
      const value = parseExpr();
      eat(')');
      return value;
    }
    if (tok.t === 'id') {
      eat();
      if (isPunct('(')) {
        eat('(');
        const args: number[] = [];
        if (!isPunct(')')) {
          args.push(parseExpr());
          while (isPunct(',')) {
            eat(',');
            args.push(parseExpr());
          }
        }
        eat(')');
        const fn = FUNCTIONS[tok.v];
        if (!fn) throw new Error(`Unknown function "${tok.v}".`);
        return fn(args);
      }
      if (tok.v in CONSTANTS) return CONSTANTS[tok.v]!;
      throw new Error(`Unknown name "${tok.v}".`);
    }
    throw new Error(`Unexpected token "${tok.v}".`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new Error('Unexpected trailing input.');
  return result;
}
