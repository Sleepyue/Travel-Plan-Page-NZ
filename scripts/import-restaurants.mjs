/* 餐厅清单导入 —— 一次把桌面表格里的餐厅同时写进两处：
   1) trip-data.json > restaurants   静态基线（app.js 的地图导航也读它）
   2) 共享层 diningRestaurants       线上 D1，两个同行人打开都能看到同一份清单

   为什么两处都要：trip-data.json 是仓库自带的权威基线，改了它谁打开都有一份
   "出厂默认"；共享层才是多人协作的真相。dining.js 只读共享层，所以只改 JSON
   的话页面上反而看不到东西。

   用法：
     node scripts/import-restaurants.mjs <表格.xlsx> [--api https://xxx.pages.dev]
   不加 --api 就只更新基线，不碰线上。

   注意：餐厅 id 由「城市+店名」决定性地派生（rest-<hash>），所以反复执行不会
   产生重复记录 —— 同一条永远落在同一个 id 上，upsert 幂等。 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const xlsxPath = args.find((arg) => !arg.startsWith("--"));
const apiIndex = args.indexOf("--api");
const apiBase = apiIndex >= 0 ? String(args[apiIndex + 1] || "").replace(/\/+$/, "") : "";
const tripId = "nz-2026-autumn";

if (!xlsxPath) {
  console.error("用法: node scripts/import-restaurants.mjs <表格.xlsx> [--api https://xxx.pages.dev]");
  process.exit(1);
}

/* ---------- 1. 读表格 ---------- */
const python = "C:/Users/LG/.workbuddy/binaries/python/versions/3.13.12/python.exe";
const dumpScript = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb[wb.sheetnames[0]]
rows = []
for r in range(2, ws.max_row + 1):
    cells = [str(ws.cell(r, c).value or "").strip() for c in range(1, 5)]
    if not any(cells):
        continue
    rows.append({"city": cells[0], "spendType": cells[1], "cuisine": cells[2], "name": cells[3]})
sys.stdout.write(json.dumps(rows, ensure_ascii=False))
`;
const raw = execFileSync(python, ["-c", dumpScript, xlsxPath], { encoding: "utf8", maxBuffer: 1 << 24 });
const rows = JSON.parse(raw);

/* ---------- 2. 归一化 ---------- */
const makeId = (city, name) => {
  const digest = createHash("sha1").update(`${city}|${name}`).digest("hex").slice(0, 10);
  return `rest-xlsx-${digest}`;
};

const seen = new Set();
const restaurants = [];
const skipped = [];
for (const row of rows) {
  const name = row.name.trim();
  if (!name) continue;
  const city = row.city.trim();
  const key = `${city}|${name}`;
  /* 表格里皇后镇有两条同名 Fergburger（一条「汉堡」一条「甜甜圈」）—— 同一家店
     只能有一条记录，否则记录 id 撞车，保留先出现的那条（汉堡，信息更具体）。 */
  if (seen.has(key)) {
    skipped.push(key);
    continue;
  }
  seen.add(key);
  restaurants.push({
    id: makeId(city, name),
    city,
    name,
    cuisine: row.cuisine.trim(),
    note: row.spendType.trim(),
    source: "导入"
  });
}
console.log(`表格 ${rows.length} 行 → ${restaurants.length} 家餐厅${skipped.length ? `（跳过重复 ${skipped.length}: ${skipped.join("、")}）` : ""}`);

/* ---------- 3. 更新 trip-data.json 基线 ---------- */
const JSON_PATH = new URL("../trip-data.json", import.meta.url);
const rawText = readFileSync(JSON_PATH, "utf8");
const br = rawText.includes("\r\n") ? "\r\n" : "\n";
const indent = (value, depth) =>
  JSON.stringify(value, null, 2).split("\n").map((line, index) => (index === 0 ? line : " ".repeat(depth) + line)).join(br);

const block = restaurants.map((item) => indent(item, 2)).join(`,${br}`);
const replacement = `"restaurants": [${br}    ${block}${br}  ],`;
const marker = /"restaurants": \[[^\]]*\],/;
if (!marker.test(rawText)) throw new Error("trip-data.json 里找不到 \"restaurants\": [...]，中止以免写坏文件");
const nextText = rawText.replace(marker, replacement);
/* 写完先自检：能被解析、且餐厅条数对得上，再落盘。 */
const parsed = JSON.parse(nextText);
if (parsed.restaurants.length !== restaurants.length) throw new Error("回写后的 trip-data.json 餐厅条数不符");
writeFileSync(JSON_PATH, nextText, "utf8");
console.log(`已写入基线 trip-data.json（${restaurants.length} 条）`);

/* ---------- 4. 写入共享层 ---------- */
if (!apiBase) {
  console.log("未指定 --api，跳过共享层写入。");
  process.exit(0);
}

const records = restaurants.map((item) => ({ ...item, createdAt: new Date().toISOString() }));
const endpoint = `${apiBase}/api/trip/${encodeURIComponent(tripId)}?collections=diningRestaurants`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ changes: records.map((record) => ({ op: "upsert", collection: "diningRestaurants", id: record.id, value: record })) })
});
if (!response.ok) {
  console.error(`共享层写入失败: HTTP ${response.status} ${await response.text()}`);
  process.exit(1);
}
const snapshot = await response.json();
console.log(`共享层现有 ${snapshot.diningRestaurants?.length ?? 0} 家餐厅`);
