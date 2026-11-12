import type { Metadata } from 'next';
import { BlogListPage, blogListMetadata } from '@/components/blog/pages';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return blogListMetadata((await params).locale, 1);
}

export default async function Page({ params }: Props) {
  return <BlogListPage locale={(await params).locale} page={1} />;
}
