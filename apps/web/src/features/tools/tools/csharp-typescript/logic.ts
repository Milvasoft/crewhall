// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-typescript/logic.ts. See THIRD_PARTY.md.
import { parseClasses } from '@/features/tools/tools/csharp-to-json/logic';

/**
 * C# ↔ TypeScript model conversion (loose). Reuses the shared loose C# parser
 * (`parseClasses`) for the C#→TS direction and a small interface parser for the
 * reverse. Like C#→JSON, this favors convenience over compiler fidelity.
 */

// --- C# → TypeScript --------------------------------------------------------

const CS_STRING = new Set([
  'string',
  'char',
  'guid',
  'datetime',
  'datetimeoffset',
  'dateonly',
  'timeonly',
  'timespan',
  'uri',
]);
const CS_NUMBER = new Set([
  'int',
  'long',
  'short',
  'byte',
  'sbyte',
  'uint',
  'ulong',
  'ushort',
  'decimal',
  'double',
  'float',
  'single',
  'int16',
  'int32',
  'int64',
]);
const CS_COLLECTIONS = [
  'list',
  'ilist',
  'ienumerable',
  'icollection',
  'ireadonlylist',
  'ireadonlycollection',
  'hashset',
  'collection',
  'observablecollection',
];

function csTypeToTs(raw: string): string {
  let t = raw.trim();
  let nullable = false;
  if (t.endsWith('?')) {
    nullable = true;
    t = t.slice(0, -1).trim();
  }
  const nul = (s: string) => (nullable ? `${s} | null` : s);

  if (t.endsWith('[]')) return nul(`${csTypeToTs(t.slice(0, -2))}[]`);

  const gen = t.match(/^([A-Za-z_][\w.]*)\s*<(.+)>$/);
  if (gen) {
    const outer = gen[1]!.toLowerCase().replace(/^.*\./, '');
    const inner = gen[2]!;
    if (CS_COLLECTIONS.includes(outer)) return nul(`${csTypeToTs(inner.split(',')[0]!)}[]`);
    if (outer === 'dictionary' || outer === 'idictionary' || outer === 'ireadonlydictionary') {
      const [k, v] = inner.split(',');
      return nul(`Record<${csTypeToTs(k!)}, ${csTypeToTs(v ?? '')}>`);
    }
    if (outer === 'task' || outer === 'valuetask') return csTypeToTs(inner);
  }

  const key = t.replace(/^.*\./, '').toLowerCase();
  if (CS_STRING.has(key)) return nul('string');
  if (key === 'bool' || key === 'boolean') return nul('boolean');
  if (CS_NUMBER.has(key)) return nul('number');
  if (key === 'object' || key === 'dynamic') return nul('unknown');
  return nul(t.replace(/^.*\./, ''));
}

export function csharpToTypeScript(code: string): string {
  const classes = parseClasses(code);
  if (classes.length === 0) throw new Error('No C# class, record or struct found.');
  return classes
    .map((c) => {
      const fields = c.props.map((p) => `  ${p.name}: ${csTypeToTs(p.type)};`).join('\n');
      return `export interface ${c.name} {\n${fields}\n}`;
    })
    .join('\n\n');
}

// --- TypeScript → C# --------------------------------------------------------

function toPascal(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function tsTypeToCs(raw: string): string {
  let t = raw.trim();
  // Strip a "| null"/"| undefined" union → nullable.
  let nullable = false;
  t = t
    .split('|')
    .map((s) => s.trim())
    .filter((s) => {
      if (s === 'null' || s === 'undefined') {
        nullable = true;
        return false;
      }
      return true;
    })
    .join(' | ');
  const nul = (s: string) => (nullable ? `${s}?` : s);

  if (t.endsWith('[]')) return nul(`List<${tsTypeToCs(t.slice(0, -2))}>`);
  const arr = t.match(/^Array<(.+)>$/);
  if (arr) return nul(`List<${tsTypeToCs(arr[1]!)}>`);
  const rec = t.match(/^Record<(.+),(.+)>$/);
  if (rec) return nul(`Dictionary<${tsTypeToCs(rec[1]!)}, ${tsTypeToCs(rec[2]!)}>`);

  switch (t.toLowerCase()) {
    case 'string':
      return nul('string');
    case 'number':
      return nul('double');
    case 'boolean':
      return nul('bool');
    case 'any':
    case 'unknown':
      return nul('object');
    case 'date':
      return nul('DateTime');
    default:
      return nul(t);
  }
}

interface TsField {
  name: string;
  type: string;
}

function splitFields(body: string): string[] {
  // Split on ; or newlines at top level (no nested <> or {}).
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '<' || ch === '{' || ch === '(') depth++;
    else if (ch === '>' || ch === '}' || ch === ')') depth--;
    if ((ch === ';' || ch === '\n') && depth <= 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function typeScriptToCsharp(code: string): string {
  const clean = code.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re =
    /(?:export\s+)?(?:interface|type)\s+([A-Za-z_]\w*)\s*(?:=|extends[^{]*)?\{([\s\S]*?)\}/g;
  const classes: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(clean))) {
    const name = m[1]!;
    const fields: TsField[] = [];
    for (const raw of splitFields(m[2]!)) {
      const fm = raw.match(/^["']?([A-Za-z_$][\w$]*)["']?\s*(\?)?\s*:\s*(.+)$/);
      if (!fm) continue;
      const optional = !!fm[2];
      const type = optional ? `${fm[3]!} | null` : fm[3]!;
      fields.push({ name: fm[1]!, type });
    }
    if (fields.length === 0) continue;
    const lines = fields.map((f) => {
      const pascal = toPascal(f.name);
      const attr = pascal !== f.name ? `    [JsonPropertyName("${f.name}")]\n` : '';
      return `${attr}    public ${tsTypeToCs(f.type)} ${pascal} { get; set; }`;
    });
    classes.push(`public class ${name}\n{\n${lines.join('\n')}\n}`);
  }

  if (classes.length === 0) throw new Error('No TypeScript interface or type found.');
  return classes.join('\n\n');
}
