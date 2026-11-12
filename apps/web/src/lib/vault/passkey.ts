import {
  fromB64,
  secretUnlockMaterial,
  toB64,
  toB64Url,
  newPrfSalt,
  wrapForSecret,
} from '@crewhall/crypto';
import { type VaultUnlockMethod } from '@crewhall/shared';
import { api } from '@/lib/api';
import { requireUnlocked } from './session';

/**
 * Passkey unlock with the WebAuthn PRF extension (design 8.3, 8.16): the authenticator turns a
 * per-credential salt into 32 secret bytes that never leave this device; they wrap a copy of
 * the private key. The vault uses its own credential, separate from sign-in passkeys.
 */

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

export function passkeySupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';
}

const toBuf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

function b64urlToBytes(s: string) {
  return fromB64(s.replace(/-/g, '+').replace(/_/g, '/'));
}

async function evaluate(credentialId: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: toBuf(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: toBuf(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const out = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  if (!out) throw new Error('prf_unsupported');
  return new Uint8Array(out);
}

/** Registers a vault passkey and stores a PRF-wrapped copy of the private key. */
export async function addPasskeyUnlock(label: string, passwordVerifier: Uint8Array) {
  const u = requireUnlocked();
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: document.title || 'Crewhall', id: location.hostname },
      user: {
        id: new TextEncoder().encode(u.userId),
        name: label,
        displayName: label,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new Error('cancelled');
  const enabled = (created.getClientExtensionResults() as PrfResults).prf?.enabled;
  if (enabled === false) throw new Error('prf_unsupported');
  const rawId = new Uint8Array(created.rawId);
  const salt = newPrfSalt();
  const secret = await evaluate(rawId, fromB64(salt));
  const wrap = wrapForSecret(u.privateKey, u.userId, 'passkey_prf', secret);
  secret.fill(0);
  return api.call('vaultAddUnlockMethod', {
    body: {
      proof: { method: 'password', verifier: toB64(passwordVerifier) },
      method: 'passkey_prf',
      label,
      credentialId: toB64Url(rawId),
      prfSalt: salt,
      ...wrap,
    },
  });
}

/** Same spelling as the authenticator's rawId turned into base64url. */
const canonicalId = (id: string) => toB64Url(b64urlToBytes(id));

/**
 * Unlock material from whichever registered vault passkey is on this device. Every passkey is
 * offered (one may live in the browser's password manager, another in Windows Hello or a phone),
 * each with its own salt through `evalByCredential`; the one the person uses picks the method.
 * Throws `no_passkey` when none of them is here (WebAuthn reports that like a cancel).
 */
export async function passkeyUnlock(methods: VaultUnlockMethod[]) {
  const usable = methods.filter((m) => m.credentialId && m.prfSalt);
  if (!usable.length) throw new Error('no_passkey');
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: usable.map((m) => ({
          type: 'public-key' as const,
          id: toBuf(b64urlToBytes(m.credentialId!)),
        })),
        userVerification: 'required',
        extensions: {
          prf: {
            evalByCredential: Object.fromEntries(
              usable.map((m) => [
                canonicalId(m.credentialId!),
                { first: toBuf(fromB64(m.prfSalt!)) },
              ]),
            ),
          },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      throw new Error('no_passkey', { cause: e });
    }
    throw e;
  }
  if (!cred) throw new Error('no_passkey');
  const used = toB64Url(new Uint8Array(cred.rawId));
  const method = usable.find((m) => canonicalId(m.credentialId!) === used);
  if (!method) throw new Error('no_passkey');
  const out = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!out) throw new Error('prf_unsupported');
  const secret = new Uint8Array(out);
  const material = secretUnlockMaterial(secret);
  secret.fill(0);
  return { method, material };
}
