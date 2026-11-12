import { feedResponse } from '@/lib/feed-route';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ locale: string }> }) {
  return feedResponse((await params).locale, 'atom');
}
