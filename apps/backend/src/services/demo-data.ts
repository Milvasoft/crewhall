/**
 * Live demo data (DEMO_MODE): a wholly fictional company. Nothing here may point at a real
 * organisation, person, internal system or server: people use the reserved .example domain
 * and links go only to public product home pages. The development seed (scripts/seed-data.ts)
 * is separate and never used by the demo; demo.test.ts scans every table for leaks.
 */

/** Shown on the sign-in page next to each account; anyone may use it. */
export const DEMO_PASSWORD = 'Nova-demo-2026';

export const DEMO_ORG = {
  name: 'Nova Teknoloji A.Ş.',
  slug: 'nova',
  defaultLocale: 'tr' as const,
};

export const DEMO_SPACES = [
  { name: 'Nova', color: 's1' as const, isDefault: true },
  { name: 'Pusula', color: 's2' as const, isDefault: false },
  { name: 'Altyapı', color: 's3' as const, isDefault: false },
  { name: 'Pazarlama', color: 's4' as const, isDefault: false },
];

export interface DemoUser {
  /** Short handle used inside the sample (mentions, assignees). */
  key: 'deniz' | 'ece' | 'kerem' | 'ayla' | 'onur' | 'melis' | 'atlas';
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  /** Extra shared spaces (by name) besides the default ones. */
  spaces: { name: string; role: 'admin' | 'editor' | 'viewer' }[];
}

export const DEMO_USERS: DemoUser[] = [
  { key: 'deniz', name: 'Deniz Kaya', email: 'deniz@nova.example', role: 'owner', spaces: [] },
  {
    key: 'ece',
    name: 'Ece Şahin',
    email: 'ece@nova.example',
    role: 'admin',
    spaces: [
      { name: 'Altyapı', role: 'admin' },
      { name: 'Pusula', role: 'editor' },
    ],
  },
  {
    key: 'kerem',
    name: 'Kerem Yılmaz',
    email: 'kerem@nova.example',
    role: 'member',
    spaces: [
      { name: 'Pusula', role: 'editor' },
      { name: 'Altyapı', role: 'editor' },
    ],
  },
  {
    key: 'ayla',
    name: 'Ayla Demirci',
    email: 'ayla@nova.example',
    role: 'member',
    spaces: [{ name: 'Pusula', role: 'editor' }],
  },
  {
    key: 'onur',
    name: 'Onur Çelikkan',
    email: 'onur@nova.example',
    role: 'member',
    spaces: [{ name: 'Pazarlama', role: 'editor' }],
  },
  { key: 'melis', name: 'Melis Aksoylu', email: 'melis@nova.example', role: 'member', spaces: [] },
  {
    key: 'atlas',
    name: 'Atlas Danışmanlık (örnek misafir)',
    email: 'misafir@atlas.example',
    role: 'guest',
    spaces: [{ name: 'Pusula', role: 'viewer' }],
  },
];

/** Left pending so the accept-invitation screen can be tried. */
export const DEMO_PENDING_INVITATION = { email: 'yeni@nova.example', role: 'member' as const };

/** Quick access: public product home pages only (link health checks reach these). */
export const DEMO_LINKS = [
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'Figma', url: 'https://www.figma.com/' },
  { title: 'Notion', url: 'https://www.notion.so/' },
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
];
export const DEMO_NOTE = 'Sprint demosu Perşembe 15:00. Sunum taslağı Drive › Sunumlar klasöründe.';
export const DEMO_TODOS = [
  'Pusula 2.3 sürüm notlarını yaz',
  'Müşteri anketini paylaş',
  'Yeni ekip arkadaşına hoş geldin mesajı',
  'Ofis toplantı odası rezervasyonu',
  "Ayla'nın tasarım incelemesine bak",
];
export const DEMO_FOLDERS = ['Sunumlar', 'Onboarding', 'Marka dosyaları'];
