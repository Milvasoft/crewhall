/**
 * Prints the current TOTP code for an otpauth:// URI (what two-factor/enable returns)
 * or a raw secret, so 2FA can be tried with curl without a phone:
 *   pnpm --filter @crewhall/backend totp "otpauth://totp/...?secret=..."
 *   pnpm --filter @crewhall/backend totp      # the seed users' shared dev secret
 */
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { SEED_TOTP_SECRET } from './seed-data';

/** better-auth base32-encodes the raw secret into the URI; createOTP takes it raw. */
export function secretFrom(input: string): string {
  if (!input.startsWith('otpauth://')) return input;
  const secret = new URL(input).searchParams.get('secret');
  if (!secret) throw new Error('otpauth URI has no secret');
  return new TextDecoder().decode(base32.decode(secret));
}

export function totpCode(secretOrUri: string) {
  return createOTP(secretFrom(secretOrUri), { digits: 6, period: 30 }).totp();
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/totp.ts')) {
  console.log(await totpCode(process.argv[2] ?? SEED_TOTP_SECRET));
}
