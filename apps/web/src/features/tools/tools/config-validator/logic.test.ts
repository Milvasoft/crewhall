// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/config-validator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { validateConfig } from './logic';

describe('config-validator', () => {
  it('flags invalid YAML', () => {
    const r = validateConfig('a: [1, 2', 'yaml');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('Invalid YAML');
  });

  it('validates docker-compose services', () => {
    const ok = validateConfig('services:\n  web:\n    image: nginx', 'docker-compose');
    expect(ok.valid).toBe(true);
    const missing = validateConfig("version: '3'\n", 'docker-compose');
    expect(missing.valid).toBe(false);
    expect(missing.errors.some((e) => e.includes('services'))).toBe(true);
  });

  it('warns about service without image/build', () => {
    const r = validateConfig("services:\n  web:\n    ports: ['80:80']", 'docker-compose');
    expect(r.warnings.some((w) => w.includes('image'))).toBe(true);
  });

  it('validates kubernetes required fields across docs', () => {
    const ok = validateConfig(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: s',
      'kubernetes',
    );
    expect(ok.valid).toBe(true);
    const bad = validateConfig('kind: Pod\n', 'kubernetes');
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => e.includes('apiVersion'))).toBe(true);
  });

  it('treats empty and whitespace-only input as invalid', () => {
    expect(validateConfig('', 'yaml')).toEqual({
      valid: false,
      errors: ['Input is empty.'],
      warnings: [],
    });
    const ws = validateConfig('   \n\t  ', 'docker-compose');
    expect(ws.valid).toBe(false);
    expect(ws.errors).toEqual(['Input is empty.']);
  });

  it('plain yaml mode accepts any valid YAML document without structural checks', () => {
    const r = validateConfig('just: text\nno: services', 'yaml');
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a non-mapping top-level docker-compose document', () => {
    const scalar = validateConfig('5', 'docker-compose');
    expect(scalar.valid).toBe(false);
    expect(scalar.errors).toContain('Top-level document must be a mapping.');

    const arr = validateConfig('- 1\n- 2', 'docker-compose');
    expect(arr.valid).toBe(false);
    expect(arr.errors).toContain('Top-level document must be a mapping.');
  });

  it('rejects a non-mapping service entry in docker-compose', () => {
    const r = validateConfig('services:\n  web: nginx', 'docker-compose');
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('Service "web" must be a mapping.');
  });

  it('flags the obsolete top-level `version` field in docker-compose', () => {
    const r = validateConfig("version: '3'\nservices:\n  web:\n    image: nginx", 'docker-compose');
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes('version'))).toBe(true);
  });

  it('rejects a non-mapping kubernetes document', () => {
    const r = validateConfig('just-a-string', 'kubernetes');
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(['must be a mapping.']);
  });

  it('labels errors per-document only when there are multiple kubernetes documents', () => {
    const single = validateConfig('kind: Pod\n', 'kubernetes');
    expect(single.errors.some((e) => e.startsWith('Document'))).toBe(false);

    const multi = validateConfig(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n---\nkind: Service\n',
      'kubernetes',
    );
    expect(multi.valid).toBe(false);
    expect(multi.errors.some((e) => e.startsWith('Document 2: '))).toBe(true);
  });

  it('flags a kubernetes document missing metadata.name', () => {
    const r = validateConfig('apiVersion: v1\nkind: Pod\n', 'kubernetes');
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('missing `metadata.name`.');
  });
});
