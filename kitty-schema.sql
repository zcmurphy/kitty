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

-- ── Migration: add short join code to trips ──────────────────
-- Run after initial schema:
-- npx wrangler d1 execute kittydb --remote --file=kitty-schema.sql

ALTER TABLE trips ADD COLUMN code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_code ON trips(code);

-- ── Seed: Japan Trip sample data ─────────────────────────────
-- npx wrangler d1 execute kittydb --remote --file=kitty-schema.sql

INSERT OR IGNORE INTO trips (id, name, start_date, end_date, icon, cover_photo, code, created_at)
VALUES (
  'demo-japan-2025',
  'Japan Trip 2025',
  '2025-04-02',
  '2025-04-12',
  '✈️',
  NULL,
  'JAPAN1',
  '2025-04-01T09:00:00Z'
);

INSERT OR IGNORE INTO people (id, trip_id, name, created_at) VALUES
  ('ppl-marcus', 'demo-japan-2025', 'Marcus',  '2025-04-01T09:00:00Z'),
  ('ppl-elena',  'demo-japan-2025', 'Elena',   '2025-04-01T09:00:00Z'),
  ('ppl-dev',    'demo-japan-2025', 'Dev',     '2025-04-01T09:00:00Z'),
  ('ppl-sara',   'demo-japan-2025', 'Sara',    '2025-04-01T09:00:00Z');

INSERT OR IGNORE INTO expenses (id, trip_id, desc, amount, paid_by, date, note, category, split_between, paid_settlements, created_at) VALUES
  ('exp-j1', 'demo-japan-2025', 'ANA Flights',             3200, 'Marcus', '2025-04-02', 'Round trip x4',          'transport',  '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-02T09:00:00Z'),
  ('exp-j2', 'demo-japan-2025', 'Hotel Gracery – 5 nights',1100, 'Elena',  '2025-04-02', 'Shinjuku, great views',   'hotel',      '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-02T09:05:00Z'),
  ('exp-j3', 'demo-japan-2025', 'Omakase dinner',           480, 'Dev',    '2025-04-05', 'Best meal of my life',    'food',       '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-05T20:00:00Z'),
  ('exp-j4', 'demo-japan-2025', 'Shinkansen passes',        340, 'Sara',   '2025-04-06', '7-day JR pass',           'transport',  '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-06T10:00:00Z'),
  ('exp-j5', 'demo-japan-2025', 'TeamLab Planets',           96, 'Marcus', '2025-04-07', 'Skip-the-line tickets',   'activity',   '["Elena","Dev","Sara"]',          '{}', '2025-04-07T14:00:00Z'),
  ('exp-j6', 'demo-japan-2025', 'Ramen tour – 3 spots',      68, 'Elena',  '2025-04-08', 'Ichiran was the best',    'food',       '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-08T12:00:00Z'),
  ('exp-j7', 'demo-japan-2025', 'Sake tasting bar',          95, 'Dev',    '2025-04-09', 'Ginza district',          'drinks',     '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-09T20:00:00Z'),
  ('exp-j8', 'demo-japan-2025', 'Tsukiji market breakfast',  42, 'Sara',   '2025-04-10', 'Fresh tuna bowls!',       'food',       '["Marcus","Elena","Dev","Sara"]', '{}', '2025-04-10T08:00:00Z');

INSERT OR IGNORE INTO history (id, trip_id, ts, who, action, desc, amount, changes) VALUES
  ('hist-j1', 'demo-japan-2025', '2025-04-02T09:00:00Z', 'Marcus', 'added',  'ANA Flights',              3200, NULL),
  ('hist-j2', 'demo-japan-2025', '2025-04-02T09:05:00Z', 'Elena',  'added',  'Hotel Gracery – 5 nights', 1100, NULL),
  ('hist-j3', 'demo-japan-2025', '2025-04-05T20:00:00Z', 'Dev',    'added',  'Omakase dinner',            480,  NULL),
  ('hist-j4', 'demo-japan-2025', '2025-04-06T10:00:00Z', 'Sara',   'added',  'Shinkansen passes',         340,  NULL),
  ('hist-j5', 'demo-japan-2025', '2025-04-07T14:00:00Z', 'Marcus', 'added',  'TeamLab Planets',            96,  NULL),
  ('hist-j6', 'demo-japan-2025', '2025-04-08T12:00:00Z', 'Elena',  'added',  'Ramen tour – 3 spots',       68,  NULL),
  ('hist-j7', 'demo-japan-2025', '2025-04-09T20:00:00Z', 'Dev',    'added',  'Sake tasting bar',           95,  NULL),
  ('hist-j8', 'demo-japan-2025', '2025-04-10T08:00:00Z', 'Sara',   'added',  'Tsukiji market breakfast',   42,  NULL);
