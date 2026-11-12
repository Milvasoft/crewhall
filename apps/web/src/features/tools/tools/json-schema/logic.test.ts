// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-schema/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateSchema, validateJson } from './logic';

describe('json-schema generate', () => {
  it('infers types, properties and required', () => {
    const schema = JSON.parse(generateSchema('{"id":1,"name":"Ada","active":true,"tags":["x"]}'));
    expect(schema.type).toBe('object');
    expect(schema.properties.id).toEqual({ type: 'integer' });
    expect(schema.properties.name).toEqual({ type: 'string' });
    expect(schema.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schema.required).toEqual(['id', 'name', 'active', 'tags']);
  });

  it('infers null, boolean and number-vs-integer at the top level', () => {
    expect(JSON.parse(generateSchema('null'))).toMatchObject({ type: 'null' });
    expect(JSON.parse(generateSchema('true'))).toMatchObject({ type: 'boolean' });
    expect(JSON.parse(generateSchema('1.5'))).toMatchObject({ type: 'number' });
    expect(JSON.parse(generateSchema('1'))).toMatchObject({ type: 'integer' });
  });

  it("infers an empty array's items as an open schema", () => {
    const schema = JSON.parse(generateSchema('{"tags":[]}'));
    expect(schema.properties.tags).toEqual({ type: 'array', items: {} });
  });

  it('infers an array of objects', () => {
    const schema = JSON.parse(generateSchema('[{"a":1},{"a":2}]'));
    expect(schema.type).toBe('array');
    expect(schema.items).toEqual({
      type: 'object',
      properties: { a: { type: 'integer' } },
      required: ['a'],
    });
  });

  it('throws on malformed JSON input', () => {
    expect(() => generateSchema('{bad')).toThrow();
  });
});

describe('json-schema validate', () => {
  const schema = JSON.stringify({
    type: 'object',
    properties: { age: { type: 'integer' }, name: { type: 'string' } },
    required: ['name'],
  });

  it('passes valid data', () => {
    const r = validateJson('{"name":"Ada","age":30}', schema);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports validation errors', () => {
    const r = validateJson('{"age":"thirty"}', schema);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('handles invalid JSON gracefully', () => {
    const r = validateJson('{bad}', schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('not valid JSON');
  });

  it('reports a malformed schema document as invalid JSON', () => {
    const r = validateJson('{"name":"Ada"}', '{bad}');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('Schema is not valid JSON');
  });

  it('reports a schema that Ajv cannot compile', () => {
    const r = validateJson('{"a":1}', '{"type":123}');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('Invalid schema');
  });

  it('round-trips generate → validate', () => {
    const data = '{"id":1,"name":"Ada"}';
    const gen = generateSchema(data);
    expect(validateJson(data, gen).valid).toBe(true);
  });

  it('round-trips generate → validate for a top-level array', () => {
    const data = '[{"id":1},{"id":2}]';
    const gen = generateSchema(data);
    expect(validateJson(data, gen).valid).toBe(true);
    // Data whose items don't match the inferred schema should fail.
    expect(validateJson('[{"id":"not-a-number"}]', gen).valid).toBe(false);
  });
});
