CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  event_name TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  device_type TEXT NOT NULL DEFAULT '',
  tour TEXT NOT NULL DEFAULT '',
  booking_key TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
  detail TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS analytics_events_occurred_at_idx
  ON analytics_events (occurred_at);

CREATE INDEX IF NOT EXISTS analytics_events_event_time_idx
  ON analytics_events (event_name, occurred_at);

CREATE INDEX IF NOT EXISTS analytics_events_session_idx
  ON analytics_events (session_id, occurred_at);

CREATE INDEX IF NOT EXISTS analytics_events_booking_idx
  ON analytics_events (booking_key, occurred_at);
