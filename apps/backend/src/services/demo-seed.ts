import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  boardColumns,
  newId,
  orgMembers,
  organizations,
  spaceMembers,
  spaces,
  surfaceCards,
  surfaces,
  users,
} from '@crewhall/db';
import { pagePath } from '@crewhall/shared';
import { createCredentialUser } from '../auth/users';
import type { Deps } from '../deps';
import type { RequestInfo } from '../http/types';
import { createBoard } from './boards/boards';
import { addComment, createCard, moveCard, updateCard } from './boards/cards';
import { createDrawing, saveScene } from './boards/drawings';
import { renderDrawingThumbnail } from './boards/thumbnail';
import type { Element } from './boards/ydoc';
import type { ChatActor } from './chat/access';
import { createConversation } from './chat/conversations';
import { react, sendMessage } from './chat/messages';
import { createWebhook, receiveHook } from './chat/webhooks';
import {
  DEMO_FOLDERS,
  DEMO_LINKS,
  DEMO_NOTE,
  DEMO_ORG,
  DEMO_PASSWORD,
  DEMO_PENDING_INVITATION,
  DEMO_SPACES,
  DEMO_TODOS,
  DEMO_USERS,
  type DemoUser,
} from './demo-data';
import { createFolder } from './drive/nodes';
import { acceptInvitation, issueInvitation } from './invitations';
import { toActor } from './membership';
import { upsertLink } from './quick/links';
import { ensureSurfaces } from './quick/surfaces';
import { runSetup } from './setup';
import { actorFor } from './wiki/access';
import { createComment } from './wiki/comments';
import { createPage } from './wiki/pages';

/**
 * The live demo's sample (DEMO_MODE), built through the same services as the UI so it looks
 * real: accounts, quick access and Drive folders, chat, pages, a board and a drawing. All of
 * it is fictional (demo-data.ts); the development seed is never used here.
 */

const REQ: RequestInfo = { ip: null, userAgent: 'crewhall-demo', locale: 'tr' };
const DAY = 86_400_000;

type People = Record<DemoUser['key'], { id: string; name: string }>;

export async function seedDemo(deps: Deps) {
  const { org, people } = await seedAccounts(deps);
  await seedQuick(deps, org.id, people);
  await seedChat(deps, org.id, people);
  await seedPages(deps, org.id, people);
  await seedBoard(deps, org.id, people);
}

async function memberActor(deps: Deps, orgId: string, userId: string) {
  const [org] = await deps.db.select().from(organizations).where(eq(organizations.id, orgId));
  const [m] = await deps.db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, userId)));
  return { org: org!, actor: toActor(m!), userId };
}

async function spaceByName(deps: Deps, orgId: string, name: string) {
  const [s] = await deps.db
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, orgId), eq(spaces.name, name), eq(spaces.kind, 'shared')));
  return s!;
}

// ---- accounts ---------------------------------------------------------------------------

async function seedAccounts(deps: Deps) {
  const { db, auth } = deps;
  const [owner, ...rest] = DEMO_USERS;
  const result = await runSetup(
    deps,
    {
      setupToken: deps.setupToken ?? undefined,
      org: DEMO_ORG,
      owner: { name: owner!.name, email: owner!.email, password: DEMO_PASSWORD },
      spaces: DEMO_SPACES,
    },
    REQ,
  );
  const [org] = await db.select().from(organizations).where(eq(organizations.id, result.orgId));
  const [ownerRow] = await db.select().from(users).where(eq(users.id, result.ownerId));
  if (!org || !ownerRow) throw new Error('demo setup did not create the org');
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, ownerRow.id));
  const people = { [owner!.key]: { id: ownerRow.id, name: ownerRow.name } } as People;

  for (const person of rest) {
    const { token } = await issueInvitation(
      db,
      org,
      ownerRow,
      {
        email: person.email,
        role: person.role as Exclude<DemoUser['role'], 'owner'>,
        spaceIds: [],
      },
      REQ,
    );
    const user = await createCredentialUser(auth, {
      email: person.email,
      name: person.name,
      password: DEMO_PASSWORD,
      locale: 'tr',
    });
    await db.transaction((tx) =>
      acceptInvitation(tx, token, user, null, REQ, { defaultSpaceRole: 'editor' }),
    );
    for (const s of person.spaces) {
      const space = await spaceByName(deps, org.id, s.name);
      await db
        .insert(spaceMembers)
        .values({
          spaceId: space.id,
          userId: user.id,
          orgId: org.id,
          role: s.role,
          addedBy: ownerRow.id,
        })
        .onConflictDoUpdate({
          target: [spaceMembers.spaceId, spaceMembers.userId],
          set: { role: s.role },
        });
    }
    people[person.key] = { id: user.id, name: person.name };
  }
  await issueInvitation(
    db,
    org,
    ownerRow,
    { ...DEMO_PENDING_INVITATION, spaceIds: [(await spaceByName(deps, org.id, 'Pazarlama')).id] },
    REQ,
  );
  return { org, people };
}

// ---- quick access and Drive ---------------------------------------------------------------

async function seedQuick(deps: Deps, orgId: string, people: People) {
  const { db } = deps;
  const a = await memberActor(deps, orgId, people.deniz.id);
  await ensureSurfaces(db, a);
  const [mine] = await db
    .select()
    .from(surfaces)
    .where(
      and(
        eq(surfaces.orgId, orgId),
        eq(surfaces.ownerType, 'user'),
        eq(surfaces.ownerId, people.deniz.id),
      ),
    );
  const items = [];
  for (const l of DEMO_LINKS) {
    // Public home pages: checked every 15 minutes, the longest interval offered.
    const link = await upsertLink(
      db,
      orgId,
      { url: l.url, title: l.title, checkEnabled: true, intervalSeconds: 900 },
      { title: l.title, faviconUrl: null },
    );
    items.push({ id: newId(), linkId: link.id, title: l.title, description: null });
  }
  const base = { orgId, createdBy: people.deniz.id };
  if (mine) {
    await db.insert(surfaceCards).values([
      {
        ...base,
        surfaceId: mine.id,
        type: 'link_group',
        x: 0,
        y: 0,
        w: 3,
        h: 4,
        config: {
          title: 'Sık kullanılanlar',
          color: 's1',
          view: 'list',
          sort: 'manual',
          sectionsAsTabs: false,
          showUrls: true,
          showHealth: true,
          sections: [{ id: newId(), title: '', items }],
        },
      },
      {
        ...base,
        surfaceId: mine.id,
        type: 'note',
        x: 3,
        y: 0,
        w: 3,
        h: 2,
        config: { text: DEMO_NOTE, color: 's3', fontSize: 'normal' },
      },
      {
        ...base,
        surfaceId: mine.id,
        type: 'todo',
        x: 6,
        y: 0,
        w: 3,
        h: 3,
        config: {
          title: 'Bu hafta',
          items: DEMO_TODOS.map((text, i) => ({
            id: newId(),
            text,
            done: i < 2,
            doneAt: i < 2 ? new Date().toISOString() : null,
          })),
        },
      },
    ]);
  }
  const home = await spaceByName(deps, orgId, 'Nova');
  const [spaceSurface] = await db
    .select()
    .from(surfaces)
    .where(and(eq(surfaces.ownerType, 'space'), eq(surfaces.ownerId, home.id)));
  if (spaceSurface) {
    await db.insert(surfaceCards).values({
      ...base,
      surfaceId: spaceSurface.id,
      type: 'note',
      x: 0,
      y: 0,
      w: 4,
      h: 2,
      config: {
        text: 'Bu bir canlı demo: veriler her saat başı sıfırlanır. Gönül rahatlığıyla dene.',
        color: 's2',
        fontSize: 'normal',
      },
    });
  }
  for (const name of DEMO_FOLDERS) await createFolder(db, a, home.id, { parentId: null, name });
  await db
    .update(surfaces)
    .set({ updatedBy: people.deniz.id, updatedAt: new Date() })
    .where(and(eq(surfaces.orgId, orgId), isNull(surfaces.updatedBy)));
}

// ---- chat -------------------------------------------------------------------------------

async function seedChat(deps: Deps, orgId: string, people: People) {
  const actor = (key: DemoUser['key']) =>
    memberActor(deps, orgId, people[key].id) as Promise<ChatActor>;
  const [deniz, ece, kerem, ayla, melis] = await Promise.all(
    (['deniz', 'ece', 'kerem', 'ayla', 'melis'] as const).map(actor),
  );
  const say = (a: ChatActor, conversationId: string, text: string, replyToId?: string) =>
    sendMessage(deps, a, conversationId, {
      clientMsgId: randomUUID(),
      text,
      attachmentNodeIds: [],
      ...(replyToId ? { replyToId } : {}),
    });

  const pusula = await spaceByName(deps, orgId, 'Pusula');
  const infra = await spaceByName(deps, orgId, 'Altyapı');

  const team = await createConversation(deps, deniz!, {
    type: 'space',
    spaceId: pusula.id,
    name: 'Pusula Ekibi',
  });
  const idea = await say(
    kerem!,
    team.id,
    'Bildirim özetini günde bir yerine iki kez göndermeyi öneriyorum: sabah 9 ve öğleden sonra 4.',
  );
  await react(deps, deniz!, idea.id, '👍', true);
  await react(deps, ece!, idea.id, '👍', true);
  await say(
    ece!,
    team.id,
    `Mantıklı. Ayarlara "özet sıklığı" seçeneği ekleyelim. <@${deniz!.userId}> sprint planına alabilir miyiz?`,
    idea.id,
  );
  await say(
    ayla!,
    team.id,
    'Ayar ekranı için iki tasarım taslağı hazırladım, Figma bağlantısını paylaşıyorum.',
  );
  await say(deniz!, team.id, 'Planlamada konuşalım, ilk sırada olsun.');

  const ops = await createConversation(deps, ece!, {
    type: 'space',
    spaceId: infra.id,
    name: 'Altyapı',
  });
  await say(
    kerem!,
    ops.id,
    `<@${deniz!.userId}> test ortamının disk kullanımı %80'e geldi, eski günlükleri temizliyorum.`,
  );

  const direct = await createConversation(deps, ece!, { type: 'direct', userId: deniz!.userId });
  await say(ece!, direct.id, 'Müşteri anketinin sonuçlarını özet sayfasına ekledim.');

  await createConversation(deps, melis!, {
    type: 'group',
    userIds: [ayla!.userId, deniz!.userId],
    message: {
      clientMsgId: randomUUID(),
      text: 'Yeni tanıtım videosunun ilk kurgusu hazır.',
      attachmentNodeIds: [],
    },
  });

  const alerts = await createConversation(deps, deniz!, {
    type: 'alert',
    name: 'Örnek Alarmlar',
    spaceId: infra.id,
    userIds: [],
  });
  const hook = await createWebhook(deps, deniz!, alerts.id, { name: 'İzleme' });
  const u = new URL(hook.url);
  await receiveHook(deps, {
    webhookId: hook.webhook.id,
    key: u.searchParams.get('key')!,
    ip: '127.0.0.1',
    body: JSON.stringify({
      card: {
        severity: 'warning',
        title: 'Yanıt süresi eşiği aştı (örnek)',
        subtitle: 'pusula-api',
        source: 'İzleme',
        fields: [
          { label: 'p95', value: '820 ms' },
          { label: 'Eşik', value: '500 ms' },
        ],
        buttons: [{ text: 'Panoyu aç', url: 'https://status.nova.example' }],
      },
    }),
  });
}

// ---- pages ------------------------------------------------------------------------------

async function seedPages(deps: Deps, orgId: string, people: People) {
  const opts = { source: 'web' as const, locale: 'tr' as const };
  const home = await spaceByName(deps, orgId, 'Nova');
  const a = await actorFor(deps.db, orgId, people.deniz.id);
  if (!a) return;
  const mention = (key: DemoUser['key']) =>
    `[@${people[key].name}](mention:user:${people[key].id})`;
  const make = (parentId: string | null, name: string, markdown: string, icon?: string) =>
    createPage(deps, a, home.id, { parentId, name, markdown, icon }, opts);

  const onboarding = await make(
    null,
    'Hoş geldin',
    `Nova Teknoloji'ye hoş geldin. Bu sayfa ilk haftanı planlaman için; sorularını Pusula Ekibi sohbetine yazabilirsin.

:::info[İlk gün]
Hesabında iki adımlı doğrulamayı kur; kasaya erişim için gerekiyor.
:::

## İlk hafta

- [x] Hesabını aç ve profil fotoğrafını ekle
- [ ] Ekip kasasına erişim iste
- [ ] Geliştirme ortamını kur
- [ ] Pusula deposundaki testleri çalıştır`,
    '👋',
  );
  const setup = await make(
    onboarding.id,
    'Geliştirme ortamı',
    `## Gerekenler

| Araç | Sürüm |
| --- | --- |
| Docker | güncel |
| Node.js | 22 |

\`\`\`bash
git clone https://git.nova.example/pusula.git
cd pusula && npm install && npm test
\`\`\``,
    '🛠️',
  );
  await make(
    onboarding.id,
    'Çalışma ilkeleri',
    `- Değişiklikler küçük ve testli olur.
- Kararlar sohbette konuşulur, sayfaya yazılır.
- Gizli değerler sayfada tutulmaz; kasadan okunur.

Kurulum için [Geliştirme ortamı](${pagePath(setup)}) sayfasına bak.`,
  );

  const product = await make(
    null,
    'Pusula',
    'Pusula, Nova Teknoloji’nin ekip görev planlama uygulaması (kurgusal örnek ürün).',
    '🧭',
  );
  const notes = await make(
    product.id,
    'Sürüm notları 2.3',
    `## Yeni

- Görevler için tekrar kuralları: günlük, haftalık, aylık.
- Takvim görünümünde sürükle-bırak.

## Düzeltmeler

- Bildirim özetinde yinelenen satırlar giderildi.`,
  );
  const design = await make(
    product.id,
    'Mimari',
    `Bu sayfa Pusula'nın parçalarını ve birbirleriyle nasıl konuştuklarını anlatır. 2.3'teki değişiklikler için [Sürüm notları 2.3](${pagePath(notes)}) sayfasına bak; bildirim tarafındaki sorular için ${mention('kerem')}.

:::note[Canlı belge]
Bir mimari karar değişirse önce Pusula Ekibi sohbetinde tartış, sonra aşağıdaki Karar kaydına tarihle ekle.
:::

## Servisler

| Servis | Sorumlu | Ölçek |
| --- | --- | --- |
| pusula-api | ${people.kerem.name} | 2 kopya |
| pusula-worker | ${people.ece.name} | 2–6 · otomatik |
| pusula-web | ${people.ayla.name} | 1 kopya |

## Akış

\`\`\`mermaid
flowchart LR
  Web --> API
  API --> Kuyruk
  Kuyruk --> Worker
  Worker --> Veritabanı
\`\`\`

## Açık işler

- [x] Bildirim özetini toplu gönder
- [ ] Tekrar kuralları için zaman dilimi desteği ${mention('kerem')}
- [ ] Takvim görünümünde haftalık özet ${mention('ayla')}

## Karar kaydı

Ekim 2026 · Bildirimler kuyruk üzerinden gönderilir; doğrudan gönderim yoğun saatlerde gecikme yaratıyordu.`,
    '🏗️',
  );
  await make(
    null,
    'Toplantı notları',
    'Haftalık ekip toplantılarının notları. Yeni not için **Şablonla başla › Toplantı notu**.',
    '🗓️',
  );
  const kerem = await actorFor(deps.db, orgId, people.kerem.id);
  if (kerem) {
    await createComment(deps, kerem, design.id, {
      body: 'Worker sayısını kuyruk uzunluğuna göre ayarlamak daha ekonomik olmaz mı?',
      mentions: [],
    });
  }
  await createComment(deps, a, design.id, {
    body: 'Akış diyagramına bildirim servisini de ekleyelim.',
    mentions: [],
  });
}

// ---- board and drawing ---------------------------------------------------------------

function box(id: string, x: number, y: number, text: string, bg: string, index: string): Element[] {
  const base = {
    angle: 0,
    strokeColor: '#141516',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
  };
  return [
    {
      ...base,
      id,
      type: 'rectangle',
      index,
      x,
      y,
      width: 180,
      height: 80,
      backgroundColor: bg,
      roundness: { type: 3 },
      boundElements: [{ type: 'text', id: `${id}-t` }],
    },
    {
      ...base,
      id: `${id}-t`,
      type: 'text',
      index: `${index}V`,
      x: x + 20,
      y: y + 28,
      width: 140,
      height: 25,
      backgroundColor: 'transparent',
      roundness: null,
      boundElements: null,
      text,
      originalText: text,
      fontSize: 20,
      fontFamily: 6,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: id,
      autoResize: true,
      lineHeight: 1.25,
    },
  ];
}

async function seedBoard(deps: Deps, orgId: string, people: People) {
  const { db } = deps;
  const home = await spaceByName(deps, orgId, 'Nova');
  const a = await memberActor(deps, orgId, people.deniz.id);
  const who = (...keys: DemoUser['key'][]) => keys.map((k) => people[k].id);

  await db.transaction(async (tx) => {
    const board = await createBoard(
      tx,
      a,
      home.id,
      {
        parentId: null,
        name: 'Pusula Yol Haritası',
        template: 'roadmap',
        cardChats: true,
        key: 'PSL',
      },
      'tr',
      REQ,
    );
    const cols = await tx
      .select()
      .from(boardColumns)
      .where(eq(boardColumns.boardNodeId, board.id))
      .orderBy(boardColumns.position);
    const [idea, queue, doing, review, done] = cols;
    const add = (
      col: typeof idea,
      title: string,
      labels: string[],
      assignees: string[] = [],
      dueInDays?: number,
    ) =>
      createCard(tx, a, board.id, {
        columnId: col!.id,
        title,
        labels,
        assigneeIds: assignees,
        dueAt:
          dueInDays === undefined ? null : new Date(Date.now() + dueInDays * DAY).toISOString(),
        afterId: null,
        beforeId: null,
        top: false,
      });
    await add(idea, 'Görevler için zaman takibi', ['l1']);
    await add(idea, 'Takvim uygulamalarıyla eşitleme', ['l1', 'l5']);
    await add(idea, 'Karanlık tema için yeni simgeler', ['l3'], who('ayla'));
    await add(queue, 'Tekrar kurallarında zaman dilimi', ['l1'], who('kerem'), 3);
    await add(queue, 'Haftalık özet e-postası', ['l3'], who('ayla'));
    await add(queue, 'Erişilebilirlik denetimi', ['l3'], who('melis'));
    const sso = await add(queue, 'Kurumsal giriş (SSO)', ['l4', 'l1'], who('deniz', 'kerem'), 4);
    await moveCard(tx, a, sso.id, { columnId: doing!.id, afterId: null, beforeId: null });
    await updateCard(tx, a, sso.id, {
      description:
        'Pusula girişleri kurum hesabıyla (OIDC) yapılacak. Akış: Authorization Code + PKCE.\n- Rol eşleme: kurum rolü → Pusula rolü\n- Oturum kapanınca uygulamadan da çıkış',
      checklistItems: [
        { id: 'a', text: 'İstemci kaydını oluştur', done: true, assigneeId: people.kerem.id },
        { id: 'b', text: 'Giriş ara katmanı', done: true, assigneeId: people.kerem.id },
        { id: 'c', text: 'Rol eşleme ve testleri', done: false, assigneeId: people.deniz.id },
        { id: 'd', text: 'Çıkış ucu', done: false, assigneeId: null },
      ],
    });
    await addComment(tx, a, sso.id, 'Rol eşlemesini testlerle güvenceye alalım.');
    await add(doing, 'Bildirim ayarları ekranı', ['l3'], who('ayla', 'ece'));
    await add(doing, 'Worker otomatik ölçekleme', ['l2'], who('ece'), -3);
    await add(review, 'İzleme alarm kuralları', ['l2'], who('kerem', 'deniz'));
    await add(review, 'Uygulama içi yardım metinleri', ['l3'], who('melis'));
    for (const t of ['Yükleme hızını iyileştir', 'Sağlık kontrolü ucu', 'Günlük seviyeleri']) {
      await add(done, t, ['l1']);
    }
  });

  const drawing = await db.transaction((tx) =>
    createDrawing(tx, a, home.id, { parentId: null, name: 'Pusula mimarisi' }, 'tr', REQ),
  );
  await saveScene(deps, a, drawing.id, [
    ...box('web', 40, 40, 'Web', '#fde68a', 'a0'),
    ...box('api', 320, 40, 'API', '#bfdbfe', 'a1'),
    ...box('db', 600, 40, 'Veritabanı', '#99f6e4', 'a2'),
    ...box('worker', 320, 200, 'Worker', '#ddd6fe', 'a3'),
  ]);
  await renderDrawingThumbnail(deps, drawing.id);
}
