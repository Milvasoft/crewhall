// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/rsa-keygen/logic.ts. See THIRD_PARTY.md.
/** RSA key-pair generation via Web Crypto, exported as PEM. Fully local. */

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toPem(base64: string, label: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

export interface RsaKeyPair {
  publicKey: string;
  privateKey: string;
}

export async function generateRsaKeyPair(modulusLength = 2048): Promise<RsaKeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]), // 65537
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    publicKey: toPem(toBase64(spki), 'PUBLIC KEY'),
    privateKey: toPem(toBase64(pkcs8), 'PRIVATE KEY'),
  };
}
