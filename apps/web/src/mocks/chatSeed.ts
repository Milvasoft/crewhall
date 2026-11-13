import {
  type AlertCard,
  type AlertSeverity,
  type ConversationFederation,
  type ConversationType,
  type MessageAttachment,
  type MessageKind,
  type MessageRef,
  type NotificationCategory,
  type NotificationSource,
  type NotifyLevel,
  type PresenceState,
  type RemoteUser,
  type SystemEvent,
  type UserStatus,
  type GifRating,
  type MessageGif,
  type MessageLinkPreview,
  type WebhookProvider,
} from '@crewhall/shared';
import { mimeFor } from '@/features/drive/fileKinds';
import { type BlobArt, type DriveState } from './driveSeed';
import { SPACE, USER } from './seed';

/** Sample chats of design 04 for the Milvasoft org; stored on MockState.chat. */

export interface MockConversation {
  id: string;
  type: ConversationType;
  spaceId: string | null;
  meetingId: string | null;
  name: string | null;
  createdBy: string | null;
  createdAt: string;
  lastSeq: number;
  archivedAt: string | null;
  attachmentsNodeId: string | null;
  /** Channel emoji; missing in states saved before it. */
  emoji?: string | null;
  /** Roadmap 26: shared with another installation. */
  federation?: ConversationFederation;
  /** Private space channel: members are the rows (people added), not the whole space. */
  private?: boolean;
}

export interface MockChatMember {
  conversationId: string;
  userId: string;
  joinedAt: string;
  historyFromSeq: number | null;
  pinnedAt: string | null;
  pinPosition: number | null;
  notify: NotifyLevel;
  mutedUntil: string | null;
  lastReadSeq: number;
  /** "Okunmadı olarak işaretle" (at least one unread until read again). */
  markedUnread?: boolean;
  readAt: string;
  /** H19: personal archive and "Benim için sil" (history up to this seq hidden). */
  archivedAt?: string | null;
  clearedAtSeq?: number | null;
  /** Private channels: owners manage people. */
  role?: 'owner' | 'member';
}

export interface MockMessage {
  id: string;
  conversationId: string;
  seq: number;
  kind: MessageKind;
  authorId: string | null;
  webhookId: string | null;
  text: string;
  card: AlertCard | null;
  system: SystemEvent | null;
  attachments: MessageAttachment[];
  replyToId: string | null;
  reactions: { emoji: string; userIds: string[] }[];
  clientMsgId: string | null;
  pinnedAt: string | null;
  pinnedBy: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Written through an MCP client or API token (Message.via). */
  via?: { kind: 'mcp' | 'api'; client: string } | null;
  /** Roadmap 26: written on another installation. */
  remoteAuthor?: RemoteUser | null;
  /** Written by a meeting guest, who has no account (Message.guestAuthor). */
  guestAuthor?: { name: string } | null;
  /** Roadmap 23: `/me`, `/whisper` and `/poll`. */
  emote?: boolean;
  whisperTo?: string | null;
  poll?: MockPoll | null;
  gif?: MessageGif | null;
  refs?: MessageRef[];
  /** "Ben bakıyorum" on a webhook card. */
  claim?: { userId: string; at: string } | null;
  /** A webhook's text without a card: the severity its webhook gives it. */
  severity?: AlertSeverity | null;
  /** Preview card of the first external link (Message.linkPreview). */
  linkPreview?: MessageLinkPreview | null;
}

export interface MockPoll {
  id: string;
  question: string;
  options: string[];
  multiple: boolean;
  closedAt: string | null;
  createdBy: string;
  votes: { userId: string; option: number }[];
}

export interface MockScheduled {
  id: string;
  conversationId: string;
  authorId: string;
  text: string;
  replyToId: string | null;
  attachmentNodeIds: string[];
  sendAt: string;
  status: 'scheduled' | 'sent' | 'cancelled' | 'failed';
  messageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MockReminder {
  id: string;
  userId: string;
  conversationId: string;
  text: string;
  remindAt: string;
  firedAt: string | null;
  createdAt: string;
}

export interface MockWebhook {
  id: string;
  conversationId: string;
  name: string;
  avatarUrl: string | null;
  key: string;
  rateLimit: number;
  lastUsedAt: string | null;
  mutedUntil: string | null;
  disabledAt: string | null;
  createdBy: string | null;
  createdAt: string;
  provider?: WebhookProvider | null;
  events?: string[];
  /** "Kartsız mesajın önemi"; null reads it from the text. */
  textSeverity?: AlertSeverity | null;
}

export interface MockDelivery {
  id: string;
  webhookId: string;
  receivedAt: string;
  status: number;
  sizeBytes: number;
  ip: string | null;
  latencyMs: number;
  error: string | null;
  bodyExcerpt: string | null;
  messageId: string | null;
}

export interface MockNotification {
  id: string;
  userId: string;
  type: string;
  category: NotificationCategory;
  source: NotificationSource;
  actorId: string | null;
  target: {
    type: 'message' | 'conversation' | 'node' | 'link' | 'card' | 'meeting' | 'space' | 'webhook';
    id: string;
    conversationId: string | null;
    seq: number | null;
    spaceId: string | null;
  };
  data: Record<string, string | number | boolean | null>;
  count: number;
  url: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MockPresence {
  /** Connected (simulated) and the state it shows. */
  state: PresenceState;
  auto: 'meeting' | 'screen_share' | null;
  lastSeenAt: string | null;
}

export interface ChatState {
  /** `/remind` (roadmap 23); missing in states saved before it. */
  reminders?: MockReminder[];
  /** Scheduled messages; missing in states saved before them. */
  scheduled?: MockScheduled[];
  /** GIF (GIPHY) settings; missing means off. */
  gif?: {
    enabled: boolean;
    apiKey: string | null;
    rating: GifRating;
    lang: string;
    keyTier?: 'beta' | 'production';
    /** GIPHY calls counted this hour (the mock never resets it). */
    used?: number;
  };
  conversations: MockConversation[];
  members: MockChatMember[];
  messages: MockMessage[];
  webhooks: MockWebhook[];
  deliveries: MockDelivery[];
  notifications: MockNotification[];
  statuses: Record<string, UserStatus>;
  presence: Record<string, MockPresence>;
  settings: Record<
    string,
    { readReceipts: boolean; timezone: string | null; recentEmojis: string[] }
  >;
  prefs: Record<
    string,
    {
      categories: {
        category: NotificationCategory;
        inApp: boolean;
        push: boolean;
        email: boolean;
      }[];
      digest: 'off' | 'hourly' | 'daily';
      quietHours: { from: string; to: string } | null;
      /** Rows the person set (NOTIFICATION_GROUPS); the others follow their category. */
      groups?: Record<string, { inApp: boolean; desktop: boolean; push: boolean; email: boolean }>;
    }
  >;
  tickets: { ticket: string; userId: string; expiresAt: string }[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const cid = (n: number) => `0190f0a0-0000-7000-8000-${(0x9000 + n).toString(16).padStart(12, '0')}`;

export const CONV = {
  milvaion: cid(1),
  prod: cid(2),
  mert: cid(3),
  altyapi: cid(4),
  elif: cid(5),
  deploy: cid(6),
  genel: cid(7),
  selinCan: cid(8),
  haftalik: cid(9),
  zeynep: cid(10),
} as const;

export const WEBHOOK = {
  uptime: cid(101),
  seq: cid(102),
  milvaion: cid(103),
  dokploy: cid(104),
  deployDokploy: cid(105),
} as const;

/** Keys of the seeded webhooks (the mock keeps them; the server only a hash). */
export const WEBHOOK_KEY = 'demo-hook-key';

const ALL_PEOPLE = Object.values(USER);

/**
 * Builds the chat store. Files that messages carry are added to Drive (`d`) under each chat's
 * "Ekler" folder, so attachments open like any other node.
 */
export function seedChat(d: DriveState): ChatState {
  const c: ChatState = {
    conversations: [],
    members: [],
    messages: [],
    webhooks: [],
    deliveries: [],
    notifications: [],
    statuses: {},
    presence: {},
    settings: {},
    prefs: {},
    tickets: [],
  };
  let n = 1000;
  const id = () => cid(++n);

  // ---- Drive folders and files for attachments ----
  const folder = (spaceId: string, parentId: string | null, name: string, by: string) => {
    const fid = id();
    d.nodes.push({
      id: fid,
      spaceId,
      parentId,
      type: 'folder',
      name,
      createdBy: by,
      updatedBy: by,
      createdAt: ago(60 * DAY),
      updatedAt: ago(60 * DAY),
      deletedAt: null,
      deletedBy: null,
      trashedWith: null,
    });
    return fid;
  };
  const file = (
    spaceId: string,
    parentId: string,
    name: string,
    sizeBytes: number,
    art: BlobArt,
    by: string,
    when: string,
  ): MessageAttachment => {
    const nid = id();
    const blobId = id();
    d.nodes.push({
      id: nid,
      spaceId,
      parentId,
      type: 'file',
      name,
      createdBy: by,
      updatedBy: by,
      createdAt: when,
      updatedAt: when,
      deletedAt: null,
      deletedBy: null,
      trashedWith: null,
    });
    const mime = mimeFor(name);
    d.blobs.push({
      id: blobId,
      sha256: `chat-${blobId}`,
      sizeBytes: Math.round(sizeBytes),
      mime,
      art,
    });
    d.versions.push({
      id: id(),
      nodeId: nid,
      version: 1,
      blobId,
      label: null,
      source: 'web',
      createdBy: by,
      createdAt: when,
    });
    const previewable = art.kind === 'image' || art.kind === 'video' || art.kind === 'pdf';
    return {
      nodeId: nid,
      name,
      mime,
      sizeBytes: Math.round(sizeBytes),
      preview: previewable ? 'ready' : 'none',
      removed: false,
    };
  };

  const eklerMilva = folder(SPACE.milvasoft, null, 'Ekler', USER.bugra);
  const eklerAltyapi = folder(SPACE.altyapi, null, 'Ekler', USER.mert);
  const personal = (userId: string) => {
    const i = ALL_PEOPLE.indexOf(userId as (typeof ALL_PEOPLE)[number]) + 1;
    return `0190f0a0-0000-7000-8000-${(300 + i).toString(16).padStart(12, '0')}`;
  };
  const chatEkleri: Record<string, string> = {};
  const myAttachments = (userId: string) =>
    (chatEkleri[userId] ??= folder(personal(userId), null, 'Chat ekleri', userId));

  // ---- conversations ----
  const conv = (
    cidv: string,
    type: ConversationType,
    opts: {
      name?: string;
      spaceId?: string;
      members: string[];
      createdBy?: string;
      createdAt?: string;
      attachments?: string;
    },
  ) => {
    c.conversations.push({
      id: cidv,
      type,
      spaceId: opts.spaceId ?? null,
      meetingId: type === 'meeting' ? id() : null,
      name: opts.name ?? null,
      createdBy: opts.createdBy ?? USER.bugra,
      createdAt: opts.createdAt ?? ago(90 * DAY),
      lastSeq: 0,
      archivedAt: null,
      attachmentsNodeId: opts.attachments ?? null,
    });
    for (const u of opts.members) {
      c.members.push({
        conversationId: cidv,
        userId: u,
        joinedAt: opts.createdAt ?? ago(90 * DAY),
        historyFromSeq: null,
        pinnedAt: null,
        pinPosition: null,
        notify:
          type === 'direct' || type === 'group'
            ? 'all'
            : type === 'alert'
              ? 'critical'
              : 'mentions',
        mutedUntil: null,
        lastReadSeq: 0,
        readAt: ago(DAY),
      });
    }
  };

  const msg = (
    convId: string,
    author: string | null,
    when: string,
    text: string,
    extra: Partial<MockMessage> = {},
  ): MockMessage => {
    const cv = c.conversations.find((x) => x.id === convId)!;
    cv.lastSeq += 1;
    const m: MockMessage = {
      id: id(),
      conversationId: convId,
      seq: cv.lastSeq,
      kind: author ? 'user' : extra.webhookId ? 'webhook' : 'system',
      authorId: author,
      webhookId: null,
      text,
      card: null,
      system: null,
      attachments: [],
      replyToId: null,
      reactions: [],
      clientMsgId: null,
      pinnedAt: null,
      pinnedBy: null,
      editedAt: null,
      deletedAt: null,
      createdAt: when,
      updatedAt: when,
      ...extra,
    };
    c.messages.push(m);
    return m;
  };
  /** Everyone has read up to here (the rest is unread for Buğra). */
  const readAll = (convId: string, except: string[] = []) => {
    const cv = c.conversations.find((x) => x.id === convId)!;
    for (const m of c.members.filter((x) => x.conversationId === convId)) {
      if (!except.includes(m.userId)) m.lastReadSeq = cv.lastSeq;
    }
  };
  const setRead = (convId: string, userId: string, seq: number) => {
    const m = c.members.find((x) => x.conversationId === convId && x.userId === userId);
    if (m) m.lastReadSeq = seq;
  };
  const pin = (convId: string, userId: string, position: number) => {
    const m = c.members.find((x) => x.conversationId === convId && x.userId === userId);
    if (m) {
      m.pinnedAt = ago(30 * DAY);
      m.pinPosition = position;
    }
  };

  const { bugra, elif, mert, zeynep, can, selin, burak } = USER;

  // 4.1 Milvaion Ekibi (space chat of Milvasoft)
  const milvaionEkler = folder(SPACE.milvasoft, eklerMilva, 'Milvaion Ekibi', bugra);
  conv(CONV.milvaion, 'space', {
    name: 'Milvaion Ekibi',
    spaceId: SPACE.milvasoft,
    members: [bugra, elif, mert, can, zeynep, selin, burak],
    attachments: milvaionEkler,
  });
  const takvim = msg(
    CONV.milvaion,
    elif,
    ago(18 * DAY),
    'Sürüm takvimi: 1.4 → 23 Ekim, 1.5 → Kasım sonu. Değişiklik olursa bu mesajı düzenliyorum.',
    { pinnedAt: ago(18 * DAY), pinnedBy: bugra, editedAt: ago(10 * DAY) },
  );
  msg(
    CONV.milvaion,
    mert,
    ago(11 * DAY),
    'Test ortamı: https://milvaion-test.milvasoft.com · Seq: https://seq.milvasoft.com . Giriş bilgileri Milvasoft kasasında.',
    { pinnedAt: ago(11 * DAY), pinnedBy: mert },
  );
  msg(
    CONV.milvaion,
    zeynep,
    ago(4 * DAY),
    '1.4 sürüm notlarının taslağı hazır, yorumlarınızı doğrudan sayfaya bırakın 🙏',
    {
      pinnedAt: ago(4 * DAY),
      pinnedBy: zeynep,
      attachments: [
        file(
          SPACE.milvasoft,
          milvaionEkler,
          'milva-sunum-2026.pdf',
          3.8 * 1024 * 1024,
          { kind: 'pdf', title: 'Milvaion 1.4', pages: 6, lines: ['Sürüm notları', 'Retry'] },
          zeynep,
          ago(4 * DAY),
        ),
      ],
    },
  );
  const retry = msg(
    CONV.milvaion,
    can,
    ago(45 * MIN),
    "Retry politikasına jitter ekledim; aynı anda düşen job'lar artık hep birlikte yeniden denenmiyor:\n```csharp\nservices.AddMilvaionScheduler(o => o.Retry = new RetryPolicy(\n    maxAttempts: 5,\n    backoff: Backoff.Exponential(TimeSpan.FromSeconds(2), jitter: 0.2)));\n```",
    {
      pinnedAt: ago(25 * MIN),
      pinnedBy: bugra,
      reactions: [
        { emoji: '👍', userIds: [elif, mert, zeynep] },
        { emoji: '🚀', userIds: [selin, bugra] },
      ],
    },
  );
  msg(
    CONV.milvaion,
    bugra,
    ago(33 * MIN),
    "Güzel. `MaxAttempts`'ı `appsettings`'e taşıyalım, varsayılan 3 olsun.",
    { replyToId: retry.id },
  );
  readAll(CONV.milvaion);
  msg(
    CONV.milvaion,
    elif,
    ago(16 * MIN),
    `PR'ı açtım: job geçmişi imleç tabanlı sayfalanıyor, 50 bin kayıtta ilk sayfa 40 ms. https://dev.azure.com/example/milvaion/_git/milvaion/pullrequest/482\n<@${bugra}> Cuma'ya yetişsin istiyorum, bugün bakabilir misin?`,
    {
      attachments: [
        file(
          SPACE.milvasoft,
          milvaionEkler,
          'job-history-bench.png',
          412 * 1024,
          { kind: 'image', width: 1200, height: 700 },
          elif,
          ago(16 * MIN),
        ),
      ],
    },
  );
  msg(
    CONV.milvaion,
    mert,
    ago(9 * MIN),
    'Test ortamına deploy ettim, sayfalama akıcı. Kısa bir ekran kaydı:',
    {
      attachments: [
        file(
          SPACE.milvasoft,
          milvaionEkler,
          'ekran-kaydi.mp4',
          24.6 * 1024 * 1024,
          { kind: 'video', durationSec: 48 },
          mert,
          ago(9 * MIN),
        ),
      ],
    },
  );
  readAll(CONV.milvaion, [bugra]);
  setRead(CONV.milvaion, bugra, c.conversations.find((x) => x.id === CONV.milvaion)!.lastSeq - 2);
  pin(CONV.milvaion, bugra, 0);
  void takvim;

  // 4.11 Prod Alarmları (alert chat of Altyapı)
  conv(CONV.prod, 'alert', {
    name: 'Prod Alarmları',
    spaceId: SPACE.altyapi,
    members: [bugra, mert, can],
    attachments: folder(SPACE.altyapi, eklerAltyapi, 'Prod Alarmları', mert),
  });
  const hook = (hid: string, convId: string, name: string, minutesAgo: number) =>
    c.webhooks.push({
      id: hid,
      conversationId: convId,
      name,
      avatarUrl: null,
      key: WEBHOOK_KEY,
      rateLimit: 60,
      lastUsedAt: ago(minutesAgo * MIN),
      mutedUntil: null,
      disabledAt: null,
      createdBy: mert,
      createdAt: ago(40 * DAY),
    });
  hook(WEBHOOK.uptime, CONV.prod, 'Uptime Kuma', 5);
  hook(WEBHOOK.seq, CONV.prod, 'Seq', 13);
  hook(WEBHOOK.milvaion, CONV.prod, 'Milvaion', 3);
  hook(WEBHOOK.dokploy, CONV.prod, 'Dokploy', 1);
  const bot = (convId: string, hid: string, when: string, card: AlertCard, text = '') =>
    msg(convId, null, when, text, { kind: 'webhook', webhookId: hid, card });
  bot(CONV.prod, WEBHOOK.uptime, ago(20 * MIN), {
    severity: 'critical',
    title: 'Erişilemiyor · RedisInsight',
    subtitle: 'redis.milvasoft.com · HTTP 502 · 3 kontrol üst üste',
    source: 'Uptime Kuma',
    fields: [],
    buttons: [{ text: "Uptime Kuma'da aç", url: 'https://status.milvasoft.com' }],
  });
  readAll(CONV.prod);
  const seqAlert = bot(CONV.prod, WEBHOOK.seq, ago(13 * MIN), {
    severity: 'critical',
    title: 'Kritik · milvaion-api · 5 dk’da 48 hata',
    subtitle: 'Prod · eşik 20',
    source: 'Seq',
    fields: [
      { label: 'Servis', value: 'milvaion-api' },
      { label: 'Ortam', value: 'Prod' },
      { label: 'Hata sayısı', value: '48' },
      { label: 'Zaman', value: '09:23 – 09:28' },
    ],
    buttons: [{ text: "Seq'te aç", url: 'https://seq.milvasoft.com' }],
  });
  const uptimeDown = c.messages.find((m) => m.webhookId === WEBHOOK.uptime)!;
  msg(CONV.prod, mert, ago(11 * MIN), "Bellek limiti dolmuş, container'ı yeniden başlatıyorum.", {
    replyToId: uptimeDown.id,
  });
  bot(CONV.prod, WEBHOOK.uptime, ago(5 * MIN), {
    severity: 'success',
    title: 'Tekrar çalışıyor · RedisInsight',
    subtitle: 'redis.milvasoft.com · 15 dk kesinti · yanıt 84 ms',
    source: 'Uptime Kuma',
    fields: [],
    buttons: [],
  });
  bot(CONV.prod, WEBHOOK.milvaion, ago(3 * MIN), {
    severity: 'warning',
    title: 'Job başarısız · invoice-sync',
    subtitle: 'Prod · TimeoutException · 3/3 deneme · sonraki çalışma 10:00',
    source: 'Milvaion',
    fields: [],
    buttons: [{ text: "Milvaion'da aç", url: 'https://milvaion.milvasoft.com' }],
  });
  bot(CONV.prod, WEBHOOK.dokploy, ago(1 * MIN), {
    severity: 'success',
    title: 'Deploy başarılı · milvaion-api 1.4.0-rc2',
    subtitle: 'Prod · 1 dk 42 sn · a3f9c21 · PR 482 · milva-01 · tetikleyen Elif Yıldız',
    source: 'Dokploy',
    fields: [],
    buttons: [],
  });
  readAll(CONV.prod, [bugra]);
  pin(CONV.prod, bugra, 1);
  void seqAlert;

  // Direct with Mert
  conv(CONV.mert, 'direct', { members: [bugra, mert], createdAt: ago(200 * DAY) });
  msg(CONV.mert, bugra, ago(2 * DAY), 'netcup faturasını ödedim, Drive’a koydum.');
  msg(CONV.mert, mert, ago(2 * DAY - 10 * MIN), 'Süper, teşekkürler 🙏');
  readAll(CONV.mert);
  msg(CONV.mert, mert, ago(14 * MIN), "RedisInsight'ı yeniden başlattım, bellek limiti dolmuş");

  // Altyapı space chat
  conv(CONV.altyapi, 'space', {
    name: 'Altyapı',
    spaceId: SPACE.altyapi,
    members: [bugra, mert, can],
    attachments: folder(SPACE.altyapi, eklerAltyapi, 'Altyapı', mert),
  });
  msg(
    CONV.altyapi,
    mert,
    ago(DAY + 3 * HOUR),
    "Redis'i 7.4'e yükselttim, milva-01'de 6 sn kesinti oldu. Yedek alındı.",
  );
  readAll(CONV.altyapi);
  msg(CONV.altyapi, can, ago(40 * MIN), 'Yedekleme planı sayfasına yorum yazdım.');
  msg(
    CONV.altyapi,
    mert,
    ago(28 * MIN),
    `<@${bugra}> milva-01 diski %85'e geldi, eski imajları siliyorum.`,
  );

  // 4.5 Direct with Elif
  conv(CONV.elif, 'direct', { members: [bugra, elif], createdAt: ago(300 * DAY) });
  msg(CONV.elif, elif, ago(3 * DAY), 'İyi hafta sonları 👋');
  msg(CONV.elif, bugra, ago(3 * DAY - 2 * MIN), 'Sana da!');
  msg(
    CONV.elif,
    elif,
    ago(55 * MIN),
    "Günaydın! NuGet API key'in süresi Cuma doluyordu, yenisini kasaya ekledim.",
  );
  msg(
    CONV.elif,
    bugra,
    ago(48 * MIN),
    "Süper, teşekkürler. Azure DevOps'taki pipeline değişkenini ben güncellerim. Compose dosyasının son hali:",
    {
      attachments: [
        file(
          personal(bugra),
          myAttachments(bugra),
          'docker-compose.yml',
          3.2 * 1024,
          { kind: 'text', text: 'services:\n  redis:\n    image: redis:7.4\n' },
          bugra,
          ago(48 * MIN),
        ),
      ],
    },
  );
  msg(
    CONV.elif,
    elif,
    ago(43 * MIN),
    "Redis'e healthcheck eklemişsin 👌 depends_on koşulunu da service_healthy yapalım mı?",
  );
  msg(CONV.elif, bugra, ago(41 * MIN), 'Evet, ekledim bile 🙂');
  readAll(CONV.elif);

  // Deploy log (alert chat of Dumpapp)
  conv(CONV.deploy, 'alert', {
    name: 'Deploy log',
    spaceId: SPACE.dumpapp,
    members: [bugra, elif, selin, can],
  });
  hook(WEBHOOK.deployDokploy, CONV.deploy, 'Dokploy', 39);
  bot(CONV.deploy, WEBHOOK.deployDokploy, ago(DAY), {
    severity: 'success',
    title: 'Deploy başarılı · dumpapp-api 2.8.1',
    subtitle: 'Prod · 58 sn',
    source: 'Dokploy',
    fields: [],
    buttons: [],
  });
  readAll(CONV.deploy);
  bot(CONV.deploy, WEBHOOK.deployDokploy, ago(39 * MIN), {
    severity: 'critical',
    title: 'Deploy başarısız · dumpapp-scheduler',
    subtitle: 'Prod · build adımında hata · exit code 1',
    source: 'Dokploy',
    fields: [{ label: 'Commit', value: '7be21d0' }],
    buttons: [],
  });
  readAll(CONV.deploy, [bugra]);

  // Milvasoft Genel
  conv(CONV.genel, 'space', {
    name: 'Milvasoft Genel',
    spaceId: SPACE.milvasoft,
    members: ALL_PEOPLE,
    attachments: folder(SPACE.milvasoft, eklerMilva, 'Milvasoft Genel', bugra),
  });
  msg(CONV.genel, zeynep, ago(DAY + 2 * HOUR), 'Cuma 16:00 demo, herkes davetli 🎉', {
    reactions: [{ emoji: '🎉', userIds: [elif, can, selin] }],
  });
  readAll(CONV.genel);

  // 4.6 Unnamed group Selin, Can
  conv(CONV.selinCan, 'group', {
    members: [bugra, selin, can],
    createdBy: selin,
    createdAt: ago(48 * DAY),
  });
  msg(CONV.selinCan, null, ago(48 * DAY), '', {
    system: { type: 'created', actorId: selin, userIds: [can, bugra] },
  });
  msg(
    CONV.selinCan,
    selin,
    ago(8 * DAY),
    'Mobil 2.3 için API değişikliklerini burada toplayalım mı?',
  );
  msg(
    CONV.selinCan,
    can,
    ago(8 * DAY - 14 * MIN),
    'Olur. /v2/sync hazır, sayfalama imleçli; eski uç Kasım sonuna kadar açık kalacak.',
  );
  msg(
    CONV.selinCan,
    selin,
    ago(DAY - 2 * HOUR),
    'TestFlight 2.3.0 yüklendi, yeni senkron ekranı:',
    {
      attachments: [
        file(
          personal(selin),
          myAttachments(selin),
          'senkron-1.png',
          380 * 1024,
          { kind: 'image', width: 750, height: 1334 },
          selin,
          ago(DAY - 2 * HOUR),
        ),
        file(
          personal(selin),
          myAttachments(selin),
          'senkron-2.png',
          402 * 1024,
          { kind: 'image', width: 750, height: 1334 },
          selin,
          ago(DAY - 2 * HOUR),
        ),
      ],
      reactions: [{ emoji: '🎉', userIds: [can, bugra] }],
    },
  );
  msg(CONV.selinCan, bugra, ago(DAY - 2 * HOUR + 13 * MIN), 'Harika, akşam cihazımda deneyeceğim.');
  readAll(CONV.selinCan);

  // 4.15 Meeting chat
  conv(CONV.haftalik, 'meeting', {
    name: 'Milvaion haftalık',
    members: [bugra, zeynep, elif, can, mert],
    createdBy: zeynep,
    createdAt: ago(30 * DAY),
  });
  msg(
    CONV.haftalik,
    zeynep,
    ago(8 * DAY),
    "Gündem: 1) 1.4 sürüm durumu 2) job geçmişi PR'ı 3) Dumpapp entegrasyonu",
  );
  msg(CONV.haftalik, elif, ago(8 * DAY - 15 * MIN), '40 ms çok iyi, 1.4’e alıyoruz 👍');
  readAll(CONV.haftalik);

  // Direct with Zeynep
  conv(CONV.zeynep, 'direct', { members: [bugra, zeynep], createdAt: ago(100 * DAY) });
  msg(CONV.zeynep, zeynep, ago(4 * DAY), "Logo paketini Drive'a koydum");
  readAll(CONV.zeynep);

  // ---- webhook deliveries (4.14) ----
  const deliver = (
    hid: string,
    minutesAgo: number,
    status: number,
    extra: Partial<MockDelivery> = {},
  ) =>
    c.deliveries.push({
      id: id(),
      webhookId: hid,
      receivedAt: ago(minutesAgo * MIN),
      status,
      sizeBytes: 640 + ((minutesAgo * 37) % 900),
      ip: '10.8.0.12',
      latencyMs: 18 + (minutesAgo % 30),
      error: null,
      bodyExcerpt: null,
      messageId: null,
      ...extra,
    });
  for (let i = 0; i < 6; i++) deliver(WEBHOOK.seq, 13 + i * 70, 200);
  for (let i = 0; i < 14; i++) deliver(WEBHOOK.uptime, 5 + i * 40, 200);
  for (let i = 0; i < 4; i++) deliver(WEBHOOK.dokploy, 1 + i * 180, 200);
  deliver(WEBHOOK.milvaion, 3, 200);
  for (let i = 0; i < 3; i++) {
    deliver(WEBHOOK.milvaion, 4 + i, 429, {
      error: 'rate_limited',
      bodyExcerpt: '{"text":"Job başarısız: invoice-sync …"}',
    });
  }
  deliver(WEBHOOK.milvaion, 300, 400, {
    error: 'webhook_payload_invalid',
    bodyExcerpt: '{"txt":"Job başarısız"}',
  });
  deliver(WEBHOOK.milvaion, 600, 413, { error: 'webhook_payload_too_large', sizeBytes: 48_211 });
  deliver(WEBHOOK.deployDokploy, 39, 200);

  // ---- people: titles, statuses, presence ----
  const status = (visibility: UserStatus['visibility'], message: UserStatus['message'] = null) => ({
    visibility,
    visibilityUntil: null,
    message,
    autoMeeting: true,
  });
  c.statuses = {
    [bugra]: status('online'),
    [elif]: status('online'),
    [mert]: status('online', { text: 'milva-01 bakımı', emoji: '🛠️', expiresAt: ago(-HOUR) }),
    [zeynep]: status('online'),
    [can]: status('busy', { text: 'Kod incelemesindeyim', emoji: null, expiresAt: null }),
    [selin]: status('online'),
    [burak]: status('online'),
  };
  c.presence = {
    [bugra]: { state: 'online', auto: null, lastSeenAt: ago(0) },
    [elif]: { state: 'online', auto: null, lastSeenAt: ago(MIN) },
    [mert]: { state: 'busy', auto: 'meeting', lastSeenAt: ago(MIN) },
    [zeynep]: { state: 'away', auto: null, lastSeenAt: ago(20 * MIN) },
    [can]: { state: 'busy', auto: null, lastSeenAt: ago(5 * MIN) },
    [selin]: { state: 'offline', auto: null, lastSeenAt: ago(3 * DAY) },
    [burak]: { state: 'online', auto: null, lastSeenAt: ago(MIN) },
  };
  for (const u of ALL_PEOPLE) {
    c.settings[u] = {
      readReceipts: true,
      timezone: 'Europe/Istanbul',
      recentEmojis: ['👍', '🎉', '🚀', '👀', '🙏'],
    };
  }

  // ---- notifications for Buğra (19.17) ----
  const note = (
    minutesAgo: number,
    p: Omit<
      MockNotification,
      | 'id'
      | 'userId'
      | 'createdAt'
      | 'updatedAt'
      | 'count'
      | 'readAt'
      | 'snoozedUntil'
      | 'dismissedAt'
    > &
      Partial<Pick<MockNotification, 'readAt' | 'snoozedUntil' | 'dismissedAt' | 'count'>>,
  ) =>
    c.notifications.push({
      id: id(),
      userId: bugra,
      count: 1,
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
      createdAt: ago(minutesAgo * MIN),
      updatedAt: ago(minutesAgo * MIN),
      ...p,
    });
  const lastOf = (convId: string) => c.conversations.find((x) => x.id === convId)!.lastSeq;
  note(13, {
    type: 'chat.alert',
    category: 'alert',
    source: 'alerts',
    actorId: null,
    target: {
      type: 'message',
      id: seqAlert.id,
      conversationId: CONV.prod,
      seq: seqAlert.seq,
      spaceId: SPACE.altyapi,
    },
    data: {
      conversationTitle: 'Prod Alarmları',
      webhookName: 'Seq',
      excerpt: 'Hata oranı eşiği aştı · milvaion-api',
      severity: 'critical',
    },
    url: `/chat/c/${CONV.prod}?seq=${seqAlert.seq}`,
  });
  note(28, {
    type: 'chat.mention',
    category: 'mention',
    source: 'chat',
    actorId: mert,
    target: {
      type: 'message',
      id: id(),
      conversationId: CONV.altyapi,
      seq: lastOf(CONV.altyapi),
      spaceId: SPACE.altyapi,
    },
    data: {
      conversationTitle: 'Altyapı',
      excerpt: "@Buğra milva-01 diski %85'e geldi, eski imajları siliyorum.",
    },
    url: `/chat/c/${CONV.altyapi}?seq=${lastOf(CONV.altyapi)}`,
  });
  note(16, {
    type: 'chat.mention',
    category: 'mention',
    source: 'chat',
    actorId: elif,
    target: {
      type: 'message',
      id: id(),
      conversationId: CONV.milvaion,
      seq: lastOf(CONV.milvaion) - 1,
      spaceId: SPACE.milvasoft,
    },
    data: {
      conversationTitle: 'Milvaion Ekibi',
      excerpt: "@Buğra Cuma'ya yetişsin istiyorum, bugün bakabilir misin?",
    },
    url: `/chat/c/${CONV.milvaion}?seq=${lastOf(CONV.milvaion) - 1}`,
  });
  note(14, {
    type: 'chat.direct',
    category: 'direct_reply',
    source: 'chat',
    actorId: mert,
    target: {
      type: 'message',
      id: id(),
      conversationId: CONV.mert,
      seq: lastOf(CONV.mert),
      spaceId: null,
    },
    data: {
      conversationTitle: 'Mert Aydın',
      excerpt: "RedisInsight'ı yeniden başlattım, bellek limiti dolmuş",
    },
    url: `/chat/c/${CONV.mert}?seq=${lastOf(CONV.mert)}`,
  });
  note(39, {
    type: 'chat.alert',
    category: 'alert',
    source: 'alerts',
    actorId: null,
    target: {
      type: 'conversation',
      id: CONV.deploy,
      conversationId: CONV.deploy,
      seq: lastOf(CONV.deploy),
      spaceId: SPACE.dumpapp,
    },
    data: {
      conversationTitle: 'Deploy log',
      webhookName: 'Dokploy',
      excerpt: 'Deploy başarısız · dumpapp-scheduler',
      severity: 'critical',
    },
    url: `/chat/c/${CONV.deploy}`,
  });
  note(3 * 60, {
    type: 'link.down',
    category: 'links',
    source: 'alerts',
    actorId: null,
    target: { type: 'link', id: id(), conversationId: null, seq: null, spaceId: SPACE.altyapi },
    data: { linkTitle: 'Portainer', url: 'https://portainer.milvasoft.com' },
    url: '/',
    readAt: ago(2 * HOUR),
  });
  note(26 * 60, {
    type: 'drive.shared',
    category: 'share',
    source: 'drive',
    actorId: zeynep,
    target: { type: 'node', id: id(), conversationId: null, seq: null, spaceId: SPACE.milvasoft },
    data: { nodeName: 'Logo paketi.zip', spaceName: 'Milvasoft' },
    url: '/drive/milvasoft',
    readAt: ago(20 * HOUR),
  });
  note(2 * 24 * 60, {
    type: 'space.added',
    category: 'share',
    source: 'drive',
    actorId: elif,
    target: {
      type: 'space',
      id: SPACE.dumpapp,
      conversationId: null,
      seq: null,
      spaceId: SPACE.dumpapp,
    },
    data: { spaceName: 'Dumpapp' },
    url: '/drive/dumpapp',
    readAt: ago(DAY),
  });
  note(5 * 60, {
    type: 'chat.reply',
    category: 'direct_reply',
    source: 'chat',
    actorId: can,
    target: { type: 'message', id: id(), conversationId: CONV.selinCan, seq: 3, spaceId: null },
    data: { conversationTitle: 'Selin, Can', excerpt: 'Olur. /v2/sync hazır, sayfalama imleçli.' },
    url: `/chat/c/${CONV.selinCan}?seq=3`,
    snoozedUntil: new Date(Date.now() + 3 * HOUR).toISOString(),
    readAt: ago(4 * HOUR),
  });

  return c;
}
