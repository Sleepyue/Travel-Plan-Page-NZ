CREATE TABLE IF NOT EXISTS ledger_bills (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, payer TEXT NOT NULL, amount INTEGER NOT NULL,
  currency TEXT NOT NULL, category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE TABLE IF NOT EXISTS ledger_travelers (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE TABLE IF NOT EXISTS trip_todos (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE TABLE IF NOT EXISTS trip_tickets (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_bills_trip ON ledger_bills(trip_id, created_at);
