import { describe, expect, it } from 'vitest';
import { excerpt } from '../src/services/chat/text';

const elif = '0190f0a0-0000-7000-8000-000000000066';
const names = new Map([[elif, 'Elif Yıldız']]);

describe('chat excerpt for notifications, e-mails and the chat list', () => {
  it('drops format markers', () => {
    expect(excerpt('*Deploy* bitti, _yarın_ ~değil~ bugün', names)).toBe(
      'Deploy bitti, yarın değil bugün',
    );
  });

  it('keeps list items readable on one line', () => {
    expect(excerpt('Yapılacaklar:\n- api\n- web', names)).toBe('Yapılacaklar: • api • web');
  });

  it('still turns mentions into names and leaves code alone', () => {
    expect(excerpt(`<@${elif}> bak: \`snake_case_name\``, names)).toBe(
      '@Elif Yıldız bak: snake_case_name',
    );
  });

  it('cuts long text with an ellipsis', () => {
    const out = excerpt(`**${'a'.repeat(300)}**`, names, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });
});
