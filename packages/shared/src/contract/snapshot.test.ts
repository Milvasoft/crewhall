import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { def, type EndpointDef } from '../endpoint-def';
import { buildContract, compareContracts, contractProblems } from './snapshot';

const Item = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['a', 'b']),
  note: z.string().optional(),
});

const table = (overrides: Record<string, EndpointDef> = {}): Record<string, EndpointDef> => ({
  getItem: def({ method: 'GET', path: '/api/v1/items/:id', auth: 'session', response: Item }),
  createItem: def({
    method: 'POST',
    path: '/api/v1/items',
    auth: 'session',
    body: z.object({
      name: z.string(),
      kind: z.enum(['a', 'b']),
      tags: z.array(z.string()).optional(),
    }),
    response: Item,
  }),
  ...overrides,
});

const meta = (apiLevel = 1) => ({ apiLevel, errorCodes: ['not_found'], capabilities: ['x'] });
const snap = (t: Record<string, EndpointDef>, level = 1) => buildContract(t, meta(level));
const base = snap(table());

function withResponse(response: z.ZodType) {
  return snap(
    table({
      getItem: def({ method: 'GET', path: '/api/v1/items/:id', auth: 'session', response }),
    }),
  );
}

function withBody(body: z.ZodType) {
  return snap(
    table({
      createItem: def({
        method: 'POST',
        path: '/api/v1/items',
        auth: 'session',
        body,
        response: Item,
      }),
    }),
  );
}

describe('contract rule check', () => {
  it('passes the same contract, and the real table builds', () => {
    expect(compareContracts(base, base)).toEqual({ breaking: [], additions: [] });
    const real = buildContract();
    expect(Object.keys(real.endpoints).length).toBeGreaterThan(100);
    expect(contractProblems(real, real).problems).toEqual([]);
  });

  it('fails when a response field is removed, narrowed or changes type', () => {
    expect(compareContracts(base, withResponse(Item.omit({ name: true }))).breaking).toEqual([
      'getItem.response.name: removed',
    ]);
    expect(
      compareContracts(base, withResponse(Item.extend({ name: z.string().optional() }))).breaking,
    ).toEqual(['getItem.response.name: now optional']);
    expect(
      compareContracts(base, withResponse(Item.extend({ name: z.string().nullable() }))).breaking,
    ).toEqual(['getItem.response.name: may now be null']);
    expect(
      compareContracts(base, withResponse(Item.extend({ id: z.number() }))).breaking[0],
    ).toMatch(/^getItem.response.id: now returns number/);
  });

  it('fails on stricter requests', () => {
    const body = z.object({
      name: z.string(),
      kind: z.enum(['a', 'b']),
      tags: z.array(z.string()).optional(),
    });
    expect(compareContracts(base, withBody(body.extend({ kind: z.enum(['a']) }))).breaking).toEqual(
      ['createItem.body.kind: no longer accepts b'],
    );
    expect(
      compareContracts(base, withBody(body.extend({ tags: z.array(z.string()) }))).breaking,
    ).toEqual(['createItem.body.tags: now required']);
    expect(compareContracts(base, withBody(body.extend({ owner: z.string() }))).breaking).toEqual([
      'createItem.body.owner: new required field',
    ]);
  });

  it('lets additions through but asks for a higher apiLevel', () => {
    const grown = snap(
      table({
        getItem: def({
          method: 'GET',
          path: '/api/v1/items/:id',
          auth: 'session',
          response: Item.extend({ kind: z.enum(['a', 'b', 'c']), color: z.string().optional() }),
        }),
        listItems: def({
          method: 'GET',
          path: '/api/v1/items',
          auth: 'session',
          response: z.array(Item),
        }),
      }),
    );
    const diff = compareContracts(base, grown);
    expect(diff.breaking).toEqual([]);
    expect(diff.additions).toEqual([
      'getItem.response.kind: new value c',
      'getItem.response.color: new field',
      'listItems: new endpoint',
    ]);
    expect(contractProblems(base, grown).problems[0]).toMatch(/raise it/);
    expect(contractProblems(base, { ...grown, apiLevel: 2 }).problems).toEqual([]);
  });

  it('fails on a removed endpoint unless its deprecation has run out', () => {
    const without = snap({ getItem: table().getItem! });
    expect(compareContracts(base, without).breaking).toEqual(['createItem: endpoint removed']);
    const marked = snap(
      table({
        createItem: {
          ...table().createItem!,
          deprecated: { since: '2026-01-01', removeAfter: '2026-06-01' },
        },
      }),
    );
    expect(compareContracts(marked, without, '2026-07-01').breaking).toEqual([]);
    expect(compareContracts(marked, without, '2026-05-01').breaking).toEqual([
      'createItem: endpoint removed',
    ]);
  });

  it('fails when a capability disappears', () => {
    const fewer = buildContract(table(), { ...meta(), capabilities: [] });
    expect(compareContracts(base, fewer).breaking).toEqual(['capability x: removed']);
  });
});
