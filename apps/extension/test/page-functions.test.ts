import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillLoginForm, probeLoginForm, readPageContent } from '../src/shared/page-functions';

const origin = location.origin;

afterEach(() => {
  document.body.innerHTML = '';
  getSelection()?.removeAllRanges();
});

const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe('finding a login form', () => {
  it('sees user, password and code fields', () => {
    document.body.innerHTML = '<form><input id="u" name="username"><input id="p" type="password"><input name="otp"></form>';
    expect(probeLoginForm()).toMatchObject({ hasUsername: true, hasPassword: true, hasOtp: true });
  });

  it('ignores hidden and disabled fields', () => {
    document.body.innerHTML = '<input type="password" style="display:none"><input type="password" disabled>';
    expect(probeLoginForm().hasPassword).toBe(false);
  });
});

describe('filling', () => {
  it('writes the user and the password and tells the page', () => {
    document.body.innerHTML = '<form><input id="u" type="email"><input id="p" type="password"></form>';
    const events = vi.fn();
    document.body.addEventListener('input', events);
    expect(fillLoginForm({ origin, username: 'ada', password: 'gizli' })).toBe(true);
    expect(value('u')).toBe('ada');
    expect(value('p')).toBe('gizli');
    expect(events).toHaveBeenCalledTimes(2);
  });

  it('uses the field right before the password when names say nothing', () => {
    document.body.innerHTML = '<form><input id="a"><input id="b"><input id="p" type="password"><input id="c"></form>';
    fillLoginForm({ origin, username: 'ada', password: 'gizli' });
    expect(value('b')).toBe('ada');
    expect(value('a')).toBe('');
    expect(value('c')).toBe('');
  });

  it('works on a two-step form with only a user name', () => {
    document.body.innerHTML = '<input id="u" autocomplete="username">';
    expect(fillLoginForm({ origin, username: 'ada', password: 'gizli' })).toBe(true);
    expect(value('u')).toBe('ada');
  });

  it('refuses when the page is no longer the expected site', () => {
    document.body.innerHTML = '<input id="p" type="password">';
    expect(fillLoginForm({ origin: 'https://other.test', password: 'gizli' })).toBe(false);
    expect(value('p')).toBe('');
  });

  it('skips hidden password fields', () => {
    document.body.innerHTML = '<input id="h" type="password" style="visibility:hidden"><input id="p" type="password">';
    fillLoginForm({ origin, password: 'gizli' });
    expect(value('h')).toBe('');
    expect(value('p')).toBe('gizli');
  });

  it('puts the code in the code field', () => {
    document.body.innerHTML = '<input id="o" autocomplete="one-time-code">';
    expect(fillLoginForm({ origin, otp: '123456' })).toBe(true);
    expect(value('o')).toBe('123456');
  });

  it('writes a generated password to new-password fields, not the current one', () => {
    document.body.innerHTML =
      '<input id="c" type="password" autocomplete="current-password"><input id="n" type="password" autocomplete="new-password"><input id="r" type="password" autocomplete="new-password">';
    expect(fillLoginForm({ origin, password: 'yeni', allPasswords: true })).toBe(true);
    expect(value('c')).toBe('');
    expect(value('n')).toBe('yeni');
    expect(value('r')).toBe('yeni');
  });
});

describe('reading a page', () => {
  it('prefers the article', () => {
    document.body.innerHTML = '<nav>menü</nav><article><p>metin</p></article>';
    expect(readPageContent()).toMatchObject({ html: '<p>metin</p>', selection: false });
  });

  it('takes the selection when there is one', () => {
    document.body.innerHTML = '<p id="a">seçili</p><p>değil</p>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('a')!);
    getSelection()!.addRange(range);
    expect(readPageContent()).toMatchObject({ html: 'seçili', selection: true });
  });

  it('stays within the limit', () => {
    document.body.innerHTML = `<main>${'a'.repeat(100)}</main>`;
    expect(readPageContent(10).html).toHaveLength(10);
  });
});
