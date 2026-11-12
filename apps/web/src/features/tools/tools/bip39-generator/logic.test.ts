// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bip39-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  validateMnemonic,
} from './logic';

const ALL_ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('bip39-generator', () => {
  it('matches the canonical zero-entropy vector', async () => {
    const entropy = new Uint8Array(16); // all zeros
    expect(await entropyToMnemonic(entropy)).toBe(ALL_ABANDON);
  });

  it('recovers entropy from a mnemonic', async () => {
    const entropy = await mnemonicToEntropy(ALL_ABANDON);
    expect(bytesToHex(entropy)).toBe('00000000000000000000000000000000');
  });

  it('derives the Trezor seed vector (passphrase TREZOR)', async () => {
    const seed = await mnemonicToSeed(ALL_ABANDON, 'TREZOR');
    expect(bytesToHex(seed)).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it('rejects a bad checksum and unknown words', async () => {
    const bad =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    expect(await validateMnemonic(bad)).toBe(false);
    expect(await validateMnemonic('not a real bip39 phrase here at all now')).toBe(false);
  });

  it('round-trips random 24-word entropy', async () => {
    const entropy = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
    const mnemonic = await entropyToMnemonic(entropy);
    expect(mnemonic.split(' ')).toHaveLength(24);
    expect(bytesToHex(await mnemonicToEntropy(mnemonic))).toBe(bytesToHex(entropy));
  });

  it('generates a valid, unique 12-word mnemonic by default', async () => {
    const a = await generateMnemonic();
    const b = await generateMnemonic();
    expect(a.split(' ')).toHaveLength(12);
    expect(a).not.toBe(b); // random entropy, extremely unlikely to collide
    expect(await validateMnemonic(a)).toBe(true);
  });

  it.each([
    [128, 12],
    [160, 15],
    [192, 18],
    [224, 21],
    [256, 24],
  ])('generateMnemonic(%i) produces %i words', async (strength, wordCount) => {
    const mnemonic = await generateMnemonic(strength);
    expect(mnemonic.split(' ')).toHaveLength(wordCount);
    expect(await validateMnemonic(mnemonic)).toBe(true);
  });

  it('rejects strengths that are not valid BIP39 steps', async () => {
    await expect(generateMnemonic(100)).rejects.toThrow(
      'Strength must be 128, 160, 192, 224 or 256 bits.',
    );
    await expect(generateMnemonic(127)).rejects.toThrow();
    await expect(generateMnemonic(288)).rejects.toThrow();
  });

  it('rejects entropy lengths outside the valid set', async () => {
    await expect(entropyToMnemonic(new Uint8Array(15))).rejects.toThrow(
      'Entropy must be 128–256 bits (in 32-bit steps).',
    );
    await expect(entropyToMnemonic(new Uint8Array(0))).rejects.toThrow();
  });

  it('rejects mnemonics with a word count outside the valid set', async () => {
    await expect(mnemonicToEntropy('abandon abandon')).rejects.toThrow(
      'A mnemonic has 12, 15, 18, 21 or 24 words.',
    );
    await expect(mnemonicToEntropy('')).rejects.toThrow();
  });

  it('rejects mnemonics containing a word not in the wordlist', async () => {
    const bad = ALL_ABANDON.replace(/^abandon/, 'notaword');
    await expect(mnemonicToEntropy(bad)).rejects.toThrow('Not a BIP39 word: "notaword".');
  });

  it('is case-insensitive and tolerant of extra whitespace', async () => {
    const messy = `  ${ALL_ABANDON.toUpperCase().split(' ').join('   ')}  `;
    const entropy = await mnemonicToEntropy(messy);
    expect(bytesToHex(entropy)).toBe('00000000000000000000000000000000');
  });

  it('validateMnemonic returns false for empty or whitespace-only input', async () => {
    expect(await validateMnemonic('')).toBe(false);
    expect(await validateMnemonic('   ')).toBe(false);
  });

  it('derives a 64-byte seed with an empty passphrase by default', async () => {
    const seed = await mnemonicToSeed(ALL_ABANDON);
    expect(seed).toHaveLength(64);
    // Deterministic given the same mnemonic and empty passphrase.
    const seed2 = await mnemonicToSeed(ALL_ABANDON, '');
    expect(bytesToHex(seed)).toBe(bytesToHex(seed2));
  });
});
