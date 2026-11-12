/* eslint-disable no-restricted-syntax -- sample data uses the example tenant (CLAUDE.md allows it in seeds) */
/**
 * Wiki sample (design 05, doc 17 §14 phase 4 "Onboarding ve Milvaion sayfaları taşındı"):
 * pages in the default space, built through the page service so they look like UI-made
 * pages (derived markdown, search, versions). Runs once: skipped when the space has pages.
 *   pnpm --filter @crewhall/backend seed:wiki
 */
import { and, eq } from 'drizzle-orm';
import { nodes, spaces, users } from '@crewhall/db';
import { pagePath } from '@crewhall/shared';
import type { Deps } from '../deps';
import { loadEnv } from '../env';
import { build } from '../server';
import { primaryOrg } from '../services/brand';
import { actorFor } from '../services/wiki/access';
import { createComment } from '../services/wiki/comments';
import { createPage } from '../services/wiki/pages';

const opts = { source: 'web' as const, locale: 'tr' as const };

export async function seedWiki(deps: Deps) {
  const { db } = deps;
  const org = await primaryOrg(db);
  if (!org) return false;
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.orgId, org.id), eq(spaces.isDefault, true)));
  if (!space) return false;
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.spaceId, space.id), eq(nodes.type, 'page')))
    .limit(1);
  if (existing) return false;

  const people = await db.select().from(users);
  const byEmail = (e: string) => people.find((u) => u.email === e);
  const owner = byEmail('bugra@milvasoft.com') ?? people[0];
  if (!owner) return false;
  const a = await actorFor(db, org.id, owner.id);
  if (!a) return false;
  const mention = (email: string) => {
    const u = byEmail(email);
    return u ? `[@${u.name}](mention:user:${u.id})` : '';
  };
  const make = (parentId: string | null, name: string, markdown: string, icon?: string) =>
    createPage(deps, a, space.id, { parentId, name, markdown, icon }, opts);

  // The Drive sample has an "Onboarding" folder at the root: the page goes inside it.
  const [folder] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.spaceId, space.id), eq(nodes.type, 'folder'), eq(nodes.name, 'Onboarding')),
    );
  const onboarding = await make(
    folder?.id ?? null,
    'Onboarding',
    `Ekibe hoş geldin. Bu sayfa ilk haftanı planlaman için; sorularını Milvasoft Genel sohbetine yazabilirsin.

:::info[İlk gün]
Hub hesabında 2FA'yı kur. Kurum genelinde zorunlu; kurmadan Kasa açılmaz.
:::

## İlk hafta

- [x] Hub hesabını aç ve 2FA'yı kur
- [ ] Milvasoft kasasına erişim iste
- [ ] Geliştirme ortamını kur (Docker, .NET 9)
- [ ] Milvaion deposunu klonla, testleri çalıştır`,
    '👋',
  );
  const devEnv = await make(
    onboarding.id,
    'Geliştirme ortamı',
    `## Gerekenler

| Araç | Sürüm |
| --- | --- |
| Docker Desktop | 4.x |
| .NET SDK | 9.0 |
| Node.js | 22 |

\`\`\`bash
git clone git@github.com:milvasoft/milvaion.git
cd milvaion && docker compose up -d
\`\`\``,
    '🛠️',
  );
  await make(
    onboarding.id,
    'Kod standartları',
    `- Commit mesajları Conventional Commits biçiminde.
- Her değişiklik testle gelir.
- Gizli değerler sayfada tutulmaz; kasadan okunur.

Ayrıntılar için [Geliştirme ortamı](${pagePath(devEnv)}) sayfasına bak.`,
  );

  const milvaion = await make(
    null,
    'Milvaion',
    `Milvaion, Milvasoft'un açık kaynak dağıtık iş zamanlayıcısı.`,
    '🧭',
  );
  const notes = await make(
    milvaion.id,
    'Sürüm notları 1.4',
    `## Yeni

- İşler için yapılandırılabilir retry politikası: sabit, doğrusal ve üstel.
- Dashboard'a iş bağımlılık grafiği.

## Düzeltmeler

- Worker'larda SIGTERM ile düzgün kapanma.`,
  );
  const mimari = await make(
    milvaion.id,
    'Mimari',
    `Milvaion, Milvasoft'un açık kaynak dağıtık iş zamanlayıcısı. Bu sayfa servislerin birbiriyle nasıl konuştuğunu, veri katmanını ve dağıtım düzenini anlatır. 1.4'teki değişiklikler için [Sürüm notları 1.4](${pagePath(notes)}) sayfasına bak; kuyruk tarafındaki sorular için ${mention('can@milvasoft.com')}.

:::note[Canlı belge]
Mimari bir karar değişirse önce Milvaion Ekibi sohbetinde tartış, sonra aşağıdaki Karar kaydı bölümüne tarihle ekle.
:::

## Genel bakış

Sistem üç süreçten oluşur: API (ASP.NET Core 9), Scheduler ve yatayda ölçeklenen Worker havuzu. İş tanımları ve geçmişi PostgreSQL'de, kuyruk RabbitMQ'da, dağıtık kilitler Redis'te tutulur. Worker sunucuları IJobHandler arayüzünü uygulayan sınıfları çalıştırır.

### İş tanımı

\`\`\`csharp
public sealed record JobDefinition
{
    public Guid Id { get; init; } = Guid.CreateVersion7();
    public required string Name { get; init; }
    public string Cron { get; init; } = "0 */5 * * * *";
    public RetryPolicy Retry { get; init; } = RetryPolicy.Exponential(maxAttempts: 5);
}
\`\`\`

## Servisler

| Servis | Sorumlu | Ölçek | Ortam |
| --- | --- | --- | --- |
| Milvaion.Api | Can Demir | 2 kopya | Prod |
| Milvaion.Scheduler | Can Demir | 1 · lider seçimi | Prod |
| Milvaion.Worker | Elif Yıldız | 3–12 · otomatik | Prod |
| Milvaion.Dashboard | Zeynep Arslan | 1 kopya | Test |

## Akış

\`\`\`mermaid
flowchart LR
  Dashboard --> API
  API --> RabbitMQ
  Scheduler --> RabbitMQ
  RabbitMQ --> Worker
  Worker --> PostgreSQL
\`\`\`

## Açık işler

- [x] Worker'larda SIGTERM ile düzgün kapanma
- [ ] Scheduler lider seçimini PostgreSQL advisory lock'a taşı ${mention('can@milvasoft.com')}
- [ ] Dashboard'a iş bağımlılık grafiği ${mention('zeynep@milvasoft.com')}

:::toggle[Neden Hangfire ya da Quartz değil?]
Dağıtık kilit ve çoklu kiracı kotaları için kendi zamanlayıcımız daha az parça demek.
:::

## Karar kaydı

14 Ekim 2026 · Kuyruk RabbitMQ'da kalıyor. LISTEN/NOTIFY denendi; saatte ~40 bin işte geri basınç olmadığı için worker'lar boğuldu.`,
    '🏗️',
  );
  await make(
    null,
    'Toplantı notları',
    `Haftalık ekip toplantılarının notları. Yeni not için **Şablonla başla › Toplantı notu**.`,
    '🗓️',
  );

  const can = byEmail('can@milvasoft.com');
  if (can) {
    const canActor = await actorFor(db, org.id, can.id);
    if (canActor) {
      await createComment(deps, canActor, mimari.id, {
        body: 'Ayrı bir kuyruk servisi işletmek yerine Postgres LISTEN/NOTIFY yetmez mi? Bir bağımlılık azalır.',
        mentions: [],
      });
    }
  }
  await createComment(deps, a, mimari.id, {
    body: "Portal'a yayınlamadan önce Akış diyagramını son hâline getirelim.",
    mentions: [],
  });
  return true;
}

if (process.argv[1]?.replaceAll('\\', '/').match(/scripts\/seed-wiki\.ts$/)) {
  const env = loadEnv();
  const built = await build(
    { ...env, MIGRATE_ON_START: true, WORKER_IN_PROCESS: false },
    { jobs: 'inline' },
  );
  try {
    console.log(
      (await seedWiki(built.deps)) ? 'Added the wiki sample (phase 4).' : 'Wiki sample skipped.',
    );
  } finally {
    await built.close();
  }
}
