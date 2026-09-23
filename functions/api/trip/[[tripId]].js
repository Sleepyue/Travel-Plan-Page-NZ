const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const table = {
  bills: "ledger_bills",
  travelers: "ledger_travelers",
  todos: "trip_todos",
  tickets: "trip_tickets",
  itinerary: "trip_itinerary",
  flights: "trip_flights",
  diningRestaurants: "dining_restaurants",
  diningRecords: "dining_records"
};

// 自愈建表：客户端首次写入某张尚未创建的表时，自动补齐，避免线上因漏跑迁移而整体不可用。
// 与 migrations/*.sql 保持一致；CREATE ... IF NOT EXISTS 幂等，重复执行安全。
const schema = {
  trip_itinerary: {
    table: "CREATE TABLE IF NOT EXISTS trip_itinerary (id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (trip_id, id))",
    index: "CREATE INDEX IF NOT EXISTS idx_trip_itinerary_trip ON trip_itinerary(trip_id, created_at)"
  },
  trip_flights: {
    table: "CREATE TABLE IF NOT EXISTS trip_flights (id TEXT NOT NULL, trip_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (trip_id, id))",
    index: "CREATE INDEX IF NOT EXISTS idx_trip_flights_trip ON trip_flights(trip_id, created_at)"
  }
};

const safeId = (value) => String(value || "").trim().slice(0, 160);
const isMissingTable = (error) => /no such table/i.test(String(error?.message || ""));

async function readSnapshot(db, tripId, collections) {
  const snapshot = {
    version: 1,
    settings: null,
    bills: [],
    travelers: [],
    todos: [],
    tickets: [],
    itinerary: [],
    flights: [],
    diningRestaurants: [],
    diningRecords: [],
    updatedAt: new Date().toISOString()
  };
  const missing = [];
  await Promise.all(collections.map(async (collection) => {
    try {
      const result = await db.prepare(`SELECT payload FROM ${table[collection]} WHERE trip_id = ? ORDER BY created_at, id`).bind(tripId).all();
      snapshot[collection] = result.results.map((row) => JSON.parse(row.payload));
    } catch (error) {
      // 单表缺失（未跑迁移）只降级这一张表，绝不能让整份快照失败；其他错误照旧抛出。
      if (!isMissingTable(error)) throw error;
      snapshot[collection] = [];
      missing.push(collection);
    }
  }));
  if (missing.length) snapshot.missingCollections = missing;
  return snapshot;
}

async function applyChanges(db, tripId, changes, collections) {
  const statements = [];
  for (const change of changes) {
    const kind = table[change.collection];
    const id = safeId(change.id);
    if (!kind || !collections.includes(change.collection) || !id || !["upsert", "delete"].includes(change.op)) return { error: "invalid change" };
    if (change.op === "delete") {
      statements.push(db.prepare(`DELETE FROM ${kind} WHERE trip_id = ? AND id = ?`).bind(tripId, id));
      continue;
    }
    const payload = JSON.stringify(change.value || {});
    const now = new Date().toISOString();
    if (change.collection === "bills") {
      const value = change.value || {};
      statements.push(db.prepare(`INSERT INTO ledger_bills (id, trip_id, payer, amount, currency, category, note, participants, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trip_id, id) DO UPDATE SET payer=excluded.payer, amount=excluded.amount, currency=excluded.currency, category=excluded.category, note=excluded.note, participants=excluded.participants, updated_at=excluded.updated_at, payload=excluded.payload`).bind(id, tripId, value.payerId || value.payer || "", Number(value.baseAmountCents ?? value.amount ?? 0), value.currency || "CNY", value.category || "其他", typeof value.note === "string" ? value.note.trim().slice(0, 160) : "", JSON.stringify(value.participantIds || value.participants || []), value.createdAt || now, value.updatedAt || now, payload));
    } else {
      statements.push(db.prepare(`INSERT INTO ${kind} (id, trip_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(trip_id, id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload`).bind(id, tripId, change.value?.createdAt || now, change.value?.updatedAt || now, payload));
    }
  }
  if (statements.length) await db.batch(statements);
  return { ok: true };
}

// 对报错信息里出现的「缺失表」执行自愈建表，返回是否至少修复了一张。
async function healMissingTables(db, error, collections) {
  const message = String(error?.message || "");
  let healed = false;
  for (const collection of collections) {
    const kind = table[collection];
    if (!schema[kind] || !message.includes(kind)) continue;
    await db.prepare(schema[kind].table).run();
    if (schema[kind].index) await db.prepare(schema[kind].index).run();
    healed = true;
  }
  return healed;
}

export async function onRequest(context) {
  const tripId = safeId(context.params.tripId);
  if (!tripId) return json({ error: "trip_id is required" }, 400);
  if (!context.env.DB) return json({ error: "D1 binding DB is missing" }, 500);
  const requested = new URL(context.request.url).searchParams.get("collections");
  const collections = [...new Set(String(requested || Object.keys(table).join(",")).split(",").filter((name) => table[name]))];
  if (!collections.length) return json({ error: "at least one valid collection is required" }, 400);
  const db = context.env.DB;
  try {
    if (context.request.method === "GET") return json(await readSnapshot(db, tripId, collections));
    if (context.request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await context.request.json();
    if (!Array.isArray(body.changes)) return json({ error: "changes must be an array" }, 400);
    let result;
    try {
      result = await applyChanges(db, tripId, body.changes, collections);
    } catch (error) {
      if (!isMissingTable(error) || !(await healMissingTables(db, error, collections))) throw error;
      result = await applyChanges(db, tripId, body.changes, collections); // 建表后重试一次（upsert 幂等）
    }
    if (result?.error) return json({ error: result.error }, 400);
    return json(await readSnapshot(db, tripId, collections));
  } catch (error) {
    return json({ error: "database operation failed", detail: error.message }, 500);
  }
}
