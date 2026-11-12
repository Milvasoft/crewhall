import { ZxcvbnFactory, type ZxcvbnResult } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';
import * as tr from '@zxcvbn-ts/language-tr';

/**
 * Password strength on the device (zxcvbn-ts, MIT; doc 17 §7: "en az güçlü seviyesi istenir").
 * A separate entry point (`@crewhall/crypto/strength`) because the dictionaries are large:
 * screens load it lazily. Feedback is returned as levels and numbers; texts come from i18n.
 */

export type StrengthLevel = 'weak' | 'fair' | 'strong' | 'very_strong';

export interface Strength {
  /** zxcvbn score 0-4. */
  score: 0 | 1 | 2 | 3 | 4;
  level: StrengthLevel;
  guessesLog10: number;
  /** Offline attack against a slow hash (Argon2id-like): what the UI calls "kırılma süresi". */
  crackSeconds: number;
  /** Matched a known leaked-password list (checked on the device). */
  leaked: boolean;
  /** Contains one of the user inputs (e-mail, name). */
  containsUserInput: boolean;
  length: number;
}

let factory: ZxcvbnFactory | null = null;

function zxcvbn(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary, ...tr.dictionary },
    // Measured (2026-10-21, Node 22): Levenshtein over these dictionaries costs 230-520 ms per
    // password and 100+ ms with the default l33t cap on symbol-heavy generated passwords; without
    // Levenshtein and with at most 3 l33t substitutions it is 5-10 ms with the same scores on our
    // samples. Leaked and dictionary words are still matched exactly and with common l33t.
    useLevenshteinDistance: false,
    l33tMaxSubstitutions: 3,
    maxLength: 64,
  });
  return factory;
}

const LEVELS: StrengthLevel[] = ['weak', 'weak', 'fair', 'strong', 'very_strong'];

export function measureStrength(password: string, userInputs: string[] = []): Strength {
  // E-mail local parts and name pieces count as guessable inputs too.
  const inputs = userInputs
    .flatMap((s) => [s, ...s.split(/[@.\s_-]+/)])
    .filter((s) => s.length >= 3);
  const result: ZxcvbnResult = zxcvbn().check(password, inputs);
  const dictionaryNames = result.sequence
    .filter((m) => m.pattern === 'dictionary')
    .map((m) => String((m as { dictionaryName?: string }).dictionaryName ?? ''));
  return {
    score: result.score,
    level: LEVELS[result.score] ?? 'weak',
    guessesLog10: result.guessesLog10,
    crackSeconds: result.crackTimes.offlineSlowHashingXPerSecond.seconds,
    leaked: dictionaryNames.some((n) => n.startsWith('passwords')),
    containsUserInput: dictionaryNames.includes('userInputs'),
    length: [...password].length,
  };
}

/** Vault password rule (design 8.1): at least 12 characters and "strong". */
export const VAULT_PASSWORD_MIN_LENGTH = 12;

export function vaultPasswordChecks(password: string, userInputs: string[] = []) {
  const s = measureStrength(password, userInputs);
  const lower = password.toLocaleLowerCase('tr-TR');
  const containsInput =
    s.containsUserInput ||
    userInputs.some((u) =>
      u
        .toLocaleLowerCase('tr-TR')
        .split(/[@.\s_-]+/)
        .some((part) => part.length >= 3 && lower.includes(part)),
    );
  const checks = {
    length: s.length >= VAULT_PASSWORD_MIN_LENGTH,
    noPersonalInfo: !containsInput,
    notLeaked: !s.leaked,
    strong: s.score >= 3,
  };
  return { strength: s, checks, ok: Object.values(checks).every(Boolean) };
}
