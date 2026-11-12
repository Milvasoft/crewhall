// @ts-check
import { themes as prismThemes } from 'prism-react-renderer';

const currentVersion = '2.0.0';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Acme Docs',
  tagline: 'Docs for Acme',
  favicon: 'img/favicon.ico',
  url: 'https://docs.acme.test',
  baseUrl: '/',
  i18n: { defaultLocale: 'en', locales: ['en', 'tr'] },
  markdown: { mermaid: true },
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    [
      'classic',
      ({
        docs: {
          sidebarPath: './sidebars.js',
          editUrl: 'https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/',
          lastVersion: 'current',
          versions: { current: { label: `${currentVersion}`, path: `${currentVersion}` } },
        },
        blog: { showReadingTime: true },
        theme: { customCss: './src/css/custom.css' },
      }),
    ],
  ],
  themeConfig: ({
    image: 'img/social.png',
    navbar: {
      title: 'Acme',
      logo: { alt: 'Acme Logo', src: 'img/logo.svg' },
      items: [
        { type: 'docSidebar', sidebarId: 'docsSidebar', position: 'left', label: 'Docs' },
        { to: '/blog', label: 'Blog', position: 'left' },
        { type: 'localeDropdown', position: 'right' },
        { type: 'docsVersionDropdown', position: 'right' },
        { href: 'https://github.com/acme', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        { title: 'Docs', items: [{ label: 'Intro', to: `/docs/${currentVersion}/intro` }] },
        { title: 'More', items: [{ label: 'Blog', to: '/blog' }, { label: 'GitHub', href: 'https://github.com/acme' }] },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Acme`,
    },
    prism: { theme: prismThemes.github, darkTheme: prismThemes.dracula },
  }),
};

export default config;
