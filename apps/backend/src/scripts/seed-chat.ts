import { and, eq, inArray } from 'drizzle-orm';
import { conversations, orgMembers, organizations, spaces, users } from '@crewhall/db';
import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps';
import type { ChatActor } from '../services/chat/access';
import { createConversation } from '../services/chat/conversations';
import { react, sendMessage } from '../services/chat/messages';
import { createWebhook, receiveHook } from '../services/chat/webhooks';
import { toActor } from '../services/membership';
import { SEED_CHAT_PEOPLE, SEED_CHAT_SPACES, SEED_ORG } from './seed-data';

/**
 * Phase 3 sample (design 04): a space conversation, a direct one, an unnamed group and
 * an alert conversation with a Seq webhook. Idempotent: skipped when the org has any.
 * Returns the webhook URL (its key is only known here).
 */
export async function seedChat(deps: Deps) {
  const { db } = deps;
  const [org] = await db.select().from(organizations).where(eq(organizations.slug, SEED_ORG.slug));
  if (!org) return null;
  const [any] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.orgId, org.id))
    .limit(1);
  if (any) return null;

  const emails = SEED_CHAT_PEOPLE;
  const people = await db.select().from(users).where(inArray(users.email, emails));
  const members = await db
    .select()
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.organizationId, org.id),
        inArray(
          orgMembers.userId,
          people.map((p) => p.id),
        ),
      ),
    );
  const actor = (email: string): ChatActor => {
    const u = people.find((p) => p.email === email)!;
    const m = members.find((x) => x.userId === u.id)!;
    return { org, actor: toActor(m), userId: u.id };
  };
  const [bugra, elif, mert, can, selin] = emails.map(actor) as [
    ChatActor,
    ChatActor,
    ChatActor,
    ChatActor,
    ChatActor,
  ];
  const say = (a: ChatActor, conversationId: string, text: string, replyToId?: string) =>
    sendMessage(deps, a, conversationId, {
      clientMsgId: randomUUID(),
      text,
      attachmentNodeIds: [],
      ...(replyToId ? { replyToId } : {}),
    });

  const spaceRows = await db.select().from(spaces).where(eq(spaces.orgId, org.id));
  const teamSpace = spaceRows.find((s) => s.kind === 'shared' && s.name === SEED_CHAT_SPACES.team)!;
  const altyapi = spaceRows.find((s) => s.kind === 'shared' && s.name === SEED_CHAT_SPACES.infra)!;

  const team = await createConversation(deps, bugra, {
    type: 'space',
    spaceId: teamSpace.id,
    name: 'Milvaion Ekibi',
  });
  const proposal = await say(
    can,
    team.id,
    'Scheduler retry politikası için önerim: MaxAttempts = 3, üstel backoff ve jitter. Dakikada bir tetiklendiği için 5 deneme fazla.',
  );
  await react(deps, bugra, proposal.id, '👍', true);
  await react(deps, elif, proposal.id, '👍', true);
  await say(
    elif,
    team.id,
    `Katılıyorum, 3 yeterli. PR'ı açtım, jitter'ı da ekledim. <@${bugra.userId}> Cuma'ya yetişsin istiyorum, bugün bakabilir misin?`,
    proposal.id,
  );
  await say(mert, team.id, "Test ortamına deploy ettim, retry'lar Seq'te düzgün görünüyor.");
  await say(bugra, team.id, "Stand-up'tan sonra bakıyorum.");

  const infra = await createConversation(deps, elif, {
    type: 'space',
    spaceId: altyapi.id,
    name: 'Altyapı',
  });
  await say(
    mert,
    infra.id,
    `<@${bugra.userId}> milva-01'de disk %80'e geldi, eski imajları siliyorum.`,
  );

  const direct = await createConversation(deps, elif, { type: 'direct', userId: bugra.userId });
  await say(elif, direct.id, "Retry PR'ında Backoff tipini değiştirdim.");

  await createConversation(deps, selin, {
    type: 'group',
    userIds: [can.userId, bugra.userId],
    message: {
      clientMsgId: randomUUID(),
      text: 'TestFlight derlemesi hazır.',
      attachmentNodeIds: [],
    },
  });

  const alerts = await createConversation(deps, bugra, {
    type: 'alert',
    name: 'Prod Alarmları',
    spaceId: altyapi.id,
    userIds: [],
  });
  const hook = await createWebhook(deps, bugra, alerts.id, { name: 'Seq' });
  const u = new URL(hook.url);
  await receiveHook(deps, {
    webhookId: hook.webhook.id,
    key: u.searchParams.get('key')!,
    ip: '127.0.0.1',
    body: JSON.stringify({
      card: {
        severity: 'critical',
        title: 'Hata oranı eşiği aştı',
        subtitle: 'milvaion-api',
        source: 'Seq',
        fields: [
          { label: 'Hata oranı', value: '%7,4' },
          { label: 'Eşik', value: '%5' },
        ],
        buttons: [{ text: "Seq'te aç", url: 'https://seq.example.com' }],
      },
    }),
  });
  return { webhookUrl: hook.url };
}
