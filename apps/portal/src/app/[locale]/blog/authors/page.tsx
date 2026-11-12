import type { Metadata } from 'next';
import { BlogFrame } from '@/components/blog/BlogViews';
import { AuthorCard } from '@/components/blog/parts';
import { strings } from '@/i18n';
import { metaContext, pageContext } from '@/lib/page';
import { buildMetadata } from '@/lib/seo';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const ctx = await metaContext(locale);
  if (!ctx) return {};
  return buildMetadata({
    site: ctx.site,
    locale,
    title: strings(locale).authorsTitle,
    path: '/blog/authors',
  });
}

export default async function AuthorsPage({ params }: Props) {
  const { locale } = await params;
  const ctx = await pageContext(locale);
  const s = strings(locale);
  const [authors, posts] = await Promise.all([
    ctx.client.authors(),
    ctx.client.posts({ locale, page: 1, pageSize: 0 }),
  ]);
  const counts = new Map<string, number>();
  for (const p of posts.items) {
    for (const a of p.authors) counts.set(a.key, (counts.get(a.key) ?? 0) + 1);
  }
  return (
    <BlogFrame ctx={ctx} path="/blog/authors">
      <h1>{s.authorsTitle}</h1>
      <section className="margin-vert--lg">
        <ul>
          {authors.items.map((a) => (
            <li key={a.key} className="authorListItem_n3yI">
              <AuthorCard author={a} as="h2" count={counts.get(a.key) ?? 0} />
            </li>
          ))}
        </ul>
      </section>
    </BlogFrame>
  );
}
