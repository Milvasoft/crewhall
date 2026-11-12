// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-parameterizer/logic.ts. See THIRD_PARTY.md.
/**
 * Replace inline string/number literals in a SQL query with placeholders and
 * return the extracted values. Single-pass tokenizer so digits inside strings
 * or identifiers aren't mistaken for numeric literals.
 */

export type ParamStyle = 'at' | 'colon' | 'question' | 'dollar';

export interface ParameterizeResult {
  query: string;
  params: { name: string; value: string | number }[];
}

function placeholder(style: ParamStyle, n: number): string {
  switch (style) {
    case 'at':
      return `@p${n}`;
    case 'colon':
      return `:p${n}`;
    case 'question':
      return '?';
    case 'dollar':
      return `$${n}`;
  }
}

export function parameterize(sql: string, style: ParamStyle): ParameterizeResult {
  let out = '';
  const params: { name: string; value: string | number }[] = [];
  let i = 0;
  let n = 0;

  const add = (value: string | number) => {
    n++;
    const name = placeholder(style, n);
    params.push({ name: style === 'question' ? `p${n}` : name.replace(/^[@:$]/, ''), value });
    out += name;
  };

  while (i < sql.length) {
    const c = sql[i]!;

    // String literal
    if (c === "'") {
      let j = i + 1;
      let val = '';
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          val += "'";
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        val += sql[j];
        j++;
      }
      add(val);
      i = j;
      continue;
    }

    // Numeric literal (not part of an identifier)
    if (/[0-9]/.test(c)) {
      const prev = sql[i - 1] ?? '';
      if (!/[\w$.]/.test(prev)) {
        let j = i;
        let num = '';
        while (j < sql.length && /[0-9.]/.test(sql[j]!)) {
          num += sql[j];
          j++;
        }
        // Only treat as literal if it's a clean number.
        if (/^\d+(\.\d+)?$/.test(num) && !/[\w$]/.test(sql[j] ?? '')) {
          add(num.includes('.') ? Number(num) : Number(num));
          i = j;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  return { query: out, params };
}
