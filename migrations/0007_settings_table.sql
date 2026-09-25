-- 0007_settings_table.sql
-- 记账「设置」的共享单例表：本位币 / 常用外币 / 消费类型。
--
-- 背景：这些设置以前只存本机 localStorage（D1 适配器里的 settings 走的是本地适配器），
-- 结果是「我加的消费类型，同行人在自己设备上记账时选不到」。
-- 现在把 settings 提升为共享层的**单例记录**：整张表最多一行，id 固定为 "settings"。
--
-- 设计：
--   · 与其它记录集合同构（id / trip_id / created_at / updated_at / payload），
--     因此复用同一套 upsert/delete 协议与自愈建表逻辑；
--   · 唯一区别在**回传形状**：服务端把它作为**对象**放进 snapshot.settings，
--     而不是像其它集合那样回传数组 —— 与本地快照的 settings 形状保持一致。
--   · payload 形如
--     {"baseCurrency":"CNY","commonCurrencies":["EUR","CHF","HKD"],
--      "categories":["餐饮","交通","住宿","门票","购物","其他"]}
--   · 本机那份 localStorage 仍保留，作用是离线兜底 + 老数据迁移来源：
--     首次读到远端为空时会自动把本机旧设置上推一次，两台设备随即收敛。
--   · 与其它共享集合一样，客户端首次写入时会自动补齐这张表，漏执行本文件不会导致不可用。
--
-- 幂等：IF NOT EXISTS，可安全重复执行。

CREATE TABLE IF NOT EXISTS trip_settings (
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (trip_id, id)
);

CREATE INDEX IF NOT EXISTS idx_trip_settings_trip ON trip_settings(trip_id, created_at);
