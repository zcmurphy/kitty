-- kitty-migrate.sql
-- Run ONLY to apply new columns to an EXISTING database.
-- npx wrangler d1 execute kittydb --remote --file=kitty-migrate.sql

ALTER TABLE expenses ADD COLUMN split_type TEXT    DEFAULT 'even';
ALTER TABLE expenses ADD COLUMN shares     TEXT    DEFAULT NULL;
ALTER TABLE expenses ADD COLUMN enabled    INTEGER DEFAULT 1;
