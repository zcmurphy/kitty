-- Run once: npx wrangler d1 execute kittydb --remote --file=kitty-schema.sql

CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  icon        TEXT,
  cover_photo TEXT,   -- R2 object key, e.g. photos/trip-id/uuid.jpg
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(trip_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
  id               TEXT PRIMARY KEY,
  trip_id          TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  desc             TEXT NOT NULL,
  amount           REAL NOT NULL,
  paid_by          TEXT NOT NULL,
  date             TEXT,
  note             TEXT,
  category         TEXT DEFAULT 'other',
  split_between    TEXT DEFAULT '[]',
  photo            TEXT,   -- R2 object key
  paid_settlements TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ts       TEXT NOT NULL,
  who      TEXT NOT NULL,
  action   TEXT NOT NULL,
  desc     TEXT,
  amount   REAL,
  changes  TEXT
);

CREATE TABLE IF NOT EXISTS settlements (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_person TEXT NOT NULL,
  to_person   TEXT NOT NULL,
  amount      REAL NOT NULL,
  ts          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_trip   ON expenses(trip_id);
CREATE INDEX IF NOT EXISTS idx_people_trip     ON people(trip_id);
CREATE INDEX IF NOT EXISTS idx_history_trip    ON history(trip_id);
CREATE INDEX IF NOT EXISTS idx_settlements_trip ON settlements(trip_id);
