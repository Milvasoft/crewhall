// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/openapi/logic.ts. See THIRD_PARTY.md.
import { load } from 'js-yaml';

/* Minimal OpenAPI/Swagger reading + C# model generation. Not a full validator. */

type AnyObj = Record<string, unknown>;

export function parseSpec(text: string): AnyObj {
  const t = text.trim();
  try {
    return JSON.parse(t) as AnyObj;
  } catch {
    const y = load(t);
    if (y === null || typeof y !== 'object') throw new Error('Not a valid JSON/YAML spec.');
    return y as AnyObj;
  }
}

export interface Operation {
  path: string;
  method: string;
  summary: string;
}

export interface OpenApiOverview {
  specVersion: string;
  title: string;
  version: string;
  operations: Operation[];
  schemaNames: string[];
}

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

function getSchemas(spec: AnyObj): AnyObj {
  const components = spec.components as AnyObj | undefined;
  if (components && typeof components.schemas === 'object') {
    return components.schemas as AnyObj;
  }
  if (typeof spec.definitions === 'object') return spec.definitions as AnyObj; // Swagger 2.0
  return {};
}

export function overview(spec: AnyObj): OpenApiOverview {
  const info = (spec.info as AnyObj) ?? {};
  const paths = (spec.paths as AnyObj) ?? {};
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (item === null || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const op = (item as AnyObj)[method] as AnyObj | undefined;
      if (op) {
        operations.push({
          path,
          method: method.toUpperCase(),
          summary: String(op.summary ?? op.operationId ?? ''),
        });
      }
    }
  }
  return {
    specVersion: String(spec.openapi ?? spec.swagger ?? 'unknown'),
    title: String(info.title ?? 'Untitled API'),
    version: String(info.version ?? ''),
    operations,
    schemaNames: Object.keys(getSchemas(spec)),
  };
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? 'object';
}

function csType(schema: AnyObj): string {
  if (typeof schema.$ref === 'string') return refName(schema.$ref);
  const type = schema.type as string | undefined;
  const format = schema.format as string | undefined;
  if (type === 'array') {
    const items = (schema.items as AnyObj) ?? {};
    return `List<${csType(items)}>`;
  }
  if (type === 'integer') return format === 'int64' ? 'long' : 'int';
  if (type === 'number') return 'double';
  if (type === 'boolean') return 'bool';
  if (type === 'string') return format === 'date-time' || format === 'date' ? 'DateTime' : 'string';
  if (type === 'object' || !type) return 'object';
  return 'object';
}

function toPascal(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') || name;
}

export function schemasToCsharp(spec: AnyObj): string {
  const schemas = getSchemas(spec);
  const classes: string[] = [];
  for (const [name, schemaRaw] of Object.entries(schemas)) {
    const schema = schemaRaw as AnyObj;
    const props = (schema.properties as AnyObj) ?? {};
    const lines = Object.entries(props).map(([prop, sRaw]) => {
      const pascal = toPascal(prop);
      const attr = pascal !== prop ? `    [JsonPropertyName("${prop}")]\n` : '';
      return `${attr}    public ${csType(sRaw as AnyObj)} ${pascal} { get; set; }`;
    });
    classes.push(`public class ${toPascal(name)}\n{\n${lines.join('\n')}\n}`);
  }
  if (classes.length === 0) throw new Error('No component schemas found in the spec.');
  return classes.join('\n\n');
}
