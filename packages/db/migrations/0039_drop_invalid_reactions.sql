-- S1: reactions stored before the server checked them (e.g. "??" from a non-UTF-8 client).
-- Real emoji are never plain ASCII, so any all-ASCII reaction is removed.
DELETE FROM "reactions" WHERE "emoji" ~ '^[[:ascii:]]*$';
