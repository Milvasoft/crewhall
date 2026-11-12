import { describe, expect, it } from 'vitest';
import { pushText } from '../src/services/notifications/push';

type Row = Parameters<typeof pushText>[0];
const row = (type: string, payload: Record<string, string>) =>
  ({ type, payload, count: 1 }) as unknown as Row;

describe('push text for meetings', () => {
  it('says a meeting moved or was cancelled, with its title', () => {
    const data = { actorName: 'Buğra', title: 'Planlama' };
    expect(pushText(row('meet.updated', data), 'tr').title).toBe(
      'Buğra toplantıyı değiştirdi: Planlama',
    );
    expect(pushText(row('meet.cancelled', data), 'tr').title).toBe(
      'Toplantı iptal edildi: Planlama',
    );
    expect(pushText(row('meet.cancelled', data), 'en').title).toBe('Meeting cancelled: Planlama');
  });

  it('says someone is calling you into a meeting, or did not come', () => {
    const data = { actorName: 'Elif', title: 'Haftalık' };
    expect(pushText(row('meet.call', { ...data, invite: true } as never), 'tr').title).toBe(
      'Elif seni toplantıya çağırıyor',
    );
    expect(pushText(row('meet.ring_declined', data), 'tr').title).toBe(
      'Elif toplantıya katılamadı',
    );
    expect(pushText(row('meet.ring_unanswered', data), 'en').title).toBe(
      "Elif didn't answer your call",
    );
  });
});
