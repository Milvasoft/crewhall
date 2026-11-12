import type { AppLocale } from '@crewhall/i18n';
import type {
  BoardTemplate,
  BoardTemplateContent,
  LabelColor,
  PageTemplateContent,
  SpaceTemplateContent,
  TemplateKind,
} from '@crewhall/shared';
import { templateColumns, templateSettings } from '../boards/templates';
import { BUILTIN_TEMPLATES } from '../wiki/builtin-templates';

/**
 * Templates that ship with Crewhall (roadmap 8): content in both languages, the gallery shows
 * the caller's. Pages come from the wiki's built-ins; boards and spaces are defined here.
 */

type Text = Record<AppLocale, string>;

export interface Builtin {
  id: string;
  kind: TemplateKind;
  category: string;
  name: Text;
  description: Text;
  content: (locale: AppLocale) => PageTemplateContent | BoardTemplateContent | SpaceTemplateContent;
}

/** A structure template of the new-board dialog (columns, labels, fields; no cards). */
function structure(template: BoardTemplate, locale: AppLocale): BoardTemplateContent {
  const settings = templateSettings(template, locale, { key: 'KRT', cardChats: true });
  return {
    columns: templateColumns(template, locale).map((c) => ({ ...c })),
    labels: settings.labels.map((l) => ({ ...l, color: l.color as LabelColor })),
    fields: settings.fields,
    cards: [],
  };
}

const ONBOARDING_BOARD: Record<AppLocale, BoardTemplateContent> = {
  tr: {
    columns: [
      { name: 'Yapılacak', wipLimit: null, isDone: false },
      { name: 'Bu hafta', wipLimit: null, isDone: false },
      { name: 'Tamamlandı', wipLimit: null, isDone: true },
    ],
    labels: [
      { id: 'l1', name: 'Hesaplar', color: 's1' },
      { id: 'l2', name: 'Ekip', color: 's2' },
      { id: 'l3', name: 'Araçlar', color: 's4' },
    ],
    fields: { points: false, priority: false },
    cards: [
      { column: 0, title: "Hesabını aç ve 2FA'yı kur", labels: ['l1'], description: '' },
      {
        column: 0,
        title: 'E-posta ve takvim erişimini kontrol et',
        labels: ['l1'],
        description: '',
      },
      { column: 0, title: 'Ekip sohbetine katıl, kendini tanıt', labels: ['l2'], description: '' },
      { column: 0, title: 'Yöneticinle tanışma görüşmesi', labels: ['l2'], description: '' },
      { column: 0, title: 'Geliştirme / çalışma ortamını kur', labels: ['l3'], description: '' },
      { column: 0, title: 'İlk görevini al', labels: [], description: '' },
    ],
  },
  en: {
    columns: [
      { name: 'To do', wipLimit: null, isDone: false },
      { name: 'This week', wipLimit: null, isDone: false },
      { name: 'Done', wipLimit: null, isDone: true },
    ],
    labels: [
      { id: 'l1', name: 'Accounts', color: 's1' },
      { id: 'l2', name: 'Team', color: 's2' },
      { id: 'l3', name: 'Tools', color: 's4' },
    ],
    fields: { points: false, priority: false },
    cards: [
      { column: 0, title: 'Open your account and set up 2FA', labels: ['l1'], description: '' },
      { column: 0, title: 'Check e-mail and calendar access', labels: ['l1'], description: '' },
      { column: 0, title: 'Join the team chat and say hello', labels: ['l2'], description: '' },
      { column: 0, title: 'Intro meeting with your manager', labels: ['l2'], description: '' },
      { column: 0, title: 'Set up your work environment', labels: ['l3'], description: '' },
      { column: 0, title: 'Pick up your first task', labels: [], description: '' },
    ],
  },
};

const KICKOFF_BOARD: Record<AppLocale, BoardTemplateContent> = {
  tr: {
    columns: [
      { name: 'Hazırlık', wipLimit: null, isDone: false },
      { name: 'Yapılıyor', wipLimit: null, isDone: false },
      { name: 'Tamamlandı', wipLimit: null, isDone: true },
    ],
    labels: [
      { id: 'l1', name: 'Planlama', color: 's1' },
      { id: 'l2', name: 'Paydaş', color: 's2' },
      { id: 'l3', name: 'Risk', color: 'danger' },
    ],
    fields: { points: false, priority: true },
    cards: [
      { column: 0, title: 'Amacı ve başarı ölçütlerini yaz', labels: ['l1'], description: '' },
      { column: 0, title: 'Kapsamı ve kapsam dışını netleştir', labels: ['l1'], description: '' },
      { column: 0, title: 'Paydaşları ve rolleri belirle', labels: ['l2'], description: '' },
      { column: 0, title: 'Kilometre taşlarını planla', labels: ['l1'], description: '' },
      { column: 0, title: 'Riskleri ve önlemleri listele', labels: ['l3'], description: '' },
      { column: 0, title: 'Başlangıç toplantısını yap', labels: ['l2'], description: '' },
    ],
  },
  en: {
    columns: [
      { name: 'Preparation', wipLimit: null, isDone: false },
      { name: 'In progress', wipLimit: null, isDone: false },
      { name: 'Done', wipLimit: null, isDone: true },
    ],
    labels: [
      { id: 'l1', name: 'Planning', color: 's1' },
      { id: 'l2', name: 'Stakeholder', color: 's2' },
      { id: 'l3', name: 'Risk', color: 'danger' },
    ],
    fields: { points: false, priority: true },
    cards: [
      { column: 0, title: 'Write the goal and success criteria', labels: ['l1'], description: '' },
      { column: 0, title: 'Agree on scope and out of scope', labels: ['l1'], description: '' },
      { column: 0, title: 'Name stakeholders and roles', labels: ['l2'], description: '' },
      { column: 0, title: 'Plan the milestones', labels: ['l1'], description: '' },
      { column: 0, title: 'List risks and mitigations', labels: ['l3'], description: '' },
      { column: 0, title: 'Hold the kickoff meeting', labels: ['l2'], description: '' },
    ],
  },
};

const page = (key: string, locale: AppLocale): PageTemplateContent => {
  const t = BUILTIN_TEMPLATES.find((x) => x.key === key)!;
  return { markdown: t.markdown[locale], icon: null };
};

const TEXT = {
  tools: {
    tr: `Ekibin kullandığı araçlar ve erişimin nasıl alınacağı.

| Araç | Ne için | Erişim |
| --- | --- | --- |
| Crewhall | Sayfalar, panolar, sohbet | Davetle |
|  |  |  |
`,
    en: `The tools the team uses and how to get access.

| Tool | What for | Access |
| --- | --- | --- |
| Crewhall | Pages, boards, chat | By invitation |
|  |  |  |
`,
  },
  team: {
    tr: `## Ekip

| Kişi | Rol | Ne zaman sorulur |
| --- | --- | --- |
|  |  |  |

## İletişim

- Günlük konuşmalar: space sohbeti
- Kararlar: sayfalar
- İşler: pano
`,
    en: `## Team

| Person | Role | Ask about |
| --- | --- | --- |
|  |  |  |

## Communication

- Day to day: the space chat
- Decisions: pages
- Work: the board
`,
  },
  decisions: {
    tr: `Projede alınan kararlar, en yeni en üstte.

| Tarih | Karar | Neden | Karar veren |
| --- | --- | --- | --- |
|  |  |  |  |
`,
    en: `Decisions taken in the project, newest first.

| Date | Decision | Why | Decided by |
| --- | --- | --- | --- |
|  |  |  |  |
`,
  },
  retros: {
    tr: `Her sprint sonunda bir alt sayfa aç (Sprint planı şablonu retro tablosunu içerir).
`,
    en: `Open a sub-page at the end of every sprint (the sprint plan template has a retro table).
`,
  },
};

export const BUILTINS: Builtin[] = [
  // ---- boards ----
  {
    id: 'builtin:board:onboarding',
    kind: 'board',
    category: 'team',
    name: { tr: 'Oryantasyon görevleri', en: 'Onboarding tasks' },
    description: {
      tr: 'Yeni gelenin ilk haftası, hazır kartlarla',
      en: "A newcomer's first week, with ready cards",
    },
    content: (l) => ONBOARDING_BOARD[l],
  },
  {
    id: 'builtin:board:kickoff',
    kind: 'board',
    category: 'project',
    name: { tr: 'Proje başlangıcı', en: 'Project kickoff' },
    description: {
      tr: 'Amaç, kapsam, paydaşlar ve riskler için kartlar',
      en: 'Cards for goal, scope, stakeholders and risks',
    },
    content: (l) => KICKOFF_BOARD[l],
  },
  {
    id: 'builtin:board:sprint',
    kind: 'board',
    category: 'engineering',
    name: { tr: 'Sprint', en: 'Sprint' },
    description: {
      tr: 'Sprint tarihleri, puan, WIP sınırı',
      en: 'Sprint dates, points, WIP limit',
    },
    content: (l) => structure('sprint', l),
  },
  {
    id: 'builtin:board:roadmap',
    kind: 'board',
    category: 'product',
    name: { tr: 'Yol haritası', en: 'Roadmap' },
    description: { tr: 'Fikirden teslime beş sütun', en: 'Five columns from idea to done' },
    content: (l) => structure('roadmap', l),
  },
  {
    id: 'builtin:board:bugs',
    kind: 'board',
    category: 'engineering',
    name: { tr: 'Hata takibi', en: 'Bug tracking' },
    description: { tr: 'Öncelik alanıyla hata akışı', en: 'Bug flow with a priority field' },
    content: (l) => structure('bugs', l),
  },
  // ---- spaces ----
  {
    id: 'builtin:space:onboarding',
    kind: 'space',
    category: 'team',
    name: { tr: 'Oryantasyon', en: 'Onboarding' },
    description: {
      tr: 'Hoş geldin sayfası, araçlar, ekip ve görev panosu',
      en: 'Welcome page, tools, team and a task board',
    },
    content: (l) => ({
      pages: [
        {
          key: 'welcome',
          parent: null,
          name: l === 'tr' ? 'Hoş geldin' : 'Welcome',
          icon: '👋',
          markdown: page('onboarding', l).markdown,
        },
        {
          key: 'tools',
          parent: 'welcome',
          name: l === 'tr' ? 'Araçlar ve erişimler' : 'Tools and access',
          icon: '🧰',
          markdown: TEXT.tools[l],
        },
        {
          key: 'team',
          parent: 'welcome',
          name: l === 'tr' ? 'Ekip ve iletişim' : 'Team and communication',
          icon: '🤝',
          markdown: TEXT.team[l],
        },
      ],
      boards: [
        {
          name: l === 'tr' ? 'Oryantasyon görevleri' : 'Onboarding tasks',
          board: ONBOARDING_BOARD[l],
        },
      ],
    }),
  },
  {
    id: 'builtin:space:kickoff',
    kind: 'space',
    category: 'project',
    name: { tr: 'Proje başlangıcı', en: 'Project kickoff' },
    description: {
      tr: 'Proje özeti, toplantı notları, kararlar, plan ve yol haritası',
      en: 'Project brief, meeting notes, decisions, plan and roadmap',
    },
    content: (l) => ({
      pages: [
        {
          key: 'brief',
          parent: null,
          name: l === 'tr' ? 'Proje özeti' : 'Project brief',
          icon: '🚀',
          markdown: page('kickoff', l).markdown,
        },
        {
          key: 'meetings',
          parent: null,
          name: l === 'tr' ? 'Toplantı notları' : 'Meeting notes',
          icon: '🗓️',
          markdown: page('meeting', l).markdown,
        },
        {
          key: 'decisions',
          parent: null,
          name: l === 'tr' ? 'Kararlar' : 'Decisions',
          icon: '✅',
          markdown: TEXT.decisions[l],
        },
      ],
      boards: [
        { name: l === 'tr' ? 'Proje planı' : 'Project plan', board: KICKOFF_BOARD[l] },
        { name: l === 'tr' ? 'Yol haritası' : 'Roadmap', board: structure('roadmap', l) },
      ],
    }),
  },
  {
    id: 'builtin:space:sprint',
    kind: 'space',
    category: 'engineering',
    name: { tr: 'Sprint ekibi', en: 'Sprint team' },
    description: {
      tr: 'Sprint planı, retrolar, sprint ve hata panoları',
      en: 'Sprint plan, retros, sprint and bug boards',
    },
    content: (l) => ({
      pages: [
        {
          key: 'plan',
          parent: null,
          name: l === 'tr' ? 'Sprint planı' : 'Sprint plan',
          icon: '🏁',
          markdown: page('sprint', l).markdown,
        },
        {
          key: 'retros',
          parent: null,
          name: l === 'tr' ? 'Retrospektifler' : 'Retrospectives',
          icon: '🔁',
          markdown: TEXT.retros[l],
        },
      ],
      boards: [
        { name: l === 'tr' ? 'Sprint panosu' : 'Sprint board', board: structure('sprint', l) },
        { name: l === 'tr' ? 'Hata takibi' : 'Bug tracking', board: structure('bugs', l) },
      ],
    }),
  },
];

/** Built-in page templates in the gallery's shape (`builtin:<key>`, as createPage takes them). */
export const PAGE_BUILTINS: Builtin[] = BUILTIN_TEMPLATES.map((t) => ({
  id: `builtin:${t.key}`,
  kind: 'page',
  category: t.category,
  name: t.name,
  description: t.description,
  content: (l) => ({ markdown: t.markdown[l], icon: null }),
}));

export const ALL_BUILTINS = [...PAGE_BUILTINS, ...BUILTINS];
