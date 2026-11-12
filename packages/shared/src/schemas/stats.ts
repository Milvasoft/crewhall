import { z } from 'zod';
import { Id, Timestamp } from './common';
import { MODULE_KEYS, UserSummary } from './org';
import { SpaceColor } from './space';

/**
 * Admin statistics (roadmap 21, Yönetim › İstatistikler). Everything here is read from the daily
 * rollup table (org_stats_daily) that a worker job fills; no request scans raw events.
 */

/**
 * Where activity is counted: the switchable modules plus the core areas (Drive, quick access)
 * and "core" for the rest (profile, admin, search).
 */
export const STATS_AREAS = ['drive', 'quick', ...MODULE_KEYS, 'core'] as const;
export const StatsArea = z.enum(STATS_AREAS);
export type StatsArea = z.infer<typeof StatsArea>;

export const STATS_RANGES = [7, 30, 90, 365] as const;

export const AdminStatsQuery = z.object({
  /** Days back from today (UTC), today included. */
  days: z.coerce
    .number()
    .int()
    .refine((n) => (STATS_RANGES as readonly number[]).includes(n))
    .default(30),
});

/** One day of active people: that day, the 7 days and the 30 days ending that day. */
export const ActiveUsersPoint = z.object({
  day: z.iso.date(),
  dau: z.number().int(),
  wau: z.number().int(),
  mau: z.number().int(),
});
export type ActiveUsersPoint = z.infer<typeof ActiveUsersPoint>;

export const StoragePoint = z.object({ day: z.iso.date(), bytes: z.number().int() });
export type StoragePoint = z.infer<typeof StoragePoint>;

export const ModuleUsage = z.object({
  area: StatsArea,
  /** Average distinct people per day over the range. */
  avgDailyUsers: z.number(),
  /** Distinct people on the busiest day of the range. */
  peakUsers: z.number().int(),
  /** Changes made (write requests) over the range. */
  actions: z.number().int(),
  series: z.array(z.object({ day: z.iso.date(), users: z.number().int() })),
});
export type ModuleUsage = z.infer<typeof ModuleUsage>;

export const SpaceGrowth = z.object({
  space: z.object({
    id: Id,
    name: z.string(),
    color: SpaceColor,
    icon: z.string().nullable(),
    kind: z.enum(['personal', 'shared']),
  }),
  bytes: z.number().int(),
  /** Bytes now minus bytes at the start of the range (first rollup in it). */
  growthBytes: z.number().int(),
  items: z.number().int(),
  growthItems: z.number().int(),
});
export type SpaceGrowth = z.infer<typeof SpaceGrowth>;

export const UserStorage = z.object({ user: UserSummary, bytes: z.number().int() });
export type UserStorage = z.infer<typeof UserStorage>;

export const AdminStats = z.object({
  days: z.number().int(),
  /** Last rollup; null before the first one (fresh installation). */
  computedAt: Timestamp.nullable(),
  totals: z.object({
    members: z.number().int(),
    dau: z.number().int(),
    wau: z.number().int(),
    mau: z.number().int(),
    storageBytes: z.number().int(),
    quotaBytes: z.number().int().nullable(),
  }),
  activeUsers: z.array(ActiveUsersPoint),
  storage: z.array(StoragePoint),
  modules: z.array(ModuleUsage),
  /** Spaces that grew most over the range, at most 10. */
  growingSpaces: z.array(SpaceGrowth),
  /** People holding the most bytes (file versions they uploaded), at most 10. */
  topUsers: z.array(UserStorage),
});
export type AdminStats = z.infer<typeof AdminStats>;
