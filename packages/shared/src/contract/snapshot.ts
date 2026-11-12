import { z } from 'zod';
import { API_LEVEL, CAPABILITIES, DEPRECATED_FIELDS, type Deprecation } from '../compat';
import type { EndpointDef } from '../endpoint-def';
import { endpoints } from '../endpoints';
import { ERROR_CODES } from '../errors';

/**
 * The contract as data (contract-snapshot.json): every endpoint's method, path and JSON Schemas
 * (requests as input, responses as output), error codes and capabilities. A release keeps its
 * snapshot; `compareContracts` tells which later changes would break apps built against it.
 */

type Json = Record<string, unknown>;

export interface EndpointSnapshot {
  method: string;
  path: string;
  auth: string;
  query?: Json;
  body?: Json;
  response: Json;
  deprecated?: Deprecation;
}

export interface ContractSnapshot {
  apiLevel: number;
  endpoints: Record<string, EndpointSnapshot>;
  errorCodes: string[];
  capabilities: string[];
}

function schemaOf(type: z.ZodType, io: 'input' | 'output'): Json {
  const json = z.toJSONSchema(type, { io, unrepresentable: 'any', cycles: 'ref' }) as Json;
  delete json.$schema;
  return json;
}

export function buildContract(
  table: Record<string, EndpointDef> = endpoints,
  meta: Pick<ContractSnapshot, 'apiLevel' | 'errorCodes' | 'capabilities'> = {
    apiLevel: API_LEVEL,
    errorCodes: [...ERROR_CODES],
    capabilities: CAPABILITIES.map((c) => c.key),
  },
): ContractSnapshot {
  const out: Record<string, EndpointSnapshot> = {};
  for (const name of Object.keys(table).sort()) {
    const d = table[name]!;
    out[name] = {
      method: d.method,
      path: d.path,
      auth: d.auth,
      ...(d.query ? { query: schemaOf(d.query, 'input') } : {}),
      ...(d.body ? { body: schemaOf(d.body, 'input') } : {}),
      response: schemaOf(d.response, 'output'),
      ...(d.deprecated ? { deprecated: d.deprecated } : {}),
    };
  }
  return { ...meta, endpoints: out };
}

export interface ContractDiff {
  /** Changes that break apps built against the old contract. */
  breaking: string[];
  /** Additions (new endpoints, fields, values): allowed, but they raise apiLevel. */
  additions: string[];
}

/** Request data flows in (old apps send it), responses out (old apps read them). */
type Dir = 'in' | 'out';

interface Ctx extends ContractDiff {
  endpoint: string;
  today: string;
}

/** A schema as its alternatives: `anyOf`/`oneOf` branches and multi-`type` lists split apart. */
function variants(node: Json): Json[] {
  const branches = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  if (branches) return branches.flatMap(variants);
  if (Array.isArray(node.type)) {
    return (node.type as string[]).map((t) => ({ ...node, type: t }));
  }
  return [node];
}

/** Matches alternatives across versions: by const, by object discriminators, else by type. */
function keyOf(node: Json): string {
  if (node.const !== undefined) return `const:${JSON.stringify(node.const)}`;
  if (node.type === 'object' && node.properties) {
    const tags = Object.entries(node.properties as Record<string, Json>)
      .filter(([, p]) => p.const !== undefined)
      .map(([k, p]) => `${k}=${JSON.stringify(p.const)}`)
      .sort();
    return `object${tags.length ? `[${tags.join(',')}]` : ''}`;
  }
  if (typeof node.type === 'string') return node.type;
  return 'any';
}

/** A field removal the deprecation list allows (its removeAfter has passed). */
function removable(ctx: Ctx, field: string) {
  return DEPRECATED_FIELDS.some(
    (f) => f.endpoint === ctx.endpoint && f.field === field && f.removeAfter <= ctx.today,
  );
}

function compareNode(ctx: Ctx, oldN: Json, newN: Json, path: string, dir: Dir) {
  if (oldN.$ref !== undefined || newN.$ref !== undefined) return;
  const oldV = variants(oldN);
  const newV = variants(newN);
  const anyOld = oldV.some((v) => keyOf(v) === 'any');
  const anyNew = newV.some((v) => keyOf(v) === 'any');
  if (anyOld || anyNew) {
    // An unconstrained schema accepts or yields anything.
    if (dir === 'in' && anyOld && !anyNew) ctx.breaking.push(`${path}: accepts less than before`);
    if (dir === 'out' && anyNew && !anyOld) ctx.breaking.push(`${path}: may return anything`);
    return;
  }
  const newBy = new Map(newV.map((v) => [keyOf(v), v]));
  const oldBy = new Map(oldV.map((v) => [keyOf(v), v]));
  if (dir === 'in') {
    for (const [k, o] of oldBy) {
      const n = newBy.get(k);
      if (!n) ctx.breaking.push(`${path}: no longer accepts ${k}`);
      else compareLeaf(ctx, o, n, path, dir);
    }
    for (const k of newBy.keys()) if (!oldBy.has(k)) ctx.additions.push(`${path}: accepts ${k}`);
  } else {
    for (const [k, n] of newBy) {
      const o = oldBy.get(k);
      if (o) compareLeaf(ctx, o, n, path, dir);
      else if (k === 'null') ctx.breaking.push(`${path}: may now be null`);
      else if (k.startsWith('object[') || k.startsWith('const:')) {
        ctx.additions.push(`${path}: new variant ${k}`);
      } else ctx.breaking.push(`${path}: now returns ${k} (was ${[...oldBy.keys()].join('|')})`);
    }
  }
}

function compareLeaf(ctx: Ctx, o: Json, n: Json, path: string, dir: Dir) {
  if (o.type === 'object') {
    const op = (o.properties ?? {}) as Record<string, Json>;
    const np = (n.properties ?? {}) as Record<string, Json>;
    const oreq = new Set((o.required ?? []) as string[]);
    const nreq = new Set((n.required ?? []) as string[]);
    for (const [k, schema] of Object.entries(op)) {
      const at = `${path}.${k}`;
      const next = np[k];
      if (!next) {
        if (
          !removable(ctx, at.slice(at.indexOf('.') + 1).replace(/^(response|body|query)\./, ''))
        ) {
          ctx.breaking.push(`${at}: removed`);
        }
        continue;
      }
      if (dir === 'out' && oreq.has(k) && !nreq.has(k)) ctx.breaking.push(`${at}: now optional`);
      if (dir === 'in' && !oreq.has(k) && nreq.has(k)) ctx.breaking.push(`${at}: now required`);
      compareNode(ctx, schema, next, at, dir);
    }
    for (const k of Object.keys(np)) {
      if (op[k]) continue;
      if (dir === 'in' && nreq.has(k)) ctx.breaking.push(`${path}.${k}: new required field`);
      else ctx.additions.push(`${path}.${k}: new field`);
    }
    const oa = o.additionalProperties;
    const na = n.additionalProperties;
    if (oa && na && typeof oa === 'object' && typeof na === 'object') {
      compareNode(ctx, oa as Json, na as Json, `${path}[*]`, dir);
    }
    return;
  }
  if (o.type === 'array') {
    if (o.items && n.items) compareNode(ctx, o.items as Json, n.items as Json, `${path}[]`, dir);
    return;
  }
  if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
    const before = new Set(o.enum as unknown[]);
    const after = new Set(n.enum as unknown[]);
    for (const v of after)
      if (!before.has(v)) ctx.additions.push(`${path}: new value ${String(v)}`);
    if (dir === 'in') {
      for (const v of before) {
        if (!after.has(v)) ctx.breaking.push(`${path}: no longer accepts ${String(v)}`);
      }
    }
  } else if (dir === 'in' && Array.isArray(n.enum) && !Array.isArray(o.enum)) {
    ctx.breaking.push(`${path}: now limited to ${(n.enum as unknown[]).join('|')}`);
  }
}

const EMPTY: Json = { type: 'object', properties: {} };

export function compareContracts(
  old: ContractSnapshot,
  next: ContractSnapshot,
  today = new Date().toISOString().slice(0, 10),
): ContractDiff {
  const diff: ContractDiff = { breaking: [], additions: [] };
  for (const [name, o] of Object.entries(old.endpoints)) {
    const n = next.endpoints[name];
    if (!n) {
      if (!(o.deprecated && o.deprecated.removeAfter <= today)) {
        diff.breaking.push(`${name}: endpoint removed`);
      }
      continue;
    }
    for (const k of ['method', 'path', 'auth'] as const) {
      if (o[k] !== n[k]) diff.breaking.push(`${name}: ${k} changed ${o[k]} → ${n[k]}`);
    }
    const ctx: Ctx = { ...diff, endpoint: name, today };
    for (const part of ['query', 'body'] as const) {
      if (!o[part] && !n[part]) continue;
      compareNode(ctx, o[part] ?? EMPTY, n[part] ?? EMPTY, `${name}.${part}`, 'in');
    }
    compareNode(ctx, o.response, n.response, `${name}.response`, 'out');
  }
  for (const name of Object.keys(next.endpoints)) {
    if (!old.endpoints[name]) diff.additions.push(`${name}: new endpoint`);
  }
  for (const code of next.errorCodes) {
    if (!old.errorCodes.includes(code)) diff.additions.push(`error ${code}: new`);
  }
  for (const cap of old.capabilities) {
    if (!next.capabilities.includes(cap)) diff.breaking.push(`capability ${cap}: removed`);
  }
  for (const cap of next.capabilities) {
    if (!old.capabilities.includes(cap)) diff.additions.push(`capability ${cap}: new`);
  }
  return diff;
}

/** Problems that fail the check: breaking changes, or additions without a higher apiLevel. */
export function contractProblems(old: ContractSnapshot, next: ContractSnapshot, today?: string) {
  const diff = compareContracts(old, next, today);
  const problems = [...diff.breaking];
  if (diff.additions.length && next.apiLevel <= old.apiLevel) {
    problems.push(
      `the contract grew (${diff.additions.length} additions, e.g. ${diff.additions[0]}) ` +
        `but API_LEVEL is still ${next.apiLevel}: raise it in packages/shared/src/compat.ts`,
    );
  }
  return { problems, diff };
}
