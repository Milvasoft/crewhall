import { z } from 'zod';
import { HubError } from '@/lib/hub';
import { hub } from '@/lib/hub-server';

export const dynamic = 'force-dynamic';

const Query = z.object({
  q: z.string().trim().min(1).max(200),
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
  version: z
    .string()
    .regex(/^[0-9A-Za-z.-]{1,40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});

/** Search box proxy to the Hub's portal search (the content token never reaches the browser). */
export async function GET(req: Request) {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = Query.safeParse(params);
  if (!parsed.success) return Response.json({ items: [] }, { status: 400 });
  try {
    const client = await hub();
    const result = await client.search(parsed.data);
    return Response.json(result, {
      headers: {
        'Cache-Control': client.preview ? 'private, no-store' : 'public, max-age=60, s-maxage=60',
      },
    });
  } catch (err) {
    const status = err instanceof HubError && err.status < 500 ? 400 : 502;
    return Response.json({ items: [] }, { status });
  }
}
