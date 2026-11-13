import { describe, expect, it } from 'vitest';
import {
  chatPlainText,
  chatTextLinks,
  parseChatInline,
  parseChatText,
  toggleChatMark,
} from './chat-format';

const t = (text: string) => ({ kind: 'text' as const, text });

describe('parseChatInline', () => {
  it('reads bold, italic and strike in both common forms', () => {
    expect(parseChatInline('a *b* c')).toEqual([
      t('a '),
      { kind: 'bold', children: [t('b')] },
      t(' c'),
    ]);
    expect(parseChatInline('**b**')).toEqual([{ kind: 'bold', children: [t('b')] }]);
    expect(parseChatInline('_i_')).toEqual([{ kind: 'italic', children: [t('i')] }]);
    expect(parseChatInline('~s~ ~~s~~')).toEqual([
      { kind: 'strike', children: [t('s')] },
      t(' '),
      { kind: 'strike', children: [t('s')] },
    ]);
  });

  it('nests markers', () => {
    expect(parseChatInline('*bold _both_ bold*')).toEqual([
      {
        kind: 'bold',
        children: [t('bold '), { kind: 'italic', children: [t('both')] }, t(' bold')],
      },
    ]);
    expect(parseChatInline('*a **b** c*')).toEqual([
      {
        kind: 'bold',
        children: [t('a '), { kind: 'bold', children: [t('b')] }, t(' c')],
      },
    ]);
  });

  it('leaves markers inside words, around spaces and across lines alone', () => {
    for (const s of [
      'snake_case_name',
      '2*3*4',
      'a * b * c',
      '* not closed',
      '*a\nb*',
      '_ x_',
      '__dunder__',
      '***',
      'price ~10 and ~20',
    ]) {
      expect(parseChatInline(s)).toEqual([t(s)]);
    }
  });

  it('works after punctuation', () => {
    expect(parseChatInline('(*b*), "_i_".')).toEqual([
      t('('),
      { kind: 'bold', children: [t('b')] },
      t('), "'),
      { kind: 'italic', children: [t('i')] },
      t('".'),
    ]);
  });

  it('never formats inside code spans', () => {
    expect(parseChatInline('*a `x*y_z` b*')).toEqual([
      { kind: 'bold', children: [t('a '), { kind: 'code', text: 'x*y_z' }, t(' b')] },
    ]);
    expect(parseChatInline('`*not bold*`')).toEqual([{ kind: 'code', text: '*not bold*' }]);
  });

  it('keeps links and mentions whole, also inside markers', () => {
    expect(parseChatInline('see https://x.com/a_b_c/d*e and <@u-1>')).toEqual([
      t('see '),
      { kind: 'link', url: 'https://x.com/a_b_c/d*e' },
      t(' and '),
      { kind: 'mention', userId: 'u-1' },
    ]);
    expect(parseChatInline('*https://x.com*')).toEqual([
      { kind: 'bold', children: [{ kind: 'link', url: 'https://x.com' }] },
    ]);
    expect(parseChatInline('_<@all>_ (https://x.com/path).')).toEqual([
      { kind: 'italic', children: [{ kind: 'mention', userId: 'all' }] },
      t(' ('),
      { kind: 'link', url: 'https://x.com/path' },
      t(').'),
    ]);
  });

  it('treats markup-looking text as text (no HTML)', () => {
    expect(parseChatInline('<b>*x*</b>')).toEqual([
      t('<b>'),
      { kind: 'bold', children: [t('x')] },
      t('</b>'),
    ]);
  });
});

describe('parseChatText', () => {
  it('splits fenced code, paragraphs and lists', () => {
    const blocks = parseChatText(
      'Plan:\n- *one*\n- two\n1. first\n2) second\nafter\n```ts\nconst a = *1*;\n```\nend',
    );
    expect(blocks).toEqual([
      { kind: 'paragraph', children: [t('Plan:')] },
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [[{ kind: 'bold', children: [t('one')] }], [t('two')]],
      },
      { kind: 'list', ordered: true, start: 1, items: [[t('first')], [t('second')]] },
      { kind: 'paragraph', children: [t('after')] },
      { kind: 'code', text: 'const a = *1*;', lang: 'ts' },
      { kind: 'paragraph', children: [t('end')] },
    ]);
  });

  it('keeps the first number of a numbered list and accepts • bullets', () => {
    expect(parseChatText('3. c\n4. d')).toEqual([
      { kind: 'list', ordered: true, start: 3, items: [[t('c')], [t('d')]] },
    ]);
    expect(parseChatText('• a\n* b')[0]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('keeps line breaks in paragraphs and returns nothing for blank text', () => {
    expect(parseChatText('a\nb')).toEqual([{ kind: 'paragraph', children: [t('a\nb')] }]);
    expect(parseChatText('  ')).toEqual([]);
    expect(parseChatText('*bold*')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'bold', children: [t('bold')] }] },
    ]);
  });
});

describe('chatPlainText and chatTextLinks', () => {
  it('drops markers and keeps list numbers', () => {
    expect(chatPlainText('*hi* <@u1>\n- _a_\n2. b', (id) => `@${id}`)).toBe('hi @u1\n• a\n2. b');
  });

  it('lists links outside code, once each', () => {
    expect(
      chatTextLinks(
        'https://a.com and *https://b.com/x*. `https://c.com` https://a.com\n```\nhttps://d.com\n```\n- https://e.com',
      ),
    ).toEqual(['https://a.com', 'https://b.com/x', 'https://e.com']);
  });
});

describe('toggleChatMark', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(toggleChatMark('say hello now', 4, 9, '*')).toEqual({
      text: 'say *hello* now',
      start: 5,
      end: 10,
    });
  });

  it('keeps spaces outside the markers', () => {
    expect(toggleChatMark('a hello b', 1, 8, '_')).toEqual({
      text: 'a _hello_ b',
      start: 3,
      end: 8,
    });
  });

  it('unwraps when already wrapped (outside or inside the selection)', () => {
    expect(toggleChatMark('say *hello* now', 5, 10, '*')).toEqual({
      text: 'say hello now',
      start: 4,
      end: 9,
    });
    expect(toggleChatMark('say ~hello~ now', 4, 11, '~')).toEqual({
      text: 'say hello now',
      start: 4,
      end: 9,
    });
  });

  it('puts the caret between two markers for an empty selection', () => {
    expect(toggleChatMark('ab', 1, 1, '*')).toEqual({ text: 'a**b', start: 2, end: 2 });
  });
});
