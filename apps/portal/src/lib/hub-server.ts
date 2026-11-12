import { cookies, draftMode } from 'next/headers';
import { env } from '@/env';
import { createHubClient, type HubClient } from '@/lib/hub';

export const PREVIEW_COOKIE = 'portal_preview';

/**
 * Preview token of this request, or null. Cookies are only read in draft mode: published pages
 * stay statically cacheable (reading cookies would make every page dynamic).
 */
export async function previewToken(): Promise<string | null> {
  const draft = await draftMode();
  if (!draft.isEnabled) return null;
  return (await cookies()).get(PREVIEW_COOKIE)?.value ?? null;
}

/** Hub client for server components and route handlers. */
export async function hub(): Promise<HubClient> {
  const e = env();
  return createHubClient({
    baseUrl: e.HUB_API_URL,
    token: e.PORTAL_CONTENT_TOKEN,
    previewToken: await previewToken(),
  });
}
