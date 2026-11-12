import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/** Case-insensitive text (citext extension), used for e-mail addresses. */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/** ltree path (ltree extension). Labels are node ids without dashes. */
export const ltree = customType<{ data: string }>({
  dataType: () => 'ltree',
});

/**
 * Human-readable names sort and case-fold with ICU Turkish rules (İ/ı, I/i),
 * design doc 17 §4 "Türkçe metin".
 */
export const textTr = customType<{ data: string }>({
  dataType: () => 'text COLLATE "tr-x-icu"',
});

/** Byte-order text for fractional index keys, which must not sort by locale. */
export const textC = customType<{ data: string }>({
  dataType: () => 'text COLLATE "C"',
});

export const newId = () => uuidv7();

export const id = () => uuid('id').primaryKey().$defaultFn(newId);

export const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = () => ({
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
