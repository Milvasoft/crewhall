import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  HUB_API_URL: z.preprocess(emptyToUndefined, z.url().default('http://localhost:4201')),
  PORTAL_CONTENT_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  PORTAL_REVALIDATE_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  PORTAL_DEFAULT_LOCALE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .default('en'),
  ),
  PORTAL_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Validated environment. Parsed lazily so `next build` works without any variables set;
 * a wrong value fails on first use with a readable message.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid portal environment: ${issues}`);
  }
  cached = { ...parsed.data, HUB_API_URL: parsed.data.HUB_API_URL.replace(/\/+$/, '') };
  return cached;
}

/** For tests. */
export function resetEnvCache() {
  cached = null;
}
