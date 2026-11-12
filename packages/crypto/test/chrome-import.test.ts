import { describe, expect, it } from 'vitest';
import { parseBitwardenExport, sniffBitwardenFile } from '../src';

const CSV = [
  'name,url,username,password,note',
  'GitHub,https://github.com/login,ada,"pa,ss""word",kişisel hesap',
  ',https://shop.example.com/giris,ali@example.com,gizli123,',
  ',,,,',
].join('\n');

describe('Chrome password export', () => {
  it('is recognised as CSV, with or without the note column', () => {
    expect(sniffBitwardenFile(CSV)).toBe('csv');
    expect(sniffBitwardenFile('name,url,username,password\na,b,c,d')).toBe('csv');
    expect(sniffBitwardenFile('name,address\na,b')).toBe('unknown');
  });

  it('becomes logins; a row without a name is named after its site', async () => {
    const parsed = await parseBitwardenExport(CSV);
    expect(parsed.stats.failed ?? 0).toBe(0);
    expect(parsed.items).toHaveLength(2);
    const [first, second] = parsed.items.map((i) => i.payload);
    expect(first).toMatchObject({
      type: 'login',
      name: 'GitHub',
      username: 'ada',
      password: 'pa,ss"word',
      uris: ['https://github.com/login'],
      notes: 'kişisel hesap',
    });
    expect(second).toMatchObject({ name: 'shop.example.com', username: 'ali@example.com' });
  });
});
