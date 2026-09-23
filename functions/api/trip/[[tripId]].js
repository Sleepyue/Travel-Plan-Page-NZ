const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const table = {
  bills: "ledger_bills",
  travelers: "ledger_travelers",
  todos: "trip_todos",
  tickets: "trip_tickets",
  diningRestaurants: "dining_restaurants",
  diningRecords: "dining_records"
};
const safeId = (value) => String(value || "").trim().slice(0, 160);

async function readSnapshot(db, tripId, collections) {
  const snapshot = {
    version: 1,
    settings: null,
    bills: [],
    travelers: [],
    todos: [],
    tickets: [],
    diningRestaurants: [],
    diningRecords: [],
    updatedAt: new Date().toISOString()
  };
  await Promise.all(collections.map(async (collection) => {
    const result = await db.prepare(`SELECT payload FROM ${table[collection]} WHERE trip_id = ? ORDER BY created_at, id`).bind(tripId).all();
    snapshot[collection] = result.results.map((row) => JSON.parse(row.payload));
  }));
  return snapshot;
}

export async function onRequest(context) {
  const tripId = safeId(context.params.tripId);
  if (!tripId) return json({ error: "trip_id is required" }, 400);
  if (!context.env.DB) return json({ error: "D1 binding DB is missing" }, 500);
  const requested = new URL(context.request.url).searchParams.get("collections");
  const collections = [...new Set(String(requested || Object.keys(table).join(",")).split(",").filter((name) => table[name]))];
  if (!collections.length) return json({ error: "at least one valid collection is required" }, 400);
  try {
    if (context.request.method === "GET") return json(await readSnapshot(context.env.DB, tripId, collections));
    if (context.request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await context.request.json();
    if (!Array.isArray(body.changes)) return json({ error: "changes must be an array" }, 400);
    const statements = [];
    for (const change of body.changes) {
      const kind = table[change.collection];
      const id = safeId(change.id);
      if (!kind || !collections.includes(change.collection) || !id || !["upsert", "delete"].includes(change.op)) return json({ error: "invalid change" }, 400);
      if (change.op === "delete") {
        statements.push(context.env.DB.prepare(`DELETE FROM ${kind} WHERE trip_id = ? AND id = ?`).bind(tripId, id));
        continue;
      }
      const payload = JSON.stringify(change.value || {});
      const now = new Date().toISOString();
      if (change.collection === "bills") {
        const value = change.value || {};
        statements.push(context.env.DB.prepare(`INSERT INTO ledger_bills (id, trip_id, payer, amount, currency, category, note, participants, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(trip_id, id) DO UPDATE SET payer=excluded.payer, amount=excluded.amount, currency=excluded.currency, category=excluded.category, note=excluded.note, participants=excluded.participants, updated_at=excluded.updated_at, payload=excluded.payload`).bind(id, tripId, value.payerId || value.payer || "", Number(value.baseAmountCents ?? value.amount ?? 0), value.currency || "CNY", value.category || "其他", typeof value.note === "string" ? value.note.trim().slice(0, 160) : "", JSON.stringify(value.participantIds || value.participants || []), value.createdAt || now, value.updatedAt || now, payload));
      } else {
        statements.push(context.env.DB.prepare(`INSERT INTO ${kind} (id, trip_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(trip_id, id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload`).bind(id, tripId, change.value?.createdAt || now, change.value?.updatedAt || now, payload));
      }
    }
    if (statements.length) await context.env.DB.batch(statements);
    return json(await readSnapshot(context.env.DB, tripId, collections));
  } catch (error) {
    return json({ error: "database operation failed", detail: error.message }, 500);
  }
}
