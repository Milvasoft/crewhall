import { and, eq, isNull } from 'drizzle-orm';
import { boardColumns, nodes, orgMembers, organizations, spaces, users } from '@crewhall/db';
import type { Deps } from '../../deps';
import type { RequestInfo } from '../../http/types';
import { SEED_ORG, SEED_SPACES, SEED_USERS } from '../../scripts/seed-data';
import { toActor } from '../membership';
import { createBoard } from './boards';
import { addComment, createCard, moveCard, updateCard } from './cards';
import { createDrawing, saveScene } from './drawings';
import { renderDrawingThumbnail } from './thumbnail';
import type { Element } from './ydoc';

/**
 * Development sample (design 06): "Milvaion Yol Haritası" in the default seed space with the
 * cards of 6.1 and the "Hub mimarisi" drawing of 6.10. Runs once; existing boards stay.
 */

const REQ: RequestInfo = { ip: null, userAgent: 'seed', locale: 'tr' };
const DAY = 86_400_000;

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

export async function seedBoards(
  deps: Deps,
  orgSlug = SEED_ORG.slug,
  ownerEmail = SEED_USERS[0]!.email,
) {
  const { db } = deps;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, orgSlug));
  const [owner] = await db.select().from(users).where(eq(users.email, ownerEmail));
  if (!org || !owner) return false;
  const [member] = await db
    .select()
    .from(orgMembers)
    .where(and(eq(orgMembers.organizationId, org.id), eq(orgMembers.userId, owner.id)));
  const [space] = await db
    .select()
    .from(spaces)
    .where(
      and(
        eq(spaces.orgId, org.id),
        eq(spaces.name, SEED_SPACES[0]!.name),
        eq(spaces.kind, 'shared'),
      ),
    );
  if (!member || !space) return false;
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.spaceId, space.id), eq(nodes.type, 'board'), isNull(nodes.deletedAt)));
  if (existing) return false;

  const a = { org, actor: toActor(member), userId: owner.id };
  const people = new Map(
    (await db.select({ id: users.id, email: users.email }).from(users)).map((u) => [
      u.email.split('@')[0]!,
      u.id,
    ]),
  );
  const who = (...names: string[]) =>
    names.map((n) => people.get(n)).filter((v): v is string => !!v);

  await db.transaction(async (tx) => {
    const board = await createBoard(
      tx,
      a,
      space.id,
      {
        parentId: null,
        name: 'Milvaion Yol Haritası',
        template: 'roadmap',
        cardChats: true,
        key: 'MLV',
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
    // Labels of the roadmap template: l1 Backend, l2 Altyapı, l3 UI, l4 Güvenlik, l5 Entegrasyon.
    await add(idea, 'Çoklu kiracı için iş kotaları', ['l1']);
    await add(idea, 'Webhook ile iş tetikleme', ['l1', 'l5']);
    await add(idea, 'İş zinciri için görsel editör', ['l3'], who('zeynep'));
    await add(queue, "Scheduler lider seçimi PostgreSQL'e", ['l1'], who('can'), 3);
    await add(queue, "Dashboard'a iş bağımlılık grafiği", ['l3'], who('zeynep'));
    await add(queue, 'Cron ifadesi doğrulayıcı', ['l1'], who('elif'));
    const sso = await add(queue, 'SSO ile giriş (OIDC)', ['l4', 'l1'], who('bugra', 'can'), 4);
    await moveCard(tx, a, sso.id, { columnId: doing!.id, afterId: null, beforeId: null });
    await updateCard(tx, a, sso.id, {
      description:
        "Milvaion Dashboard girişleri Crewhall üzerinden OIDC ile yapılacak; ayrı kullanıcı tablosu kalkıyor. Akış: Authorization Code + PKCE, kapsamlar openid profile milvaion.jobs.\n- Rol eşleme: Hub space rolü → Milvaion rolü (Sahip/Yönetici → Admin, Düzenleyen → Operator, İzleyen → Viewer)\n- Oturum kapanınca Hub'dan back-channel logout gelir",
      checklistItems: [
        {
          id: 'a',
          text: "Hub'da milvaion-dashboard istemcisini oluştur",
          done: true,
          assigneeId: who('can')[0] ?? null,
        },
        {
          id: 'b',
          text: "Dashboard'a OpenIdConnect ara katmanı",
          done: true,
          assigneeId: who('can')[0] ?? null,
        },
        { id: 'c', text: 'Rol eşleme tablosu ve testleri', done: false, assigneeId: owner.id },
        { id: 'd', text: 'Back-channel logout ucu', done: false, assigneeId: null },
        {
          id: 'e',
          text: 'Eski kullanıcı tablosunu kaldıran migration',
          done: false,
          assigneeId: null,
        },
      ],
    });
    await addComment(
      tx,
      a,
      sso.id,
      'Refresh token 30 gün olsun, sliding. Rol eşlemesini testlere bağlayalım.',
    );
    await add(doing, 'Retry politikası arayüzü', ['l3'], who('zeynep', 'elif'));
    await add(doing, 'Worker otomatik ölçekleme (KEDA)', ['l2'], who('mert'), -3);
    await add(review, 'Seq alarm kuralları', ['l2'], who('mert', 'bugra'));
    await add(review, "Worker'larda SIGTERM ile düzgün kapanma", ['l1'], who('elif'));
    for (const t of ['Docker imajı küçültme', 'Health check ucu', 'Log seviyeleri'])
      await add(done, t, ['l1']);
  });

  const drawing = await db.transaction((tx) =>
    createDrawing(tx, a, space.id, { parentId: null, name: 'Hub mimarisi' }, 'tr', REQ),
  );
  await saveScene(deps, a, drawing.id, [
    ...box('web', 40, 40, 'Web', '#fde68a', 'a0'),
    ...box('api', 320, 40, 'API (Hono)', '#bfdbfe', 'a1'),
    ...box('pg', 600, 40, 'PostgreSQL', '#99f6e4', 'a2'),
    ...box('collab', 320, 200, 'Hocuspocus', '#ddd6fe', 'a3'),
  ]);
  await renderDrawingThumbnail(deps, drawing.id);
  return true;
}
