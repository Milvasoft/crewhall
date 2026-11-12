import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/lib/ids';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when the page is a secure context', () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it('still makes v4 UUIDs over plain HTTP, where randomUUID is missing', () => {
    // http://192.168.x.x is not a secure context: crypto there has getRandomValues only
    const real = crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});
