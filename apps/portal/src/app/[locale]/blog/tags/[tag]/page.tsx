import type { Metadata } from 'next';
import { TagPage, tagMetadata } from '@/components/blog/pages';
import { decodeSegment } from '@/lib/page';

type Props = { params: Promise<{ locale: string; tag: string }> };

export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, tag } = await params;
  return tagMetadata(locale, decodeSegment(tag), 1);
}

export default async function Page({ params }: Props) {
  const { locale, tag } = await params;
  return <TagPage locale={locale} tag={decodeSegment(tag)} page={1} />;
}
