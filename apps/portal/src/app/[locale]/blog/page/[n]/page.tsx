import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BlogListPage, blogListMetadata } from '@/components/blog/pages';

type Props = { params: Promise<{ locale: string; n: string }> };

export async function generateStaticParams() {
  return [];
}

const pageNumber = (n: string) => (/^[1-9]\d{0,4}$/.test(n) ? Number(n) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, n } = await params;
  return blogListMetadata(locale, pageNumber(n) ?? 1);
}

export default async function Page({ params }: Props) {
  const { locale, n } = await params;
  const page = pageNumber(n);
  if (!page) notFound();
  return <BlogListPage locale={locale} page={page} />;
}
