// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-to-json/logic.ts. See THIRD_PARTY.md.
/**
 * Loose-mode C# -> JSON.
 *
 * The goal is convenience over compiler-level strictness: extract enough model
 * shape from pasted C# to produce sample JSON, tolerating namespaces, usings,
 * attributes, comments and partial/non-compiling code. This is a small tokenizer
 * + brace matcher, NOT one giant regex, so it stays debuggable and extensible
 * (a future "Roslyn mode" can slot in as an alternative front end).
 */

export interface CsharpToJsonOptions {
  camelCase?: boolean;
  /** Put one sample element inside arrays of known/primitive types. */
  sampleArrayItems?: boolean;
  /**
   * Fill scalars with representative example values (e.g. "string", 123, true)
   * instead of empty defaults ("", 0, false). Also implies sampleArrayItems.
   */
  sampleValues?: boolean;
}

interface PropInfo {
  name: string;
  type: string;
}
interface ClassInfo {
  name: string;
  props: PropInfo[];
}

// --- cleaning ---------------------------------------------------------------

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function stripNoise(code: string): string {
  return (
    stripComments(code)
      .replace(/^\s*#.*$/gm, ' ') // preprocessor directives
      // Attributes (single-line). Require content so empty `[]` array markers and
      // `[,]` rank specifiers on array types are preserved.
      .replace(/\[[A-Za-z_][^\]\n]*\]/g, ' ')
  );
}

// --- extraction -------------------------------------------------------------

const TYPE_DECL = /\b(?:class|record\s+struct|record|struct|interface)\s+([A-Za-z_]\w*)/g;

function findMatchingBrace(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PROP_RE =
  /(?:public|internal|protected|private)\s+(?:(?:virtual|override|static|readonly|required|new|abstract|sealed)\s+)*([A-Za-z_][\w<>[\],.?\s]*?)\s+([A-Za-z_]\w*)\s*(?:\{\s*(?:get|set|init)\b[\s\S]*?\}|=>[^;]+;|=[^;]+;|;)/g;

function parseProps(body: string): PropInfo[] {
  const props: PropInfo[] = [];
  let m: RegExpExecArray | null;
  PROP_RE.lastIndex = 0;
  while ((m = PROP_RE.exec(body))) {
    const type = m[1]!.replace(/\s+/g, ' ').trim();
    const name = m[2]!;
    if (!type || type === 'return' || type === 'class') continue;
    props.push({ name, type });
  }
  return props;
}

// Positional record: record User(string Name, int Age);
function parseRecordParams(params: string): PropInfo[] {
  const props: PropInfo[] = [];
  // Split on commas that are not inside <...> generics.
  let depth = 0;
  let current = '';
  const parts: string[] = [];
  for (const ch of params) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current);

  for (const part of parts) {
    const t = part.trim().replace(/\[[^\]]*\]/g, '');
    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      props.push({ type: tokens[tokens.length - 2]!, name: tokens[tokens.length - 1]! });
    }
  }
  return props;
}

export function parseClasses(code: string): ClassInfo[] {
  const clean = stripNoise(code);
  const classes: ClassInfo[] = [];
  let m: RegExpExecArray | null;
  TYPE_DECL.lastIndex = 0;

  while ((m = TYPE_DECL.exec(clean))) {
    const name = m[1]!;
    const afterName = m.index + m[0].length;

    // Positional record parameters, if present before the body/semicolon.
    const rest = clean.slice(afterName);
    const braceRel = rest.indexOf('{');
    const semiRel = rest.indexOf(';');
    const parenRel = rest.indexOf('(');

    let props: PropInfo[] = [];

    const hasBody = braceRel !== -1 && (semiRel === -1 || braceRel < semiRel);

    if (
      parenRel !== -1 &&
      (braceRel === -1 || parenRel < braceRel) &&
      (semiRel === -1 || parenRel < semiRel)
    ) {
      const closeParen = rest.indexOf(')', parenRel);
      if (closeParen !== -1) {
        props = props.concat(parseRecordParams(rest.slice(parenRel + 1, closeParen)));
      }
    }

    if (hasBody) {
      const openIndex = afterName + braceRel;
      const closeIndex = findMatchingBrace(clean, openIndex);
      if (closeIndex !== -1) {
        const body = clean.slice(openIndex + 1, closeIndex);
        props = props.concat(parseProps(body));
        TYPE_DECL.lastIndex = closeIndex; // continue after this type
      }
    }

    classes.push({ name, props });
  }

  return classes;
}

// --- type -> default value --------------------------------------------------

const NUMERIC = new Set([
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
  'nint',
  'nuint',
  'int32',
  'int64',
  'int16',
]);
const STRINGY = new Set(['string', 'char', 'guid', 'uri']);
const DATEY = new Set(['datetime', 'datetimeoffset', 'dateonly', 'timeonly', 'timespan']);
const COLLECTIONS = [
  'list',
  'ilist',
  'ienumerable',
  'icollection',
  'ireadonlylist',
  'ireadonlycollection',
  'hashset',
  'collection',
  'array',
  'observablecollection',
];

function defaultForType(
  rawType: string,
  classMap: Map<string, ClassInfo>,
  opts: CsharpToJsonOptions,
  seen: Set<string>,
): unknown {
  const type = rawType.trim();

  // Nullable -> null (both `T?` and `Nullable<T>`).
  if (type.endsWith('?')) return null;
  const nullableMatch = type.match(/^Nullable<(.+)>$/);
  if (nullableMatch) return null;

  const wantSampleItems = opts.sampleArrayItems || opts.sampleValues;

  // Arrays.
  if (type.endsWith('[]')) {
    if (!wantSampleItems) return [];
    const inner = type.slice(0, -2);
    return [defaultForType(inner, classMap, opts, seen)];
  }

  const generic = type.match(/^([A-Za-z_][\w.]*)\s*<(.+)>$/);
  if (generic) {
    const outer = generic[1]!.toLowerCase().replace(/^.*\./, '');
    const inner = generic[2]!;
    if (outer === 'dictionary' || outer === 'idictionary' || outer === 'ireadonlydictionary') {
      return {};
    }
    if (COLLECTIONS.includes(outer)) {
      if (!wantSampleItems) return [];
      const elem = inner.split(',')[0]!.trim();
      return [defaultForType(elem, classMap, opts, seen)];
    }
    // Task<T> and similar wrappers -> unwrap.
    if (outer === 'task' || outer === 'valuetask') {
      return defaultForType(inner, classMap, opts, seen);
    }
  }

  const key = type.replace(/^.*\./, '').toLowerCase();
  const sample = opts.sampleValues;
  if (STRINGY.has(key)) {
    if (!sample) return '';
    if (key === 'guid') return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    if (key === 'uri') return 'https://example.com';
    if (key === 'char') return 'c';
    return 'string';
  }
  if (key === 'bool' || key === 'boolean') return sample ? true : false;
  if (NUMERIC.has(key)) {
    if (!sample) return 0;
    const floaty = ['decimal', 'double', 'float', 'single'].includes(key);
    return floaty ? 123.45 : 123;
  }
  if (DATEY.has(key)) {
    if (!sample) return '';
    if (key === 'dateonly') return '2024-01-01';
    if (key === 'timeonly') return '12:00:00';
    if (key === 'timespan') return '00:00:00';
    return '2024-01-01T00:00:00Z';
  }
  if (key === 'object' || key === 'dynamic') return {};

  // Known custom type -> recurse (with cycle guard).
  const found = classMap.get(type) ?? classMap.get(type.replace(/^.*\./, ''));
  if (found) {
    if (seen.has(found.name)) return {};
    return buildObject(found, classMap, opts, new Set(seen).add(found.name));
  }

  // Unknown type: assume an object shape rather than a scalar.
  return {};
}

function propName(name: string, opts: CsharpToJsonOptions): string {
  if (!opts.camelCase) return name;
  if (!name) return name;
  // camelCase: lowercase leading run of capitals conservatively (just first char).
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function buildObject(
  cls: ClassInfo,
  classMap: Map<string, ClassInfo>,
  opts: CsharpToJsonOptions,
  seen: Set<string>,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const prop of cls.props) {
    obj[propName(prop.name, opts)] = defaultForType(prop.type, classMap, opts, seen);
  }
  return obj;
}

export function csharpToJson(code: string, opts: CsharpToJsonOptions = {}): string {
  const classes = parseClasses(code);
  if (classes.length === 0) {
    throw new Error('No C# class, record or struct found.');
  }

  const classMap = new Map(classes.map((c) => [c.name, c]));

  // Root = a type not referenced as a property type by any other type.
  const referenced = new Set<string>();
  for (const c of classes) {
    for (const p of c.props) {
      const base = p.type
        .replace(/\?$/, '')
        .replace(/\[\]$/, '')
        .replace(/<.*>/, '')
        .replace(/^.*\./, '');
      if (classMap.has(base)) referenced.add(base);
      const inner = p.type.match(/<(.+)>/);
      if (inner) {
        for (const part of inner[1]!.split(',')) {
          const b = part.trim().replace(/^.*\./, '');
          if (classMap.has(b)) referenced.add(b);
        }
      }
    }
  }
  const root = classes.find((c) => !referenced.has(c.name)) ?? classes[0]!;

  const obj = buildObject(root, classMap, opts, new Set([root.name]));
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
// JSON -> C# (the reverse direction; generate DTO classes from sample JSON)
// ---------------------------------------------------------------------------

export interface JsonToCsharpOptions {
  rootName?: string;
  /** Emit `record` types instead of `class`. */
  useRecords?: boolean;
}

function toPascal(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z_]/.test(pascal) ? pascal : '_' + pascal;
}

function singular(name: string): string {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, 'y');
  if (/s$/i.test(name) && !/ss$/i.test(name)) return name.slice(0, -1);
  return name;
}

interface GenClass {
  name: string;
  fields: { name: string; type: string; jsonKey: string }[];
}

export function jsonToCsharp(jsonText: string, opts: JsonToCsharpOptions = {}): string {
  const value = JSON.parse(jsonText) as unknown;
  const rootName = toPascal(opts.rootName || 'Root') || 'Root';
  const classes: GenClass[] = [];
  const usedNames = new Set<string>();

  const uniqueName = (base: string): string => {
    let name = base || 'Type';
    let i = 2;
    while (usedNames.has(name)) name = `${base}${i++}`;
    usedNames.add(name);
    return name;
  };

  const inferType = (val: unknown, suggested: string): string => {
    if (val === null || val === undefined) return 'object';
    if (Array.isArray(val)) {
      const first = val.find((v) => v !== null && v !== undefined);
      const elem = first === undefined ? 'object' : inferType(first, singular(suggested));
      return `List<${elem}>`;
    }
    switch (typeof val) {
      case 'string':
        return 'string';
      case 'boolean':
        return 'bool';
      case 'number':
        return Number.isInteger(val)
          ? val > 2147483647 || val < -2147483648
            ? 'long'
            : 'int'
          : 'double';
      case 'object':
        return buildClass(val as Record<string, unknown>, suggested);
      default:
        return 'object';
    }
  };

  const buildClass = (obj: Record<string, unknown>, suggested: string): string => {
    const name = uniqueName(toPascal(suggested) || 'Type');
    const gen: GenClass = { name, fields: [] };
    classes.push(gen); // push before children → root appears first
    for (const [key, val] of Object.entries(obj)) {
      gen.fields.push({ name: toPascal(key), type: inferType(val, key), jsonKey: key });
    }
    return name;
  };

  if (value === null || typeof value !== 'object') {
    throw new Error('Provide a JSON object or array to generate C# classes.');
  }
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === 'object');
    if (!first) throw new Error('Array does not contain objects to model.');
    buildClass(first as Record<string, unknown>, rootName);
  } else {
    buildClass(value as Record<string, unknown>, rootName);
  }

  const keyword = opts.useRecords ? 'record' : 'class';
  return classes
    .map((c) => {
      const lines = c.fields.map((f) => {
        const attr = f.name !== f.jsonKey ? `    [JsonPropertyName("${f.jsonKey}")]\n` : '';
        return `${attr}    public ${f.type} ${f.name} { get; set; }`;
      });
      return `public ${keyword} ${c.name}\n{\n${lines.join('\n')}\n}`;
    })
    .join('\n\n');
}
