import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/**
 * LiveKit settings (doc 17 §11: LIVEKIT_URL · _API_KEY · _API_SECRET). Read from the
 * process environment by the meet module itself so the core env schema stays untouched.
 *
 * - LIVEKIT_URL: what the api calls (http(s)://, e.g. http://localhost:7880 or http://livekit:7880).
 * - LIVEKIT_PUBLIC_URL: what browsers and phones connect to (ws(s)://lk.<domain>); defaults
 *   to LIVEKIT_URL with ws(s)://.
 * - MEET_EGRESS_ENABLED: egress is running (recording button works).
 * - MEET_EGRESS_S3_ENDPOINT: S3 endpoint as the egress container sees it (defaults to S3_ENDPOINT).
 */
export const MeetConfigSchema = z.object({
  LIVEKIT_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  LIVEKIT_PUBLIC_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  LIVEKIT_API_KEY: z.preprocess(emptyToUndefined, z.string().min(3).optional()),
  LIVEKIT_API_SECRET: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  MEET_EGRESS_ENABLED: bool,
  MEET_EGRESS_S3_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
});

export interface MeetConfig {
  apiUrl: string;
  publicUrl: string;
  apiKey: string;
  apiSecret: string;
  egressEnabled: boolean;
  egressS3Endpoint: string | null;
}

/** Null when LiveKit is not configured: joining answers 503 meet_unavailable. */
export function loadMeetConfig(
  source: Record<string, string | undefined> = process.env,
): MeetConfig | null {
  const parsed = MeetConfigSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid meet environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  if (!e.LIVEKIT_URL || !e.LIVEKIT_API_KEY || !e.LIVEKIT_API_SECRET) return null;
  const apiUrl = e.LIVEKIT_URL.replace(/^ws/, 'http');
  return {
    apiUrl,
    publicUrl: e.LIVEKIT_PUBLIC_URL ?? apiUrl.replace(/^http/, 'ws'),
    apiKey: e.LIVEKIT_API_KEY,
    apiSecret: e.LIVEKIT_API_SECRET,
    egressEnabled: e.MEET_EGRESS_ENABLED,
    egressS3Endpoint: e.MEET_EGRESS_S3_ENDPOINT ?? null,
  };
}
