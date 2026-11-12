// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-schema/logic.ts. See THIRD_PARTY.md.
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

type Schema = Record<string, unknown>;

function infer(value: unknown): Schema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const first = value.find((v) => v !== undefined);
    return { type: 'array', items: value.length ? infer(first) : {} };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object': {
      const obj = value as Record<string, unknown>;
      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        properties[k] = infer(v);
        required.push(k);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    default:
      return {};
  }
}

/** Infer a draft-07 JSON Schema from a sample JSON document. */
export function generateSchema(jsonText: string): string {
  const value = JSON.parse(jsonText) as unknown;
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...infer(value),
  };
  return JSON.stringify(schema, null, 2);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate JSON data against a JSON Schema using Ajv. */
export function validateJson(dataText: string, schemaText: string): ValidationResult {
  let data: unknown;
  let schema: object;
  try {
    data = JSON.parse(dataText);
  } catch (e) {
    return { valid: false, errors: [`Data is not valid JSON: ${(e as Error).message}`] };
  }
  try {
    schema = JSON.parse(schemaText);
  } catch (e) {
    return { valid: false, errors: [`Schema is not valid JSON: ${(e as Error).message}`] };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    return { valid: false, errors: [`Invalid schema: ${(e as Error).message}`] };
  }

  const valid = validate(data);
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map((err) =>
    `${err.instancePath || '(root)'} ${err.message ?? ''}`.trim(),
  );
  return { valid: false, errors };
}
