import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { notificationTitle } from '@/components/notifications/text';
import type { Notification } from '@/lib/chat/types';
import { I18nProvider, useI18n } from '@/lib/i18n/I18nContext';

const translator = (locale: 'tr' | 'en') =>
  renderHook(() => useI18n(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <I18nProvider locale={locale}>{children}</I18nProvider>
    ),
  }).result.current.t;

const note = (type: string, data: Notification['data'], count = 1): Notification => ({
  id: '01a157ef-56c0-7944-8111-dcb4b723bf46',
  type,
  category: 'mention',
  source: 'pages',
  actor: {
    id: '01a157ef-50da-7a8a-b80c-941119e0d28d',
    name: 'Mert',
    email: 'mert@milvasoft.com',
    imageUrl: null,
  },
  target: {
    type: 'node',
    id: '01a157ef-56c0-7944-8111-dcb4b723bf47',
    conversationId: null,
    seq: null,
    spaceId: null,
  },
  data,
  count,
  url: '/',
  readAt: null,
  snoozedUntil: null,
  dismissedAt: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
});

describe('notification titles', () => {
  it('names the page for wiki notifications', () => {
    const tr = translator('tr');
    const en = translator('en');
    expect(notificationTitle(note('page.mention', { name: 'Mimari' }), tr)).toBe(
      'Mert, Mimari sayfasında senden bahsetti',
    );
    expect(notificationTitle(note('page.comment_mention', { name: 'Mimari' }), en)).toBe(
      'Mert mentioned you in a comment on Mimari',
    );
    expect(notificationTitle(note('page.comment_reply', { name: 'Mimari' }, 3), tr)).toBe(
      'Mimari sayfasındaki yorumuna 3 yeni yanıt',
    );
    expect(notificationTitle(note('page.restored', { name: 'Mimari' }), en)).toBe(
      'Mert restored Mimari to an earlier version',
    );
    expect(notificationTitle(note('page.updated', { name: 'Mimari' }), en)).toBe(
      'Mert updated Mimari',
    );
  });

  it('uses the boards texts instead of the generic title', () => {
    const tr = translator('tr');
    const data = { key: 'ATM-1', title: 'Kilit', boardName: 'Atölye' };
    expect(notificationTitle(note('boards.assigned', data), tr)).toBe(
      'Mert seni ATM-1 kartına atadı: Kilit',
    );
    expect(notificationTitle(note('boards.comment', data), tr)).toBe(
      'Mert ATM-1 kartına yorum yazdı',
    );
    expect(notificationTitle(note('boards.due_soon', data), translator('en'))).toBe(
      'ATM-1 is due soon: Kilit',
    );
    expect(notificationTitle(note('unknown.thing', {}), tr)).toBe('Yeni bildirim');
  });
});

describe('plugin notifications', () => {
  it('lead with the plugin name', () => {
    const data = { plugin: 'WhatsApp', title: 'Ayşe', excerpt: 'Yarın?' };
    expect(notificationTitle(note('plugin.notification', data), translator('tr'))).toBe(
      'WhatsApp · Ayşe',
    );
  });
});

describe('channel emoji in notification titles', () => {
  it('leads the conversation name', () => {
    const t = translator('tr');
    const rocket = String.fromCodePoint(0x1f680);
    const n = note('chat.mention', { conversationTitle: 'Roket', conversationEmoji: rocket });
    expect(notificationTitle(n, t)).toContain(`${rocket} Roket`);
    expect(
      notificationTitle(note('chat.mention', { conversationTitle: 'Roket' }), t),
    ).not.toContain(rocket);
  });
});
