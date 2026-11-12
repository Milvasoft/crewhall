import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TagPage, tagMetadata } from '@/components/blog/pages';
import { decodeSegment } from '@/lib/page';

type Props = { params: Promise<{ locale: string; tag: string; n: string }> };

export async function generateStaticParams() {
  return [];
}

const pageNumber = (n: string) => (/^[1-9]\d{0,4}$/.test(n) ? Number(n) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, tag, n } = await params;
  return tagMetadata(locale, decodeSegment(tag), pageNumber(n) ?? 1);
}

export default async function Page({ params }: Props) {
  const { locale, tag, n } = await params;
  const page = pageNumber(n);
  if (!page) notFound();
  return <TagPage locale={locale} tag={decodeSegment(tag)} page={page} />;
}
