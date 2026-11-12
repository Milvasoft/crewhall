import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuthorPage, authorMetadata } from '@/components/blog/pages';
import { decodeSegment } from '@/lib/page';

type Props = { params: Promise<{ locale: string; key: string; n: string }> };

export async function generateStaticParams() {
  return [];
}

const pageNumber = (n: string) => (/^[1-9]\d{0,4}$/.test(n) ? Number(n) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, key, n } = await params;
  return authorMetadata(locale, decodeSegment(key), pageNumber(n) ?? 1);
}

export default async function Page({ params }: Props) {
  const { locale, key, n } = await params;
  const page = pageNumber(n);
  if (!page) notFound();
  return <AuthorPage locale={locale} authorKey={decodeSegment(key)} page={page} />;
}
