/**
 * Passkeys in the desktop app (the vault unlocks with WebAuthn PRF).
 *
 * Windows: Chromium talks to Windows Hello and security keys through webauthn.dll; nothing to
 * configure. Phones work over the hybrid (QR) transport everywhere.
 *
 * macOS: Electron serves no platform authenticator until `app.configureWebAuthn` is called. Touch
 * ID needs a keychain access group that is also in the signed app's `keychain-access-groups`
 * entitlement (`<TEAM_ID>.<BUNDLE_ID>.webauthn`), so it is only switched on for a signed build
 * that names the group (CREWHALL_MAC_KEYCHAIN_GROUP at build time). Unsigned builds keep phones
 * and security keys.
 */
export function macWebAuthnOptions(
  platform: string,
  keychainAccessGroup: string,
): { touchID: { keychainAccessGroup: string } } | null {
  if (platform !== 'darwin' || !/^[A-Z0-9]{10}\.[\w.-]+$/.test(keychainAccessGroup)) return null;
  return { touchID: { keychainAccessGroup } };
}
