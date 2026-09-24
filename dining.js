/* 旅行餐饮 (Dining) — DIY add-on module.
   Same-level view as 旅行信息 / 记账. Reuses the ledger design system (ledger-* classes). */
(() => {
  "use strict";

  const STORAGE_VERSION = 1;
  const SPEND_TYPES = ["早餐", "午餐", "晚餐", "正餐", "咖啡", "甜点", "饮品", "酒吧", "零食", "食材", "外卖", "其他"];
  /* 消费类型 is a free-text field with suggestions (same pattern as 城市 / 餐饮类型),
     because the built-in list cannot cover everything. Custom values typed earlier
     are folded back into the suggestion list so they don't have to be retyped. */
  const MAX_SPEND_TYPE_LENGTH = 12;
  function spendTypeSuggestions() {
    const used = (Array.isArray(data?.records) ? data.records : [])
      .map((record) => String(record?.spendType || "").trim())
      .filter((type) => type && !SPEND_TYPES.includes(type));
    return [...SPEND_TYPES, ...[...new Set(used)].sort((first, second) => first.localeCompare(second, "zh-CN"))];
  }
  const CUISINE_TYPES = ["日料", "中餐", "西餐", "快餐", "韩餐", "泰餐", "东南亚", "新西兰本地", "咖啡烘焙", "其他"];
  const RATING_OPTIONS = [["0", "未评"], ["1", "★"], ["2", "★★"], ["3", "★★★"], ["4", "★★★★"], ["5", "★★★★★"]];
  const CURRENCIES = [["CNY", "¥"], ["NZD", "NZ$"], ["HKD", "HK$"], ["USD", "$"]];
  const CURRENCY_SYMBOL = Object.fromEntries(CURRENCIES);
  const MAX_IMAGES = 3;
  const MAX_IMAGE_EDGE = 1280;
  const IMAGE_QUALITY = 0.72;

  const DEFAULT_CITIES = ["深圳", "香港", "奥克兰", "基督城", "特卡波", "库克山", "瓦纳卡", "皇后镇", "但尼丁", "奥马鲁"];

  let root = null;
  let tripId = "default-trip";
  let storageKey = "";
  let data = null;
  let tripCities = [...DEFAULT_CITIES];
  let tripDays = [];
  let activeTab = "restaurants";
  let diningFilter = "all";
  let notice = "";
  let editingRecordId = "";
  let editingRestaurantId = "";
  let draft = emptyDraft();
  let memorySnapshot = null;
  let adapter = null;
  let sharedReady = true;
  let initialized = false;

  function emptyDraft() {
    return {
      city: "", spendType: "正餐", name: "", cuisine: "", rating: "0",
      cost: "", currency: "CNY", note: "", occurredAt: todayIso(), images: []
    };
  }

  function todayIso() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
  const escapeAttribute = escapeHtml;

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function formatMoney(value, currency) {
    const amount = Number(value) || 0;
    const symbol = CURRENCY_SYMBOL[currency] || currency || "";
    const text = amount.toLocaleString("zh-CN", {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2
    });
    return `${symbol} ${text}`;
  }

  function formatDate(value) {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(parsed);
  }

  function stars(rating) {
    const count = Math.max(0, Math.min(5, Number(rating) || 0));
    return count ? "★".repeat(count) + "☆".repeat(5 - count) : "未评价";
  }

  /* ---------- data ---------- */

  function defaultData() {
    return {
      version: STORAGE_VERSION,
      restaurants: [],
      records: [],
      updatedAt: new Date().toISOString()
    };
  }

  function normalizeRestaurant(raw, index) {
    const name = String(raw?.name || "").trim().slice(0, 60);
    if (!name) return null;
    return {
      id: String(raw?.id || "").trim() || makeId("rest"),
      city: String(raw?.city || "").trim().slice(0, 30),
      name,
      cuisine: CUISINE_TYPES.includes(raw?.cuisine) ? raw.cuisine : String(raw?.cuisine || "").trim().slice(0, 20),
      /* 消费类型：早期导入的 53 家把「消费类型」写在了 note 里（餐厅当时没有这个字段），
         restaurantSpendType() 会在 spendType 为空时回退读 note，保证老数据照常显示。 */
      spendType: String(raw?.spendType || "").trim().slice(0, MAX_SPEND_TYPE_LENGTH),
      priceLevel: String(raw?.priceLevel ?? raw?.price ?? "").trim().slice(0, 20),
      note: String(raw?.note || "").trim().slice(0, 160),
      source: String(raw?.source || "").trim().slice(0, 20),
      starred: Boolean(raw?.starred),
      checkedIn: Boolean(raw?.checkedIn),
      createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : new Date().toISOString()
    };
  }

  /* 消费类型：新字段优先，老数据回退到 note。 */
  function restaurantSpendType(restaurant) {
    return String(restaurant?.spendType || restaurant?.note || "").trim();
  }

  /* 餐厅的去重键：城市 + 店名（大小写/空格无关）。 */
  function restaurantKey(restaurant) {
    return `${String(restaurant?.city || "").trim()}|${String(restaurant?.name || "").trim().toLowerCase()}`;
  }

  function findRestaurant({ city = "", name = "" } = {}) {
    const wantedName = String(name || "").trim().toLowerCase();
    if (!wantedName) return null;
    const wantedCity = String(city || "").trim();
    const named = data.restaurants.filter((restaurant) => String(restaurant.name || "").trim().toLowerCase() === wantedName);
    if (!named.length) return null;
    if (wantedCity) {
      const exact = named.find((restaurant) => String(restaurant.city || "").trim() === wantedCity);
      if (exact) return exact;
    }
    return named[0];
  }

  function normalizeRecord(raw) {
    const name = String(raw?.name || "").trim().slice(0, 60);
    const city = String(raw?.city || "").trim().slice(0, 30);
    const cost = Number(raw?.cost);
    if (!name && !city && !Number.isFinite(cost)) return null;
    const images = (Array.isArray(raw?.images) ? raw.images : [])
      .filter((image) => typeof image === "string" && image.startsWith("data:image"))
      .slice(0, MAX_IMAGES);
    /* A custom type is kept as typed — coercing anything unknown to 其他 is what
       silently discarded the free-text values. */
    const requestedSpendType = String(raw?.spendType || "").trim().slice(0, MAX_SPEND_TYPE_LENGTH);
    return {
      id: String(raw?.id || "").trim() || makeId("meal"),
      city,
      spendType: requestedSpendType || "其他",
      name,
      cuisine: String(raw?.cuisine || "").trim().slice(0, 20),
      rating: Math.max(0, Math.min(5, Number(raw?.rating) || 0)),
      cost: Number.isFinite(cost) ? Math.max(0, cost) : 0,
      currency: CURRENCY_SYMBOL[raw?.currency] ? raw.currency : "CNY",
      note: String(raw?.note || "").trim().slice(0, 160),
      occurredAt: typeof raw?.occurredAt === "string" ? raw.occurredAt : todayIso(),
      images,
      createdAt: typeof raw?.createdAt === "string" ? raw.createdAt : new Date().toISOString()
    };
  }

  function normalizeData(raw) {
    if (!raw || typeof raw !== "object") return defaultData();
    const restaurants = (Array.isArray(raw.restaurants) ? raw.restaurants : []).map(normalizeRestaurant).filter(Boolean);
    const records = (Array.isArray(raw.records) ? raw.records : []).map(normalizeRecord).filter(Boolean);
    return {
      version: STORAGE_VERSION,
      restaurants,
      records,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
    };
  }

  /* ---------- persistence ----------
     local mode  : own localStorage key (default).
     shared (d1) : the same Cloudflare D1 endpoint the ledger uses, through
                   runtime-storage.js, using two shared collections. */

  const SHARED_COLLECTIONS = Object.freeze(["diningRestaurants", "diningRecords"]);

  function createSharedAdapter(persistence = {}) {
    const runtimeStorage = globalThis.TravelRuntimeStorage;
    if (!runtimeStorage?.createAdapter) return null;
    try {
      return runtimeStorage.createAdapter({
        mode: "d1",
        tripId,
        apiBase: persistence.apiBase || "/api/trip",
        collections: [...SHARED_COLLECTIONS]
      });
    } catch (error) {
      console.warn("TravelDining could not start the shared adapter; falling back to local storage.", error);
      return null;
    }
  }

  function snapshotToData(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    return {
      restaurants: snapshot.diningRestaurants,
      records: snapshot.diningRecords,
      updatedAt: snapshot.updatedAt
    };
  }

  function dataToSnapshot() {
    return {
      version: STORAGE_VERSION,
      diningRestaurants: deepClone(data.restaurants),
      diningRecords: deepClone(data.records),
      updatedAt: new Date().toISOString()
    };
  }

  async function readStored() {
    if (adapter) {
      try {
        const parsed = snapshotToData(await adapter.load());
        memorySnapshot = parsed && typeof parsed === "object" ? parsed : null;
        sharedReady = true;
        return memorySnapshot ? deepClone(memorySnapshot) : null;
      } catch (error) {
        // Never treat a read failure as "everything was deleted": block writes
        // until a load succeeds so a transient network error cannot wipe rows.
        sharedReady = false;
        console.warn("TravelDining could not read shared data.", error);
        setNotice("数据读取失败，已暂停写入以免覆盖云端记录，请检查网络后刷新。");
        return null;
      }
    }
    try {
      const raw = globalThis.localStorage?.getItem(storageKey) ?? null;
      if (!raw) return memorySnapshot ? deepClone(memorySnapshot) : null;
      const parsed = JSON.parse(raw);
      memorySnapshot = parsed && typeof parsed === "object" ? parsed : null;
      return memorySnapshot ? deepClone(memorySnapshot) : null;
    } catch (error) {
      console.warn("TravelDining could not read localStorage; using memory for this tab.", error);
      return memorySnapshot ? deepClone(memorySnapshot) : null;
    }
  }

  function persist() {
    data.updatedAt = new Date().toISOString();
    const snapshot = deepClone(data);
    memorySnapshot = snapshot;
    if (adapter) {
      if (!sharedReady) {
        setNotice("本次改动未同步到云端。");
        return;
      }
      adapter.save(dataToSnapshot()).catch((error) => {
        console.warn("TravelDining could not save shared data.", error);
        setNotice("写入云端失败，请检查网络后重试。");
      });
      return;
    }
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("TravelDining could not write localStorage (quota?). Images may be too large.", error);
      setNotice("本地存储写入失败，可能是图片过多；记录仅在本页会话中保留。");
    }
  }

  /* ---------- derived ---------- */

  function cityOptions() {
    const found = new Set(tripCities.filter(Boolean));
    data.restaurants.forEach((restaurant) => restaurant.city && found.add(restaurant.city));
    data.records.forEach((record) => record.city && found.add(record.city));
    return [...found];
  }

  /* 餐饮类型候选：内置类型 + 餐厅明细 / 记录里出现过的值（需求 3②a 下拉来源）。 */
  function cuisineOptions() {
    const found = new Set(CUISINE_TYPES);
    data.restaurants.forEach((restaurant) => restaurant.cuisine && found.add(restaurant.cuisine));
    data.records.forEach((record) => record.cuisine && found.add(record.cuisine));
    return [...found];
  }

  /* 消费类型候选：内置 + 自填 + 餐厅明细里的消费类型。 */
  function spendTypeOptions() {
    const found = new Set(spendTypeSuggestions());
    data.restaurants.forEach((restaurant) => {
      const type = restaurantSpendType(restaurant);
      if (type) found.add(type);
    });
    return [...found];
  }

  /* 筛选值：all（全部）/ checked（打卡）/ starred（收藏）/ 具体城市名。
     打卡、收藏只对餐厅明细有意义；饮食明细只认城市，遇到标记筛选时按「全部记录」处理。 */
  const FLAG_FILTERS = Object.freeze([
    ["all", "全部"],
    ["checked", "打卡"],
    ["starred", "收藏"]
  ]);
  const FLAG_FILTER_NAMES = new Set(FLAG_FILTERS.map(([value]) => value));

  function filteredRestaurants() {
    if (diningFilter === "checked") return data.restaurants.filter((restaurant) => restaurant.checkedIn);
    if (diningFilter === "starred") return data.restaurants.filter((restaurant) => restaurant.starred);
    if (diningFilter === "all") return [...data.restaurants];
    return data.restaurants.filter((restaurant) => restaurant.city === diningFilter);
  }

  function filteredRecords() {
    if (FLAG_FILTER_NAMES.has(diningFilter)) return data.records;
    return data.records.filter((record) => record.city === diningFilter);
  }

  /* 当前筛选的可读名字，用于「合计 / 仅看 … / N 家餐厅」这类文案。 */
  function filterLabel() {
    const flag = FLAG_FILTERS.find(([value]) => value === diningFilter);
    return flag ? flag[1] : diningFilter;
  }

  function filterIsAll() { return diningFilter === "all"; }
  function filterIsFlag() { return FLAG_FILTER_NAMES.has(diningFilter); }

  function totalsByCurrency(records) {
    const totals = new Map();
    records.forEach((record) => {
      const key = record.currency || "CNY";
      totals.set(key, (totals.get(key) || 0) + (Number(record.cost) || 0));
    });
    return [...totals.entries()].sort((first, second) => second[1] - first[1]);
  }

  function setNotice(message) {
    // While the shared layer is down, every notice has to carry the caveat:
    // otherwise a transient "saved" toast would hide that nothing reached D1.
    notice = sharedReady ? message : `共享同步未恢复，改动仅在本页保留；${message}`;
    const live = root?.querySelector(".ledger-live");
    if (live) live.textContent = notice;
  }

  /* ---------- markup ---------- */

  /* 筛选栏：全部 / 打卡 / 收藏 / 各城市。
     对「饮食记录」页签不渲染 —— 那一页只有录入表单，筛选没有意义（2026-09-24 第六轮需求 4b）。 */
  function renderCityNav() {
    if (activeTab === "record") return "";
    const cities = cityOptions();
    const buttons = FLAG_FILTERS
      .map(([value, label]) => `<button type="button" data-dining-city="${value}" aria-pressed="${diningFilter === value}">${label}</button>`)
      .concat(cities.map((city) => `<button type="button" data-dining-city="${escapeAttribute(city)}" aria-pressed="${diningFilter === city}">${escapeHtml(city)}</button>`));
    return `<nav class="dining-city-nav" aria-label="筛选餐厅明细">${buttons.join("")}</nav>`;
  }

  /* 星标（五角星）/ 打卡（月牙）图标。内联 SVG：emoji 在不同系统上字重和颜色不可控。 */
  const STAR_PATH = "M12 2.6l2.92 5.92 6.53.95-4.73 4.61 1.12 6.5L12 17.5l-5.84 3.08 1.12-6.5-4.73-4.61 6.53-.95z";
  const MOON_PATH = "M20.9 13.35A8.9 8.9 0 1 1 10.65 3.1a7.1 7.1 0 0 0 10.25 10.25z";

  function diningFlagButton(restaurant, kind) {
    const on = kind === "star" ? restaurant.starred : restaurant.checkedIn;
    const label = kind === "star" ? "星标" : "打卡";
    const action = kind === "star" ? "toggle-star" : "toggle-checkin";
    return `
      <button type="button" class="dining-flag dining-flag--${kind}${on ? " is-on" : ""}" data-dining-action="${action}" data-dining-id="${escapeAttribute(restaurant.id)}" aria-pressed="${on ? "true" : "false"}" aria-label="${on ? `取消${label}` : `标记${label}`}：${escapeAttribute(restaurant.name)}" title="${label}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${kind === "star" ? STAR_PATH : MOON_PATH}"></path></svg>
      </button>`;
  }

  /* 行内编辑餐厅明细（需求 3①e）。
     老数据把「消费类型」存在 note 里：这种行进入编辑时，消费类型预填 note 值、
     备注留空，保存后 note 迁移到 spendType，不再重复显示。 */
  function renderRestaurantEditor(restaurant) {
    const legacy = !String(restaurant.spendType || "").trim();
    return `
      <form class="dining-restaurant-editor" data-dining-form="restaurant-edit" data-dining-id="${escapeAttribute(restaurant.id)}">
        <div class="dining-grid-2">
          <label class="ledger-field"><span class="ledger-field-label">城市</span><input class="ledger-input" name="city" list="dining-city-list" maxlength="30" value="${escapeAttribute(restaurant.city || "")}"></label>
          <label class="ledger-field"><span class="ledger-field-label">店名</span><input class="ledger-input" name="name" maxlength="60" value="${escapeAttribute(restaurant.name)}" required></label>
          <label class="ledger-field"><span class="ledger-field-label">餐饮类型</span><input class="ledger-input" name="cuisine" list="dining-cuisine-list" maxlength="20" value="${escapeAttribute(restaurant.cuisine || "")}"></label>
          <label class="ledger-field"><span class="ledger-field-label">消费类型</span><input class="ledger-input" name="spendType" list="dining-spend-type-list" maxlength="${MAX_SPEND_TYPE_LENGTH}" value="${escapeAttribute(restaurantSpendType(restaurant))}"></label>
          <label class="ledger-field"><span class="ledger-field-label">人均 <small>选填</small></span><input class="ledger-input" name="priceLevel" maxlength="20" value="${escapeAttribute(restaurant.priceLevel || "")}"></label>
          <label class="ledger-field"><span class="ledger-field-label">备注 <small>选填</small></span><input class="ledger-input" name="note" maxlength="160" value="${escapeAttribute(legacy ? "" : restaurant.note || "")}"></label>
        </div>
        <p class="ledger-form-error" data-dining-form-error role="alert"></p>
        <div class="dining-restaurant-editor__actions">
          <button class="ledger-primary-button" type="submit">保存修改</button>
          <button class="ledger-text-button" type="button" data-dining-action="cancel-restaurant-edit">取消</button>
        </div>
      </form>`;
  }

  /* 餐厅明细一行：行首两列（星标 / 打卡），中间三行（城市 / 店名 / 消费类型·餐饮类型）。
     城市与店名同号，第三行小一号；不再显示来源（导入 / 手动 / 行程）标识。 */
  function renderRestaurantRow(restaurant) {
    if (editingRestaurantId === restaurant.id) {
      return `
        <article class="ledger-bill-row dining-row dining-row--editing" data-dining-restaurant-id="${escapeAttribute(restaurant.id)}">
          ${renderRestaurantEditor(restaurant)}
        </article>`;
    }
    const tags = [restaurantSpendType(restaurant), restaurant.cuisine].filter(Boolean).join(" · ");
    return `
      <article class="ledger-bill-row dining-row" data-dining-restaurant-id="${escapeAttribute(restaurant.id)}">
        <div class="dining-row__body">
          <div class="dining-row__flags">
            ${diningFlagButton(restaurant, "star")}
            ${diningFlagButton(restaurant, "moon")}
          </div>
          <div class="ledger-bill-main">
            <div class="ledger-bill-title-row">
              <span class="dining-mark" data-dining-cuisine="${escapeAttribute(restaurant.cuisine || "其他")}" aria-hidden="true"></span>
              <div>
                <p class="dining-row__city">${escapeHtml(restaurant.city || "未填写城市")}</p>
                <h3 class="dining-row__name">${escapeHtml(restaurant.name)}</h3>
                ${tags ? `<p class="dining-row__tags">${escapeHtml(tags)}</p>` : ""}
              </div>
            </div>
            ${restaurant.priceLevel ? `<div class="ledger-bill-amount"><strong>${escapeHtml(restaurant.priceLevel)}</strong></div>` : ""}
          </div>
        </div>
        <div class="ledger-row-actions">
          <button class="ledger-text-button" type="button" data-dining-action="use-restaurant" data-dining-id="${escapeAttribute(restaurant.id)}">用它记一笔</button>
          <button class="ledger-text-button" type="button" data-dining-action="edit-restaurant" data-dining-id="${escapeAttribute(restaurant.id)}">编辑</button>
          <button class="ledger-text-button ledger-danger-button" type="button" data-dining-action="delete-restaurant" data-dining-id="${escapeAttribute(restaurant.id)}">删除</button>
        </div>
      </article>`;
  }

  function renderRestaurantsPanel() {
    /* 筛选栏现在真的作用于餐厅明细了（此前只筛记录，点城市没有任何反应）。 */
    const restaurants = [...filteredRestaurants()].sort((first, second) =>
      (first.city || "").localeCompare(second.city || "", "zh-CN") || first.name.localeCompare(second.name, "zh-CN"));
    return `
      <section class="ledger-tab-panel" data-dining-panel="restaurants" role="tabpanel" aria-labelledby="dining-restaurants-tab" ${activeTab === "restaurants" ? "" : "hidden"}>
        <section class="ledger-list-section" aria-labelledby="dining-restaurant-list-title">
          <div class="ledger-section-heading ledger-list-heading">
            <div>
              <p class="ledger-section-kicker">餐厅明细</p>
              <h2 id="dining-restaurant-list-title">${restaurants.length
                ? `${restaurants.length} 家餐厅${filterIsAll() ? "" : ` · ${escapeHtml(filterLabel())}`}`
                : (filterIsAll() ? "还没有餐厅" : `没有${escapeHtml(filterLabel())}的餐厅`)}</h2>
            </div>
          </div>
          ${restaurants.length
            ? `<div class="ledger-bill-list">${restaurants.map(renderRestaurantRow).join("")}</div>`
            : `<div class="ledger-empty-state"><p>${filterIsAll() ? "导入或手动添加餐厅后，会显示在这里。" : "换个筛选条件看看，或者先给餐厅打上标记。"}</p></div>`}
        </section>

        <section class="ledger-entry-card" aria-labelledby="dining-add-restaurant-title">
          <div class="ledger-section-heading">
            <div>
              <p class="ledger-section-kicker">手动添加</p>
              <h2 id="dining-add-restaurant-title">新增一家餐厅</h2>
            </div>
          </div>
          <form class="ledger-bill-form" data-dining-form="restaurant" novalidate>
            <div class="dining-grid-2">
              <label class="ledger-field">
                <span class="ledger-field-label">城市</span>
                <input class="ledger-input" name="city" list="dining-city-list" maxlength="30" placeholder="皇后镇">
              </label>
              <label class="ledger-field">
                <span class="ledger-field-label">店名</span>
                <input class="ledger-input" name="name" maxlength="60" placeholder="Fergburger" required>
              </label>
              <label class="ledger-field">
                <span class="ledger-field-label">餐饮类型</span>
                <input class="ledger-input" name="cuisine" list="dining-cuisine-list" maxlength="20" placeholder="快餐">
              </label>
              <label class="ledger-field">
                <span class="ledger-field-label">消费类型</span>
                <input class="ledger-input" name="spendType" list="dining-spend-type-list" maxlength="${MAX_SPEND_TYPE_LENGTH}" placeholder="正餐">
              </label>
              <label class="ledger-field">
                <span class="ledger-field-label">人均 <small>选填</small></span>
                <input class="ledger-input" name="priceLevel" maxlength="20" placeholder="NZ$18">
              </label>
              <label class="ledger-field">
                <span class="ledger-field-label">备注 <small>选填</small></span>
                <input class="ledger-input" name="note" maxlength="160" placeholder="必点 / 位置 / 营业时间">
              </label>
            </div>
            <p class="ledger-form-error" data-dining-form-error role="alert"></p>
            <button class="ledger-primary-button" type="submit">添加餐厅</button>
          </form>
        </section>

        <section class="ledger-entry-card" aria-labelledby="dining-import-title">
          <div class="ledger-section-heading">
            <div>
              <p class="ledger-section-kicker">预备清单</p>
              <h2 id="dining-import-title">导入餐厅清单</h2>
            </div>
            <button class="ledger-text-button" type="button" data-dining-action="import-from-trip">从行程导入用餐点</button>
          </div>
          <form class="ledger-bill-form" data-dining-form="import" novalidate>
            <label class="ledger-field">
              <span class="ledger-field-label">每行一条 <small>城市, 店名, 餐饮类型, 人均, 备注</small></span>
              <textarea class="ledger-input dining-textarea" name="bulk" rows="4" placeholder="皇后镇, Fergburger, 快餐, NZ$18, 网红汉堡&#10;奥克兰, Depot, 新西兰本地, NZ$40"></textarea>
            </label>
            <p class="ledger-form-error" data-dining-form-error role="alert"></p>
            <button class="ledger-primary-button" type="submit">导入清单</button>
          </form>
          <p class="dining-hint">也支持粘贴 JSON 数组，例如 <code>[{"city":"皇后镇","name":"Fergburger","cuisine":"快餐"}]</code>。</p>
        </section>
      </section>`;
  }

  function renderRecordForm() {
    const editing = editingRecordId ? data.records.find((record) => record.id === editingRecordId) : null;
    const source = editing || draft;
    const images = editing ? editing.images || [] : draft.images || [];
    return `
      <section class="ledger-entry-card" aria-labelledby="dining-record-form-title">
        <div class="ledger-section-heading">
          <div>
            <p class="ledger-section-kicker">${editing ? "编辑记录" : "记一笔"}</p>
            <h2 id="dining-record-form-title">${editing ? "修改这条饮食记录" : "记录这次用餐"}</h2>
          </div>
          ${editing ? `<button class="ledger-text-button" type="button" data-dining-action="cancel-edit">取消编辑</button>` : ""}
        </div>
        <form class="ledger-bill-form" data-dining-form="record" novalidate>
          <div class="dining-grid-2">
            <label class="ledger-field">
              <span class="ledger-field-label">城市</span>
              <input class="ledger-input" name="city" list="dining-city-list" maxlength="30" placeholder="皇后镇" value="${escapeAttribute(source.city || "")}">
            </label>
            <label class="ledger-field">
              <span class="ledger-field-label">日期</span>
              <input class="ledger-input" type="date" name="occurredAt" value="${escapeAttribute(source.occurredAt || todayIso())}">
            </label>
            <label class="ledger-field">
              <span class="ledger-field-label">消费类型</span>
              <input class="ledger-input" name="spendType" list="dining-spend-type-list" maxlength="${MAX_SPEND_TYPE_LENGTH}" placeholder="正餐" value="${escapeAttribute(source.spendType || "")}">
            </label>
            <label class="ledger-field">
              <span class="ledger-field-label">餐饮类型</span>
              <input class="ledger-input" name="cuisine" list="dining-cuisine-list" maxlength="20" placeholder="日料" value="${escapeAttribute(source.cuisine || "")}">
            </label>
          </div>
          <label class="ledger-field dining-field-block">
            <span class="ledger-field-label">店名</span>
            <input class="ledger-input" name="name" list="dining-restaurant-list" maxlength="60" placeholder="寿司郎天虹龙华店" value="${escapeAttribute(source.name || "")}" required>
          </label>

          <fieldset class="ledger-fieldset">
            <legend class="ledger-field-label">评价</legend>
            <div class="ledger-category-grid">
              ${RATING_OPTIONS.map(([value, label]) => `
                <label class="ledger-category-choice">
                  <input class="ledger-category-input" type="radio" name="rating" value="${value}" ${String(source.rating ?? "0") === value ? "checked" : ""}>
                  <span>${escapeHtml(label)}</span>
                </label>`).join("")}
            </div>
          </fieldset>

          <div class="ledger-amount-block dining-amount-block">
            <label class="ledger-field">
              <span class="ledger-field-label">币种</span>
              <select class="ledger-select" name="currency">
                ${CURRENCIES.map(([code]) => `<option value="${code}" ${source.currency === code ? "selected" : ""}>${code}</option>`).join("")}
              </select>
            </label>
            <label class="ledger-field ledger-field-amount">
              <span class="ledger-field-label">花费</span>
              <input class="ledger-amount-input" name="cost" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${escapeAttribute(source.cost === 0 || source.cost ? source.cost : "")}">
            </label>
          </div>

          <label class="ledger-field dining-field-block">
            <span class="ledger-field-label">备注 <small>选填</small></span>
            <input class="ledger-input" name="note" maxlength="160" placeholder="味道 / 推荐菜 / 排队情况" value="${escapeAttribute(source.note || "")}">
          </label>

          <div class="ledger-fieldset dining-upload-field">
            <span class="ledger-field-label">图片 <small>选填，最多 ${MAX_IMAGES} 张</small></span>
            <label class="dining-upload">
              <input type="file" accept="image/*" multiple data-dining-field="images">
              <span class="dining-upload__icon" aria-hidden="true">＋</span>
              <span class="dining-upload__text">点击选择或拖入图片，自动压缩后保存在本机</span>
            </label>
            <div class="dining-thumbs" data-dining-thumbs>
              ${images.map((image, index) => `
                <span class="dining-thumb">
                  <img src="${escapeAttribute(image)}" alt="记录图片 ${index + 1}">
                  <button type="button" data-dining-action="remove-image" data-dining-index="${index}" aria-label="移除图片 ${index + 1}">×</button>
                </span>`).join("")}
            </div>
          </div>

          <p class="ledger-form-error" data-dining-form-error role="alert"></p>
          <button class="ledger-primary-button" type="submit">${editing ? "保存修改" : "保存记录"}</button>
        </form>
      </section>`;
  }

  function renderRecordRow(record) {
    const thumb = (record.images || [])[0];
    return `
      <article class="ledger-bill-row dining-row" data-dining-record-id="${escapeAttribute(record.id)}">
        <div class="ledger-bill-main">
          <div class="ledger-bill-title-row">
            <span class="ledger-category-mark" data-dining-spend="${escapeAttribute(record.spendType)}" aria-hidden="true"></span>
            <div>
              <h3>${escapeHtml(record.name || record.spendType)}</h3>
              <p class="ledger-bill-date">${escapeHtml([record.city, record.spendType, record.cuisine].filter(Boolean).join(" · "))}</p>
              <p class="dining-row__meta"><span class="dining-row__stars">${escapeHtml(stars(record.rating))}</span>${record.note ? ` · ${escapeHtml(record.note)}` : ""}</p>
            </div>
          </div>
          <div class="ledger-bill-amount">
            <strong>${escapeHtml(formatMoney(record.cost, record.currency))}</strong>
            ${record.occurredAt ? `<span>${escapeHtml(formatDate(record.occurredAt))}</span>` : ""}
          </div>
        </div>
        ${thumb ? `<div class="dining-row__thumbs">${(record.images || []).map((image, index) => `<button type="button" class="dining-thumb dining-thumb--sm" data-dining-action="view-image" data-dining-id="${escapeAttribute(record.id)}" data-dining-index="${index}" aria-label="查看图片 ${index + 1}"><img src="${escapeAttribute(image)}" alt=""></button>`).join("")}</div>` : ""}
        <div class="ledger-row-actions">
          <button class="ledger-text-button" type="button" data-dining-action="edit-record" data-dining-id="${escapeAttribute(record.id)}">编辑</button>
          <button class="ledger-text-button ledger-danger-button" type="button" data-dining-action="delete-record" data-dining-id="${escapeAttribute(record.id)}">删除</button>
        </div>
      </article>`;
  }

  function renderRecordPanel() {
    return `
      <section class="ledger-tab-panel" data-dining-panel="record" role="tabpanel" aria-labelledby="dining-record-tab" ${activeTab === "record" ? "" : "hidden"}>
        ${renderRecordForm()}
      </section>`;
  }

  /* 已提交记录：原属「饮食记录」页签，现移到「饮食明细」页签下方（需求 3②c），
     条数 / 合计 / 编辑 / 删除等规则保持不变。 */
  function renderSubmittedRecords() {
    const records = [...filteredRecords()].sort((first, second) =>
      String(second.occurredAt || second.createdAt).localeCompare(String(first.occurredAt || first.createdAt)));
    return `
      <section class="ledger-list-section" aria-labelledby="dining-record-list-title">
        <div class="ledger-section-heading ledger-list-heading">
          <div>
            <p class="ledger-section-kicker">已提交记录</p>
            <h2 id="dining-record-list-title">${records.length ? `${records.length} 条记录` : "还没有记录"}</h2>
          </div>
          <div class="ledger-list-total">
            <span>${filterIsAll() ? "合计" : escapeHtml(filterLabel())}</span>
            <strong>${escapeHtml(totalsByCurrency(records).map(([code, sum]) => formatMoney(sum, code)).join(" · ") || formatMoney(0, "CNY"))}</strong>
          </div>
        </div>
        ${records.length
          ? `<div class="ledger-bill-list">${records.map(renderRecordRow).join("")}</div>`
          : `<div class="ledger-empty-state"><p>记下第一笔用餐后，记录会显示在这里。</p></div>`}
      </section>`;
  }

  function renderBreakdownPanel() {
    const records = filteredRecords();
    const totals = totalsByCurrency(records);
    const rated = records.filter((record) => record.rating > 0);
    const averageRating = rated.length ? (rated.reduce((sum, record) => sum + record.rating, 0) / rated.length).toFixed(1) : "—";
    /* Built-in types keep their canonical order; custom ones trail alphabetically
       so a newly typed type still gets its own group instead of vanishing. */
    const present = [...new Set(records.map((record) => String(record.spendType || "").trim()).filter(Boolean))];
    const orderedTypes = [
      ...SPEND_TYPES.filter((type) => present.includes(type)),
      ...present.filter((type) => !SPEND_TYPES.includes(type)).sort((first, second) => first.localeCompare(second, "zh-CN"))
    ];
    const groups = orderedTypes.map((type) => ({
      type,
      records: records.filter((record) => record.spendType === type)
        .sort((first, second) => String(second.occurredAt).localeCompare(String(first.occurredAt)))
    })).filter((group) => group.records.length);
    return `
      <section class="ledger-tab-panel" data-dining-panel="breakdown" role="tabpanel" aria-labelledby="dining-breakdown-tab" ${activeTab === "breakdown" ? "" : "hidden"}>
        <section class="ledger-stats-overview" aria-labelledby="dining-total-title">
          <p class="ledger-section-kicker">饮食明细</p>
          <h2 id="dining-total-title">${escapeHtml(totals.map(([code, sum]) => formatMoney(sum, code)).join(" · ") || formatMoney(0, "CNY"))}</h2>
          <span>${records.length} 条记录 · 平均评价 ${escapeHtml(averageRating)}${filterIsAll() || filterIsFlag() ? "" : ` · 仅看 ${escapeHtml(diningFilter)}`}</span>
        </section>

        ${groups.length ? groups.map((group) => {
          const subtotal = totalsByCurrency(group.records).map(([code, sum]) => formatMoney(sum, code)).join(" · ");
          return `
            <section class="ledger-settlement-section" aria-labelledby="dining-group-${escapeAttribute(group.type)}">
              <div class="ledger-section-heading">
                <div>
                  <p class="ledger-section-kicker">消费类型</p>
                  <h2 id="dining-group-${escapeAttribute(group.type)}">${escapeHtml(group.type)}</h2>
                </div>
                <span class="ledger-soft-count">${group.records.length} 条 · ${escapeHtml(subtotal)}</span>
              </div>
              <div class="ledger-transfer-list dining-group-list">
                ${group.records.map((record) => `
                  <div class="dining-group-row">
                    <div class="dining-group-row__main">
                      <strong>${escapeHtml(record.name || record.spendType)}</strong>
                      <small>${escapeHtml([record.city, record.cuisine, formatDate(record.occurredAt)].filter(Boolean).join(" · "))}</small>
                    </div>
                    <span class="dining-group-row__stars" aria-label="评价 ${escapeAttribute(stars(record.rating))}">${escapeHtml(stars(record.rating))}</span>
                    <strong class="ledger-transfer-amount">${escapeHtml(formatMoney(record.cost, record.currency))}</strong>
                  </div>`).join("")}
              </div>
            </section>`;
        }).join("") : `<div class="ledger-empty-state"><p>${filterIsAll() || filterIsFlag() ? "添加饮食记录后，这里会按消费类型汇总。" : `${escapeHtml(diningFilter)} 还没有饮食记录。`}</p></div>`}

        ${renderSubmittedRecords()}
      </section>`;
  }

  function renderApp() {
    if (!root || !data) return;
    root.innerHTML = `
      <div class="ledger-app dining-app" data-dining-trip-id="${escapeAttribute(tripId)}">
        <header class="ledger-page-header">
          <h1>旅行餐饮</h1>
          <div class="ledger-header-actions">
            <button class="ledger-icon-button" type="button" data-dining-action="export" aria-label="导出餐饮数据">导出</button>
          </div>
        </header>
        <nav class="ledger-tabs" role="tablist" aria-label="餐饮页面">
          <button id="dining-restaurants-tab" class="ledger-tab ${activeTab === "restaurants" ? "ledger-is-active" : ""}" type="button" role="tab" aria-selected="${activeTab === "restaurants"}" data-dining-action="set-tab" data-dining-tab="restaurants">餐厅明细</button>
          <button id="dining-record-tab" class="ledger-tab ${activeTab === "record" ? "ledger-is-active" : ""}" type="button" role="tab" aria-selected="${activeTab === "record"}" data-dining-action="set-tab" data-dining-tab="record">饮食记录</button>
          <button id="dining-breakdown-tab" class="ledger-tab ${activeTab === "breakdown" ? "ledger-is-active" : ""}" type="button" role="tab" aria-selected="${activeTab === "breakdown"}" data-dining-action="set-tab" data-dining-tab="breakdown">饮食明细</button>
        </nav>
        ${renderCityNav()}
        <div class="ledger-live" role="status" aria-live="polite">${escapeHtml(notice)}</div>
        <datalist id="dining-city-list">${cityOptions().map((city) => `<option value="${escapeAttribute(city)}"></option>`).join("")}</datalist>
        <datalist id="dining-cuisine-list">${cuisineOptions().map((cuisine) => `<option value="${escapeAttribute(cuisine)}"></option>`).join("")}</datalist>
        <datalist id="dining-spend-type-list">${spendTypeOptions().map((type) => `<option value="${escapeAttribute(type)}"></option>`).join("")}</datalist>
        <datalist id="dining-restaurant-list">${data.restaurants.map((restaurant) => `<option value="${escapeAttribute(restaurant.name)}"></option>`).join("")}</datalist>
        ${renderRestaurantsPanel()}
        ${renderRecordPanel()}
        ${renderBreakdownPanel()}
      </div>`;
  }

  /* ---------- images ---------- */

  async function compressImage(file) {
    const bitmap = await loadBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
    }
    if (typeof bitmap.close === "function") bitmap.close();
    return canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
  }

  function loadBitmap(file) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file).catch(() => loadImageElement(file));
    }
    return loadImageElement(file);
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
      image.src = url;
    });
  }

  async function attachImages(files) {
    const existing = (editingRecordId ? (data.records.find((record) => record.id === editingRecordId)?.images || []) : draft.images) || [];
    let images = [...existing];
    for (const file of files) {
      if (images.length >= MAX_IMAGES) { setNotice(`最多保存 ${MAX_IMAGES} 张图片。`); break; }
      try {
        images.push(await compressImage(file));
      } catch (error) {
        console.warn("TravelDining image import failed", error);
        setNotice("有图片无法读取，已跳过。");
      }
    }
    images = images.slice(0, MAX_IMAGES);
    if (editingRecordId) {
      mutateRecord(editingRecordId, { images });
      renderApp();
    } else {
      draft.images = images;
      renderApp();
    }
  }

  function currentImages() {
    return (editingRecordId ? (data.records.find((record) => record.id === editingRecordId)?.images || []) : draft.images) || [];
  }

  /* ---------- mutations ---------- */

  function mutateRecord(id, patch) {
    const index = data.records.findIndex((record) => record.id === id);
    if (index < 0) return;
    data.records[index] = normalizeRecord({ ...data.records[index], ...patch });
    persist();
  }

  function captureDraft(form) {
    if (!form || editingRecordId) return;
    const read = (name) => form.querySelector(`[name="${name}"]`)?.value ?? "";
    draft = {
      ...draft,
      city: read("city").trim(),
      spendType: read("spendType") || "正餐",
      name: read("name").trim(),
      cuisine: read("cuisine").trim(),
      rating: form.querySelector('[name="rating"]:checked')?.value || "0",
      cost: read("cost").trim(),
      currency: read("currency") || "CNY",
      note: read("note").trim(),
      occurredAt: read("occurredAt") || todayIso()
    };
  }

  function saveRecord(form) {
    const errorNode = form.querySelector("[data-dining-form-error]");
    const read = (name) => form.querySelector(`[name="${name}"]`)?.value ?? "";
    const name = read("name").trim();
    if (!name) {
      if (errorNode) errorNode.textContent = "请填写店名。";
      return;
    }
    const images = currentImages();
    const record = normalizeRecord({
      id: editingRecordId || makeId("meal"),
      city: read("city").trim(),
      spendType: read("spendType") || "正餐",
      name,
      cuisine: read("cuisine").trim(),
      rating: form.querySelector('[name="rating"]:checked')?.value || "0",
      cost: read("cost").replace(/[^0-9.]/g, ""),
      currency: read("currency") || "CNY",
      note: read("note").trim(),
      occurredAt: read("occurredAt") || todayIso(),
      images,
      createdAt: editingRecordId ? data.records.find((item) => item.id === editingRecordId)?.createdAt : new Date().toISOString()
    });
    const wasEditing = Boolean(editingRecordId);
    if (wasEditing) {
      const index = data.records.findIndex((item) => item.id === editingRecordId);
      data.records[index] = record;
      editingRecordId = "";
    } else {
      data.records.push(record);
    }
    const linked = linkRecordToRestaurant(record);
    setNotice(wasEditing
      ? "已保存修改。"
      : linked ? `已记录一笔用餐，并勾选「${linked}」的打卡。` : "已记录一笔用餐。");
    draft = emptyDraft();
    draft.city = record.city;
    persist();
    renderApp();
  }

  /* 需求 3②b：提交用餐记录时同步餐厅明细 ——
     已有这家店就勾上打卡；没有就按记录里的城市 / 消费类型 / 餐饮类型 / 店名新增一家并勾上打卡。
     返回匹配到的店名（用于提示文案），没匹配上返回空串。 */
  function linkRecordToRestaurant(record) {
    if (!record?.name) return "";
    const existing = findRestaurant({ city: record.city, name: record.name });
    if (existing) {
      const index = data.restaurants.findIndex((item) => item.id === existing.id);
      if (index < 0) return existing.name;
      const patch = { ...existing, checkedIn: true };
      /* 只在餐厅侧缺字段时补齐，不覆盖用户已经填好的内容。 */
      if (!patch.city && record.city) patch.city = record.city;
      if (!patch.cuisine && record.cuisine) patch.cuisine = record.cuisine;
      if (!patch.spendType && !patch.note && record.spendType) patch.spendType = record.spendType;
      data.restaurants[index] = normalizeRestaurant(patch);
      return existing.name;
    }
    const created = normalizeRestaurant({
      city: record.city, name: record.name, cuisine: record.cuisine,
      spendType: record.spendType, checkedIn: true, source: "记录"
    });
    if (!created) return "";
    data.restaurants.push(created);
    return created.name;
  }

  function parseRestaurantImport(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.map((item, index) => normalizeRestaurant(item, index)).filter(Boolean) : [];
      } catch (error) {
        console.warn("TravelDining JSON import failed", error);
        return [];
      }
    }
    return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/[,，\t|]/).map((part) => part.trim());
      return normalizeRestaurant({
        city: parts[0], name: parts[1], cuisine: parts[2], priceLevel: parts[3], note: parts[4], source: "导入"
      });
    }).filter(Boolean);
  }

  /* Map a day to a real city name: "香港西九龙" -> "香港". */
  function cityForDay(day) {
    const locations = (day.locations || []).filter(Boolean);
    for (const location of locations) {
      const match = tripCities.find((city) => city && location.includes(city));
      if (match) return match;
    }
    return locations[0] || "";
  }

  function importFromTrip() {
    const found = [];
    tripDays.forEach((day) => {
      const city = cityForDay(day);
      (day.schedule || []).forEach((item) => {
        if (item.type !== "restaurant" && !/餐|咖啡|食/.test(item.text || "")) return;
        const name = String(item.text || "").replace(/（.*?）/g, "").trim();
        if (!name) return;
        found.push(normalizeRestaurant({ city, name, cuisine: "", note: `DAY ${day.day} ${item.time}`, source: "行程" }));
      });
    });
    if (!found.length) { setNotice("行程中未找到用餐点。"); return; }
    const existing = new Set(data.restaurants.map((restaurant) => `${restaurant.city}|${restaurant.name}`));
    const fresh = found.filter((restaurant) => !existing.has(`${restaurant.city}|${restaurant.name}`));
    if (!fresh.length) { setNotice("行程中的用餐点都已在清单里。"); return; }
    data.restaurants.push(...fresh);
    persist();
    setNotice(`已从行程导入 ${fresh.length} 个用餐点。`);
    renderApp();
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `dining-${tripId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("已导出餐饮数据 JSON。");
  }

  /* ---------- events ---------- */

  function handleClick(event) {
    const cityButton = event.target.closest("[data-dining-city]");
    if (cityButton) {
      diningFilter = cityButton.dataset.diningCity;
      renderApp();
      return;
    }

    const actionButton = event.target.closest("[data-dining-action]");
    if (!actionButton) return;
    const action = actionButton.dataset.diningAction;
    const id = actionButton.dataset.diningId || "";

    if (action === "set-tab") {
      const next = ["restaurants", "record", "breakdown"].includes(actionButton.dataset.diningTab) ? actionButton.dataset.diningTab : "restaurants";
      if (next !== "record") editingRecordId = "";
      if (next !== "restaurants") editingRestaurantId = "";
      activeTab = next;
      renderApp();
      return;
    }
    /* 星标 / 打卡：点击即切换并写回共享层（需求 3①d）。 */
    if (action === "toggle-star" || action === "toggle-checkin") {
      const index = data.restaurants.findIndex((item) => item.id === id);
      if (index < 0) return;
      const field = action === "toggle-star" ? "starred" : "checkedIn";
      const restaurant = data.restaurants[index];
      data.restaurants[index] = normalizeRestaurant({ ...restaurant, [field]: !restaurant[field] });
      persist();
      renderApp();
      return;
    }
    if (action === "edit-restaurant") {
      editingRestaurantId = editingRestaurantId === id ? "" : id;
      renderApp();
      return;
    }
    if (action === "cancel-restaurant-edit") {
      editingRestaurantId = "";
      renderApp();
      return;
    }
    if (action === "use-restaurant") {
      const restaurant = data.restaurants.find((item) => item.id === id);
      if (!restaurant) return;
      editingRecordId = "";
      draft = { ...emptyDraft(), city: restaurant.city, name: restaurant.name, cuisine: restaurant.cuisine, spendType: restaurantSpendType(restaurant) || "正餐" };
      activeTab = "record";
      setNotice(`已带上「${restaurant.name}」，补充花费后保存。`);
      renderApp();
      return;
    }
    if (action === "delete-restaurant") {
      data.restaurants = data.restaurants.filter((item) => item.id !== id);
      persist();
      setNotice("已删除餐厅。");
      renderApp();
      return;
    }
    if (action === "edit-record") {
      const record = data.records.find((item) => item.id === id);
      if (!record) return;
      editingRecordId = id;
      activeTab = "record";
      renderApp();
      return;
    }
    if (action === "cancel-edit") {
      editingRecordId = "";
      draft = emptyDraft();
      renderApp();
      return;
    }
    if (action === "delete-record") {
      data.records = data.records.filter((item) => item.id !== id);
      if (editingRecordId === id) editingRecordId = "";
      persist();
      setNotice("已删除记录。");
      renderApp();
      return;
    }
    if (action === "remove-image") {
      const index = Number(actionButton.dataset.diningIndex);
      const images = currentImages().filter((_, position) => position !== index);
      if (editingRecordId) mutateRecord(editingRecordId, { images });
      else draft.images = images;
      renderApp();
      return;
    }
    if (action === "view-image") {
      const record = data.records.find((item) => item.id === id);
      const image = record?.images?.[Number(actionButton.dataset.diningIndex)];
      if (image) openImageViewer(image);
      return;
    }
    if (action === "import-from-trip") { importFromTrip(); return; }
    if (action === "export") { exportData(); return; }
  }

  function openImageViewer(image) {
    const overlay = document.createElement("div");
    overlay.className = "dining-viewer";
    overlay.innerHTML = `<button type="button" class="dining-viewer__close" aria-label="关闭">×</button><img src="${escapeAttribute(image)}" alt="饮食记录图片">`;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest(".dining-viewer__close")) overlay.remove();
    });
    document.body.append(overlay);
  }

  function handleSubmit(event) {
    const form = event.target.closest("[data-dining-form]");
    if (!form) return;
    event.preventDefault();
    const errorNode = form.querySelector("[data-dining-form-error]");
    if (errorNode) errorNode.textContent = "";
    const kind = form.dataset.diningForm;

    if (kind === "import") {
      const restaurants = parseRestaurantImport(form.querySelector('[name="bulk"]')?.value || "");
      if (!restaurants.length) {
        if (errorNode) errorNode.textContent = "没有解析到餐厅，请检查格式（城市, 店名, 餐饮类型…）。";
        return;
      }
      data.restaurants.push(...restaurants);
      persist();
      setNotice(`已导入 ${restaurants.length} 家餐厅。`);
      renderApp();
      return;
    }

    if (kind === "restaurant") {
      const read = (name) => form.querySelector(`[name="${name}"]`)?.value || "";
      const restaurant = normalizeRestaurant({
        city: read("city"), name: read("name"), cuisine: read("cuisine"),
        spendType: read("spendType"), priceLevel: read("priceLevel"), note: read("note"), source: "手动"
      });
      if (!restaurant) {
        if (errorNode) errorNode.textContent = "请填写店名。";
        return;
      }
      data.restaurants.push(restaurant);
      persist();
      setNotice("已添加餐厅。");
      renderApp();
      return;
    }

    /* 行内编辑餐厅明细：保留 id / 星标 / 打卡等未在表单里的字段。 */
    if (kind === "restaurant-edit") {
      const index = data.restaurants.findIndex((item) => item.id === (form.dataset.diningId || ""));
      if (index < 0) return;
      const read = (name) => form.querySelector(`[name="${name}"]`)?.value || "";
      const updated = normalizeRestaurant({
        ...data.restaurants[index],
        city: read("city"), name: read("name"), cuisine: read("cuisine"),
        spendType: read("spendType"), priceLevel: read("priceLevel"), note: read("note")
      });
      if (!updated) {
        if (errorNode) errorNode.textContent = "请填写店名。";
        return;
      }
      data.restaurants[index] = updated;
      editingRestaurantId = "";
      persist();
      setNotice("已保存餐厅修改。");
      renderApp();
      return;
    }

    if (kind === "record") saveRecord(form);
  }

  function handleChange(event) {
    const fileInput = event.target.closest('[data-dining-field="images"]');
    if (fileInput) {
      const files = [...(fileInput.files || [])];
      if (files.length) void attachImages(files);
      return;
    }
    const form = event.target.closest('[data-dining-form="record"]');
    if (form) {
      if (event.target.closest('[name="name"]')) autofillFromRestaurantName(form);
      captureDraft(form);
    }
  }

  function handleInput(event) {
    const form = event.target.closest('[data-dining-form="record"]');
    if (!form) return;
    /* 只在改「店名」时联动，避免用户手改城市 / 消费类型时被反复覆盖回原值。 */
    if (event.target.closest('[name="name"]')) autofillFromRestaurantName(form);
    captureDraft(form);
  }

  /* 需求 3②a：店名与餐厅明细里的某家店一致时，自动带出城市 / 消费类型 / 餐饮类型。
     三个字段仍是普通可编辑输入框，不是强制关联。 */
  function autofillFromRestaurantName(form) {
    const nameField = form.querySelector('[name="name"]');
    if (!nameField) return;
    const restaurant = findRestaurant({
      name: nameField.value,
      city: form.querySelector('[name="city"]')?.value || ""
    });
    if (!restaurant) return;
    const apply = (fieldName, value) => {
      const field = form.querySelector(`[name="${fieldName}"]`);
      if (field && value && field.value !== value) field.value = value;
    };
    apply("city", restaurant.city);
    apply("spendType", restaurantSpendType(restaurant));
    apply("cuisine", restaurant.cuisine);
  }

  /* ---------- init ---------- */

  async function init(options = {}) {
    const requestedRoot = typeof options.root === "string"
      ? document.querySelector(options.root)
      : options.root || document.querySelector("#dining-root");
    if (!requestedRoot) return null;
    if (initialized && requestedRoot === root) return deepClone(data);

    root = requestedRoot;
    tripId = String(options.tripId || "default-trip");
    storageKey = `travel-plan:dining:v1:${encodeURIComponent(tripId)}`;
    if (Array.isArray(options.cities) && options.cities.length) tripCities = options.cities.map(String);
    if (Array.isArray(options.days)) tripDays = options.days;
    adapter = options.persistence?.mode === "d1" ? createSharedAdapter(options.persistence) : null;
    sharedReady = !adapter;

    data = normalizeData(await readStored());
    root.addEventListener("click", handleClick);
    root.addEventListener("submit", handleSubmit);
    root.addEventListener("change", handleChange);
    root.addEventListener("input", handleInput);
    initialized = true;
    renderApp();
    return deepClone(data);
  }

  const publicApi = {
    init,
    setActiveTab(tab) {
      const next = ["restaurants", "record", "breakdown"].includes(tab) ? tab : "restaurants";
      if (next !== "record") editingRecordId = "";
      if (next !== "restaurants") editingRestaurantId = "";
      activeTab = next;
      if (data) renderApp();
    },
    getSnapshot() { return data ? deepClone(data) : null; },
    getStorageKey() { return storageKey; },
    getPersistenceMode() { return adapter ? "d1" : "local"; },
    getSharedCollections() { return adapter ? [...SHARED_COLLECTIONS] : []; }
  };
  if (typeof module === "object" && module.exports) module.exports = publicApi;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  window.TravelDining = publicApi;
})();
