-- 餐饮模块 (Dining) shared-state tables.
-- Apply after 0001_shared_trip_data.sql.
-- Additive and idempotent: safe to run on an existing database.
CREATE TABLE IF NOT EXISTS dining_restaurants (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE TABLE IF NOT EXISTS dining_records (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE INDEX IF NOT EXISTS idx_dining_restaurants_trip ON dining_restaurants(trip_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dining_records_trip ON dining_records(trip_id, created_at);
