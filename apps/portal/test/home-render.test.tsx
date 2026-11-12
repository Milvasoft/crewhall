import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Home, type HomeSectionData } from '@/components/home/Home';
import { splitLines } from '@/components/home/Text';

const sections: HomeSectionData[] = [
  {
    type: 'hero',
    id: 'hero',
    title: 'Welcome To<br />Acme Portal',
    badge: 'Version 1.0.1',
    description: 'Docs and more.',
    card: '/media/card.svg',
    tech: '/media/tech.png',
    wordmarkVertical: '/media/wordmark-v.png',
    wordmark: '/media/wordmark.png',
    mark: { src: '/media/mark.png', dark: null },
  },
  {
    type: 'about',
    id: 'about',
    title: 'Who We Are',
    description: 'We build things together.',
    video: { id: 'abc', title: 'Intro' },
  },
  {
    type: 'features',
    id: 'f',
    title: 'What You Can Do',
    items: ['Read', 'Write'],
    image: null,
    dot: null,
  },
  {
    type: 'projects',
    id: 'p',
    title: 'Open Source',
    description: 'Our libraries.',
    projects: [
      {
        name: 'Helpers',
        image: null,
        url: 'https://example.com/helpers',
        description: 'A library.',
        badges: [{ url: 'https://example.com/pkg', image: '/b.svg', alt: 'downloads' }],
      },
    ],
  },
];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('home page markup', () => {
  const html = renderToStaticMarkup(
    <Home
      sections={sections}
      labels={{ scroll: 'Scroll', chapters: 'Page sections', video: 'Video' }}
    />,
  );

  it('keeps headings as real, readable text', () => {
    const h1 = /<h1[^>]*>(.*?)<\/h1>/s.exec(html)?.[1] ?? '';
    expect(text(h1)).toBe('Welcome To Acme Portal');
    const h2s = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((m) => text(m[1]!));
    expect(h2s).toEqual(['Who We Are', 'What You Can Do', 'Open Source']);
    expect(html).toContain('We build things together.'.split(' ')[0]);
    expect(text(html)).toContain('We build things together.');
  });

  it('labels each section by its heading and keeps links working', () => {
    expect(html).toContain('aria-labelledby="home-about"');
    expect(html).toContain('id="home-about"');
    expect(html).toContain('href="https://example.com/pkg"');
    // the project's name links to its repository
    expect(html).toMatch(
      /<h3[^>]*><a href="https:\/\/example.com\/helpers"[^>]*>Helpers<\/a><\/h3>/,
    );
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders everything visible: no motion state is baked into the markup', () => {
    expect(html).not.toMatch(/opacity:\s*0/);
    expect(html).not.toContain('clip-path');
    expect(html).not.toContain('--reveal');
    expect(html).not.toContain('--ink');
  });

  it('describes the choreography on the wrappers for CSS', () => {
    expect(html).toContain('data-enter="arc"');
    expect(html).toContain('data-enter="iris"');
    expect(html).toContain('data-exit="iris"');
    expect(html).toMatch(/--len:\s*3\.7/);
  });

  it('offers a chapter rail of real links to every section', () => {
    expect(html).toContain('<nav');
    expect(html).toContain('aria-label="Page sections"');
    expect(html).toContain('href="#section-about"');
    expect(html).toContain('id="section-about"');
    // hero title without its line break
    expect(text(/<nav[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? '')).toContain(
      'Welcome To Acme Portal',
    );
  });

  it('splits the hero title on the line breaks the content uses', () => {
    expect(splitLines('A<br />B<br/>C')).toEqual(['A', 'B', 'C']);
    expect(splitLines('Only one')).toEqual(['Only one']);
  });
});
