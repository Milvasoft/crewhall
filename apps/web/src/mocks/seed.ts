import {
  DEFAULT_THEME,
  type Branding,
  type MemberStatus,
  type OrgPermission,
  type OrgRole,
  type OrgSettings,
  type OrgTheme,
  type SpaceColor,
  type SpaceKind,
  type SpaceRole,
  type UiPrefs,
} from '@crewhall/shared';
import { type DriveState } from './driveSeed';
import { type QuickState } from './quickSeed';

/**
 * Sample data for the in-browser mock (design kit "Örnek veri"). Example tenant data may
 * name Milvasoft; product code never does. Test credentials are documented in README.
 */

export const MOCK_PASSWORD = 'crewhall-demo-2026';
/** The TOTP code the mock accepts for every account. */
export const MOCK_TOTP = '123456';
export const MOCK_RESET_TOKEN = 'demo-reset-token';
export const MOCK_EXPIRED_RESET_TOKEN = 'expired';
export const MOCK_INVITE_TOKEN = 'demo-invite';
export const MOCK_EXPIRED_INVITE_TOKEN = 'expired-invite';
/** Setup token the empty install asks for (bootstrap.setup.tokenRequired). */
export const MOCK_SETUP_TOKEN = 'demo-setup-token';

export interface MockUser {
  id: string;
  name: string;
  email: string;
  password: string;
  imageUrl: string | null;
  locale: 'tr' | 'en';
  twoFactorEnabled: boolean;
  /** Enrolment started (enable called) but not verified yet. */
  totpPending: boolean;
  backupCodes: string[];
  passkeys: { id: string; name: string; deviceType: string; createdAt: string }[];
}

export interface MockMember {
  userId: string;
  role: OrgRole;
  permissions: OrgPermission[];
  status: MemberStatus;
  joinedAt: string | null;
  lastSeenAt: string | null;
}

export interface MockInvitation {
  id: string;
  token: string;
  email: string;
  role: Exclude<OrgRole, 'owner'>;
  invitedById: string;
  spaceIds: string[];
  expiresAt: string;
  createdAt: string;
}

export interface MockSpace {
  id: string;
  kind: SpaceKind;
  ownerUserId: string | null;
  name: string;
  slug: string;
  color: SpaceColor;
  icon: string | null;
  usedBytes: number;
  quotaBytes: number | null;
  archivedAt: string | null;
  createdAt: string;
  /** New members join default spaces automatically. */
  isDefault?: boolean;
}

export interface MockSpaceMember {
  spaceId: string;
  userId: string;
  role: SpaceRole;
  addedAt: string;
}

export interface MockSession {
  id: string;
  userId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastActiveAt: string;
}

export interface MockState {
  needsSetup: boolean;
  /** Setup token the wizard must send; null when the server does not require one. */
  setupToken?: string | null;
  /** SMTP configured: reset and invitation e-mails are sent (bootstrap.auth.emailEnabled). */
  emailEnabled?: boolean;
  org: {
    id: string;
    slug: string;
    name: string;
    branding: Branding;
    settings: OrgSettings;
    createdAt: string;
  } | null;
  theme: OrgTheme;
  users: MockUser[];
  members: MockMember[];
  invitations: MockInvitation[];
  spaces: MockSpace[];
  spaceMembers: MockSpaceMember[];
  sessions: MockSession[];
  /** Left-menu order per user (getUiPrefs); older stored states have none. */
  uiPrefs?: Record<string, string[]>;
  /** Per user: module sidebar widths and collapsed modules (UiPrefs). */
  uiSidebar?: Record<string, Pick<UiPrefs, 'sidebarWidths' | 'sidebarCollapsed'>>;
  /** Per user: the web's own left menu (UiPrefs). */
  uiRail?: Record<string, Pick<UiPrefs, 'railOrder' | 'railHidden' | 'railShortcuts'>>;
  /** Per user: pages open full width (UiPrefs.pagesFullWidth). */
  uiPagesFullWidth?: Record<string, boolean>;
  /** Per user: pages hiding completed to-dos (UiPrefs.pagesHideDone). */
  uiPagesHideDone?: Record<string, string[]>;
  /** QR connect tickets (12.3): single use, 5 minutes. */
  mobileConnect?: { token: string; userId: string; expiresAt: string }[];
  /** getCompat store links (CLIENT_STORE_URL_* on the server); null when not set. */
  storeUrls?: { ios: string | null; android: string | null; desktop: string | null };
  /** Mobile browser sign-in codes (PKCE S256): single use, 60 seconds. */
  mobileHandoff?: {
    code: string;
    challenge: string;
    redirectUri: string;
    userId: string;
    expiresAt: string;
  }[];
  /** Phase 1 stores, seeded on first use (drive.ts, quick.ts). */
  drive?: DriveState;
  quick?: QuickState;
  auth: {
    sessionId: string | null;
    pending2faUserId: string | null;
    failed: Record<string, number>;
    lockedUntil: Record<string, string>;
    /** Last failed attempt per e-mail, shown on the lock screen (1.16). */
    lastFailed?: Record<string, { at: string; ip: string }>;
    /** Consecutive locks per e-mail (15, 30, 60 minutes). */
    lockCount?: Record<string, number>;
    lastEmail: string | null;
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Stable fake uuids so URLs survive a reload. */
const uid = (n: number) => `0190f0a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

export const ORG_ID = uid(1);
export const USER = {
  bugra: uid(101),
  elif: uid(102),
  mert: uid(103),
  zeynep: uid(104),
  can: uid(105),
  selin: uid(106),
  burak: uid(107),
} as const;
export const SPACE = {
  milvasoft: uid(201),
  altyapi: uid(202),
  dumpapp: uid(203),
  opsiyon: uid(204),
  eski: uid(205),
} as const;

const BACKUP = [
  '4F7K92QD',
  '7KQ2M9XD',
  'P8TZ5WAF',
  'C1LX6RJE',
  'N5AH3ZVM',
  'H3VN8E2L',
  'R6YB1KCW',
  '2MDS7QHN',
  'X9GU4TPB',
  'E4WQ9FLY',
];

function user(
  id: string,
  name: string,
  email: string,
  opts: Partial<Pick<MockUser, 'twoFactorEnabled' | 'passkeys'>> = {},
): MockUser {
  return {
    id,
    name,
    email,
    password: MOCK_PASSWORD,
    imageUrl: null,
    locale: 'tr',
    twoFactorEnabled: opts.twoFactorEnabled ?? true,
    totpPending: false,
    backupCodes: [...BACKUP],
    passkeys: opts.passkeys ?? [],
  };
}

export const DEFAULT_BRANDING: Branding = {
  orgName: 'Crewhall',
  appName: 'Crewhall',
  logoLightUrl: null,
  logoDarkUrl: null,
  markUrl: null,
  faviconUrl: null,
  showPoweredBy: true,
  defaultLocale: 'tr',
};

/** Empty install: the setup wizard runs (doc 01 · 1.10). */
export function freshState(): MockState {
  return {
    needsSetup: true,
    setupToken: MOCK_SETUP_TOKEN,
    emailEnabled: false,
    org: null,
    theme: { ...DEFAULT_THEME },
    users: [],
    members: [],
    invitations: [],
    spaces: [],
    spaceMembers: [],
    sessions: [],
    auth: { sessionId: null, pending2faUserId: null, failed: {}, lockedUntil: {}, lastEmail: null },
  };
}

export function personalSpace(userId: string, n: number, createdAt: string): MockSpace {
  return {
    id: uid(300 + n),
    kind: 'personal',
    ownerUserId: userId,
    name: 'Kişisel',
    slug: `kisisel-${n}`,
    color: 's6',
    icon: null,
    usedBytes: 1_200_000_000,
    quotaBytes: 5 * 1024 ** 3,
    archivedAt: null,
    createdAt,
  };
}

/** Milvasoft sample org with seven people and four shared spaces. */
export function seedState(): MockState {
  const s = freshState();
  s.needsSetup = false;
  s.setupToken = null;
  s.emailEnabled = true;
  s.org = {
    id: ORG_ID,
    slug: 'milvasoft',
    name: 'Milvasoft',
    branding: { ...DEFAULT_BRANDING, orgName: 'Milvasoft' },
    settings: {
      requireTwoFactor: true,
      defaultLocale: 'tr',
      membersCanCreateSpaces: false,
      publicLinksEnabled: true,
    },
    createdAt: '2024-03-12T09:00:00.000Z',
  };
  s.theme = { ...DEFAULT_THEME, version: 12 };
  s.users = [
    user(USER.bugra, 'Ahmet Buğra Kösen', 'bugra@milvasoft.com', {
      passkeys: [
        {
          id: 'pk-1',
          name: 'Windows Hello',
          deviceType: 'singleDevice',
          createdAt: '2026-04-04T10:00:00.000Z',
        },
        {
          id: 'pk-2',
          name: 'iPhone 15 Pro',
          deviceType: 'multiDevice',
          createdAt: '2026-04-04T10:05:00.000Z',
        },
      ],
    }),
    user(USER.elif, 'Elif Yıldız', 'elif@milvasoft.com'),
    user(USER.mert, 'Mert Aydın', 'mert@milvasoft.com', {
      twoFactorEnabled: false,
      passkeys: [
        {
          id: 'pk-3',
          name: 'YubiKey 5C NFC',
          deviceType: 'singleDevice',
          createdAt: '2026-07-11T10:00:00.000Z',
        },
      ],
    }),
    user(USER.zeynep, 'Zeynep Arslan', 'zeynep@milvasoft.com'),
    user(USER.can, 'Can Demir', 'can@milvasoft.com'),
    user(USER.selin, 'Selin Öztürk', 'selin@milvasoft.com', { twoFactorEnabled: false }),
    user(USER.burak, 'Burak Şahin', 'burak@milvasoft.com', {
      passkeys: [
        {
          id: 'pk-4',
          name: 'Android',
          deviceType: 'multiDevice',
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ],
    }),
  ];
  const m = (userId: string, role: OrgRole, joined: string, seen: string | null): MockMember => ({
    userId,
    role,
    permissions: [],
    status: 'active',
    joinedAt: joined,
    lastSeenAt: seen,
  });
  s.members = [
    m(USER.bugra, 'owner', '2024-03-12T09:00:00.000Z', ago(0)),
    m(USER.elif, 'admin', '2025-03-01T09:00:00.000Z', ago(2 * MIN)),
    m(USER.mert, 'member', '2024-04-02T09:00:00.000Z', ago(4 * MIN)),
    m(USER.zeynep, 'member', '2024-05-10T09:00:00.000Z', ago(15 * HOUR)),
    m(USER.can, 'member', '2024-06-18T09:00:00.000Z', ago(12 * MIN)),
    m(USER.selin, 'member', '2025-01-20T09:00:00.000Z', ago(3 * DAY)),
    m(USER.burak, 'member', '2026-09-01T09:00:00.000Z', ago(1 * MIN)),
  ];
  s.invitations = [
    {
      id: uid(401),
      token: MOCK_INVITE_TOKEN,
      email: 'ozan.kaya@milvasoft.com',
      role: 'member',
      invitedById: USER.elif,
      spaceIds: [SPACE.milvasoft],
      expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
      createdAt: ago(2 * DAY),
    },
    {
      id: uid(402),
      token: MOCK_EXPIRED_INVITE_TOKEN,
      email: 'destek@dumpapp.io',
      role: 'guest',
      invitedById: USER.bugra,
      spaceIds: [SPACE.dumpapp],
      expiresAt: ago(7 * DAY),
      createdAt: ago(14 * DAY),
    },
  ];
  const shared = (
    id: string,
    name: string,
    slug: string,
    color: SpaceColor,
    usedGb: number,
    quotaGb: number | null,
    createdAt: string,
    archivedAt: string | null = null,
  ): MockSpace => ({
    id,
    kind: 'shared',
    ownerUserId: null,
    name,
    slug,
    color,
    icon: null,
    usedBytes: Math.round(usedGb * 1024 ** 3),
    quotaBytes: quotaGb === null ? null : quotaGb * 1024 ** 3,
    archivedAt,
    createdAt,
  });
  s.spaces = [
    {
      ...shared(
        SPACE.milvasoft,
        'Milvasoft',
        'milvasoft',
        's1',
        18.4,
        50,
        '2024-03-12T09:00:00.000Z',
      ),
      isDefault: true,
    },
    shared(SPACE.altyapi, 'Altyapı', 'altyapi', 's2', 6.2, 20, '2024-04-02T09:00:00.000Z'),
    shared(SPACE.dumpapp, 'Dumpapp', 'dumpapp', 's3', 9.8, 12, '2024-06-18T09:00:00.000Z'),
    shared(SPACE.opsiyon, 'Opsiyon', 'opsiyon', 's4', 1.1, 10, '2026-02-05T09:00:00.000Z'),
    shared(
      SPACE.eski,
      'Eski web sitesi',
      'eski-web-sitesi',
      's5',
      2.3,
      null,
      '2023-09-09T09:00:00.000Z',
      '2026-01-10T09:00:00.000Z',
    ),
    ...Object.values(USER).map((id, i) => personalSpace(id, i + 1, '2024-03-12T09:00:00.000Z')),
  ];
  const sm = (
    spaceId: string,
    userId: string,
    role: SpaceRole,
    addedAt = '2024-04-02T09:00:00.000Z',
  ): MockSpaceMember => ({
    spaceId,
    userId,
    role,
    addedAt,
  });
  s.spaceMembers = [
    sm(SPACE.milvasoft, USER.bugra, 'owner'),
    sm(SPACE.milvasoft, USER.zeynep, 'admin'),
    sm(SPACE.milvasoft, USER.elif, 'editor'),
    sm(SPACE.milvasoft, USER.mert, 'editor'),
    sm(SPACE.milvasoft, USER.can, 'editor'),
    sm(SPACE.milvasoft, USER.selin, 'editor'),
    sm(SPACE.milvasoft, USER.burak, 'viewer'),
    sm(SPACE.altyapi, USER.bugra, 'owner'),
    sm(SPACE.altyapi, USER.mert, 'admin'),
    sm(SPACE.altyapi, USER.can, 'editor'),
    sm(SPACE.dumpapp, USER.elif, 'owner'),
    sm(SPACE.dumpapp, USER.bugra, 'admin'),
    sm(SPACE.dumpapp, USER.selin, 'editor'),
    sm(SPACE.dumpapp, USER.can, 'viewer'),
    sm(SPACE.opsiyon, USER.zeynep, 'owner'),
    sm(SPACE.opsiyon, USER.bugra, 'editor'),
    sm(SPACE.eski, USER.bugra, 'owner'),
    ...s.spaces
      .filter((x) => x.kind === 'personal' && x.ownerUserId)
      .map((x) => sm(x.id, x.ownerUserId as string, 'owner')),
  ];
  s.sessions = [
    {
      id: uid(501),
      userId: USER.bugra,
      userAgent: 'Crewhall iOS 1.0.3 · iPhone 15 Pro',
      ip: '85.105.12.44',
      createdAt: ago(20 * DAY),
      lastActiveAt: ago(2 * HOUR),
    },
    {
      id: uid(502),
      userId: USER.bugra,
      userAgent: 'Firefox 131 · Ubuntu 24.04',
      ip: '10.8.0.9',
      createdAt: ago(30 * DAY),
      lastActiveAt: ago(3 * DAY),
    },
  ];
  return s;
}
