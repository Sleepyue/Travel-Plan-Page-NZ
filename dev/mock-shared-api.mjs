/* 本地「共享模式」开发服务器 —— 仅用于本机联调，不是 Cloudflare。

   它做两件事：
   1. 像 local-preview-server.mjs 一样提供静态文件；
   2. 在内存里实现同一个 /api/trip/<tripId> 接口（与 functions/api/trip/[[tripId]].js 等价的表映射与
      upsert/delete 语义），这样不用连 Cloudflare 就能验证「多人编辑」是否真的生效。

   用法：
     node dev/mock-shared-api.mjs            # 默认 http://127.0.0.1:4193/
     node dev/mock-shared-api.mjs 5000       # 指定端口

   验证多设备：用普通窗口 + 无痕窗口（或两台设备）打开同一地址，在一边「餐饮 → 饮食记录」
   新增一条，另一边刷新即可看到。

   ⚠️ 数据只存在进程内存里，重启即清空；每个 tripId 互相隔离。
   ⚠️ 没有任何认证，不要拿来对外提供服务。
   ⚠️ 端口默认 4193：4190 之类的端口在 Fetch 规范的 bad-port 名单里，会被 Node 的
      fetch / undici 直接拒绝（浏览器不受影响），换端口会自动避开。
*/
import http from "node:http";
import { promises as fs, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || process.env.PORT || 4193);
const host = process.env.HOST || "127.0.0.1";

/* 与 functions/api/trip/[[tripId]].js 的 table 映射保持一致 */
const TABLES = {
  bills: "ledger_bills",
  travelers: "ledger_travelers",
  todos: "trip_todos",
  tickets: "trip_tickets",
  itinerary: "trip_itinerary",
  flights: "trip_flights",
  accommodations: "trip_accommodations",
  ticketPlans: "trip_ticket_plans",
  diningRestaurants: "dining_restaurants",
  diningRecords: "dining_records"
};
const RECORD_TABLES = Object.values(TABLES);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".geojson": "application/json; charset=utf-8"
};

/** `${table}:${tripId}` -> Map<id, row> */
const store = new Map();
const rows = (table, tripId) => {
  const key = `${table}:${tripId}`;
  if (!store.has(key)) store.set(key, new Map());
  return store.get(key);
};

const sendJson = (response, body, status = 200) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
};

const readBody = (request) => new Promise((resolve, reject) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => resolve(raw));
  request.on("error", reject);
});

function snapshotFor(tripId, collections) {
  const snapshot = {
    version: 1,
    settings: null,
    updatedAt: new Date().toISOString()
  };
  for (const collection of collections) snapshot[collection] = [...rows(TABLES[collection], tripId).values()];
  return snapshot;
}

let writeCount = 0;

async function handleApi(request, response, url) {
  const tripId = String(decodeURIComponent(url.pathname.split("/")[3] || "")).trim().slice(0, 160);
  if (!tripId) return sendJson(response, { error: "trip_id is required" }, 400);

  const requested = url.searchParams.get("collections");
  const collections = [...new Set(String(requested || Object.keys(TABLES).join(","))
    .split(",").map((name) => name.trim()).filter((name) => TABLES[name]))];
  if (!collections.length) return sendJson(response, { error: "at least one valid collection is required" }, 400);

  if (request.method === "GET") return sendJson(response, snapshotFor(tripId, collections));
  if (request.method !== "POST") return sendJson(response, { error: "method not allowed" }, 405);

  let body;
  try {
    body = JSON.parse(await readBody(request) || "{}");
  } catch {
    return sendJson(response, { error: "body must be valid JSON" }, 400);
  }
  if (!Array.isArray(body.changes)) return sendJson(response, { error: "changes must be an array" }, 400);

  for (const change of body.changes) {
    const table = TABLES[change.collection];
    const id = String(change.id || "").trim().slice(0, 160);
    if (!table || !collections.includes(change.collection) || !id || !["upsert", "delete"].includes(change.op)) {
      return sendJson(response, { error: "invalid change", change }, 400);
    }
    const bucket = rows(table, tripId);
    if (change.op === "delete") bucket.delete(id);
    else bucket.set(id, change.value || {});
  }
  writeCount += 1;
  return sendJson(response, snapshotFor(tripId, collections));
}

async function serveStatic(request, response, url) {
  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    return response.end("Method not allowed");
  }
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.resolve(repoRoot, `.${requested}`);
  if (filePath !== repoRoot && !filePath.startsWith(`${repoRoot}${path.sep}`)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return response.end("Forbidden");
  }
  try {
    if (statSync(filePath).isDirectory()) throw new Error("directory");
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith("/api/trip/")) return await handleApi(request, response, url);
    if (url.pathname === "/__mock-state") {
      const dump = {};
      for (const [key, bucket] of store) dump[key] = [...bucket.values()];
      return sendJson(response, dump);
    }
    if (url.pathname === "/__stats") {
      return sendJson(response, { writes: writeCount });
    }
    if (url.pathname === "/__mock-reset") {
      store.clear();
      return sendJson(response, { ok: true, cleared: RECORD_TABLES.length });
    }
    return await serveStatic(request, response, url);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Server error: ${error.message}`);
  }
});

server.listen(port, host, () => {
  const functionsEntry = path.join(repoRoot, "functions", "api", "trip", "[[tripId]].js");
  const missing = !existsSync(functionsEntry);
  console.log(`\n  本地共享模式预览（内存 Mock，非 Cloudflare）`);
  console.log(`  → http://${host}:${port}/`);
  console.log(`  多设备验证：普通窗口 + 无痕窗口同时打开，任一边新增记录，另一边刷新可见。`);
  console.log(`  数据仅存在进程内存，重启清空；/__mock-state 查看当前数据。`);
  if (missing) {
    console.log(`  ⚠️ 未找到 Pages Function：${functionsEntry}`);
    console.log(`     部署前请确认仓库已包含 functions/api/trip/[[tripId]].js。`);
  } else {
    console.log(`  ✓ 已包含 Pages Function，部署时 Cloudflare 会用它自己的 D1（与本机无关）。`);
  }
  console.log("");
});
