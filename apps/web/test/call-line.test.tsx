import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { missedCallKey } from '@/components/chat/MessageItem';
import { callLength } from '@/components/meet/bits';
import { I18nProvider, useI18n } from '@/lib/i18n/I18nContext';
import { type SystemEvent } from '@/lib/chat/types';

function Line({ e }: { e: SystemEvent }) {
  const { t } = useI18n();
  return <span>{t(missedCallKey(e), { actor: 'Ahmet' })}</span>;
}

const line = (e: Partial<SystemEvent>): SystemEvent => ({
  type: 'call_missed',
  actorId: null,
  ...e,
});

describe('call lines in the chat', () => {
  it.each([
    [line({}), 'Cevapsız sesli arama · Ahmet'],
    [line({ callOutcome: 'missed', video: true }), 'Cevapsız görüntülü arama · Ahmet'],
    [line({ callOutcome: 'cancelled' }), 'Cevapsız sesli arama · Ahmet'],
    [line({ callOutcome: 'declined' }), 'Reddedilen sesli arama · Ahmet'],
    [line({ callOutcome: 'busy', video: true }), 'Reddedilen görüntülü arama · Ahmet · Meşgul'],
  ])('says what happened to a call nobody answered', (e, text) => {
    render(
      <I18nProvider locale="tr">
        <Line e={e} />
      </I18nProvider>,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('writes a call length as m:ss or h:mm:ss', () => {
    expect(callLength(0)).toBe('0:00');
    expect(callLength(313)).toBe('5:13');
    expect(callLength(3727)).toBe('1:02:07');
  });
});
