import { decodeSegment, missing, pageContext } from '@/lib/page';

export async function generateStaticParams() {
  return [];
}

/** Any other path: a Hub-managed redirect (e.g. /markdown-page) or a real 404. */
export default async function OtherPage({
  params,
}: {
  params: Promise<{ locale: string; rest: string[] }>;
}) {
  const { locale, rest } = await params;
  const ctx = await pageContext(locale);
  return missing(ctx, `/${rest.map(decodeSegment).join('/')}`);
}
