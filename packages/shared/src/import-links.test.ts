import { describe, expect, it } from 'vitest';
import { importLinkResolver } from './import-links';

describe('links between imported files', () => {
  const resolve = importLinkResolver([
    'Ops.md',
    'Ops/Yedekleme Planı.md',
    'Ops/Disk.markdown',
    'Tek.md',
    'A/Aynı.md',
    'B/Aynı.md',
  ]);

  it('follows the linking file first, then the root', () => {
    expect(resolve('Disk.markdown', 'Ops/Yedekleme Planı.md')).toBe('Ops/Disk.markdown');
    expect(resolve('../Ops.md', 'Ops/Disk.markdown')).toBe('Ops.md');
    expect(resolve('./Yedekleme Planı.md', 'Ops/Disk.markdown')).toBe('Ops/Yedekleme Planı.md');
    expect(resolve('Ops/Disk.markdown', 'A/Aynı.md')).toBe('Ops/Disk.markdown');
  });

  it('reads a leading slash as the root of the import', () => {
    expect(resolve('/A/Aynı.md', 'B/Aynı.md')).toBe('A/Aynı.md');
    expect(resolve('/Aynı.md', 'B/Aynı.md')).toBeNull();
  });

  it('accepts encoded paths, angle brackets, fragments and any letter case', () => {
    expect(resolve('Ops/Yedekleme%20Plan%C4%B1.md#kurulum', 'Ops.md')).toBe(
      'Ops/Yedekleme Planı.md',
    );
    expect(resolve('<Ops/Yedekleme Planı.md>', 'Ops.md')).toBe('Ops/Yedekleme Planı.md');
    expect(resolve('ops.MD?v=1', 'A/Aynı.md')).toBe('Ops.md');
  });

  it('uses a file name only when it exists once', () => {
    expect(resolve('baska/klasor/Tek.md', 'Ops.md')).toBe('Tek.md');
    expect(resolve('baska/klasor/Aynı.md', 'Ops.md')).toBeNull();
  });

  it('leaves web addresses and other files alone', () => {
    expect(resolve('https://example.com/Ops.md', 'Tek.md')).toBeNull();
    expect(resolve('mailto:x@example.com', 'Tek.md')).toBeNull();
    expect(resolve('Ops/resim.png', 'Tek.md')).toBeNull();
    expect(resolve('#bolum', 'Tek.md')).toBeNull();
    expect(resolve('Yok.md', 'Tek.md')).toBeNull();
  });
});
