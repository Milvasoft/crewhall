import type { EvalContext } from './harness';

/**
 * The assistant's Turkish eval set: the conversation a user reported as "inanılmaz işlevsiz" and
 * similar multi-turn tasks across modules. Every check looks at real data after the turns (what is
 * on the page, on the to-do card, in the calendar), so the same scenarios run against a real model
 * (`AI_EVAL_LIVE=1`, see harness.ts).
 *
 * `model` scripts the mock used in CI, one step per model call in the turn. It says what a competent
 * model would answer (`good`) and what that answer needs from the prompt (`needs`: action or read
 * kinds it lists, the conversation so far). When the prompt does not offer them, the mock answers
 * `weak`, like the real model did in the reported conversation. So the mock measures the server's
 * routing, resolving, carrying and reporting, not the model's intelligence.
 */

type Reply = Record<string, unknown>;

export interface MockStep {
  needs?: { kinds?: string[]; history?: boolean };
  good: Reply | ((prompt: string) => Reply);
  weak?: Reply;
}

export interface Turn {
  user: string;
  model?: MockStep[];
  /** Press "Onayla" on every open card after the turn. */
  approve?: boolean;
  check?: (c: EvalContext) => Promise<void> | void;
}

export interface Scenario {
  id: string;
  area: 'reported' | 'pages' | 'todo' | 'boards' | 'calendar' | 'chat' | 'drive' | 'honesty';
  seed?: (c: EvalContext) => Promise<void>;
  turns: Turn[];
}

const ASKS_AGAIN = { message: 'Tam olarak ne yapmamı istiyorsun?', actions: [] };

const TODO_TO_PAGE = (extra: Reply = {}) => ({
  message: 'Kartındaki maddeleri yeni sayfaya aktarmayı hazırladım.',
  actions: [{ type: 'todo_to_page', todo_card: null, title: 'Yapılacaklar', ...extra }],
});
/** What the real model wrote: a page with a sentence instead of the items. */
const EMPTY_PAGE = {
  message: 'Görevleri yeni sayfaya aktardım.',
  actions: [
    {
      type: 'create_page',
      space: null,
      title: 'Yapılacaklar',
      text: '- [ ] Yapılacaklar listesindeki görevler buraya aktarıldı',
    },
  ],
};
const PAGE_TO_TODOS = (page: string, extra: Reply = {}) => ({
  message: 'Sayfadaki maddeleri yapılacaklara çevirmeyi hazırladım.',
  actions: [{ type: 'page_to_tasks', page, target: 'todo', ...extra }],
});
/** The nearest thing the old action list offered: the page's name as a conversation. */
const AS_CONVERSATION = (name: string) => ({
  message: 'Görevleri çıkarıyorum.',
  actions: [{ type: 'extract_tasks', conversation: name, target: 'todo' }],
});
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

export const SCENARIOS: Scenario[] = [
  // ---- the reported conversation ---------------------------------------------------------
  {
    id: 'kart-sayfaya-gercekten-aktarilir',
    area: 'reported',
    seed: (c) => c.todo('Bu hafta', ['Faturayı öde', 'Sunucuyu yedekle', 'Elif ile görüş']),
    turns: [
      {
        user: "Ana sayfada yapılacaklar kartındakileri temiz bir page'e çeksene",
        model: [{ needs: { kinds: ['todo_to_page'] }, good: TODO_TO_PAGE(), weak: EMPTY_PAGE }],
        approve: true,
        check: async (c) => {
          const md = await c.pageMarkdown('Yapılacaklar');
          for (const item of ['Faturayı öde', 'Sunucuyu yedekle', 'Elif ile görüş']) {
            c.contains(md, item);
          }
          c.lacks(md, 'aktarıldı');
          c.contains(c.applied(), '"items":3');
        },
      },
    ],
  },
  {
    id: 'evet-son-oneriyi-onaylar',
    area: 'reported',
    seed: (c) => c.todo('Bu hafta', ['Faturayı öde']),
    turns: [
      {
        user: 'Kartımdakileri bir sayfaya çek',
        model: [{ needs: { kinds: ['todo_to_page'] }, good: TODO_TO_PAGE(), weak: EMPTY_PAGE }],
        check: (c) => c.proposed(1),
      },
      {
        user: 'evet',
        model: [{ good: { message: 'Başka bir isteğin var mı?', actions: [] } }],
        check: async (c) => c.contains(await c.pageMarkdown('Yapılacaklar'), 'Faturayı öde'),
      },
    ],
  },
  {
    id: 'yok-yap-hadi-son-oneriyi-onaylar',
    area: 'reported',
    seed: (c) => c.todo('Bu hafta', ['Sunucuyu yedekle']),
    turns: [
      {
        user: 'Yapılacaklarımı temiz bir sayfaya çek',
        model: [{ needs: { kinds: ['todo_to_page'] }, good: TODO_TO_PAGE(), weak: EMPTY_PAGE }],
      },
      {
        user: 'yok yap hadi',
        model: [{ good: ASKS_AGAIN }],
        check: async (c) => c.contains(await c.pageMarkdown('Yapılacaklar'), 'Sunucuyu yedekle'),
      },
    ],
  },
  {
    id: 'evet-teklifi-bagla-yurutur',
    area: 'reported',
    seed: (c) => c.todo('Bu hafta', ['Faturayı öde', 'Rapor yaz']),
    turns: [
      {
        user: 'İçi boş kaldı, todo listem nerede',
        model: [
          {
            needs: { kinds: ['home_cards'] },
            good: { reads: [{ type: 'home_cards' }] },
            weak: { message: 'İstersen kontrol edebilirim.', actions: [] },
          },
          {
            good: (p) => ({
              message: p.includes('Faturayı öde')
                ? 'Listen "Bu hafta" kartında: Faturayı öde, Rapor yaz. Sayfaya aktarayım mı?'
                : 'Bulamadım.',
              actions: [],
            }),
          },
        ],
        check: (c) => c.contains(c.said(), 'Faturayı öde'),
      },
      {
        user: 'evet',
        model: [
          {
            needs: { kinds: ['todo_to_page'], history: true },
            good: TODO_TO_PAGE(),
            weak: { message: 'Başka bir isteğin var mı?', actions: [] },
          },
        ],
        approve: true,
        check: async (c) => c.contains(await c.pageMarkdown('Yapılacaklar'), 'Rapor yaz'),
      },
    ],
  },
  {
    id: 'sayfa-adi-kisi-sanilmaz',
    area: 'reported',
    seed: async (c) => {
      await c.todo('Bu hafta', ['Eski madde']);
      await c.page('Milvasoft', 'Yapılacaklar Listesi', '- [ ] Sözleşmeyi oku\n- [ ] Teklif yaz');
    },
    turns: [
      {
        user: 'Yapılacaklar Listesi sayfasındaki itemları todoya çevir',
        model: [
          {
            needs: { kinds: ['page_to_tasks'] },
            good: PAGE_TO_TODOS('Yapılacaklar Listesi'),
            weak: AS_CONVERSATION('Yapılacaklar Listesi'),
          },
        ],
        approve: true,
        check: async (c) => {
          c.lacks(c.said(), 'kişi ya da');
          const items = await c.todoItems('Bu hafta');
          c.includes(items, 'Sözleşmeyi oku');
          c.includes(items, 'Teklif yaz');
          c.includes(items, 'Eski madde');
        },
      },
    ],
  },
  {
    id: 'model-sohbet-sansa-da-sayfa-bulunur',
    area: 'reported',
    seed: async (c) => {
      await c.todo('Bu hafta', []);
      await c.page('Milvasoft', 'Yapılacaklar Listesi', '- [ ] Sözleşmeyi oku');
    },
    turns: [
      {
        user: 'Yapılacaklar Listesindeki maddeleri görev yap',
        // Even when the model takes the page for a conversation, the server must not say "kişi".
        model: [{ good: AS_CONVERSATION('Yapılacaklar Listesi') }],
        approve: true,
        check: async (c) => {
          c.lacks(c.said(), 'kişi ya da');
          c.includes(await c.todoItems('Bu hafta'), 'Sözleşmeyi oku');
        },
      },
    ],
  },
  {
    id: 'sayfa-bulunduktan-sonra-icerigi-cevrilir',
    area: 'reported',
    seed: async (c) => {
      await c.todo('Bu hafta', []);
      await c.page('Milvasoft', 'Yapılacaklar Listesi', '- [ ] Teklif yaz\n- [ ] Ali ara');
    },
    turns: [
      {
        user: 'ya milvasoft space altında yapılacaklar listesi adında bi sayfa var',
        model: [
          {
            needs: { kinds: ['find_pages'] },
            good: {
              reads: [{ type: 'find_pages', query: 'yapılacaklar listesi', space: 'Milvasoft' }],
            },
            weak: { message: 'Hangi sayfa?', actions: [] },
          },
          {
            good: (p) => ({
              message: p.includes('Yapılacaklar Listesi')
                ? 'Evet, Milvasoft alanında "Yapılacaklar Listesi" sayfası var. Ne yapayım?'
                : 'Bulamadım.',
              actions: [],
            }),
          },
        ],
        check: (c) => c.contains(c.said(), 'Yapılacaklar Listesi'),
      },
      {
        user: 'içeriği todo liste çevir',
        model: [
          {
            needs: { kinds: ['page_to_tasks'], history: true },
            good: PAGE_TO_TODOS('Yapılacaklar Listesi', { space: 'Milvasoft' }),
            weak: { message: 'Hangi konuşmadaki içerik?', actions: [] },
          },
        ],
        approve: true,
        check: async (c) => {
          const items = await c.todoItems('Bu hafta');
          c.includes(items, 'Teklif yaz');
          c.includes(items, 'Ali ara');
        },
      },
    ],
  },

  // ---- pages ---------------------------------------------------------------------------------
  {
    id: 'ayni-adli-sayfalar-adaylarla-sorulur',
    area: 'pages',
    seed: async (c) => {
      await c.todo('Bu hafta', []);
      await c.page('Milvasoft', 'Notlar', '- [ ] Milvasoft maddesi');
      await c.page('Altyapı', 'Notlar', '- [ ] Altyapı maddesi');
    },
    turns: [
      {
        user: 'Notlar sayfasını todoya çevir',
        model: [
          {
            needs: { kinds: ['page_to_tasks'] },
            good: PAGE_TO_TODOS('Notlar'),
            weak: AS_CONVERSATION('Notlar'),
          },
        ],
        check: (c) => {
          c.proposed(0);
          c.contains(c.said(), 'Milvasoft');
          c.contains(c.said(), 'Altyapı');
        },
      },
      {
        user: 'Altyapıdaki',
        model: [
          {
            needs: { kinds: ['page_to_tasks'], history: true },
            good: PAGE_TO_TODOS('Notlar', { space: 'Altyapı' }),
            weak: ASKS_AGAIN,
          },
        ],
        approve: true,
        check: async (c) => {
          const items = await c.todoItems('Bu hafta');
          c.includes(items, 'Altyapı maddesi');
          c.excludes(items, 'Milvasoft maddesi');
        },
      },
    ],
  },
  {
    id: 'sayfa-icerigi-okunur',
    area: 'pages',
    seed: (c) => c.page('Milvasoft', 'Sürüm notları', 'Sürüm 2.4 cuma çıkıyor.').then(() => {}),
    turns: [
      {
        user: 'Sürüm notları sayfasında ne yazıyor',
        model: [
          {
            needs: { kinds: ['read_page'] },
            good: { reads: [{ type: 'read_page', page: 'Sürüm notları' }] },
            weak: { message: 'Sayfa içeriğini okuyamıyorum.', actions: [] },
          },
          {
            good: (p) => ({
              message: p.includes('cuma çıkıyor')
                ? 'Sürüm 2.4 cuma çıkıyor yazıyor.'
                : 'Bulamadım.',
              actions: [],
            }),
          },
        ],
        check: (c) => c.contains(c.said(), 'cuma'),
      },
    ],
  },
  {
    id: 'bos-sayfa-durustce-soylenir',
    area: 'pages',
    seed: async (c) => {
      await c.todo('Bu hafta', ['Eski madde']);
      await c.page('Milvasoft', 'Boş sayfa', '');
    },
    turns: [
      {
        user: 'Boş sayfa sayfasını todoya çevir',
        model: [
          {
            needs: { kinds: ['page_to_tasks'] },
            good: PAGE_TO_TODOS('Boş sayfa'),
            weak: { message: 'Maddeleri yapılacaklara ekledim.', actions: [] },
          },
        ],
        check: async (c) => {
          c.proposed(0);
          c.contains(c.said(), 'madde');
          c.claimsNothing();
          c.same(await c.todoItems('Bu hafta'), ['Eski madde']);
        },
      },
    ],
  },
  {
    id: 'mevcut-sayfanin-sonuna-aktarir',
    area: 'pages',
    seed: async (c) => {
      await c.todo('Bu hafta', ['Yeni madde']);
      await c.page('Milvasoft', 'Liste', 'Önceki içerik');
    },
    turns: [
      {
        user: 'Kartımdakileri Liste sayfasının sonuna ekle',
        model: [
          {
            needs: { kinds: ['todo_to_page'] },
            good: TODO_TO_PAGE({ page: 'Liste', title: null }),
            weak: {
              message: 'Ekledim.',
              actions: [{ type: 'append_page', page: 'Liste', text: '- Kart maddeleri' }],
            },
          },
        ],
        approve: true,
        check: async (c) => {
          const md = await c.pageMarkdown('Liste');
          c.contains(md, 'Önceki içerik');
          c.contains(md, 'Yeni madde');
        },
      },
    ],
  },

  // ---- to-dos --------------------------------------------------------------------------------
  {
    id: 'bos-kart-durustce-soylenir',
    area: 'todo',
    seed: (c) => c.todo('Bu hafta', []),
    turns: [
      {
        user: 'Kartımdakileri sayfaya çek',
        model: [{ needs: { kinds: ['todo_to_page'] }, good: TODO_TO_PAGE(), weak: EMPTY_PAGE }],
        check: (c) => {
          c.proposed(0);
          c.contains(c.said(), 'madde');
          c.claimsNothing();
        },
      },
    ],
  },
  {
    id: 'maddeler-kartlar-arasi-tasinir',
    area: 'todo',
    seed: async (c) => {
      await c.todo('Bu hafta', ['Süt al', 'Rapor yaz']);
      await c.todo('Ev işleri', ['Çöp at']);
    },
    turns: [
      {
        user: 'Bu hafta kartındaki Süt al maddesini Ev işleri kartına taşı',
        model: [
          {
            needs: { kinds: ['move_todo_items'] },
            good: {
              message: 'Taşımayı hazırladım.',
              actions: [
                { type: 'move_todo_items', from: 'Bu hafta', to: 'Ev işleri', items: ['Süt al'] },
              ],
            },
            weak: {
              message: 'Taşıdım.',
              actions: [{ type: 'add_todo_item', todo_card: 'Ev işleri', text: 'Süt al' }],
            },
          },
        ],
        approve: true,
        check: async (c) => {
          c.same(await c.todoItems('Bu hafta'), ['Rapor yaz']);
          c.same(await c.todoItems('Ev işleri'), ['Çöp at', 'Süt al']);
        },
      },
    ],
  },
  {
    id: 'kart-okunur-maddeler-soylenir',
    area: 'todo',
    seed: (c) => c.todo('Bu hafta', ['Süt al', 'Ekmek al']),
    turns: [
      {
        user: 'Yapılacaklar kartımda ne var',
        model: [
          {
            needs: { kinds: ['read_todo_card'] },
            good: { reads: [{ type: 'read_todo_card', card: null }] },
            weak: { message: 'İstersen kontrol edebilirim.', actions: [] },
          },
          {
            good: (p) => ({
              message: p.includes('Ekmek al') ? 'Kartında Süt al ve Ekmek al var.' : 'Bilmiyorum.',
              actions: [],
            }),
          },
        ],
        check: (c) => c.contains(c.said(), 'Ekmek al'),
      },
    ],
  },
  {
    id: 'kaynak-kart-istenirse-temizlenir',
    area: 'todo',
    seed: (c) => c.todo('Bu hafta', ['Teklif yaz', 'Ali ara']),
    turns: [
      {
        user: 'Kartımdakileri sayfaya taşı, karttan da sil',
        model: [
          {
            needs: { kinds: ['todo_to_page'] },
            good: TODO_TO_PAGE({ remove_from_card: true }),
            weak: EMPTY_PAGE,
          },
        ],
        approve: true,
        check: async (c) => {
          c.contains(await c.pageMarkdown('Yapılacaklar'), 'Ali ara');
          c.same(await c.todoItems('Bu hafta'), []);
        },
      },
    ],
  },

  // ---- boards --------------------------------------------------------------------------------
  {
    id: 'pano-karti-evet-ile-acilir',
    area: 'boards',
    turns: [
      {
        user: 'Sürüm işleri panosuna sürüm notlarını yaz kartı aç',
        model: [
          {
            good: {
              message: 'Kartı hazırladım.',
              actions: [
                { type: 'create_card', board: 'Sürüm işleri', title: 'Sürüm notlarını yaz' },
              ],
            },
          },
        ],
        check: (c) => c.proposed(1),
      },
      {
        user: 'evet',
        model: [{ good: ASKS_AGAIN }],
        check: async (c) => c.includes(await c.boardCards(), 'Sürüm notlarını yaz'),
      },
    ],
  },
  {
    id: 'sayfa-maddeleri-pano-kartina-donusur',
    area: 'boards',
    seed: (c) =>
      c
        .page('Milvasoft', 'Sürüm işleri listesi', '- [ ] Testleri koş\n- [ ] Duyuru yaz')
        .then(() => {}),
    turns: [
      {
        user: 'Sürüm işleri listesi sayfasındaki maddeleri Sürüm işleri panosuna kart olarak aç',
        model: [
          {
            needs: { kinds: ['page_to_tasks'] },
            good: PAGE_TO_TODOS('Sürüm işleri listesi', { target: 'Sürüm işleri' }),
            weak: AS_CONVERSATION('Sürüm işleri listesi'),
          },
        ],
        approve: true,
        check: async (c) => {
          const cards = await c.boardCards();
          c.includes(cards, 'Testleri koş');
          c.includes(cards, 'Duyuru yaz');
        },
      },
    ],
  },

  // ---- calendar ------------------------------------------------------------------------------
  {
    id: 'randevu-sonra-saati-duzeltilir',
    area: 'calendar',
    turns: [
      {
        user: "yarın 10'a dişçi randevusu ekle",
        model: [
          {
            good: {
              message: 'Randevuyu hazırladım.',
              actions: [{ type: 'create_event', title: 'Dişçi', start: `${tomorrow()}T10:00` }],
            },
          },
        ],
        check: (c) => c.proposed(1),
      },
      {
        user: 'saatini 11 yap',
        model: [
          {
            needs: { history: true },
            good: {
              message: 'Saati 11:00 yaptım.',
              replaces_last: true,
              actions: [{ type: 'create_event', title: 'Dişçi', start: `${tomorrow()}T11:00` }],
            },
            weak: ASKS_AGAIN,
          },
        ],
        approve: true,
        check: async (c) => {
          const events = await c.events();
          c.same(
            events.filter((e) => e.title === 'Dişçi').map((e) => e.start),
            [`${tomorrow()}T11:00:00.000Z`],
          );
        },
      },
    ],
  },
  {
    id: 'vazgectim-oneriyi-reddeder',
    area: 'calendar',
    turns: [
      {
        user: 'yarın tüm gün izinliyim takvime ekle',
        model: [
          {
            good: {
              message: 'Hazırladım.',
              actions: [{ type: 'create_event', title: 'İzin', start: tomorrow() }],
            },
          },
        ],
        check: (c) => c.proposed(1),
      },
      {
        user: 'vazgeçtim',
        model: [{ good: { message: 'Tamam.', actions: [] } }],
        check: async (c) => {
          c.same(await c.pendingCount(), 0);
          c.same(
            (await c.events()).filter((e) => e.title === 'İzin'),
            [],
          );
        },
      },
    ],
  },

  // ---- chat ----------------------------------------------------------------------------------
  {
    id: 'mesaj-evet-ile-gider',
    area: 'chat',
    turns: [
      {
        user: "Elif'e yaz: toplantı yarına kaldı",
        model: [
          {
            good: {
              message: 'Mesajı hazırladım.',
              actions: [{ type: 'send_message', to: 'elif', text: 'Toplantı yarına kaldı.' }],
            },
          },
        ],
        check: (c) => c.proposed(1),
      },
      {
        user: 'tamam gönder',
        model: [{ good: ASKS_AGAIN }],
        check: async (c) => c.includes(await c.sentMessages(), 'Toplantı yarına kaldı.'),
      },
    ],
  },
  {
    id: 'sayfaya-mesaj-sohbet-sanilmaz',
    area: 'chat',
    seed: (c) => c.page('Milvasoft', 'Yapılacaklar Listesi', '- [ ] x').then(() => {}),
    turns: [
      {
        user: 'Yapılacaklar Listesine merhaba yaz',
        // The server says what the name really is, whichever way the model read it.
        model: [
          {
            good: {
              message: 'Hazırladım.',
              actions: [{ type: 'send_message', to: 'Yapılacaklar Listesi', text: 'Merhaba' }],
            },
          },
        ],
        check: (c) => {
          c.proposed(0);
          c.contains(c.said(), 'sayfa');
          c.lacks(c.said(), 'kişi ya da');
        },
      },
    ],
  },
  {
    id: 'sohbetten-gorev-cikar',
    area: 'chat',
    seed: async (c) => {
      await c.todo('Bu hafta', []);
      await c.group('Sürüm ekibi', 'Yarın testleri koşalım, sen bak.');
    },
    turns: [
      {
        user: 'Sürüm ekibi sohbetini özetle görevleri yapılacaklarıma ekle',
        model: [
          {
            good: {
              message: 'Okuyorum.',
              actions: [{ type: 'extract_tasks', conversation: 'Sürüm ekibi', target: 'todo' }],
            },
          },
          {
            good: (p) =>
              p.includes('testleri koşalım')
                ? { summary: 'Testler konuşuldu.', tasks: [{ title: 'Testleri koş', owner: null }] }
                : { summary: '', tasks: [] },
          },
        ],
        approve: true,
        check: async (c) => c.includes(await c.todoItems('Bu hafta'), 'Testleri koş'),
      },
    ],
  },

  // ---- Drive ---------------------------------------------------------------------------------
  {
    id: 'dosya-bulunur-sonra-adi-yazilir',
    area: 'drive',
    seed: (c) => c.folder('Milvasoft', 'Bütçe 2026').then(() => {}),
    turns: [
      {
        user: 'bütçe klasörü nerede',
        model: [
          {
            needs: { kinds: ['search_files'] },
            good: { reads: [{ type: 'search_files', query: 'bütçe' }] },
            weak: { message: 'İstersen kontrol edebilirim.', actions: [] },
          },
          {
            good: (p) => ({
              message: p.includes('Bütçe 2026') ? 'Milvasoft alanında: Bütçe 2026.' : 'Bulamadım.',
              actions: [],
            }),
          },
        ],
        check: (c) => c.contains(c.said(), 'Bütçe 2026'),
      },
      {
        user: "onun adını Elif'e yaz",
        model: [
          {
            needs: { history: true },
            good: {
              message: 'Hazırladım.',
              actions: [{ type: 'send_message', to: 'elif', text: 'Bütçe 2026' }],
            },
            weak: ASKS_AGAIN,
          },
        ],
        approve: true,
        check: async (c) => c.includes(await c.sentMessages(), 'Bütçe 2026'),
      },
    ],
  },

  // ---- honesty and multi-step ----------------------------------------------------------------
  {
    id: 'cok-adim-tek-seferde-planlanir',
    area: 'honesty',
    seed: (c) => c.todo('Bu hafta', ['Teklif yaz']),
    turns: [
      {
        user: "Kartımı sayfaya çek, Elif'e de haber ver, yarın 10'a toplantı kur",
        model: [
          {
            needs: { kinds: ['todo_to_page'] },
            good: {
              message: 'Üç işi hazırladım.',
              actions: [
                { type: 'todo_to_page', todo_card: null, title: 'Yapılacaklar' },
                { type: 'send_message', to: 'elif', text: 'Yapılacakları sayfaya aktarıyorum.' },
                { type: 'create_meeting', title: 'Görüşme', start: `${tomorrow()}T10:00` },
              ],
            },
            weak: { message: 'Önce hangisini yapayım?', actions: [] },
          },
        ],
        check: (c) => c.proposed(3),
        approve: true,
      },
    ],
  },
  {
    id: 'yetkisiz-sayfa-reddedilir',
    area: 'honesty',
    seed: async (c) => {
      await c.page('Altyapı', 'Kilitli notlar', 'İçerik', { lock: true });
    },
    turns: [
      {
        user: 'Kilitli notlar sayfasına not ekle: bugün bitti',
        model: [
          {
            good: {
              message: 'Ekledim.',
              actions: [{ type: 'append_page', page: 'Kilitli notlar', text: 'Bugün bitti' }],
            },
          },
        ],
        check: async (c) => {
          c.proposed(0);
          c.claimsNothing();
          c.lacks(await c.pageMarkdown('Kilitli notlar', 'owner'), 'Bugün bitti');
        },
      },
    ],
  },
  {
    id: 'hazirlanan-is-yapildi-denmez',
    area: 'honesty',
    seed: (c) => c.todo('Bu hafta', []),
    turns: [
      {
        user: 'Süt al yapılacaklarıma ekle',
        model: [
          {
            good: {
              message: 'Süt al maddesini ekledim.',
              actions: [{ type: 'add_todo_item', todo_card: null, text: 'Süt al' }],
            },
          },
        ],
        check: async (c) => {
          c.proposed(1);
          c.claimsNothing();
          c.same(await c.todoItems('Bu hafta'), []);
        },
      },
    ],
  },
  {
    id: 'belirsiz-istek-soru-sorar',
    area: 'honesty',
    turns: [
      {
        user: 'bunu hallet',
        model: [
          { good: { message: 'Neyi halledeyim? Bir kart, sayfa ya da toplantı mı?', actions: [] } },
        ],
        check: (c) => {
          c.proposed(0);
          c.contains(c.said(), '?');
        },
      },
    ],
  },
];
