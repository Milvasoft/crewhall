// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/appsettings-env/logic.ts. See THIRD_PARTY.md.
/**
 * Bidirectional appsettings.json <-> environment-variable conversion.
 *
 * The engine is split into (1) flatten JSON -> key/value entries and (2) render
 * entries in a target format. Adding a new output format means adding one
 * renderer, no rewrite. Reverse parsing rebuilds nested JSON from flat keys.
 */

export type Primitive = string | number | boolean | null;

export interface Entry {
  /** Segments; numbers denote array indices. */
  path: (string | number)[];
  value: Primitive;
}

export type OutputFormat =
  | 'colon' // .NET config: Jwt:Issuer=example
  | 'double-underscore' // Jwt__Issuer=example
  | 'dotenv' // .env: Jwt__Issuer="example"
  | 'bash' // export Jwt__Issuer='example'
  | 'powershell' // $env:Jwt__Issuer = 'example'
  | 'docker-compose' // YAML environment list
  | 'k8s-configmap'; // YAML ConfigMap data

// ---------------------------------------------------------------------------
// JSON -> entries
// ---------------------------------------------------------------------------

export function flatten(value: unknown, prefix: (string | number)[] = []): Entry[] {
  if (Array.isArray(value)) {
    // Empty arrays/objects contribute no environment variables.
    return value.flatMap((item, i) => flatten(item, [...prefix, i]));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.flatMap(([key, v]) => flatten(v, [...prefix, key]));
  }
  return [{ path: prefix, value: value as Primitive }];
}

function keyString(path: (string | number)[], sep: string): string {
  return path.map(String).join(sep);
}

function valueString(value: Primitive): string {
  if (value === null) return '';
  return String(value);
}

// ---------------------------------------------------------------------------
// entries -> formatted output
// ---------------------------------------------------------------------------

function needsShellQuote(v: string): boolean {
  return v === '' || /[\s"'$`\\;&|<>(){}#*?~=]/.test(v);
}

export function render(entries: Entry[], format: OutputFormat): string {
  switch (format) {
    case 'colon':
      return entries.map((e) => `${keyString(e.path, ':')}=${valueString(e.value)}`).join('\n');

    case 'double-underscore':
      return entries.map((e) => `${keyString(e.path, '__')}=${valueString(e.value)}`).join('\n');

    case 'dotenv':
      return entries
        .map((e) => {
          const v = valueString(e.value);
          const rhs = /[\s#"'`$]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
          return `${keyString(e.path, '__')}=${rhs}`;
        })
        .join('\n');

    case 'bash':
      return entries
        .map((e) => {
          const v = valueString(e.value);
          const rhs = needsShellQuote(v) ? `'${v.replace(/'/g, `'\\''`)}'` : v;
          return `export ${keyString(e.path, '__')}=${rhs}`;
        })
        .join('\n');

    case 'powershell':
      return entries
        .map((e) => {
          const v = valueString(e.value).replace(/'/g, "''");
          return `$env:${keyString(e.path, '__')} = '${v}'`;
        })
        .join('\n');

    case 'docker-compose':
      return [
        'environment:',
        ...entries.map((e) => `  - ${keyString(e.path, '__')}=${valueString(e.value)}`),
      ].join('\n');

    case 'k8s-configmap':
      return [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: appsettings',
        'data:',
        ...entries.map(
          (e) => `  ${keyString(e.path, '__')}: "${valueString(e.value).replace(/"/g, '\\"')}"`,
        ),
      ].join('\n');
  }
}

export function jsonToEnv(jsonText: string, format: OutputFormat): string {
  const parsed = JSON.parse(jsonText) as unknown;
  const entries = flatten(parsed);
  return render(entries, format);
}

// ---------------------------------------------------------------------------
// environment variables -> JSON
// ---------------------------------------------------------------------------

function coerce(raw: string): Primitive {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return raw;
}

function parseLine(line: string): { key: string; value: string } | null {
  let l = line.trim();
  if (!l || l.startsWith('#') || l.startsWith('//')) return null;
  l = l.replace(/^export\s+/, '');
  l = l.replace(/^\$env:/, '');
  l = l.replace(/^-\s+/, ''); // docker-compose list item
  const eq = l.indexOf('=');
  if (eq === -1) return null;
  let key = l.slice(0, eq).trim();
  let value = l.slice(eq + 1).trim();
  // Strip surrounding quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  key = key.replace(/\s+/g, '');
  return { key, value };
}

function detectSeparator(key: string): string {
  if (key.includes('__')) return '__';
  if (key.includes(':')) return ':';
  return '__';
}

function setDeep(root: Record<string, unknown>, segments: string[], value: Primitive): void {
  let node: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const nextSeg = segments[i + 1];
    const nextIsIndex = nextSeg !== undefined && /^\d+$/.test(nextSeg);

    if (/^\d+$/.test(seg) && Array.isArray(node)) {
      const idx = Number(seg);
      if (isLast) {
        node[idx] = value;
      } else {
        if (node[idx] === undefined) node[idx] = nextIsIndex ? [] : {};
        node = node[idx] as Record<string, unknown> | unknown[];
      }
    } else {
      const obj = node as Record<string, unknown>;
      if (isLast) {
        obj[seg] = value;
      } else {
        if (obj[seg] === undefined) obj[seg] = nextIsIndex ? [] : {};
        node = obj[seg] as Record<string, unknown> | unknown[];
      }
    }
  }
}

export function envToJson(text: string, indent = 2): string {
  const root: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const sep = detectSeparator(parsed.key);
    const segments = parsed.key.split(sep).filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    setDeep(root, segments, coerce(parsed.value));
  }
  return JSON.stringify(root, null, indent);
}
