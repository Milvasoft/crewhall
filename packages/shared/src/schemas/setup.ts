import { z } from 'zod';
import { Locale } from './common';
import { OrgRole } from './org';
import { SpaceColor } from './space';

/**
 * First-run wizard. Only accepted while no organization exists.
 * After success the owner signs in and must enrol 2FA before reaching the app.
 */
export const SetupRequest = z.object({
  /**
   * Setup token printed in the server logs (design 1.10). Required in production;
   * a development server without SETUP_TOKEN accepts setup without it.
   */
  setupToken: z.string().optional(),
  org: z.object({
    name: z.string().min(1).max(80),
    slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
    defaultLocale: Locale,
  }),
  owner: z.object({
    name: z.string().min(1).max(80),
    email: z.email(),
    password: z.string().min(12).max(128),
  }),
  /**
   * Wizard step 3 (1.12). Defaults to one default space named after the org.
   * Default spaces are joined automatically by every new member (not guests).
   */
  spaces: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        color: SpaceColor,
        isDefault: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(20)
    .optional(),
  /** Wizard step 4 (1.13). Invitees join the default spaces when they accept. */
  invitations: z
    .array(z.object({ email: z.email(), role: OrgRole.exclude(['owner']) }))
    .max(200)
    .optional(),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const SmtpTestRequest = z.object({ to: z.email(), setupToken: z.string().optional() });

export const SetupResult = z.object({
  orgId: z.uuid(),
  ownerId: z.uuid(),
  /** Accept links for the invitations, to copy when SMTP is not set up (1.13). */
  invitations: z.array(z.object({ email: z.email(), url: z.url() })).optional(),
});
export type SetupResult = z.infer<typeof SetupResult>;
