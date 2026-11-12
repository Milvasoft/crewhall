import { z } from 'zod';
import * as shared from '@crewhall/shared';
import { ERROR_CODES, MODULE_OF_ENDPOINT, endpoints, type EndpointName } from '@crewhall/shared';
import { resources, type AppLocale } from '@crewhall/i18n';
import { tokenScopeOf } from './mcp/rest';
import { PACKAGE_VERSION } from '../version';

/**
 * OpenAPI 3.1 document of the REST API, generated from the contract table
 * (packages/shared endpoints + zod schemas), so a new endpoint is documented the moment it
 * is added. Named schema exports become `components.schemas`; requests use the input side
 * of a schema (defaults optional), responses the output side, and a schema whose two
 * sides differ gets a second `<Name>Input` component.
 */

type Json = { [key: string]: unknown };
type Io = 'input' | 'output';

const REF = '#/components/schemas/';
const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Exported zod schemas by object identity; the first export name wins. */
function exportedNames(): Map<z.ZodType, string> {
  const names = new Map<z.ZodType, string>();
  for (const [name, value] of Object.entries(shared)) {
    if (value instanceof z.ZodType && !names.has(value)) names.set(value, name);
  }
  return names;
}

interface Roots {
  /** Every schema that becomes a component, with its id. */
  ids: Map<z.ZodType, string>;
  /** Per endpoint: the component ids of its body and response. */
  ops: Map<EndpointName, { body?: string; response: string }>;
}

function collectRoots(): Roots {
  const ids = exportedNames();
  const taken = new Set(ids.values());
  const idFor = (schema: z.ZodType, fallback: string) => {
    const known = ids.get(schema);
    if (known) return known;
    let id = fallback;
    for (let i = 2; taken.has(id); i++) id = `${fallback}${i}`;
    ids.set(schema, id);
    taken.add(id);
    return id;
  };
  const ops = new Map<EndpointName, { body?: string; response: string }>();
  for (const name of Object.keys(endpoints) as EndpointName[]) {
    const e: shared.EndpointDef = endpoints[name];
    ops.set(name, {
      ...(e.body ? { body: idFor(e.body, `${pascal(name)}Body`) } : {}),
      response: idFor(e.response, `${pascal(name)}Response`),
    });
  }
  return { ids, ops };
}

/** All roots converted for one side; refs between them point at `<id><suffix>`. */
function convert(ids: Map<z.ZodType, string>, io: Io, suffix: string): Record<string, Json> {
  const registry = z.registry<{ id: string }>();
  for (const [schema, id] of ids) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    uri: (id) => `${REF}${id}${suffix}`,
  }) as { schemas: Record<string, Json> };
  // `$id`/`$schema` per component would only move the base URI the refs resolve against.
  return Object.fromEntries(
    Object.entries(schemas).map(([id, { $id: _id, $schema: _schema, ...rest }]) => [id, rest]),
  );
}

/** Deep copy with every `$ref` passed through `map`. */
function mapRefs<T>(value: T, map: (ref: string) => string): T {
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, map)) as T;
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === '$ref' && typeof v === 'string' ? map(v) : mapRefs(v, map);
    }
    return out as T;
  }
  return value;
}

/**
 * Output components keep the plain id; an input side identical to its output (once its
 * own refs are mapped the same way) shares it, otherwise it becomes `<id>Input`.
 */
function buildComponents(ids: Map<z.ZodType, string>) {
  const out = convert(ids, 'output', '');
  const inp = convert(ids, 'input', 'Input');
  const same = new Set(Object.keys(out).filter((id) => id in inp));
  const toShared = (ref: string) => {
    const m = /^#\/components\/schemas\/(.+)Input$/.exec(ref);
    return m && same.has(m[1]!) ? `${REF}${m[1]}` : ref;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const id of same) {
      if (JSON.stringify(mapRefs(inp[id], toShared)) !== JSON.stringify(out[id])) {
        same.delete(id);
        changed = true;
      }
    }
  }
  const components: Record<string, Json> = {};
  for (const [id, schema] of Object.entries(out)) components[id] = schema;
  for (const [id, schema] of Object.entries(inp)) {
    if (!same.has(id)) components[`${id}Input`] = mapRefs(schema, toShared);
  }
  const inputRef = (id: string) => `${REF}${same.has(id) ? id : `${id}Input`}`;
  return { components, inputRef };
}

/** Only the components an operation reaches, directly or through other components. */
function prune(paths: Json, components: Record<string, Json>): Record<string, Json> {
  const keep = new Set<string>();
  const visit = (value: unknown) => {
    mapRefs(value, (ref) => {
      const id = ref.startsWith(REF) ? ref.slice(REF.length) : null;
      if (id && !keep.has(id) && components[id]) {
        keep.add(id);
        visit(components[id]);
      }
      return ref;
    });
  };
  visit(paths);
  return Object.fromEntries([...keep].sort().map((id) => [id, components[id]!]));
}

function queryParameters(schema: z.ZodType): Json[] {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Json;
  const props = (json.properties ?? {}) as Record<string, Json>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: 'query',
    required: required.has(name),
    ...(typeof s.description === 'string' ? { description: s.description } : {}),
    schema: s,
  }));
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface OpenApiOptions {
  /** Base URL clients call, e.g. https://hub.example.com. */
  serverUrl: string;
  locale: AppLocale;
}

export function buildOpenApi({ serverUrl, locale }: OpenApiOptions) {
  const text = resources[locale].email.mcp.openapi;
  const roots = collectRoots();
  const { components, inputRef } = buildComponents(roots.ids);
  const paths: Record<string, Record<string, Json>> = {};
  const tags = new Set<string>();

  for (const name of Object.keys(endpoints) as EndpointName[]) {
    const e: shared.EndpointDef = endpoints[name];
    const op = roots.ops.get(name)!;
    const path = e.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const pathParams = [...e.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const tag = MODULE_OF_ENDPOINT[name] ?? 'core';
    tags.add(tag);
    const scope = tokenScopeOf(name);
    const parameters = [
      ...pathParams,
      ...(e.query ? queryParameters(e.query) : []),
      ...(WRITE_METHODS.has(e.method)
        ? [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              description: text.idempotency,
              schema: { type: 'string', maxLength: 200 },
            },
          ]
        : []),
    ];
    paths[path] ??= {};
    paths[path][e.method.toLowerCase()] = {
      operationId: name,
      tags: [tag],
      summary: name,
      description:
        e.auth === 'public'
          ? text.public
          : scope
            ? text.tokenScope.replace('{scope}', scope)
            : text.noToken,
      security:
        e.auth === 'public'
          ? []
          : [
              ...(scope ? [{ personalToken: [] }] : []),
              { sessionCookie: [] },
              { sessionToken: [] },
            ],
      'x-crewhall-token-scope': e.auth === 'public' ? null : scope,
      ...(parameters.length ? { parameters } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { $ref: inputRef(op.body) } } },
            },
          }
        : {}),
      responses: {
        '200': {
          description: text.ok,
          content: { 'application/json': { schema: { $ref: `${REF}${op.response}` } } },
        },
        default: {
          description: text.error,
          content: { 'application/json': { schema: { $ref: `${REF}ApiErrorBody` } } },
        },
      },
    };
  }

  const schemas = prune(paths, components);
  // The error body's `code` lists every code; each is also an `errors.<code>` i18n key.
  schemas.ApiErrorBody = {
    ...schemas.ApiErrorBody,
    properties: {
      ...((schemas.ApiErrorBody?.properties as Json | undefined) ?? {}),
      code: { type: 'string', enum: [...ERROR_CODES] },
    },
  };

  return {
    openapi: '3.1.1',
    info: {
      title: text.title,
      version: PACKAGE_VERSION,
      description: text.description,
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [{ url: serverUrl }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      schemas,
      securitySchemes: {
        personalToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'mhp_…',
          description: text.personalToken,
        },
        sessionToken: {
          type: 'http',
          scheme: 'bearer',
          description: text.sessionToken,
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'crewhall.session_token',
          description: text.sessionCookie,
        },
      },
    },
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApi>;
