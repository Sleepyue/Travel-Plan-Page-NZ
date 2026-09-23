-- 0005_flights_table.sql
-- 航班信息的「客户端覆盖层」表，与 trip_itinerary 同构。
--
-- 设计：trip-data.json 的 flights[] 是权威基线，这里按航班 id 存放增量覆盖。
--   · payload 形如 {"id":"f1","flightNumber":"NZ081","departure":{"date":"2026-09-25","time":"20:10"}}
--     只存被改动过的字段即可，读取时按 {...基线, ...覆盖} 合并（嵌套的 departure/arrival 逐层合并）。
--   · 因此「还原」只需删除对应行 —— 基线永远在，不需要墓碑记录。
--   · 与其它共享集合一样，客户端首次写入时会自动补齐本表，漏执行本文件不会导致不可用。
--
-- 幂等：全部 IF NOT EXISTS，可安全重复执行。

CREATE TABLE IF NOT EXISTS trip_flights (
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (trip_id, id)
);

CREATE INDEX IF NOT EXISTS idx_trip_flights_trip ON trip_flights(trip_id, created_at);
