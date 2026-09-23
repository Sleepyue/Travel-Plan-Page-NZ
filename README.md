# 新西兰南岛 11 日自驾 · 行程网页

一个纯静态的行程网页（机票 / 总览地图 / 每日行程 / 行前准备 / 租车 / 记账 / 餐饮），
部署在 Cloudflare Pages 上，并用你自己的 Cloudflare D1 数据库实现**多人、多设备实时共享**。

- 静态资源：HTML / CSS / JS，无构建步骤
- 共享数据：`functions/api/trip/[[tripId]].js`（Cloudflare Pages Function）+ D1
- 共享范围：行前准备（todo）、行程票券（ticket）、记账（ledger）、餐饮（dining）
- 未列入共享范围的内容（如记账的币种偏好）仍只存在各自浏览器里

---

## 一、本地预览

```bash
npm run preview
```

打开终端输出的 `http://127.0.0.1:4173/`。这是纯静态服务器，**不提供 `/api/trip`**。

### 想在本地验证「多人编辑」

```bash
npm run preview:shared
```

打开 `http://127.0.0.1:4193/`。这个开发服务器额外在内存里实现了同一个 `/api/trip/<tripId>`
接口（表映射与 upsert/delete 语义和线上 Pages Function 一致），所以**不连 Cloudflare 也能验证共享是否生效**：

- 用**普通窗口 + 无痕窗口**（或两台设备）打开同一地址
- 在一边「餐饮 → 饮食记录」新增一条，另一边刷新即可看到
- 行前准备勾选、票券勾选、记账账单同理

数据只存在进程内存里，重启清空；`/__mock-state` 可查看当前数据，`/__mock-reset` 可清空。
**它是开发工具，不会部署到线上**，线上用的是你的 D1。

### 纯静态模式下的预期表现

`npm run preview` 因为拿不到 `/api/trip`，页面会显示
「共享同步未恢复，改动仅在本页保留」并**暂停写入云端** —— 这是刻意的保护：
一次网络抖动不会被误判成"云端数据被清空"。刷新即可恢复。

如果要用真实 Pages Function 本地联调（需要已建好 D1）：

```bash
npx wrangler pages dev . --d1 DB=<你的 D1 数据库名>
```

---

## 二、部署到 GitHub + Cloudflare Pages

### 1. 先跑一次部署前自检

```bash
npm run preflight
```

不需要联网，也不需要 Cloudflare 凭据。它检查仓库自身是否自洽，专门拦住几类**线上才暴露、且不会报错只会静默失效**的问题：

- `sharedCollections` 里写了某个模块，但 Pages Function 没有对应的表映射
- 有表映射，但 `migrations/` 里没有建表语句（线上会返回 `database operation failed`）
- 模块在 `config.modules` 里关掉了，却仍列在 `sharedCollections`
- `index.html` 引用了不存在的资源（部署后 404）
- `trip-data.json` 里混入了本机绝对路径或开发凭据

退出码 0 才可以部署。**以后每次改完 `trip-data.json` 都建议先跑一次。**

### 2. 推到 GitHub

远端仓库：**https://github.com/Sleepyue/Travel-Plan-Page-NZ**（`main` 分支）

这个仓库原本是模板 [do-tongxue/Travel-Plan-Page](https://github.com/do-tongxue/Travel-Plan-Page) 的 fork，
里面只有上游作者的两条提交。本站点是用它替换掉的，所以**首次推送需要强制覆盖**：

```bash
# 首次：用站点内容覆盖 fork 里的模板
git remote set-url origin https://github.com/Sleepyue/Travel-Plan-Page-NZ.git
git push --force origin main
```

> ⚠️ `--force` 会丢弃远端的旧历史。执行前确认远端没有你还需要的提交
> （`git ls-remote origin main` 可以看远端当前的 commit）。
> 想更稳一点可以先 `git fetch origin`，再用 `--force-with-lease`：一旦远端在你之后有别人推过，它会直接拒绝而不是覆盖。

**之后每次更新**走正常流程就行，不需要再 force：

```bash
npm run preflight          # 改过 trip-data.json 就先跑这个
git add .
git commit -m "更新行程"
git push origin main
```

### 3. 连接 Cloudflare Pages

1. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. 授权 Cloudflare 访问这一个仓库，选择生产分支（`main`）
3. 构建配置：**不要填构建命令**，这是一个无编译的静态站点
   - Framework preset：`None`
   - Build command：留空
   - Build output directory：`/`（仓库根目录就是站点根目录）
4. 保存并完成首次部署 → 打开 `*.pages.dev` 地址检查页面

之后每次 `git push` 到 `main` 都会自动重新部署。

---

## 三、创建并初始化 D1 数据库

1. Cloudflare Dashboard → **Storage & Databases** → **D1** → **Create database**
   - 名称自定，例如 `nz-trip`
2. 打开这个数据库 → **Console**，依次执行 `migrations/` 下的两个 SQL 文件：

   | 顺序 | 文件 | 作用 |
   | --- | --- | --- |
   | 1 | `migrations/0001_shared_trip_data.sql` | `ledger_bills`、`ledger_travelers`、`trip_todos`、`trip_tickets` |
   | 2 | `migrations/0002_dining_tables.sql` | `dining_restaurants`、`dining_records` |

   两个文件都是 `CREATE TABLE IF NOT EXISTS`，可以安全重复执行。

   也可以用 Wrangler（会把改动应用到**云端**数据库，请确认数据库名再执行）：

   ```bash
   npx wrangler d1 execute <数据库名> --remote --file=./migrations/0001_shared_trip_data.sql
   npx wrangler d1 execute <数据库名> --remote --file=./migrations/0002_dining_tables.sql
   ```

---

## 四、把 D1 绑定到 Pages 项目

1. Cloudflare Dashboard → 你的 Pages 项目 → **Settings** → **Bindings** → **Add** → **D1 database**
2. Variable name 必须填 **`DB`**（代码里就是读这个名字）
3. 选择上一步创建的数据库
4. 保存后 **重新部署一次**，让绑定生效

> 生产环境和 Preview 环境的绑定是分开的，两边都要检查。
> 绑定指向的 database ID 不要写进仓库。

---

## 五、共享配置在哪里

`trip-data.json` 顶部的 `config`：

```json
"persistence": {
  "mode": "d1",
  "apiBase": "/api/trip",
  "sharedCollections": ["todos", "tickets", "ledger", "dining"]
}
```

- `mode: "d1"` —— 启用共享层。改成 `"local"` 就退回纯浏览器本地存储（此时不需要 D1，也不需要 `functions/`）。
- `sharedCollections` —— 只有列在这里的模块会同步到 D1。
  - `todos` → 行前准备
  - `tickets` → 行程票券勾选
  - `ledger` → 记账（账单、成员）
  - `dining` → 餐饮（餐厅清单 + 饮食记录）
- 未列入的仍然只存在各自浏览器里。

数据表的映射关系：

| collection | D1 表 |
| --- | --- |
| `bills` / `travelers` | `ledger_bills` / `ledger_travelers` |
| `todos` / `tickets` | `trip_todos` / `trip_tickets` |
| `diningRestaurants` / `diningRecords` | `dining_restaurants` / `dining_records` |

---

## 六、验证共享是否生效

1. 用两台设备（或一个正常窗口 + 一个无痕窗口）打开线上地址
2. 在 A 上「餐饮 → 饮食记录」新增一条，在 B 上刷新，应能看到
3. 检查行前准备勾选、票券勾选、记账账单是否同样互通
4. 断网后新增一条：应提示"共享同步未恢复，改动仅在本页保留"，恢复网络后刷新不会丢失云端原有数据

---

## 七、发布前已做的隐私处理

公开版本已经抹掉了下列信息（本地开发用的完整版仍保留在你的工作目录里）。
**具体值不在本文件里重复，避免二次泄露。**

| 类型 | 涉及条数 | 处理 |
| --- | --- | --- |
| Booking 住宿确认号 | 2 条 | → `确认号已隐藏` |
| 门锁 PIN | 2 个 | → `PIN 已隐藏` |
| Airbnb 确认码 | 4 条 | → `确认码已隐藏` |
| 民宿房东手机 | 4 个 | 已删除 |
| 租车确认号 / 单号 | 2 个 | → `已隐藏` |

仍然保留、需要你自己确认的内容：

- 民宿街道地址（打车/导航需要）
- 房东称呼（Jennifer / Michael / Jay 等）
- 租车门店公开电话、租租车客服电话（公开信息）
- 姓名、航班号、金额

如果这些也要隐藏，直接说一声即可。

---

## 八、安全边界（重要）

`metadata.tripId`（当前为 `nz-2026-autumn`）只是数据分区键，**不是密码**。
这个 Pages Function 没有登录、没有记录级授权、没有冲突合并。

所以：

- 任何拿到站点地址的人，只要知道 tripId，理论上就能读写共享数据
- **不要**在 D1 里存票据原件、二维码、订单号、护照或其他高敏感资料
- 需要真正私密时，请在 Cloudflare 侧配置 **Cloudflare Access**，或改用带认证的实现
- 同一记录被两台设备同时修改时，可能发生「后写覆盖」
- 餐饮记录里的图片是压缩后（长边 1280px / JPEG 0.72）以 base64 存在记录里，
  单条记录最多 3 张；D1 单行 payload 有大小上限，别把它当图床

---

## 九、目录结构

```
index.html                 页面骨架
styles.css                 主样式
app.js                     主逻辑（行程、地图、todo、此刻关注）
ledger.css / ledger.js     记账模块
dining.css / dining.js     餐饮模块
site-navigation.js         旅行信息 / 记账 / 餐饮 三视图切换
runtime-storage.js         localStorage / D1 双适配器
overview-map.js route-ui.js ticket-pdf-preview.js
trip-data.json             全部行程数据（config / days / accommodations / ...）
assets/                    地图模板与边界 geojson
functions/api/trip/[[tripId]].js   Pages Function：共享数据读写
migrations/                D1 建表 SQL
local-preview-server.mjs   本地静态预览
dev/mock-shared-api.mjs    本地共享模式 Mock（开发工具，不部署）
scripts/preflight.mjs      部署前自检
```

---

## 十、许可

页面模板来自 [do-tongxue/Travel-Plan-Page](https://github.com/do-tongxue/Travel-Plan-Page)，
详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
