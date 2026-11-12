import { type CardType, type LinkHealth, type SpaceColor } from '@crewhall/shared';
import { NODE } from './driveSeed';
import { SPACE, USER } from './seed';

/** Quick access sample (design 02 · 2.1, 2.5, 2.8, 2.12) for the Milvasoft org. */

export interface MockLink {
  id: string;
  url: string;
  host: string;
  siteTitle: string | null;
  faviconUrl: string | null;
  checkEnabled: boolean;
  intervalSeconds: 60 | 300 | 900;
  health: LinkHealth;
  opens30d: number;
}

export interface MockCard {
  id: string;
  surfaceId: string;
  type: CardType;
  /** Shape follows `type` (CardConfig in @crewhall/shared); checked by the resolvers. */
  config: Record<string, unknown>;
  layout: { x: number; y: number; w: number; h: number };
  mobileOrder: number | null;
  pinnedFrom: { cardId: string; surfaceId: string } | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MockSurface {
  id: string;
  ownerType: 'user' | 'space';
  ownerId: string;
  layoutRev: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface QuickState {
  links: MockLink[];
  surfaces: MockSurface[];
  cards: MockCard[];
}

const qid = (n: number) => `0190f0a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const SURFACE = {
  bugra: qid(7001),
  milvasoft: qid(7002),
  altyapi: qid(7003),
} as const;

export const LINK = {
  redisTest: qid(7120),
  portainerProd: qid(7127),
} as const;

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function up(latencyMs: number): LinkHealth {
  return {
    status: 'up',
    since: ago(3 * 24 * 60 * MIN),
    checkedAt: ago(40_000),
    httpStatus: 200,
    latencyMs,
    tlsExpiresAt: new Date(Date.now() + 70 * 24 * 60 * MIN).toISOString(),
    reason: null,
    lastUpAt: ago(40_000),
  };
}

export function seedQuick(): QuickState {
  const q: QuickState = { links: [], surfaces: [], cards: [] };
  let counter = 7100;
  const next = () => qid(counter++);

  const link = (
    url: string,
    siteTitle: string | null,
    health: LinkHealth = up(120),
    id = next(),
  ) => {
    q.links.push({
      id,
      url,
      host: new URL(url).host,
      siteTitle,
      faviconUrl: null,
      checkEnabled: true,
      intervalSeconds: 60,
      health,
      opens30d: 0,
    });
    return id;
  };
  const item = (linkId: string, title: string, description: string | null = null) => ({
    id: next(),
    linkId,
    title,
    description,
  });

  const docs = link('https://docs.milvasoft.com/', 'Milvasoft Docs');
  const cavepass = link('https://cavepass.milvasoft.com/', 'Cavepass');
  const meet = link('https://meet.milvasoft.com/', 'Meet');
  const devops = link('https://dev.azure.com/', 'Azure DevOps');
  const nuget = link('https://www.nuget.org/profiles/Milvasoft', 'NuGet Gallery');
  const dockerHub = link('https://hub.docker.com/u/milvasoft', 'Docker Hub');
  const milvaion = link('https://milvaion.milvasoft.com/', 'Milvaion');
  const github = link('https://github.com/milvasoft', 'GitHub');
  const dokploy = link('https://deploy.milvasoft.com/', 'Dokploy');
  const pairdrop = link('https://drop.milvasoft.com/', 'PairDrop');
  // Tools · Test
  const seqTest = link('https://seq.test.milvasoft.com/', 'Seq');
  const pgTest = link('https://pgadmin.test.milvasoft.com/', 'pgAdmin');
  link(
    'https://redis.test.milvasoft.com/',
    'RedisInsight',
    {
      status: 'down',
      since: ago(7 * MIN),
      checkedAt: ago(30_000),
      httpStatus: 502,
      latencyMs: null,
      tlsExpiresAt: null,
      reason: 'http_502',
      lastUpAt: ago(10 * MIN),
    },
    LINK.redisTest,
  );
  const portainerTest = link('https://portainer.test.milvasoft.com/', 'Portainer');
  // Tools · Prod
  const seq = link('https://seq.milvasoft.com/', 'Seq');
  const pg = link('https://pgadmin.milvasoft.com/', 'pgAdmin');
  const redis = link('https://redis.milvasoft.com/', 'RedisInsight');
  link(
    'https://portainer.milvasoft.com/',
    'Portainer',
    { ...up(1800), status: 'warn', since: ago(25 * MIN), reason: 'slow' },
    LINK.portainerProd,
  );

  const now = ago(0);
  const surface = (id: string, ownerType: 'user' | 'space', ownerId: string, by: string | null) =>
    q.surfaces.push({
      id,
      ownerType,
      ownerId,
      layoutRev: 1,
      updatedAt: ago(2 * 24 * 60 * MIN),
      updatedBy: by,
    });
  const card = (
    surfaceId: string,
    type: CardType,
    config: Record<string, unknown>,
    [x, y, w, h]: [number, number, number, number],
  ) => {
    const id = next();
    q.cards.push({
      id,
      surfaceId,
      type,
      config,
      layout: { x, y, w, h },
      mobileOrder: null,
      pinnedFrom: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    return id;
  };
  const group = (
    title: string,
    color: SpaceColor | null,
    view: 'list' | 'grid',
    sections: { title: string; items: ReturnType<typeof item>[] }[],
  ) => ({
    title,
    color,
    view,
    sort: 'manual',
    sectionsAsTabs: sections.length > 1,
    showUrls: view === 'list',
    showHealth: true,
    sections: sections.map((s) => ({ id: next(), ...s })),
  });
  const tools = () =>
    group('Tools', null, 'grid', [
      {
        title: 'Test',
        items: [
          item(seqTest, 'Seq'),
          item(pgTest, 'pgAdmin'),
          item(LINK.redisTest, 'RedisInsight'),
          item(portainerTest, 'Portainer'),
        ],
      },
      {
        title: 'Prod',
        items: [
          item(seq, 'Seq'),
          item(pg, 'pgAdmin'),
          item(redis, 'Redis'),
          item(LINK.portainerProd, 'Portainer'),
        ],
      },
    ]);

  // ---- Benim · Buğra (2.1) ----
  const B = SURFACE.bugra;
  surface(B, 'user', USER.bugra, USER.bugra);
  card(
    B,
    'link_group',
    group('Milvasoft', 's1', 'list', [
      {
        title: '',
        items: [
          item(docs, 'Docs'),
          item(cavepass, 'Cavepass'),
          item(meet, 'Meet'),
          item(devops, 'Azure DevOps'),
          item(nuget, 'NuGet'),
          item(dockerHub, 'Docker Hub'),
          item(milvaion, 'Milvaion'),
        ],
      },
    ]),
    [0, 0, 3, 5],
  );
  card(
    B,
    'note',
    {
      text: "Prod deploy'dan önce Seq'te hata oranına bak. Cuma 17:00'den sonra deploy yok.",
      color: 's3',
      fontSize: 'large',
    },
    [3, 0, 3, 2],
  );
  card(B, 'link', { item: item(dokploy, 'Dokploy', 'Deploy paneli') }, [6, 0, 2, 1]);
  card(B, 'link', { item: item(pairdrop, 'PairDrop', 'Dosya at') }, [8, 0, 2, 1]);
  card(B, 'link', { item: item(github, 'GitHub') }, [10, 0, 2, 1]);
  card(B, 'node', { nodeId: NODE.onboarding }, [6, 1, 3, 3]);
  card(B, 'node', { nodeId: NODE.q3 }, [9, 1, 3, 1]);
  card(B, 'node', { nodeId: NODE.sunum2026 }, [9, 2, 3, 2]);
  const done = ago(26 * 60 * MIN);
  card(
    B,
    'todo',
    {
      title: 'Bu hafta',
      items: [
        { id: next(), text: 'Milvaion 1.4 sürüm notları', done: true, doneAt: done },
        { id: next(), text: 'netcup faturasını öde', done: true, doneAt: done },
        { id: next(), text: "Portal'ı Hub'a taşı", done: false, doneAt: null },
        { id: next(), text: 'Dumpapp test ortamı SSL', done: false, doneAt: null },
        { id: next(), text: "Selin'in PR'ını incele", done: false, doneAt: null },
      ],
    },
    [3, 2, 3, 3],
  );
  card(B, 'link_group', tools(), [0, 5, 3, 2]);
  card(B, 'node', { nodeId: NODE.logoSunumlar, maxItems: 2 }, [3, 5, 3, 2]);

  // ---- Milvasoft space surface (2.8) ----
  const MS = SURFACE.milvasoft;
  surface(MS, 'space', SPACE.milvasoft, USER.zeynep);
  card(
    MS,
    'link_group',
    group('Milvasoft', 's1', 'grid', [
      {
        title: '',
        items: [
          item(docs, 'Docs'),
          item(cavepass, 'Cavepass'),
          item(meet, 'Meet'),
          item(devops, 'DevOps'),
          item(nuget, 'NuGet'),
          item(dockerHub, 'Docker Hub'),
          item(github, 'GitHub'),
          item(milvaion, 'Milvaion'),
        ],
      },
    ]),
    [0, 0, 4, 2],
  );
  card(
    MS,
    'note',
    {
      text: "## Ekip kuralları\nPR'lar en az bir onayla birleşir. Prod'a Cuma 17:00'den sonra çıkılmaz. Kasa erişimi için Buğra'ya yaz.",
      color: 's1',
      fontSize: 'normal',
    },
    [4, 0, 4, 2],
  );
  card(MS, 'node', { nodeId: NODE.onboarding }, [8, 0, 4, 3]);
  card(MS, 'node', { nodeId: NODE.sunumlar, maxItems: 3 }, [0, 2, 4, 2]);
  card(MS, 'node', { nodeId: NODE.yolHaritasi }, [4, 2, 4, 1]);

  // ---- Altyapı space surface ----
  const AS = SURFACE.altyapi;
  surface(AS, 'space', SPACE.altyapi, USER.mert);
  card(AS, 'link_group', tools(), [0, 0, 4, 3]);
  card(
    AS,
    'note',
    { text: 'Nöbet: bu hafta Mert, gelecek hafta Can.', color: 's2', fontSize: 'normal' },
    [4, 0, 3, 2],
  );
  card(AS, 'node', { nodeId: NODE.milva01, maxItems: 3 }, [7, 0, 3, 2]);
  return q;
}
