import { describe, expect, it } from 'vitest';
import { genericMessages, MAX_GENERIC_MESSAGES } from '../src/services/chat/webhook-generic';

describe('generic webhook bodies', () => {
  it('reads title, text, links and status from common field names', () => {
    const [m] = genericMessages(
      {
        event: 'deploy.failed',
        message: 'api 1.4.0 <b>did not start</b>',
        html_url: 'https://ci.example.com/run/7',
        status: 'failure',
        environment: 'prod',
        runId: 7,
      },
      'en',
    );
    expect(m!.card).toMatchObject({
      severity: 'critical',
      title: 'deploy.failed',
      text: 'api 1.4.0 did not start',
      buttons: [{ text: 'Open', url: 'https://ci.example.com/run/7' }],
      fields: [
        { label: 'status', value: 'failure' },
        { label: 'environment', value: 'prod' },
      ],
    });
  });

  it('keeps a lone sentence as plain text', () => {
    expect(genericMessages({ message: 'Yedek alındı' }, 'tr')).toEqual([
      { text: 'Yedek alındı', card: null },
    ]);
    expect(genericMessages('merhaba', 'tr')).toEqual([{ text: 'merhaba', card: null }]);
  });

  it('writes unreadable JSON as a code block and says nothing for empty bodies', () => {
    const [m] = genericMessages({ a: { b: [1, 2] } }, 'tr');
    expect(m!.text.startsWith('```json\n')).toBe(true);
    expect(genericMessages({}, 'tr')).toEqual([]);
    expect(genericMessages([], 'tr')).toEqual([]);
    expect(genericMessages(null, 'tr')).toEqual([]);
  });

  it('caps the messages an array body can make', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ text: `n${i}` }));
    expect(genericMessages(many, 'tr')).toHaveLength(MAX_GENERIC_MESSAGES);
  });

  it('labels links to a published post', () => {
    const [m] = genericMessages(
      { content: 'x', releaseURL: 'https://example.com/p/1', integration: { name: 'Kanal' } },
      'tr',
    );
    expect(m!.card!.buttons).toEqual([{ text: 'Paylaşımı aç', url: 'https://example.com/p/1' }]);
    expect(m!.card!.title).toBe('Kanal');
  });
});
