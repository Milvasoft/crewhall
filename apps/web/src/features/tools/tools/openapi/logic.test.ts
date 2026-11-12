// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/openapi/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { overview, parseSpec, schemasToCsharp } from './logic';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Demo API', version: '1.2.0' },
  paths: {
    '/users': {
      get: { summary: 'List users' },
      post: { operationId: 'createUser' },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer', format: 'int64' },
          name: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          tags: { type: 'array', items: { type: 'string' } },
          address: { $ref: '#/components/schemas/Address' },
        },
      },
    },
  },
});

describe('openapi', () => {
  it('parses JSON and extracts an overview', () => {
    const o = overview(parseSpec(SPEC));
    expect(o.title).toBe('Demo API');
    expect(o.specVersion).toBe('3.0.0');
    expect(o.operations).toContainEqual({
      path: '/users',
      method: 'GET',
      summary: 'List users',
    });
    expect(o.operations.find((op) => op.method === 'POST')?.summary).toBe('createUser');
    expect(o.schemaNames).toEqual(['User']);
  });

  it('parses YAML too', () => {
    const o = overview(parseSpec("openapi: 3.0.0\ninfo:\n  title: Y\n  version: '1'\npaths: {}\n"));
    expect(o.title).toBe('Y');
  });

  it('generates C# models with correct type mapping', () => {
    const cs = schemasToCsharp(parseSpec(SPEC));
    expect(cs).toContain('public class User');
    expect(cs).toContain('public long Id { get; set; }');
    expect(cs).toContain('public string Name { get; set; }');
    expect(cs).toContain('public DateTime CreatedAt { get; set; }');
    expect(cs).toContain('public List<string> Tags { get; set; }');
    expect(cs).toContain('public Address Address { get; set; }');
    expect(cs).toContain('[JsonPropertyName("created_at")]');
  });

  it('throws for input that is neither valid JSON nor a YAML mapping', () => {
    expect(() => parseSpec('')).toThrow('Not a valid JSON/YAML spec.');
    expect(() => parseSpec('just some plain text')).toThrow('Not a valid JSON/YAML spec.');
  });

  it('falls back to defaults when info/paths/components are missing', () => {
    const o = overview(parseSpec('{}'));
    expect(o.title).toBe('Untitled API');
    expect(o.version).toBe('');
    expect(o.specVersion).toBe('unknown');
    expect(o.operations).toEqual([]);
    expect(o.schemaNames).toEqual([]);
  });

  it("reads Swagger 2.0 'swagger' version and 'definitions' schemas", () => {
    const spec = parseSpec(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'Old API', version: '1.0' },
        paths: {},
        definitions: {
          Widget: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      }),
    );
    const o = overview(spec);
    expect(o.specVersion).toBe('2.0');
    expect(o.schemaNames).toEqual(['Widget']);
    const cs = schemasToCsharp(spec);
    expect(cs).toContain('public class Widget');
    expect(cs).toContain('public int Id { get; set; }');
  });

  it('collects multiple HTTP methods on the same path and skips non-object path items', () => {
    const spec = parseSpec(
      JSON.stringify({
        paths: {
          '/items': { get: { summary: 'list' }, delete: { summary: 'remove' } },
          '/broken': null,
        },
      }),
    );
    const o = overview(spec);
    const methods = o.operations.filter((op) => op.path === '/items').map((op) => op.method);
    expect(methods.sort()).toEqual(['DELETE', 'GET']);
    expect(o.operations.some((op) => op.path === '/broken')).toBe(false);
  });

  it('throws when the spec has no component schemas', () => {
    expect(() => schemasToCsharp(parseSpec('{}'))).toThrow(
      'No component schemas found in the spec.',
    );
  });

  it('maps integer without format, number, boolean and untyped/object schemas', () => {
    const spec = parseSpec(
      JSON.stringify({
        components: {
          schemas: {
            Mixed: {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                price: { type: 'number' },
                active: { type: 'boolean' },
                blob: {},
                nested: { type: 'object' },
              },
            },
          },
        },
      }),
    );
    const cs = schemasToCsharp(spec);
    expect(cs).toContain('public int Count { get; set; }');
    expect(cs).toContain('public double Price { get; set; }');
    expect(cs).toContain('public bool Active { get; set; }');
    expect(cs).toContain('public object Blob { get; set; }');
    expect(cs).toContain('public object Nested { get; set; }');
  });

  it('does not add JsonPropertyName when the property is already PascalCase', () => {
    const spec = parseSpec(
      JSON.stringify({
        components: {
          schemas: {
            Thing: { type: 'object', properties: { Name: { type: 'string' } } },
          },
        },
      }),
    );
    const cs = schemasToCsharp(spec);
    expect(cs).toContain('public string Name { get; set; }');
    expect(cs).not.toContain('JsonPropertyName');
  });

  it('produces an empty-bodied class for a schema with no properties', () => {
    const spec = parseSpec(
      JSON.stringify({ components: { schemas: { Empty: { type: 'object' } } } }),
    );
    const cs = schemasToCsharp(spec);
    expect(cs).toBe('public class Empty\n{\n\n}');
  });

  it('maps a $ref inside an array to List<RefName>', () => {
    const spec = parseSpec(
      JSON.stringify({
        components: {
          schemas: {
            Order: {
              type: 'object',
              properties: {
                items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
              },
            },
          },
        },
      }),
    );
    const cs = schemasToCsharp(spec);
    expect(cs).toContain('public List<Item> Items { get; set; }');
  });
});
