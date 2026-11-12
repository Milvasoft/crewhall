import { CryptoError } from './bytes';
import { randomInt, shuffle } from './random';
import { WORDLISTS, type WordlistLang } from './wordlists';

/**
 * Password and passphrase generator (design 8.9). Uses the injected secure random source with
 * rejection sampling, so there is no modulo bias.
 */

export const CHARSETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*',
} as const;

/** Removed with "Benzer karakterleri çıkar": l 1 I O 0 (and o, |). */
const AMBIGUOUS = new Set(['l', '1', 'I', 'O', '0', 'o']);

export interface PasswordOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 22,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};

export const PASSWORD_LENGTH = { min: 8, max: 64 } as const;

function classes(o: PasswordOptions): string[] {
  const picked = (['upper', 'lower', 'digits', 'symbols'] as const)
    .filter((k) => o[k])
    .map((k) => CHARSETS[k]);
  const sets = picked.map((s) =>
    o.avoidAmbiguous ? [...s].filter((c) => !AMBIGUOUS.has(c)).join('') : s,
  );
  if (!sets.length) throw new CryptoError('invalid_input', 'pick at least one character set');
  return sets;
}

/** Every chosen class appears at least once; positions are shuffled uniformly. */
export function generatePassword(options: Partial<PasswordOptions> = {}): string {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  const length = Math.round(o.length);
  if (length < PASSWORD_LENGTH.min || length > PASSWORD_LENGTH.max) {
    throw new CryptoError('invalid_input', 'password length out of range');
  }
  const sets = classes(o);
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)] as string);
  while (chars.length < length) chars.push(all[randomInt(all.length)] as string);
  return shuffle(chars).join('');
}

/** Upper bound of the entropy in bits (charset size ^ length), as shown next to the result. */
export function passwordEntropyBits(options: Partial<PasswordOptions> = {}): number {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...options };
  return Math.floor(o.length * Math.log2(classes(o).join('').length));
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  /** Appends one digit to one random word. */
  includeNumber: boolean;
  lang: WordlistLang;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  words: 5,
  separator: '-',
  capitalize: true,
  includeNumber: true,
  lang: 'en',
};

export const PASSPHRASE_WORDS = { min: 4, max: 10 } as const;

const capitalize = (w: string, lang: WordlistLang) =>
  (lang === 'tr' ? w.charAt(0).toLocaleUpperCase('tr-TR') : w.charAt(0).toUpperCase()) + w.slice(1);

export function generatePassphrase(options: Partial<PassphraseOptions> = {}): string {
  const o = { ...DEFAULT_PASSPHRASE_OPTIONS, ...options };
  if (o.words < PASSPHRASE_WORDS.min || o.words > PASSPHRASE_WORDS.max) {
    throw new CryptoError('invalid_input', 'word count out of range');
  }
  const list = WORDLISTS[o.lang];
  const words = Array.from({ length: o.words }, () => list[randomInt(list.length)] as string).map(
    (w) => (o.capitalize ? capitalize(w, o.lang) : w),
  );
  if (o.includeNumber) {
    const i = randomInt(words.length);
    words[i] = `${words[i]}${randomInt(10)}`;
  }
  return words.join(o.separator.slice(0, 3));
}

export function passphraseEntropyBits(options: Partial<PassphraseOptions> = {}): number {
  const o = { ...DEFAULT_PASSPHRASE_OPTIONS, ...options };
  const perWord = Math.log2(WORDLISTS[o.lang].length);
  return Math.floor(o.words * perWord + (o.includeNumber ? Math.log2(10 * o.words) : 0));
}
