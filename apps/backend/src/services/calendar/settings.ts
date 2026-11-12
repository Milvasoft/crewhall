import { and, eq, inArray } from 'drizzle-orm';
import {
  calendarUserSettings,
  chatUserSettings,
  type CalendarSettingsData,
  type DbOrTx,
} from '@crewhall/db';
import { safeZone, type CalendarSettings, type UpdateCalendarSettings } from '@crewhall/shared';

/** Ten minutes before, like most calendars. */
export const DEFAULT_REMINDERS = [10];

/**
 * The person's calendar settings. The zone falls back to the one set for chat (quiet hours,
 * person card), then UTC; the web client sends the browser's zone once while not explicit.
 */
export function resolveSettings(
  data: CalendarSettingsData | undefined,
  chatZone: string | null | undefined,
): CalendarSettings {
  const d = data ?? {};
  return {
    timeZone: safeZone(d.timeZone ?? chatZone ?? 'UTC'),
    timeZoneExplicit: d.timeZoneExplicit ?? false,
    weekStart: d.weekStart ?? 1,
    defaultView: d.defaultView ?? 'week',
    defaultReminders: d.defaultReminders ?? DEFAULT_REMINDERS,
    allDayReminderMinute: d.allDayReminderMinute ?? 540,
    workdayStart: d.workdayStart ?? 9,
    workdayEnd: d.workdayEnd ?? 18,
    showMeetings: d.showMeetings ?? true,
    showCards: d.showCards ?? true,
    showDeclined: d.showDeclined ?? false,
    hiddenCalendarIds: d.hiddenCalendarIds ?? [],
  };
}

export async function settingsFor(db: DbOrTx, orgId: string, userId: string) {
  return (await settingsForMany(db, orgId, [userId])).get(userId)!;
}

export async function settingsForMany(db: DbOrTx, orgId: string, userIds: string[]) {
  const ids = [...new Set(userIds)];
  const out = new Map<string, CalendarSettings>();
  if (!ids.length) return out;
  const [rows, chat] = await Promise.all([
    db
      .select()
      .from(calendarUserSettings)
      .where(and(eq(calendarUserSettings.orgId, orgId), inArray(calendarUserSettings.userId, ids))),
    db
      .select({ userId: chatUserSettings.userId, timezone: chatUserSettings.timezone })
      .from(chatUserSettings)
      .where(and(eq(chatUserSettings.orgId, orgId), inArray(chatUserSettings.userId, ids))),
  ]);
  for (const id of ids) {
    out.set(
      id,
      resolveSettings(
        rows.find((r) => r.userId === id)?.settings,
        chat.find((c) => c.userId === id)?.timezone,
      ),
    );
  }
  return out;
}

export async function updateSettings(
  db: DbOrTx,
  orgId: string,
  userId: string,
  patch: UpdateCalendarSettings,
): Promise<CalendarSettings> {
  const [row] = await db
    .select()
    .from(calendarUserSettings)
    .where(and(eq(calendarUserSettings.orgId, orgId), eq(calendarUserSettings.userId, userId)));
  const next: CalendarSettingsData = { ...(row?.settings ?? {}) };
  for (const [k, v] of Object.entries(patch) as [keyof CalendarSettingsData, unknown][]) {
    if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  // An explicit zone is the person's choice; the browser's guess never overrides it.
  if (patch.timeZone !== undefined && patch.timeZoneExplicit === undefined) {
    next.timeZoneExplicit = true;
  }
  if (
    patch.timeZone !== undefined &&
    patch.timeZoneExplicit === false &&
    row?.settings.timeZoneExplicit
  ) {
    next.timeZone = row.settings.timeZone;
    next.timeZoneExplicit = true;
  }
  if ((next.workdayEnd ?? 18) <= (next.workdayStart ?? 9))
    next.workdayEnd = (next.workdayStart ?? 9) + 1;
  await db
    .insert(calendarUserSettings)
    .values({ orgId, userId, settings: next })
    .onConflictDoUpdate({
      target: [calendarUserSettings.orgId, calendarUserSettings.userId],
      set: { settings: next, updatedAt: new Date() },
    });
  return settingsFor(db, orgId, userId);
}
