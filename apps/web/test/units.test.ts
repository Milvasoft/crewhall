import { type DriveNode, type Meeting } from '@crewhall/shared';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { passwordScore } from '@/components/auth/PasswordStrength';
import { canMoveInto } from '@/features/drive/dnd';
import { pagePreview, pickMeeting } from '@/features/quick/moduleCards';
import { formatBytes } from '@/lib/i18n/format';
import { safeRedirect } from '@/lib/redirect';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

describe('safeRedirect', () => {
  it('allows only in-app paths', () => {
    expect(safeRedirect('/account/security')).toBe('/account/security');
    expect(safeRedirect('https://evil.test')).toBe('/');
    expect(safeRedirect('//evil.test')).toBe('/');
    expect(safeRedirect('/login/2fa')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
  });
});

describe('passwordScore', () => {
  it('rewards length and penalizes personal info', () => {
    expect(passwordScore('kisa')).toBe(0);
    expect(passwordScore('kuzey-fener-bulut-42')).toBe(4);
    expect(passwordScore('bugra-2026-sifre', ['bugra'])).toBe(1);
  });
});

describe('formatBytes', () => {
  it('uses the locale decimal separator', () => {
    expect(formatBytes(4.2 * 1024 ** 2, 'tr')).toBe('4,2 MB');
    expect(formatBytes(4.2 * 1024 ** 2, 'en')).toBe('4.2 MB');
    expect(formatBytes(512, 'en')).toBe('512 B');
  });
});

describe('useDocumentTitle', () => {
  it('puts the org title back when the screen leaves', () => {
    document.title = 'Milvasoft · Crewhall';
    const { rerender, unmount } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: undefined as string | undefined },
    });
    expect(document.title).toBe('Milvasoft · Crewhall');
    rerender({ title: 'Hub mimarisi' });
    expect(document.title).toBe('Hub mimarisi');
    unmount();
    expect(document.title).toBe('Milvasoft · Crewhall');
  });
});

describe('canMoveInto', () => {
  const node = (id: string, parentId: string | null, spaceId = 's1') =>
    ({ id, parentId, spaceId }) as DriveNode;
  it('refuses no-op moves and folders going into themselves or below', () => {
    const a = node('a', null);
    const b = node('b', 'x');
    expect(canMoveInto([a], { spaceId: 's1', id: 'f' })).toBe(true);
    expect(canMoveInto([a], { spaceId: 's1', id: null })).toBe(false);
    expect(canMoveInto([a, b], { spaceId: 's1', id: null })).toBe(true);
    expect(canMoveInto([a], { spaceId: 's2', id: null })).toBe(true);
    expect(canMoveInto([a], { spaceId: 's1', id: 'a' })).toBe(false);
    expect(canMoveInto([a], { spaceId: 's1', id: 'c', ancestorIds: ['a', 'b'] })).toBe(false);
    expect(canMoveInto([], { spaceId: 's1', id: 'f' })).toBe(false);
  });
});

describe('module cards (H4)', () => {
  it('previews a page as plain text', () => {
    const md = [
      '# Başlık',
      '',
      '- [x] **Bitti** madde',
      '> alıntı',
      '[[Mimari|mimari sayfası]] ve [link](https://x.test)',
      '```',
      'kod',
      '```',
    ].join('\n');
    expect(pagePreview(md)).toBe(['Başlık', 'Bitti madde', 'alıntı', 'Mimari ve link'].join('\n'));
  });

  it('picks the live meeting first, else the next planned one in the space', () => {
    const m = (id: string, spaceId: string | null, startsAt: string | null) =>
      ({ id, spaceId, startsAt }) as Meeting;
    const now = Date.parse('2026-10-21T09:00:00Z');
    const later = m('later', 's1', '2026-10-21T15:00:00Z');
    const soon = m('soon', 's2', '2026-10-21T10:00:00Z');
    const old = m('old', 's1', '2026-10-20T10:00:00Z');
    expect(pickMeeting([], [later, soon, old], null, now)?.meeting.id).toBe('soon');
    expect(pickMeeting([], [later, soon, old], 's1', now)?.meeting.id).toBe('later');
    expect(pickMeeting([m('room', 's2', null)], [soon], null, now)).toMatchObject({
      live: true,
      meeting: { id: 'room' },
    });
    expect(pickMeeting([m('room', 's2', null)], [], 's1', now)).toBeNull();
  });
});
