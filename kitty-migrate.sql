-- kitty-migrate.sql
-- Run ONLY to apply new columns to an EXISTING database.
-- Each statement is safe to retry if it partially succeeded.
-- npx wrangler d1 execute kittydb --remote --file=kitty-migrate.sql

ALTER TABLE trips    ADD COLUMN code       TEXT        DEFAULT NULL;
ALTER TABLE expenses ADD COLUMN split_type TEXT        DEFAULT 'even';
ALTER TABLE expenses ADD COLUMN shares     TEXT        DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_code ON trips(code);
