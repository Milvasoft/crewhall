/**
 * @crewhall/crypto — zero-knowledge vault cryptography (doc 17 §7), shared by web and mobile.
 *
 * Pure TypeScript + WASM with no Node or DOM globals. Platform hooks:
 * - configureRandom(): secure random source (React Native: expo-crypto getRandomValues)
 * - configureArgon2id(): native Argon2id where WebAssembly is missing (Hermes); the pure-JS
 *   fallback works but is slow
 *
 * Password strength lives in `@crewhall/crypto/strength` (large dictionaries, load lazily).
 * The server never imports this package; only tests do.
 */

export * from './bytes';
export * from './random';
export * from './context';
export * from './aead';
export * from './kdf';
export * from './keys';
export * from './base32';
export * from './recovery';
export * from './account';
export * from './item';
export * from './vault';
export * from './attachment';
export * from './totp';
export * from './generator';
export * from './wordlists';
export * from './ssh';
export * from './bitwarden';
export * from './health';
export * from './summary';
export * from './breach';
export * from './share';
