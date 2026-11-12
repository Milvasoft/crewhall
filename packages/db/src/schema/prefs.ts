import { jsonb, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { organizations } from './org';
import { timestamps } from './types';

/** Personal interface choices that follow the person to every device (web, desktop app). */
export interface UiPrefsData {
  /** Left menu (rail) and phone tab bar order: module ids, first shown first. */
  navOrder?: string[];
  /** Web and desktop left menu, apart from the phone's bar (navOrder): order, hidden, keys. */
  railOrder?: string[];
  railHidden?: string[];
  railShortcuts?: Record<string, string>;
  /** Module sidebar width per module id, px. */
  sidebarWidths?: Record<string, number>;
  /** Module ids whose sidebar is collapsed. */
  sidebarCollapsed?: string[];
  /** Pages open full width; filled once from the old per-page choice when absent. */
  pagesFullWidth?: boolean;
  /** Pages (node ids) where the person hides completed to-dos. */
  pagesHideDone?: string[];
}

/** Per person and org: the modules differ per org, so does their order. */
export const userUiPrefs = pgTable(
  'user_ui_prefs',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    settings: jsonb('settings').$type<UiPrefsData>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);
