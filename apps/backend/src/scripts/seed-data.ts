/**
 * Development sample data (the example tenant may be named here; see CLAUDE.md).
 * Every seeded account uses the same password; owner and admin also share one
 * TOTP secret so `pnpm --filter @crewhall/backend totp` prints a valid code.
 */
export const SEED_PASSWORD = 'Crewhall-dev-2026';
/** Raw TOTP secret (32 chars, as better-auth generates); dev only. */
export const SEED_TOTP_SECRET = 'CrewhallDevTotpSecret0123456789X';
/**
 * Stored normalised (8 upper-case characters, design 1.4); shown and typed as
 * DEVA-2345 … DEVK-2345, any case, dash optional.
 */
export const SEED_BACKUP_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'].map(
  (letter) => `DEV${letter}2345`,
);

export const SEED_ORG = { name: 'Milvasoft', slug: 'milvasoft', defaultLocale: 'tr' as const };

export const SEED_SPACES = [
  { name: 'Milvasoft', color: 's1' as const, isDefault: true },
  { name: 'Altyapı', color: 's2' as const, isDefault: false },
  { name: 'Dumpapp', color: 's3' as const, isDefault: false },
  { name: 'Opsiyon', color: 's4' as const, isDefault: false },
];

export interface SeedUser {
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  totp: boolean;
  /** Extra shared spaces (by name) besides the default ones. */
  spaces: { name: string; role: 'admin' | 'editor' | 'viewer' }[];
}

export const SEED_USERS: SeedUser[] = [
  {
    name: 'Ahmet Buğra Kösen',
    email: 'bugra@milvasoft.com',
    role: 'owner',
    totp: true,
    spaces: [],
  },
  {
    name: 'Elif Yıldız',
    email: 'elif@milvasoft.com',
    role: 'admin',
    totp: true,
    spaces: [
      { name: 'Altyapı', role: 'admin' },
      { name: 'Dumpapp', role: 'editor' },
    ],
  },
  {
    name: 'Mert Aydın',
    email: 'mert@milvasoft.com',
    role: 'member',
    totp: false,
    spaces: [{ name: 'Altyapı', role: 'editor' }],
  },
  {
    name: 'Zeynep Arslan',
    email: 'zeynep@milvasoft.com',
    role: 'member',
    totp: false,
    spaces: [{ name: 'Opsiyon', role: 'editor' }],
  },
  {
    name: 'Can Demir',
    email: 'can@milvasoft.com',
    role: 'member',
    totp: false,
    spaces: [{ name: 'Dumpapp', role: 'editor' }],
  },
  {
    name: 'Selin Öztürk',
    email: 'selin@milvasoft.com',
    role: 'member',
    totp: false,
    spaces: [],
  },
  {
    name: 'Dumpapp Destek',
    email: 'destek@dumpapp.io',
    role: 'guest',
    totp: false,
    spaces: [{ name: 'Dumpapp', role: 'viewer' }],
  },
];

/** Left pending so the accept-invitation screen can be tried. */
export const SEED_PENDING_INVITATION = { email: 'burak@milvasoft.com', role: 'member' as const };

/** Quick access sample (design 2.1). Health checks start off: these are real sites. */
export const SEED_LINKS = [
  { title: 'Docs', url: 'https://docs.milvasoft.com/' },
  { title: 'Cavepass', url: 'https://cavepass.milvasoft.com/' },
  { title: 'Meet', url: 'https://meet.milvasoft.com/' },
  { title: 'Azure DevOps', url: 'https://dev.azure.com/' },
  { title: 'NuGet', url: 'https://www.nuget.org/profiles/Milvasoft' },
  { title: 'Docker Hub', url: 'https://hub.docker.com/u/milvasoft' },
  { title: 'Milvaion', url: 'https://milvaion.milvasoft.com/' },
];
export const SEED_NOTE =
  "Prod deploy'dan önce Seq'te hata oranına bak. Cuma 17:00'den sonra deploy yok.";
export const SEED_TODOS = [
  'Milvaion 1.4 sürüm notları',
  'netcup faturasını öde',
  "Portal'ı Hub'a taşı",
  'Dumpapp test ortamı SSL',
  "Selin'in PR'ını incele",
];
export const SEED_FOLDERS = ['Logo ve sunumlar', 'Onboarding', 'Sunumlar'];

/** People in the chat sample (phase 3), in this order: owner, Elif, Mert, Can, Selin. */
export const SEED_CHAT_PEOPLE = [
  'bugra@milvasoft.com',
  'elif@milvasoft.com',
  'mert@milvasoft.com',
  'can@milvasoft.com',
  'selin@milvasoft.com',
];
/** Shared spaces of the chat sample: the team conversation's and the alerts'. */
export const SEED_CHAT_SPACES = { team: 'Milvasoft', infra: 'Altyapı' };
