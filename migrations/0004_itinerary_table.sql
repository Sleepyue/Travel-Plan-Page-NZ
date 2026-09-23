-- 每日行程（itinerary）共享状态表。
-- 在 0001 / 0002 之后执行。加表操作，幂等，可对已有数据库直接跑。
--
-- 为什么需要这张表：行程编辑（改时间/内容、新增、删除、标记完成）要能多端同步，
-- 所以每条改动都作为一条记录落到共享层，而不是整份 days 覆盖写 —— 两个人同时
-- 改不同条目时才不会互相覆盖。
--
-- 记录 payload 形如：
--   {"id":"3::d3-abc","day":3,"itemId":"d3-abc","time":"09:00","text":"…","type":"note",
--    "completed":true,"deleted":false}
-- id 为 `${day}::${itemId}`：
--   * itemId 来自 trip-data.json 的 days[].schedule[].id（新增的条目自行生成）
--   * deleted=true 是「墓碑」，用来压掉 trip-data.json 里的原始条目
--     （只删共享层新增的条目时不需要墓碑，直接删行即可）
--
-- 用法：Cloudflare Dashboard -> 存储和数据库 -> D1 -> 你的库 -> 控制台，粘贴执行。

CREATE TABLE IF NOT EXISTS trip_itinerary (
  id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (trip_id, id)
);
CREATE INDEX IF NOT EXISTS idx_trip_itinerary_trip ON trip_itinerary(trip_id, created_at);
