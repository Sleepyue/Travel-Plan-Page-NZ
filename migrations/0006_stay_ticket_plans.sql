-- 0006_stay_ticket_plans.sql
-- 住宿安排 / 门票明细的「客户端覆盖层」表，与 trip_flights 同构。
--
-- 设计：trip-data.json 的 accommodations[] 与 ticketPlanning.items[] 是权威基线，
-- 这里按各自 id 存放增量覆盖。
--   · trip_accommodations payload 形如
--     {"id":"acc-akl","city":"奥克兰","name":"JetPark…","checkIn":"2026-09-26","checkOut":"2026-09-27","note":"…"}
--   · trip_ticket_plans payload 形如
--     {"id":"ticket-heli-tasman","name":"…","day":4,"purchaseStatus":"purchased",
--      "date":"09-28 10:30","event":"25 分钟直升机观光飞行…","info":["预订人 XIAO***","1 成人"]}
--     只存被改动过的字段，读取时按 {...基线, ...覆盖} 合并。
--   · 因此「还原」只需删除对应行 —— 基线永远在，不需要墓碑记录。
--   · 与其它共享集合一样，客户端首次写入时会自动补齐这两张表，漏执行本文件不会导致不可用。
--
-- 幂等：全部 IF NOT EXISTS，可安全重复执行。

CREATE TABLE IF NOT EXISTS trip_accommodations (
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (trip_id, id)
);

CREATE INDEX IF NOT EXISTS idx_trip_accommodations_trip ON trip_accommodations(trip_id, created_at);

CREATE TABLE IF NOT EXISTS trip_ticket_plans (
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (trip_id, id)
);

CREATE INDEX IF NOT EXISTS idx_trip_ticket_plans_trip ON trip_ticket_plans(trip_id, created_at);
