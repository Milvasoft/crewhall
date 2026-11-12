import { describe, expect, it } from 'vitest';
import { parsePollInput, parseReminder, parseSlashCommand, parseWhen } from './chat-commands';
import {
  CreatePoll,
  GifSearchQuery,
  isGiphyMediaUrl,
  isReactionEmoji,
  SendMessage,
  VotePoll,
} from './schemas/chat';

// Thursday 22 October 2026, 14:10 local time.
const NOW = new Date(2026, 9, 22, 14, 10);
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe('parseSlashCommand', () => {
  it('reads known commands only, case-insensitively', () => {
    expect(parseSlashCommand('/remind 15dk toplantı')).toEqual({
      command: 'remind',
      rest: '15dk toplantı',
    });
    expect(parseSlashCommand('/ME kahve alıyor')).toEqual({ command: 'me', rest: 'kahve alıyor' });
    expect(parseSlashCommand('/meet')).toEqual({ command: 'meet', rest: '' });
    expect(parseSlashCommand('/meeting yarın')).toBeNull();
    expect(parseSlashCommand('/shrug')).toBeNull();
    expect(parseSlashCommand('selam /me')).toBeNull();
    expect(parseSlashCommand('/me\nikinci satır')?.rest).toBe('ikinci satır');
  });
});

describe('parseReminder', () => {
  it('reads relative times', () => {
    const r = parseReminder('15dk toplantı', NOW);
    expect(r?.at.getTime()).toBe(NOW.getTime() + 15 * 60_000);
    expect(r?.text).toBe('toplantı');
    expect(parseReminder('2 saat 30 dk rapor', NOW)?.at.getTime()).toBe(
      NOW.getTime() + 150 * 60_000,
    );
    expect(parseReminder('me in 10 minutes call Ali', NOW)?.text).toBe('call Ali');
    expect(parseReminder('1g sonra fatura', NOW)?.text).toBe('fatura');
  });

  it('reads days and times', () => {
    expect(parseReminder('yarın 9:00 sunum', NOW)?.at.getTime()).toBe(at(2026, 10, 23, 9));
    expect(parseReminder('yarın sunum', NOW)?.at.getTime()).toBe(at(2026, 10, 23, 9));
    expect(parseReminder("bugün 17'de çık", NOW)?.at.getTime()).toBe(at(2026, 10, 22, 17));
    expect(parseReminder('cuma saat 14.30 demo', NOW)?.at.getTime()).toBe(at(2026, 10, 23, 14, 30));
    // Same weekday means next week.
    expect(parseReminder('perşembe 10:00 x', NOW)?.at.getTime()).toBe(at(2026, 10, 29, 10));
    expect(parseReminder('25/12 10:00 tatil', NOW)?.at.getTime()).toBe(at(2026, 12, 25, 10));
    expect(parseReminder('tomorrow 3pm standup', NOW)?.at.getTime()).toBe(at(2026, 10, 23, 15));
  });

  it('rolls a passed time to tomorrow and refuses what it cannot read', () => {
    expect(parseReminder('09:30 su iç', NOW)?.at.getTime()).toBe(at(2026, 10, 23, 9, 30));
    expect(parseReminder('18:00 spor', NOW)?.at.getTime()).toBe(at(2026, 10, 22, 18));
    expect(parseReminder('5 elma al', NOW)).toBeNull();
    expect(parseReminder('toplantı', NOW)).toBeNull();
    expect(parseReminder('bugün 9:00 geçti', NOW)).toBeNull();
    expect(parseReminder('31/02 10:00 yok', NOW)).toBeNull();
  });
});

describe('poll and whisper inputs', () => {
  it('splits a poll line', () => {
    expect(parsePollInput('Öğle? | Pizza | Döner')).toEqual({
      question: 'Öğle?',
      options: ['Pizza', 'Döner'],
    });
    expect(parsePollInput('Sadece soru')).toEqual({ question: 'Sadece soru', options: [] });
  });

  it('validates poll and send bodies', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(CreatePoll.safeParse({ clientMsgId: id, question: 'Q', options: ['a'] }).success).toBe(
      false,
    );
    expect(
      CreatePoll.parse({ clientMsgId: id, question: ' Q ', options: ['a', 'b'] }),
    ).toMatchObject({ question: 'Q', multiple: false });
    expect(VotePoll.safeParse({ options: [10] }).success).toBe(false);
    expect(SendMessage.parse({ clientMsgId: id, text: 'x', whisperTo: id }).whisperTo).toBe(id);
  });
});

describe('isReactionEmoji (S1)', () => {
  const e = (...cps: number[]) => String.fromCodePoint(...cps);
  it('accepts one emoji grapheme, with skin tones and ZWJ sequences', () => {
    for (const ok of [
      e(0x1f44d), // thumbs up
      e(0x2764, 0xfe0f), // red heart
      e(0x1f44d, 0x1f3fd), // thumbs up, medium skin tone
      e(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466), // family
      e(0x1f1f9, 0x1f1f7), // flag TR
      e(0x31, 0xfe0f, 0x20e3), // keycap 1
      e(0x2615), // hot beverage
    ]) {
      expect(isReactionEmoji(ok), ok).toBe(true);
    }
  });
  it('refuses text, question marks and several emoji', () => {
    for (const bad of ['??', '?', 'ok', '1', '#', ' ', '', e(0x1f44d, 0x1f44d), `${e(0x1f44d)}a`]) {
      expect(isReactionEmoji(bad), bad).toBe(false);
    }
  });
});

describe('parseWhen (scheduled messages)', () => {
  it('reads Turkish and English times', () => {
    const cases: [string, number, string][] = [
      ['yarın 9:00 Toplantıyı unutmayın', at(2026, 10, 23, 9), 'Toplantıyı unutmayın'],
      ['öbür gün 10:00 rapor', at(2026, 10, 24, 10), 'rapor'],
      ['day after tomorrow 10am report', at(2026, 10, 24, 10), 'report'],
      ['pazartesi sprint', at(2026, 10, 26, 9), 'sprint'],
      ['monday 14:00 sprint', at(2026, 10, 26, 14), 'sprint'],
      ['2026-10-25 14:30 tatil planı', at(2026, 10, 25, 14, 30), 'tatil planı'],
      ['15:00 kahve', at(2026, 10, 22, 15), 'kahve'],
      ['in 2 hours deploy', NOW.getTime() + 120 * 60_000, 'deploy'],
      ['2 saat sonra deploy', NOW.getTime() + 120 * 60_000, 'deploy'],
      ['30dk mola', NOW.getTime() + 30 * 60_000, 'mola'],
    ];
    for (const [input, when, text] of cases) {
      const r = parseWhen(input, NOW);
      expect(r?.at.getTime(), input).toBe(when);
      expect(r?.text, input).toBe(text);
    }
    expect(parseWhen('toplantı yarın', NOW)).toBeNull();
    expect(parseWhen('2026-02-30 10:00 x', NOW)).toBeNull();
    expect(parseSlashCommand('/zamanla yarın 9:00 selam')).toEqual({
      command: 'zamanla',
      rest: 'yarın 9:00 selam',
    });
  });
});

describe('GIF contract', () => {
  it('accepts only GIPHY media URLs', () => {
    expect(isGiphyMediaUrl('https://media2.giphy.com/media/abc/giphy.gif')).toBe(true);
    expect(isGiphyMediaUrl('https://media.giphy.com/media/abc/200w.webp?cid=1')).toBe(true);
    for (const bad of [
      'http://media.giphy.com/media/abc.gif',
      'https://giphy.com/gifs/abc',
      'https://media.giphy.com.evil.example/a.gif',
      'https://evil.example/media.giphy.com/a.gif',
      'https://user@media.giphy.com/a.gif',
      'javascript:alert(1)',
    ]) {
      expect(isGiphyMediaUrl(bad), bad).toBe(false);
    }
    const id = '00000000-0000-4000-8000-000000000001';
    const gif = {
      provider: 'giphy',
      id: 'abc',
      url: 'https://media.giphy.com/media/abc/giphy.gif',
      width: 480,
      height: 270,
    };
    expect(SendMessage.parse({ clientMsgId: id, gif }).gif?.title).toBe('');
    expect(GifSearchQuery.safeParse({ q: ' ' }).success).toBe(false);
  });
});
