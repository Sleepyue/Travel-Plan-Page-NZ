/* 部署前自检 —— 不需要联网、不需要 Cloudflare 凭据。

   它检查的是「仓库自身是否自洽」，专门拦住几类会静默失败的问题：
     · sharedCollections 里写了某个模块，但 Pages Function 没有对应表映射
     · 有 Functions 映射，但 migrations/ 里没有建表语句（线上会返回 database operation failed）
     · 模块在 config.modules 里关掉了，却仍列在 sharedCollections（配了但永远用不上）
     · index.html 引用的本地资源不存在（部署后 404）
     · trip-data.json 里混入了本机绝对路径或开发凭据

   用法：node scripts/preflight.mjs
   退出码 0 = 可以部署；非 0 = 有问题，下面会逐条列出。
*/
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];
const notes = [];
const fail = (message) => problems.push(message);
const warn = (message) => warnings.push(message);

const read = (relative) => readFileSync(path.join(repoRoot, relative), "utf8");
const has = (relative) => existsSync(path.join(repoRoot, relative));

/* ---------- 1. trip-data.json parses and its config is coherent ---------- */
const MODULE_NAMES = ["flights", "overview", "itinerary", "todo", "driving", "ledger"];
const KNOWN_SHARED = new Set(["todos", "tickets", "itinerary", "ledger", "dining"]);
/* sharedCollection -> module that must be enabled, and the record collections it maps to */
const SHARED_REQUIREMENTS = {
  todos: { module: "todo", collections: ["todos"] },
  tickets: { module: "itinerary", collections: ["tickets"] },
  itinerary: { module: "itinerary", collections: ["itinerary"] },
  ledger: { module: "ledger", collections: ["bills", "travelers"] },
  dining: { module: null, collections: ["diningRestaurants", "diningRecords"] }
};

let trip = null;
try {
  trip = JSON.parse(read("trip-data.json"));
  notes.push("trip-data.json 解析通过");
} catch (error) {
  fail(`trip-data.json 无法解析：${error.message}`);
}

if (trip) {
  const config = trip.config || {};
  if (config.schemaVersion !== "1.0.0") fail(`config.schemaVersion 应为 1.0.0，当前为 ${JSON.stringify(config.schemaVersion)}`);
  for (const name of MODULE_NAMES) {
    if (typeof config.modules?.[name] !== "boolean") fail(`config.modules.${name} 必须是布尔值`);
  }
  const extraModules = Object.keys(config.modules || {}).filter((name) => !MODULE_NAMES.includes(name));
  if (extraModules.length) fail(`config.modules 含未支持的键：${extraModules.join(", ")}（只允许 ${MODULE_NAMES.join("/")}）`);

  const persistence = config.persistence || {};
  if (persistence.mode !== "local" && persistence.mode !== "d1") {
    fail(`config.persistence.mode 只能是 local 或 d1，当前为 ${JSON.stringify(persistence.mode)}`);
  }

  if (persistence.mode === "local") {
    notes.push("persistence.mode = local（纯浏览器本地存储，不需要 D1，也不需要 functions/）");
    if (has("functions")) warn("存在 functions/ 目录但 mode 是 local：静态站点用不到它，可以删掉或保留不影响");
  } else {
    const shared = [...new Set(persistence.sharedCollections || [])];
    if (!shared.length) fail("mode = d1 时必须提供非空的 config.persistence.sharedCollections");
    for (const name of shared) {
      if (!KNOWN_SHARED.has(name)) fail(`sharedCollections 含未知项「${name}」（只允许 ${[...KNOWN_SHARED].join("/")}）`);
    }
    const apiBase = persistence.apiBase || "/api/trip";
    if (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase)) {
      fail(`apiBase 必须是同源绝对路径，当前为 ${JSON.stringify(apiBase)}`);
    }
    if (!has("functions/api/trip/[[tripId]].js")) {
      fail("mode = d1 但缺少 functions/api/trip/[[tripId]].js —— 线上所有共享写入都会 404");
    }
    notes.push(`persistence.mode = d1，共享：${shared.join(" / ")}`);

    /* ---------- 2. every shared collection needs BOTH a table mapping and a CREATE TABLE ---------- */
    let tableMap = {};
    if (has("functions/api/trip/[[tripId]].js")) {
      const source = read("functions/api/trip/[[tripId]].js");
      const block = /const table = \{([\s\S]*?)\};/.exec(source);
      if (!block) {
        fail("functions/api/trip/[[tripId]].js 里找不到 `const table = {...}` 映射");
      } else {
        for (const match of block[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) tableMap[match[1]] = match[2];
      }
    }

    const migrationFiles = has("migrations")
      ? readdirSync(path.join(repoRoot, "migrations")).filter((f) => f.endsWith(".sql")).sort()
      : [];
    const declaredTables = new Set();
    for (const file of migrationFiles) {
      const sql = read(`migrations/${file}`);
      for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)) declaredTables.add(match[1]);
    }

    for (const name of shared) {
      const requirement = SHARED_REQUIREMENTS[name];
      if (!requirement) continue;
      for (const collection of requirement.collections) {
        const table = tableMap[collection];
        if (!table) {
          fail(`sharedCollections 含「${name}」，但 Functions 的 table 映射缺少「${collection}」→ 该模块会静默不同步`);
          continue;
        }
        if (!declaredTables.has(table)) {
          fail(`集合「${collection}」映射到表 ${table}，但 migrations/（${migrationFiles.join(", ") || "空"}）里没有建表语句 → 线上会返回 database operation failed`);
        }
      }
      if (requirement.module && config.modules?.[requirement.module] !== true) {
        warn(`「${name}」已列入 sharedCollections，但 config.modules.${requirement.module} = false：配置了却不会使用`);
      }
    }

    /* surface anything declared but unused, both directions */
    for (const collection of Object.keys(tableMap)) {
      const used = shared.some((name) => SHARED_REQUIREMENTS[name]?.collections.includes(collection));
      if (!used && collection !== "bills" && collection !== "travelers") {
        // bills/travelers belong to the `ledger` group; anything else unused is worth a nudge
        if (!shared.includes("ledger")) warn(`Functions 映射了「${collection}」，但它所属的共享模块未启用`);
      }
    }
    for (const table of declaredTables) {
      if (!Object.values(tableMap).includes(table)) warn(`migrations/ 建了表 ${table}，但 Functions 没有映射到它（可能是历史遗留）`);
    }

    if (migrationFiles.length > 1) {
      notes.push(`需按顺序在 D1 Console 执行，且全部都要执行：${migrationFiles.join(" → ")}`);
    }
  }
}

/* ---------- 3. index.html references exist ---------- */
if (has("index.html")) {
  const html = read("index.html");
  const referenced = [...html.matchAll(/(?:src|href)="([^"#:]+?)(?:\?[^"]*)?"/g)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith("data:") && !value.startsWith("http"));
  const missing = [...new Set(referenced)].filter((relative) => !has(relative));
  if (missing.length) fail(`index.html 引用了不存在的文件：${missing.join(", ")}`);
  else notes.push(`index.html 引用的 ${new Set(referenced).size} 个本地资源均存在`);
} else {
  fail("缺少 index.html");
}

/* ---------- 4. required scripts ---------- */
for (const required of ["runtime-storage.js", "app.js", "styles.css", "trip-data.json"]) {
  if (!has(required)) fail(`缺少必需文件 ${required}`);
}

/* ---------- 5. no machine-specific paths or dev credentials ---------- */
if (has("trip-data.json")) {
  const text = read("trip-data.json");
  if (/[A-Za-z]:\\{1,2}(?:Users|1 安装文件|Program)/.test(text)) fail("trip-data.json 里出现本机绝对路径");
  for (const marker of [".dev.vars", "CLOUDFLARE_API_TOKEN", "database_id", "account_id", "BEGIN PRIVATE KEY"]) {
    if (text.includes(marker)) fail(`trip-data.json 里出现开发凭据标记「${marker}」`);
  }
}

/* ---------- report ---------- */
console.log("\n  部署前自检");
console.log("  ─────────────────────────────────────────");
for (const note of notes) console.log(`  · ${note}`);
for (const message of warnings) console.log(`  ⚠ ${message}`);
for (const message of problems) console.log(`  ✗ ${message}`);
console.log("");

if (problems.length) {
  console.log(`  自检未通过：${problems.length} 个必须修复的问题\n`);
  process.exitCode = 1;
} else {
  console.log(`  自检通过${warnings.length ? `（${warnings.length} 条提醒）` : ""}，可以部署\n`);
}
