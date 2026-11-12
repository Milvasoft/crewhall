import type { Metadata } from 'next';
import { AuthorPage, authorMetadata } from '@/components/blog/pages';
import { decodeSegment } from '@/lib/page';

type Props = { params: Promise<{ locale: string; key: string }> };

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, key } = await params;
  return authorMetadata(locale, decodeSegment(key), 1);
}

export default async function Page({ params }: Props) {
  const { locale, key } = await params;
  return <AuthorPage locale={locale} authorKey={decodeSegment(key)} page={1} />;
}
