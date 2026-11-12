import { type NodeType, type ShareRole } from '@crewhall/shared';
import { mimeFor } from '@/features/drive/fileKinds';
import { SPACE, USER } from './seed';

/**
 * Drive sample tree (design 03 · 3.4-3.18, 19.1-19.5) for the Milvasoft org. Dates are
 * relative to now so "bugün 09:20" stays today.
 */

export type BlobArt =
  | { kind: 'image'; width: number; height: number }
  | { kind: 'logo'; dark: boolean }
  | { kind: 'pdf'; title: string; pages: number; lines: string[] }
  | { kind: 'video'; durationSec: number }
  | { kind: 'text'; text: string }
  | { kind: 'none' }
  | { kind: 'failed' };

export interface MockBlob {
  id: string;
  sha256: string;
  sizeBytes: number;
  mime: string | null;
  art: BlobArt;
  /** Uploaded in this browser session: bytes live in memory (see drive.ts). */
  uploaded?: boolean;
  /** Preview worker finishes at this time (uploads). */
  readyAt?: string;
}

export interface MockVersion {
  id: string;
  nodeId: string;
  version: number;
  blobId: string;
  label: string | null;
  source: 'web' | 'mobile' | 'mcp' | 'api';
  createdBy: string;
  createdAt: string;
}

export interface MockNode {
  id: string;
  spaceId: string;
  parentId: string | null;
  type: NodeType;
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  /** Root of the trash operation that took this node (children travel with their folder). */
  trashedWith: string | null;
  /** The app's own folder (page images, attachments): found by role, not listed (server: system_role). */
  systemRole?: string | null;
}

export interface MockShare {
  id: string;
  nodeId: string;
  kind: 'user' | 'link';
  role: ShareRole;
  granteeId: string | null;
  /** The mock keeps the token (the server keeps only its hash). */
  token: string | null;
  password: string | null;
  expiresAt: string | null;
  allowDownload: boolean;
  openCount: number;
  failures: number;
  lockedUntil: string | null;
  createdBy: string;
  createdAt: string;
}

export interface MockUserNode {
  userId: string;
  nodeId: string;
  favorite: boolean;
  favoritePos: number;
  lastOpenedAt: string | null;
}

export interface MockUpload {
  id: string;
  userId: string;
  spaceId: string;
  parentId: string | null;
  /** Existing node for a new version. */
  nodeId: string | null;
  name: string;
  sizeBytes: number;
  mime: string | null;
  partSize: number;
  partCount: number;
  status: 'uploading' | 'completed' | 'aborted' | 'expired';
  parts: { partNumber: number; sizeBytes: number; etag: string }[];
  /** Replace an existing node once complete (onConflict=replace). */
  replaceNodeId: string | null;
  /** New version only while the file is still at this version (version_conflict). */
  baseVersion?: number | null;
  expiresAt: string;
  createdAt: string;
}

export interface DriveState {
  nodes: MockNode[];
  versions: MockVersion[];
  blobs: MockBlob[];
  shares: MockShare[];
  userNodes: MockUserNode[];
  uploads: MockUpload[];
  grants: { grant: string; shareId: string; expiresAt: string }[];
  /** Bytes outside the seeded tree (chat, pages), so the quota bar looks like 3.16. */
  otherBytes: number;
}

const nid = (n: number) => `0190f0a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/** Ids the tests and quick access cards refer to. */
export const NODE = {
  finans: nid(5001),
  sunumlar: nid(5002),
  tasarim: nid(5003),
  ikonlar: nid(5004),
  logoSunumlar: nid(5005),
  sunum2026: nid(5010),
  q3: nid(5011),
  onboarding: nid(5020),
  yolHaritasi: nid(5021),
  hubMimarisi: nid(5022),
  faturalar: nid(5100),
  faturaEylul: nid(5101),
  netcup: nid(5103),
  milva01: nid(5110),
  compose: nid(5111),
  envanter: nid(5120),
  sprint42: nid(5200),
} as const;

export const PUBLIC_TOKEN = {
  file: 'Rm4tQ8vW',
  password: 'k7Fq2xP9',
  expired: 'Hq81mZ4c',
  folder: 'Lg5sNw2e',
} as const;
export const PUBLIC_PASSWORD = 'milva-2026';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MB = 1024 * 1024;
const KB = 1024;

/** `daysAgo` days back at hh:mm, never in the future. */
function at(daysAgo: number, hh = 10, mm = 0): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hh, mm, 0, 0);
  const t = Math.min(d.getTime(), Date.now() - 5 * MIN);
  return new Date(t).toISOString();
}

const COMPOSE = `# milva-01 · Crewhall yığını
# Sırlar Altyapı kasasından .env ile gelir, buraya yazılmaz
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: crewhall
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data

  seaweedfs:
    image: chrislusf/seaweedfs:3.80
    command: server -s3 -dir=/data
    volumes:
      - blob-data:/data

  api:
    image: ghcr.io/milvasoft/crewhall-api:1.0.3
    depends_on: [postgres, seaweedfs]
    environment:
      S3_ENDPOINT: http://seaweedfs:8333
      DATABASE_URL: \${DATABASE_URL}
    ports:
      - "3000:3000"

volumes:
  pg-data:
  blob-data:
`;

const SUNUM_LINES = [
  'Urun yol haritasi',
  'Milvaion 1.5 · SSO ve is akislari',
  'Crewhall · kaynagi acik cekirdek',
  'Dumpapp · mobil surum',
  'Portal · cok dilli dokuman',
];

export function seedDrive(): DriveState {
  const d: DriveState = {
    nodes: [],
    versions: [],
    blobs: [],
    shares: [],
    userNodes: [],
    uploads: [],
    grants: [],
    otherBytes: Math.round(58.6 * 1024 * MB),
  };
  let seq = 6000;
  const next = () => nid(seq++);

  function node(
    spaceId: string,
    parentId: string | null,
    type: NodeType,
    name: string,
    by: string,
    when: string,
    id = next(),
  ): string {
    d.nodes.push({
      id,
      spaceId,
      parentId,
      type,
      name,
      createdBy: by,
      updatedBy: by,
      createdAt: when,
      updatedAt: when,
      deletedAt: null,
      deletedBy: null,
      trashedWith: null,
    });
    return id;
  }

  function file(
    spaceId: string,
    parentId: string | null,
    name: string,
    sizeBytes: number,
    art: BlobArt,
    by: string,
    when: string,
    opts: {
      id?: string;
      versions?: { by: string; when: string; size: number; label?: string }[];
    } = {},
  ): string {
    const history = opts.versions ?? [{ by, when, size: sizeBytes }];
    const id = node(spaceId, parentId, 'file', name, history[0]!.by, history[0]!.when, opts.id);
    history.forEach((v, i) => {
      const blobId = next();
      d.blobs.push({
        id: blobId,
        sha256: `seed-${blobId}`,
        sizeBytes: Math.round(v.size),
        mime: mimeFor(name),
        art,
      });
      d.versions.push({
        id: next(),
        nodeId: id,
        version: i + 1,
        blobId,
        label: v.label ?? null,
        source: 'web',
        createdBy: v.by,
        createdAt: v.when,
      });
    });
    const n = d.nodes.find((x) => x.id === id)!;
    n.updatedBy = history.at(-1)!.by;
    n.updatedAt = history.at(-1)!.when;
    return id;
  }

  const { bugra, zeynep, elif, mert, can, selin } = USER;
  const M = SPACE.milvasoft;
  const pdf = (title: string, pages: number, lines = SUNUM_LINES): BlobArt => ({
    kind: 'pdf',
    title,
    pages,
    lines,
  });
  const img = (width: number, height: number): BlobArt => ({ kind: 'image', width, height });

  // ---- Milvasoft ----
  node(M, null, 'folder', 'Finans', bugra, at(16, 11, 5), NODE.finans);
  file(M, NODE.finans, 'butce-2026.xlsx', 64 * KB, { kind: 'none' }, bugra, at(16, 11, 10));
  file(
    M,
    NODE.finans,
    'maas-bordrosu-eylul.pdf',
    1.2 * MB,
    pdf('Bordro · Eylül', 3),
    bugra,
    at(18),
  );

  node(M, null, 'folder', 'Sunumlar', zeynep, at(40), NODE.sunumlar);
  file(
    M,
    NODE.sunumlar,
    'milva-sunum-2026.pdf',
    4.2 * MB,
    pdf('Milvasoft · 2026 planı', 18),
    zeynep,
    at(0, 9, 20),
    {
      id: NODE.sunum2026,
      versions: [
        { by: zeynep, when: at(17, 15), size: 3.8 * MB, label: 'İlk taslak' },
        { by: bugra, when: at(5, 16, 40), size: 4.1 * MB },
        {
          by: zeynep,
          when: at(0, 9, 20),
          size: 4.2 * MB,
          label: 'Q4 grafiği ve Portal maddesi eklendi',
        },
      ],
    },
  );
  file(
    M,
    NODE.sunumlar,
    'milva-sunum-2025.pdf',
    3.1 * MB,
    pdf('Milvasoft · 2025 planı', 14),
    zeynep,
    at(280),
  );
  file(
    M,
    NODE.sunumlar,
    'ekran-kaydi.mp4',
    186 * MB,
    { kind: 'video', durationSec: 252 },
    selin,
    at(10, 13),
  );
  file(
    M,
    NODE.sunumlar,
    'milvaion-demo.mp4',
    218 * MB,
    { kind: 'video', durationSec: 460 },
    elif,
    at(17, 11),
  );
  node(M, NODE.sunumlar, 'page', 'Demo senaryosu', zeynep, at(1, 11, 2));
  node(M, NODE.sunumlar, 'drawing', 'Sunum akışı', bugra, at(12));

  node(M, null, 'folder', 'Tasarım', zeynep, at(60), NODE.tasarim);
  node(M, NODE.tasarim, 'folder', 'İkonlar', zeynep, at(0, 9, 0), NODE.ikonlar);
  file(M, NODE.tasarim, 'hub-ekran-01.png', 2.4 * MB, img(2880, 1800), zeynep, at(1, 17, 48));
  file(M, NODE.tasarim, 'hub-ekran-02.png', 2.1 * MB, img(2880, 1800), zeynep, at(1, 17, 40));
  file(M, NODE.tasarim, 'hub-mobil-01.png', 1.2 * MB, img(1170, 2532), zeynep, at(2));
  file(M, NODE.tasarim, 'logo-koyu.svg', 6 * KB, { kind: 'logo', dark: true }, zeynep, at(30));
  file(M, NODE.tasarim, 'logo-acik.svg', 6 * KB, { kind: 'logo', dark: false }, zeynep, at(30));
  file(M, NODE.tasarim, 'renk-paleti.png', 180 * KB, img(1600, 900), zeynep, at(30));
  file(M, NODE.tasarim, 'tasarim-v3.fig', 38 * MB, { kind: 'failed' }, zeynep, at(4));
  file(M, NODE.tasarim, 'Logo paketi.zip', 12 * MB, { kind: 'none' }, zeynep, at(16));
  node(M, NODE.tasarim, 'page', 'Marka kılavuzu', zeynep, at(9));
  node(M, NODE.tasarim, 'drawing', 'Ekran akışı', bugra, at(6));

  node(M, null, 'folder', 'Logo ve sunumlar', zeynep, at(48), NODE.logoSunumlar);
  const eski = node(M, NODE.logoSunumlar, 'folder', 'Eski sunumlar', zeynep, at(221));
  file(
    M,
    eski,
    'milva-sunum-2024.pdf',
    2.9 * MB,
    pdf('Milvasoft · 2024 planı', 12),
    zeynep,
    at(221),
  );
  file(
    M,
    eski,
    'milva-sunum-2023.pdf',
    3.3 * MB,
    pdf('Milvasoft · 2023 planı', 12),
    zeynep,
    at(400),
  );
  file(M, NODE.logoSunumlar, 'Logo paketi.zip', 12 * MB, { kind: 'none' }, zeynep, at(16));
  file(
    M,
    NODE.logoSunumlar,
    'milva-sunum-2026.pdf',
    4.2 * MB,
    pdf('Milvasoft · 2026 planı', 18),
    zeynep,
    at(0, 9, 20),
  );
  file(
    M,
    NODE.logoSunumlar,
    'marka-kilavuzu.pdf',
    6.8 * MB,
    pdf('Marka kılavuzu', 24, ['Logo', 'Renkler', 'Tipografi', 'Kullanım']),
    zeynep,
    at(35),
  );
  file(
    M,
    NODE.logoSunumlar,
    'milvasoft-logo.svg',
    18 * KB,
    { kind: 'logo', dark: false },
    zeynep,
    at(35),
  );
  file(
    M,
    NODE.logoSunumlar,
    'milvasoft-logo-beyaz.svg',
    18 * KB,
    { kind: 'logo', dark: true },
    zeynep,
    at(35),
  );
  file(M, NODE.logoSunumlar, 'milvasoft-amblem.png', 240 * KB, img(1024, 1024), zeynep, at(35));
  file(M, NODE.logoSunumlar, 'sunum-sablonu.pptx', 9.1 * MB, { kind: 'none' }, zeynep, at(47));

  node(M, null, 'page', 'Onboarding', bugra, at(7), NODE.onboarding);
  node(M, NODE.onboarding, 'page', 'Geliştirme ortamı', elif, at(7));
  node(M, NODE.onboarding, 'page', 'Kod standartları', elif, at(7));
  const milvaion = node(M, null, 'page', 'Milvaion', elif, at(1, 16, 5));
  node(M, milvaion, 'page', 'Mimari', elif, at(1, 11, 48));
  node(M, milvaion, 'page', 'Sürüm notları', elif, at(3));
  node(M, null, 'page', 'Toplantı notları', zeynep, at(3, 15, 40));
  node(M, null, 'board', 'Milvaion Yol Haritası', bugra, at(0, 8, 55), NODE.yolHaritasi);
  node(M, null, 'drawing', 'Hub mimarisi', bugra, at(5), NODE.hubMimarisi);
  file(M, null, 'Q3-rapor.xlsx', 86 * KB, { kind: 'none' }, bugra, at(11), { id: NODE.q3 });

  // Trash (3.16): remaining days 28, 23, 13, 6, 3, 2.
  const trashed = (id: string, by: string, daysAgo: number, parentId: string | null) => {
    const n = d.nodes.find((x) => x.id === id)!;
    n.parentId = parentId;
    n.deletedAt = at(daysAgo, 14);
    n.deletedBy = by;
    n.trashedWith = id;
  };
  trashed(
    file(
      M,
      NODE.sunumlar,
      'ekran-kaydi-ham.mp4',
      1.2 * 1024 * MB,
      { kind: 'video', durationSec: 1210 },
      selin,
      at(3),
    ),
    selin,
    2,
    NODE.sunumlar,
  );
  trashed(node(M, null, 'page', 'Eski toplantı notları', zeynep, at(60)), zeynep, 7, null);
  trashed(
    file(M, null, 'Q2-rapor.xlsx', 74 * KB, { kind: 'none' }, bugra, at(100)),
    bugra,
    17,
    null,
  );
  trashed(
    file(M, NODE.tasarim, 'logo-eski.zip', 48 * MB, { kind: 'none' }, zeynep, at(200)),
    zeynep,
    24,
    NODE.tasarim,
  );
  trashed(node(M, null, 'board', 'Retro panosu', bugra, at(90)), bugra, 27, null);
  trashed(
    file(M, NODE.tasarim, 'tasarim-v2.fig', 36 * MB, { kind: 'failed' }, zeynep, at(120)),
    zeynep,
    28,
    NODE.tasarim,
  );

  // ---- Altyapı ----
  const A = SPACE.altyapi;
  node(A, null, 'folder', 'Faturalar', mert, at(200), NODE.faturalar);
  const invoice = (title: string, no: string) =>
    pdf(title, 2, ['netcup GmbH', `Fatura no ${no}`, 'VPS 8000 G11', 'KDV dahil toplam 64,90 €']);
  file(
    A,
    NODE.faturalar,
    'sunucu-faturasi-eylul.pdf',
    214 * KB,
    invoice('Fatura · Eylül', '2026-09-1187'),
    mert,
    at(17, 9, 30),
    { id: NODE.faturaEylul },
  );
  file(
    A,
    NODE.faturalar,
    'sunucu-faturasi-agustos.pdf',
    209 * KB,
    invoice('Fatura · Ağustos', '2026-08-0954'),
    mert,
    at(46),
  );
  file(
    A,
    NODE.faturalar,
    'netcup-alan-adi-2026.pdf',
    188 * KB,
    invoice('Alan adı · 2026', '2026-01-0031'),
    bugra,
    at(278),
    { id: NODE.netcup },
  );
  file(
    A,
    NODE.faturalar,
    'squarespace-yenileme.pdf',
    402 * KB,
    invoice('Squarespace', 'SQ-2026-03'),
    bugra,
    at(231),
  );
  node(A, NODE.faturalar, 'page', 'Fatura takibi', mert, at(1));
  const sunucular = node(A, null, 'folder', 'Sunucular', mert, at(300));
  node(A, sunucular, 'folder', 'milva-01', mert, at(300), NODE.milva01);
  file(
    A,
    NODE.milva01,
    'docker-compose.yml',
    1.4 * KB,
    { kind: 'text', text: COMPOSE },
    mert,
    at(3, 14),
    {
      id: NODE.compose,
      versions: Array.from({ length: 7 }, (_, i) => ({
        by: i % 2 ? can : mert,
        when: at(60 - i * 9, 14),
        size: 1.2 * KB + i * 30,
      })),
    },
  );
  const m2 = node(A, sunucular, 'folder', 'milva-02', mert, at(200));
  file(
    A,
    m2,
    'docker-compose.yml',
    1.1 * KB,
    { kind: 'text', text: COMPOSE.replace(/milva-01/g, 'milva-02') },
    can,
    at(40),
  );
  file(
    A,
    m2,
    'backup.sh',
    0.6 * KB,
    {
      kind: 'text',
      text: '#!/bin/sh\nset -e\npg_dump "$DATABASE_URL" | gzip > /backup/crewhall-$(date +%F).sql.gz\n',
    },
    can,
    at(40),
  );
  node(A, null, 'page', 'Sunucu envanteri', can, at(1, 17, 30), NODE.envanter);
  node(A, null, 'page', 'Yedekleme planı', can, at(9));

  // ---- Dumpapp ----
  const D = SPACE.dumpapp;
  const dTasarim = node(D, null, 'folder', 'Tasarım', selin, at(70));
  const ekran = node(D, dTasarim, 'folder', 'Ekran görüntüleri', selin, at(20));
  for (let i = 1; i <= 4; i++) {
    file(
      D,
      ekran,
      `dumpapp-ekran-0${i}.png`,
      (0.9 + i * 0.2) * MB,
      img(1170, 2532),
      selin,
      at(20 - i),
    );
  }
  const magaza = node(D, dTasarim, 'folder', 'Mağaza görselleri', selin, at(25));
  file(D, magaza, 'play-store-kapak.png', 1.4 * MB, img(1024, 500), selin, at(25));
  node(D, null, 'folder', 'Sprint notları', elif, at(30));
  node(D, null, 'board', 'Dumpapp Sprint 42', elif, at(1, 14, 12), NODE.sprint42);
  node(D, null, 'drawing', 'Dumpapp akış diyagramı', elif, at(14));

  // ---- Opsiyon ----
  const O = SPACE.opsiyon;
  const soz = node(O, null, 'folder', 'Sözleşmeler', zeynep, at(80));
  file(
    O,
    soz,
    'opsiyon-hizmet-sozlesmesi.pdf',
    820 * KB,
    pdf('Hizmet sözleşmesi', 6, ['Taraflar', 'Kapsam', 'Ücret', 'Süre']),
    zeynep,
    at(80),
  );

  // ---- Shares (3.11, 19.1-19.5) ----
  const share = (
    p: Omit<MockShare, 'id' | 'openCount' | 'failures' | 'lockedUntil'> & { openCount?: number },
  ) =>
    d.shares.push({
      id: next(),
      failures: 0,
      lockedUntil: null,
      ...p,
      openCount: p.openCount ?? 0,
    });
  const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
  share({
    nodeId: NODE.sunum2026,
    kind: 'link',
    role: 'viewer',
    granteeId: null,
    token: PUBLIC_TOKEN.file,
    password: null,
    expiresAt: inDays(7),
    allowDownload: true,
    createdBy: zeynep,
    createdAt: at(0, 9, 24),
    openCount: 3,
  });
  share({
    nodeId: NODE.faturaEylul,
    kind: 'user',
    role: 'viewer',
    granteeId: zeynep,
    token: null,
    password: null,
    expiresAt: inDays(12),
    allowDownload: true,
    createdBy: bugra,
    createdAt: at(3),
  });
  share({
    nodeId: NODE.faturaEylul,
    kind: 'link',
    role: 'viewer',
    granteeId: null,
    token: PUBLIC_TOKEN.password,
    password: PUBLIC_PASSWORD,
    expiresAt: inDays(7),
    allowDownload: false,
    createdBy: bugra,
    createdAt: at(1),
    openCount: 3,
  });
  share({
    nodeId: NODE.netcup,
    kind: 'link',
    role: 'viewer',
    granteeId: null,
    token: PUBLIC_TOKEN.expired,
    password: null,
    expiresAt: at(2),
    allowDownload: true,
    createdBy: bugra,
    createdAt: at(9),
  });
  share({
    nodeId: NODE.logoSunumlar,
    kind: 'link',
    role: 'viewer',
    granteeId: null,
    token: PUBLIC_TOKEN.folder,
    password: null,
    expiresAt: inDays(14),
    allowDownload: true,
    createdBy: zeynep,
    createdAt: at(4),
  });

  // ---- Favorites and recent (3.17) for Buğra ----
  const fav = [NODE.yolHaritasi, NODE.compose, NODE.envanter, NODE.sprint42, NODE.hubMimarisi];
  fav.forEach((nodeId, i) =>
    d.userNodes.push({ userId: bugra, nodeId, favorite: true, favoritePos: i, lastOpenedAt: null }),
  );
  const opened: [string, string][] = [
    [NODE.sunum2026, at(0, 9, 22)],
    [NODE.compose, at(0, 9, 5)],
    [NODE.yolHaritasi, at(0, 8, 56)],
    [NODE.envanter, at(1, 17, 30)],
    [NODE.sprint42, at(1, 14, 12)],
    [NODE.q3, at(1, 11, 48)],
  ];
  for (const [nodeId, when] of opened) {
    const un = d.userNodes.find((x) => x.userId === bugra && x.nodeId === nodeId);
    if (un) un.lastOpenedAt = when;
    else {
      d.userNodes.push({
        userId: bugra,
        nodeId,
        favorite: false,
        favoritePos: 0,
        lastOpenedAt: when,
      });
    }
  }
  return d;
}
