import { describe, expect, it } from 'vitest';
import { resolveCollabUrl } from './schemas/wiki';

/** B12: a collab path resolves against the address the hub was opened at. */
describe('resolveCollabUrl', () => {
  it('resolves a path against the page address with the matching WebSocket scheme', () => {
    expect(resolveCollabUrl('/collab', 'http://127.0.0.1:4110/p/plan-1')).toBe(
      'ws://127.0.0.1:4110/collab',
    );
    expect(resolveCollabUrl('/collab', 'https://hub.example.com/sayfalar/x?y=1')).toBe(
      'wss://hub.example.com/collab',
    );
    expect(resolveCollabUrl('/collab', 'http://192.168.1.9:4110')).toBe(
      'ws://192.168.1.9:4110/collab',
    );
  });

  it('leaves full URLs and an empty value alone', () => {
    expect(resolveCollabUrl('ws://localhost:3001', 'https://hub.example.com/')).toBe(
      'ws://localhost:3001',
    );
    expect(resolveCollabUrl('', 'https://hub.example.com/')).toBe('');
  });
});
