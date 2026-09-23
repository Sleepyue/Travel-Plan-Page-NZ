const state = {
  data: null,
  config: null,
  runtimeAdapters: {},
  /* 每日行程：默认全部展开，collapsedDays 只记录被手动收起的天；
     itineraryView 为 "all"（总览）或具体天号（单天查看按键）。 */
  collapsedDays: new Set(),
  itineraryView: "all",
  editingScheduleId: null,
  countdownTimer: null,
  purchasedTickets: new Set(),
  todos: [],
  todoFilter: "all",
  /* 责任人视角：all（全部）/ p1 / p2。切到某人时只列出他负责的和「共同」的项。 */
  todoOwnerView: "all",
  prepNameListenerBound: false,
  /* Shared itinerary edits, one record per `${day}::${itemId}`. Authored
     days[].schedule in trip-data.json stays the baseline; these overlay it. */
  itinerary: [],
  /* 航班覆盖层：trip-data.json 的 flights[] 是权威基线，这里按航班 id 存增量覆盖。
     与 itinerary 同构：删掉记录即回到基线，因此不需要墓碑。 */
  flights: [],
  editingFlightId: null,
  /* 天气基线（trip-data.json 原始预报）与上次更新时间：「更新天气」只改 state.data.weather，
     反复点更新时始终以基线为起点，避免逐次叠加。 */
  authoredWeather: null,
  weatherUpdatedAt: null,
  focusTarget: null,
  focusFinished: false
};

const MODULE_NAMES = Object.freeze(["flights", "overview", "itinerary", "todo", "driving", "ledger"]);
/* Note the mixed granularity: "todos"/"tickets"/"itinerary"/"flights" name real record collections,
   while "ledger"/"dining" name whole modules whose tables ledger.js and dining.js own.
   The allowlist is validated verbatim against trip-data.json, so entries have to match
   exactly what that file declares. */
const SHARED_COLLECTIONS = Object.freeze(["todos", "tickets", "itinerary", "flights", "ledger", "dining"]);

function normalizeTripConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== "1.0.0") throw new Error("trip-data.json config.schemaVersion must be 1.0.0");
  if (!raw.modules || typeof raw.modules !== "object") throw new Error("trip-data.json config must contain confirmed module switches");
  const modules = Object.fromEntries(MODULE_NAMES.map((name) => {
    if (typeof raw.modules[name] !== "boolean") throw new Error(`trip-data.json config.modules.${name} must be boolean`);
    return [name, raw.modules[name]];
  }));
  const mode = raw?.persistence?.mode;
  if (mode !== "local" && mode !== "d1") throw new Error("trip-data.json config.persistence.mode must be local or d1");
  const sharedCollections = mode === "d1" ? [...new Set(raw.persistence.sharedCollections || [])] : [];
  if (mode === "d1" && (!sharedCollections.length || sharedCollections.some((name) => !SHARED_COLLECTIONS.includes(name)))) {
    throw new Error("D1 mode requires an explicit sharedCollections allowlist");
  }
  const apiBase = raw.persistence.apiBase || "/api/trip";
  if (mode === "d1" && (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase))) {
    throw new Error("D1 apiBase must be a same-origin path");
  }
  return {
    ...raw,
    modules,
    persistence: {
      ...(raw.persistence || {}),
      mode,
      ...(mode === "d1" ? { apiBase, sharedCollections } : {})
    }
  };
}

function moduleEnabled(name) {
  return Boolean(state.config && state.config.modules?.[name] === true);
}

function applyModuleConfig() {
  /* 视图容器（[data-site-view]）的显隐由 site-navigation.js 统一管理：
     这里若一并设置，会出现「模块启用 → 强制显示」把 travel 与 prep 同时点亮的问题。 */
  document.querySelectorAll("[data-module]:not([data-site-view])").forEach((element) => {
    element.hidden = !moduleEnabled(element.dataset.module);
  });
  /* 页内栏目导航（.trip-nav）：模块项由上面的通用逻辑处理；「提醒」跟随行程提醒卡片的
     显隐。两个固定栏目（提醒 / 天气）没有 data-module，统计可见项时要一并算进去。 */
  syncFocusNavLink();
  const visibleTravelLinks = [...document.querySelectorAll(".trip-nav a")].filter((link) => !link.hidden);
  document.documentElement.dataset.persistence = state.config.persistence.mode;

  const hashModules = {
    "#flights": "flights", "#route": "overview", "#itinerary": "itinerary",
    "#drive": "driving", "#prep": "todo", "#ledger": "ledger",
    "#ledger-stats": "ledger", "#ledger-detail": "ledger"
  };
  const requestedModule = hashModules[location.hash];
  if (requestedModule && !moduleEnabled(requestedModule)) {
    const firstVisible = visibleTravelLinks[0]?.getAttribute("href") || "#top";
    history.replaceState({ view: "travel" }, "", firstVisible);
  }
  window.dispatchEvent(new CustomEvent("travel-config:ready", { detail: { config: state.config } }));
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

const airportCity = (airport) => airport.city || airport.airportCode;

function localDateTime(date, time, _airportCode, utcOffset = "") {
  return new Date(`${date}T${time}:00${utcOffset || "+00:00"}`);
}

function countdownParts(target, now = new Date()) {
  const difference = target.getTime() - now.getTime();
  if (difference <= 0) return { difference, days: 0, hours: 0, minutes: 0 };
  const totalMinutes = Math.floor(difference / 60000);
  return {
    difference,
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60
  };
}

function countdownText(target, completionText = "已出发") {
  const value = countdownParts(target);
  if (value.difference <= 0) return completionText;
  if (value.days > 0) return `${value.days}天 ${String(value.hours).padStart(2, "0")}小时`;
  if (value.hours > 0) return `${value.hours}小时 ${String(value.minutes).padStart(2, "0")}分`;
  return `${Math.max(1, value.minutes)}分钟`;
}

function preciseCountdownText(target, completionText = "已出发") {
  const difference = target.getTime() - Date.now();
  if (difference <= 0) return completionText;
  const totalSeconds = Math.floor(difference / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return days > 0 ? `${days}天 ${clock}` : clock;
}

/* The 「此刻关注」card highlights the single nearest schedule item across the whole trip. */
function dayUtcOffset(day) {
  for (const flight of mergedFlights()) {
    if (flight.departure?.date === day.date && flight.departure?.utcOffset) return flight.departure.utcOffset;
    if (flight.arrival?.date === day.date && flight.arrival?.utcOffset) return flight.arrival.utcOffset;
  }
  const locations = (day.locations || []).join("");
  if (/香港|深圳|广州|澳门/.test(locations)) return "+08:00";
  /* New Zealand: NZST +12:00 until NZDT starts on the last Sunday of September. */
  return day.date >= "2026-09-27" ? "+13:00" : "+12:00";
}

/* ---------- 行程提醒：三卡轮播（上一件·已完成 / 最近一件 / 下一件） ----------
   数据仍全部来自每日行程的合并视图；轮播交互对齐航班卡片。 */

function reminderTriplet() {
  const now = Date.now();
  const items = [];
  for (const day of itineraryDays()) {
    const offset = dayUtcOffset(day);
    for (const item of day.schedule || []) {
      const clock = String(item.time || "").match(/(\d{1,2}):(\d{2})/);
      if (!clock) continue;
      const target = new Date(`${day.date}T${clock[1].padStart(2, "0")}:${clock[2]}:00${offset}`);
      if (Number.isNaN(target.getTime())) continue;
      items.push({ target, day, item });
    }
  }
  items.sort((first, second) => first.target - second.target);
  const pending = items.filter((entry) => !entry.item.completed);
  if (!pending.length) return null;
  /* 最近一件：优先取未来第一件；全部过期时取最后一件（旧行为一致）。 */
  const current = pending.find((entry) => entry.target.getTime() > now) || pending[pending.length - 1];
  const currentIndex = items.indexOf(current);
  const prev = [...items.slice(0, currentIndex)].reverse().find((entry) => entry.item.completed) || null;
  return {
    prev,
    current,
    next: items[currentIndex + 1] || null,
    remaining: pending.filter((entry) => entry.target.getTime() > now).length
  };
}

function focusUnit(value, unit) {
  return `<span class="focus-unit"><b>${String(value).padStart(2, "0")}</b><i>${unit}</i></span>`;
}

function updateFocusCountdown() {
  const el = $("#focus-countdown");
  const target = state.focusTarget;
  if (!el || !target) return;
  const diff = target.getTime() - Date.now();
  if (diff <= 0) {
    el.innerHTML = `<span class="focus-done">${state.focusFinished ? "行程已结束" : "行程进行中"}</span>`;
    return;
  }
  const total = Math.floor(diff / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  el.innerHTML = `${focusUnit(days, "天")}${focusUnit(hours, "时")}${focusUnit(minutes, "分")}${focusUnit(seconds, "秒")}`;
}

function focusCardMarkup(entry, role) {
  const roleLabel = role === "prev" ? "上一件 · 已完成" : role === "next" ? "下一件" : "最近一件";
  if (!entry) {
    return `
      <article class="focus-slide focus-card is-empty" data-focus-role="${role}">
        <div class="focus-card__label">${roleLabel}</div>
        <div class="focus-card__event">${role === "prev" ? "还没有已完成的行程" : "后面暂时没有安排"}</div>
        <div class="focus-card__sub">左右滑动查看其它提醒</div>
      </article>`;
  }
  const { day, item } = entry;
  return `
    <article class="focus-slide focus-card${item.completed ? " is-done" : ""}" data-focus-role="${role}" data-focus-day="${day.day}" data-focus-item="${escapeHtml(item.itemId)}">
      <div class="focus-card__label">${roleLabel}</div>
      <div class="focus-card__event">${escapeHtml(item.text || `DAY ${String(day.day).padStart(2, "0")}`)}</div>
      <div class="focus-card__sub">${escapeHtml(`DAY ${String(day.day).padStart(2, "0")} · ${formatCompactDate(day.date)} ${item.time || ""}`)}</div>
      ${role === "current" ? `<div class="focus-countdown" id="focus-countdown" aria-live="polite"></div>` : ""}
    </article>`;
}

/* 轮播当前可见的是哪张卡：0=上一件 1=最近一件 2=下一件。 */
function visibleFocusRole() {
  const carousel = $("#focus-carousel");
  if (!carousel || !carousel.clientWidth) return "current";
  const index = Math.max(0, Math.min(2, Math.round(carousel.scrollLeft / carousel.clientWidth)));
  return ["prev", "current", "next"][index] || "current";
}

/* 「提醒」栏目与行程提醒卡片同显隐：卡片在没有未完成事项时会自己隐藏。 */
function syncFocusNavLink() {
  const link = document.querySelector('.trip-nav a[href="#focus-card-section"]');
  const card = $("#focus-card-section");
  if (link && card) link.hidden = card.hidden;
}

function renderFocus() {
  const card = $("#focus-card-section");
  if (!card) return;
  const triplet = reminderTriplet();
  if (!triplet) { card.hidden = true; state.focusTarget = null; syncFocusNavLink(); return; }
  card.hidden = false;
  syncFocusNavLink();

  const carousel = $("#focus-carousel");
  carousel.innerHTML = [
    focusCardMarkup(triplet.prev, "prev"),
    focusCardMarkup(triplet.current, "current"),
    focusCardMarkup(triplet.next, "next")
  ].join("");
  const dots = $("#focus-dots");
  const paintDots = (index) => {
    dots.innerHTML = [0, 1, 2].map((dot) => `<span class="carousel-dot${dot === index ? " is-active" : ""}"></span>`).join("");
  };
  paintDots(1);

  /* 每次重绘都回到中间一张（最近一件）；左右滑动看上一件 / 下一件。 */
  requestAnimationFrame(() => { carousel.scrollLeft = carousel.clientWidth; });
  let scheduled = false;
  carousel.onscroll = () => {
    if (scheduled || !carousel.clientWidth) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const index = Math.max(0, Math.min(2, Math.round(carousel.scrollLeft / carousel.clientWidth)));
      paintDots(index);
      updateFocusButtons(["prev", "current", "next"][index]);
    });
  };

  const remaining = $("#focus-remaining");
  if (remaining) remaining.textContent = `还剩 ${triplet.remaining} 项`;
  state.focusTarget = triplet.current?.target || null;
  state.focusFinished = !(triplet.current?.target.getTime() > Date.now());
  updateFocusCountdown();

  /* 按钮作用于「当前可见的那张卡」：完成 / 未完成按该条目的状态各自禁用。 */
  const updateFocusButtons = (role) => {
    const entry = triplet[role] || triplet.current;
    const done = $("#focus-done");
    const undo = $("#focus-undo");
    if (done) done.disabled = !entry || entry.item.completed;
    if (undo) undo.disabled = !entry || !entry.item.completed;
  };
  updateFocusButtons("current");
  $("#focus-done").onclick = () => applyFocusCompletion(true);
  $("#focus-undo").onclick = () => applyFocusCompletion(false);
}

/* 「完成 / 未完成」作用于轮播中当前可见的那张卡。
   完成（需求③d）：把该条目的时间更新为完成时刻 —— 例如 11:00 的午餐在 10:50 点完成，
   每日行程里的时间就改成 10:50；未完成不改时间。 */
function applyFocusCompletion(completed) {
  const triplet = reminderTriplet();
  const entry = triplet?.[visibleFocusRole()] || triplet?.current;
  if (!entry) return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  saveItineraryRecord(entry.day.day, entry.item.itemId, {
    time: completed ? time : entry.item.time,
    text: entry.item.text,
    type: entry.item.type,
    completed
  });
  renderTimeline();
  renderFocus();
}

function formatDate(dateString, includeYear = false) {
  const date = new Date(`${dateString}T12:00:00`);
  const options = includeYear
    ? { year: "numeric", month: "long", day: "numeric" }
    : { month: "long", day: "numeric" };
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

function formatCompactDate(dateString) {
  const [, month, day] = dateString.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function todayForTrip() {
  const timeZone = state.data?.metadata?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
}

function mapsSearch(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function heroDestinationFor(trip) {
  const destinations = (trip.countries || []).filter((country) => (trip.primaryDestinationCountries || []).includes(country.code));
  const isDomestic = destinations.length > 0 && destinations.every((country) => country.code === "CN");
  const customTitle = String(trip.heroTitle || "").trim();
  if (customTitle) {
    return { title: customTitle, eyebrow: String(trip.heroEyebrow || "").trim(), destinations, isDomestic };
  }
  if (isDomestic) {
    const destination = String(trip.primaryDestinationName || trip.primaryDestinationCity || trip.citiesAndAreas?.[0] || "目的地待补充").trim();
    return {
      title: destination,
      eyebrow: String(trip.primaryDestinationNameEn || trip.primaryDestinationCityEn || "DOMESTIC JOURNEY").trim(),
      destinations,
      isDomestic
    };
  }
  return {
    title: destinations.map((country) => country.nameZh || country.name).join(" × ") || "目的地待补充",
    eyebrow: destinations.map((country) => country.nameEn || country.name).filter(Boolean).join(" × "),
    destinations,
    isDomestic
  };
}

function renderHero() {
  const { trip } = state.data;
  if (trip.status === "uninitialized") {
    document.title = state.data.metadata.title;
    $("#trip-title").textContent = "旅行计划待生成";
    $("#trip-eyebrow").textContent = "READY FOR YOUR JOURNEY";
    $("#wordmark").innerHTML = "TRIP <span>· READY</span>";
    $("#footer-mark").textContent = "TRIP · READY";
    $("#route-day-count").textContent = "0 DAYS";
    $("#trip-date").textContent = "等待旅行资料";
    return;
  }
  const hero = heroDestinationFor(trip);
  const { destinations } = hero;
  const shortMark = destinations.map((country) => country.code).join(" / ");
  const year = trip.startDate.slice(0, 4);
  document.title = state.data.metadata.title;
  $("#trip-title").textContent = hero.title;
  $("#trip-eyebrow").textContent = hero.eyebrow;
  $("#wordmark").innerHTML = `${escapeHtml(shortMark)} <span>· ${escapeHtml(year)}</span>`;
  $("#footer-mark").textContent = `${shortMark} · ${year}`;
  $("#route-day-count").textContent = `${trip.dayCount} DAYS`;
  $("#trip-date").textContent = `${formatCompactDate(trip.startDate)} — ${formatCompactDate(trip.endDate)} · ${trip.dayCount}天`;
}

function journeyFlights(journeyId) {
  return mergedFlights()
    .filter((flight) => flight.journeyId === journeyId)
    .sort((first, second) => first.sequence - second.sequence);
}

/* ===== 航班编辑：trip-data.json 的 flights[] 是基线，共享层按航班 id 存覆盖 ===== */

function normalizeFlightRecord(raw) {
  const id = String(raw?.id || "").trim().slice(0, 60);
  if (!id) return null;
  const record = { id };
  if (typeof raw.flightNumber === "string") record.flightNumber = raw.flightNumber.trim().slice(0, 12);
  for (const key of ["departure", "arrival"]) {
    const side = raw?.[key];
    if (!side || typeof side !== "object") continue;
    const next = {};
    if (typeof side.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(side.date.trim())) next.date = side.date.trim();
    if (typeof side.time === "string" && /^\d{2}:\d{2}$/.test(side.time.trim())) next.time = side.time.trim();
    if (typeof side.airportCode === "string" && side.airportCode.trim()) next.airportCode = side.airportCode.trim().toUpperCase().slice(0, 4);
    if (typeof side.city === "string" && side.city.trim()) next.city = side.city.trim().slice(0, 24);
    if (Object.keys(next).length) record[key] = next;
  }
  return record;
}

/* 基线 + 覆盖：departure / arrival 逐层合并（只改一个字段不会把同侧的其它字段冲掉），
   其余字段整体替换。 */
function mergedFlights() {
  const overrides = new Map((state.flights || []).map((row) => [String(row.id), row]));
  return (state.data?.flights || []).map((base) => {
    const patch = overrides.get(String(base.id));
    if (!patch) return base;
    return {
      ...base,
      ...patch,
      departure: { ...base.departure, ...(patch.departure || {}) },
      arrival: { ...base.arrival, ...(patch.arrival || {}) }
    };
  });
}

function flightIsEdited(flightId) {
  return (state.flights || []).some((row) => String(row.id) === String(flightId));
}

function saveFlightRecord(flightId, patch) {
  const id = String(flightId);
  const record = { id, ...patch };
  const index = state.flights.findIndex((row) => String(row.id) === id);
  if (index >= 0) state.flights[index] = record;
  else state.flights.push(record);
  saveSharedChange("flights", record).catch(console.error);
}

function resetFlightRecord(flightId) {
  const id = String(flightId);
  state.flights = state.flights.filter((row) => String(row.id) !== id);
  saveSharedChange("flights", { id }, "delete").catch(console.error);
}

function journeyStatusAndTarget(flights) {
  const now = new Date();
  for (const flight of flights) {
    const departure = localDateTime(flight.departure.date, flight.departure.time, flight.departure.airportCode, flight.departure.utcOffset);
    const arrival = localDateTime(flight.arrival.date, flight.arrival.time, flight.arrival.airportCode, flight.arrival.utcOffset);
    if (now < departure) return { target: departure, label: flight === flights[0] ? "距离起飞还剩" : "距离下一程起飞还剩", complete: false };
    if (now < arrival) return { target: arrival, label: "飞行中 · 距抵达", complete: false };
  }
  return { target: null, label: "已抵达", complete: true };
}

function relativeFlightDate(date, journeyStartDate) {
  if (date === journeyStartDate) return formatCompactDate(date);
  const difference = Math.round((new Date(`${date}T12:00:00`) - new Date(`${journeyStartDate}T12:00:00`)) / 86400000);
  return difference === 1 ? "次日" : formatCompactDate(date);
}

function flightStopMarkup(stop, position, journeyStartDate) {
  let timing;
  if (position === 0) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.departure.date, journeyStartDate))}</span><b>${escapeHtml(stop.departure.time)} 出发</b>`;
  } else if (position === stop.totalStops - 1) {
    timing = `<span>${escapeHtml(relativeFlightDate(stop.arrival.date, journeyStartDate))}</span><b>${escapeHtml(stop.arrival.time)} 抵达</b>`;
  } else {
    const nextFlight = stop.nextFlight;
    const connection = nextFlight.connectionFromPrevious || {};
    const duration = connection.calculatedFromSchedule || connection.durationUsingTicketTimes || connection.plannedDurationText || "中转";
    timing = `
      <span>${escapeHtml(stop.arrival.time)} 抵达</span>
      <em>${escapeHtml(duration)}</em>
      <b>${escapeHtml(relativeFlightDate(nextFlight.departure.date, journeyStartDate))} ${escapeHtml(nextFlight.departure.time)}</b>
      <span>起飞</span>
    `;
  }
  return `
    <div class="flight-stop${position > 0 && position < stop.totalStops - 1 ? " is-transfer" : ""}">
      <span class="flight-stop__code">${escapeHtml(stop.airport.airportCode)}</span>
      <span class="flight-stop__city">${escapeHtml(airportCity(stop.airport))}</span>
      <span class="flight-stop__dot" aria-hidden="true"></span>
      <div class="flight-stop__timing">${timing}</div>
    </div>
  `;
}

function flightMissingFieldLabel(field) {
  return ({
    carrierId: "航空公司",
    flightNumber: "航班号",
    departure: "起飞信息",
    arrival: "抵达信息",
    departurePlace: "出发机场",
    arrivalPlace: "抵达机场",
    departureTime: "起飞时间",
    arrivalTime: "抵达时间",
    timeZone: "当地时区"
  })[field] || String(field || "待补充信息");
}

function flightPlaceholderCard(journey, index) {
  const missingFields = [...new Set(journey.missingFields || [])].map(flightMissingFieldLabel);
  return `
    <article class="flight-card flight-card--placeholder" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-placeholder">
        <span class="flight-placeholder__eyebrow">资料待补充</span>
        <h3>${escapeHtml(journey.title || "航班信息待补充")}</h3>
        <p>已按第二轮确认继续生成标准预览；系统没有猜测或伪造缺失的航班事实。</p>
        ${missingFields.length ? `<ul>${missingFields.map((field) => `<li>${escapeHtml(field)}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}" data-placeholder="true">
          <span>当前状态</span>
          <strong>待补充</strong>
        </div>
      </div>
    </article>
  `;
}

function flightCard(journey, index) {
  const flights = journeyFlights(journey.id);
  if (journey.placeholder || journey.status === "missing" || journey.status === "pending" || !flights.length || flights.some((flight) => flight.placeholder)) {
    return flightPlaceholderCard(journey, index);
  }
  const first = flights[0];
  const last = flights[flights.length - 1];
  const status = journeyStatusAndTarget(flights);
  const countdown = status.complete ? "已完成" : preciseCountdownText(status.target, "即将出发");
  const stops = [
    { airport: first.departure, departure: first.departure },
    ...flights.map((flight, flightIndex) => ({
      airport: flight.arrival,
      arrival: flight.arrival,
      nextFlight: flights[flightIndex + 1]
    }))
  ];
  const routeItems = [];
  stops.forEach((stop, stopIndex) => {
    routeItems.push(flightStopMarkup({ ...stop, totalStops: stops.length }, stopIndex, first.departure.date));
    if (stopIndex < flights.length) {
      const flight = flights[stopIndex];
      routeItems.push(`
        <div class="flight-segment">
          <span>${escapeHtml(flight.flightNumber)}</span>
          <i aria-hidden="true">→</i>
        </div>
      `);
    }
  });
  return `
    <article class="flight-card" data-journey="${escapeHtml(journey.id)}">
      <div class="flight-card__top">
        <span>FLIGHT ${String(index + 1).padStart(2, "0")} / ${String(state.data.flightJourneys.length).padStart(2, "0")}</span>
      </div>
      <div class="flight-card__airlines">${escapeHtml([...new Set(flights.map((flight) => flight.airline.nameZh || flight.airline.name))].join(" · "))}</div>
      <div class="flight-flow" style="--route-columns: ${stops.map((_, stopIndex) => stopIndex < stops.length - 1 ? "minmax(0,1fr) minmax(34px,.5fr)" : "minmax(0,1fr)").join(" ")}">
        ${routeItems.join("")}
      </div>
      <div class="flight-card__countdown-row">
        <div class="flight-countdown" data-countdown-journey="${escapeHtml(journey.id)}">
          <span>${escapeHtml(status.label)}</span>
          <strong>${escapeHtml(countdown)}</strong>
        </div>
      </div>
      <div class="flight-card__edit">
        <div class="flight-edit-toggles">${flights.map((flight) => `
          <button type="button" class="flight-edit-toggle${state.editingFlightId === flight.id ? " is-active" : ""}" data-flight-edit="${escapeHtml(flight.id)}" aria-expanded="${state.editingFlightId === flight.id ? "true" : "false"}">
            ✎ ${escapeHtml(flight.flightNumber)}${flightIsEdited(flight.id) ? "<i>已改</i>" : ""}
          </button>`).join("")}
        </div>
        ${flights.map((flight) => state.editingFlightId === flight.id ? flightEditorMarkup(flight) : "").join("")}
      </div>
    </article>
  `;
}

/* 单次航班的编辑表单：航班号 + 出发/到达两侧的机场与日期时间。
   保存写入共享层覆盖记录，两台设备看到同一份，且各旅程的其它航班不受影响。 */
function flightEditorMarkup(flight) {
  const side = (key, label, value) => `
        <fieldset class="flight-editor__side">
          <legend>${escapeHtml(label)}</legend>
          <label><span>机场代码</span><input name="${key}.airportCode" type="text" maxlength="4" value="${escapeHtml(value?.airportCode || "")}" required></label>
          <label><span>日期</span><input name="${key}.date" type="date" value="${escapeHtml(value?.date || "")}" required></label>
          <label><span>时间</span><input name="${key}.time" type="time" value="${escapeHtml(value?.time || "")}" required></label>
          <label><span>城市</span><input name="${key}.city" type="text" maxlength="24" value="${escapeHtml(value?.city || "")}"></label>
        </fieldset>`;
  return `
      <form class="flight-editor" data-flight-form="${escapeHtml(flight.id)}">
        <p class="flight-editor__head">编辑航班 ${escapeHtml(flight.flightNumber || "")}</p>
        <label class="flight-editor__number"><span>航班号</span><input name="flightNumber" type="text" maxlength="12" value="${escapeHtml(flight.flightNumber || "")}" required></label>
        <div class="flight-editor__sides">
          ${side("departure", "出发", flight.departure)}
          ${side("arrival", "到达", flight.arrival)}
        </div>
        <div class="flight-editor__actions">
          ${flightIsEdited(flight.id) ? `<button type="button" class="flight-editor__reset" data-flight-reset="${escapeHtml(flight.id)}">还原原始信息</button>` : ""}
          <button type="button" data-flight-cancel>取消</button>
          <button type="submit">保存</button>
        </div>
      </form>`;
}

function renderFlights() {
  const journeys = state.data.flightJourneys;
  $("#flight-carousel").innerHTML = journeys.map(flightCard).join("");
  $("#flight-dots").innerHTML = journeys.map((_, index) => `<span class="carousel-dot${index === 0 ? " is-active" : ""}"></span>`).join("");
  $("#flight-index").textContent = `1 / ${journeys.length}`;

  const carousel = $("#flight-carousel");
  /* 编辑保存后需要重渲染卡片，所以这里一律用 on* 赋值而不是 addEventListener：
     后者每重渲染一次就多挂一个监听器，滚动回调会成倍触发。 */
  let scheduled = false;
  carousel.onscroll = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const cards = $$(".flight-card", carousel);
      const center = carousel.scrollLeft + carousel.clientWidth / 2;
      let activeIndex = 0;
      let distance = Infinity;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        if (Math.abs(cardCenter - center) < distance) {
          distance = Math.abs(cardCenter - center);
          activeIndex = index;
        }
      });
      $$(".carousel-dot", $("#flight-dots")).forEach((dot, index) => dot.classList.toggle("is-active", index === activeIndex));
      $("#flight-index").textContent = `${activeIndex + 1} / ${journeys.length}`;
      scheduled = false;
    });
  };

  carousel.onclick = (event) => {
    const editButton = event.target.closest("[data-flight-edit]");
    if (editButton) {
      const id = editButton.dataset.flightEdit;
      state.editingFlightId = state.editingFlightId === id ? null : id;
      renderFlights();
      return;
    }
    if (event.target.closest("[data-flight-cancel]")) {
      state.editingFlightId = null;
      renderFlights();
      return;
    }
    const resetButton = event.target.closest("[data-flight-reset]");
    if (resetButton) {
      resetFlightRecord(resetButton.dataset.flightReset);
      state.editingFlightId = null;
      renderFlights();
    }
  };

  carousel.onsubmit = (event) => {
    const form = event.target.closest("[data-flight-form]");
    if (!form) return;
    event.preventDefault();
    const data = new FormData(form);
    const read = (key) => String(data.get(key) || "").trim();
    saveFlightRecord(form.dataset.flightForm, {
      flightNumber: read("flightNumber").toUpperCase(),
      departure: {
        airportCode: read("departure.airportCode").toUpperCase(),
        date: read("departure.date"),
        time: read("departure.time"),
        city: read("departure.city")
      },
      arrival: {
        airportCode: read("arrival.airportCode").toUpperCase(),
        date: read("arrival.date"),
        time: read("arrival.time"),
        city: read("arrival.city")
      }
    });
    state.editingFlightId = null;
    renderFlights();
    updateFlightCountdowns();
  };
}

function updateFlightCountdowns() {
  state.data.flightJourneys.forEach((journey) => {
    const target = $(`[data-countdown-journey="${journey.id}"]`);
    if (!target || target.dataset.placeholder === "true" || journey.placeholder) return;
    const status = journeyStatusAndTarget(journeyFlights(journey.id));
    $("strong", target).textContent = status.complete ? "已完成" : preciseCountdownText(status.target, "即将出发");
    $("span", target).textContent = status.label;
  });
}

function costText(cost) {
  if (cost.amount !== undefined) return `${cost.item} · ${cost.currency} ${cost.amount}`;
  if (cost.standard !== undefined && cost.standard !== null) return `${cost.item} · ${cost.currency} ${cost.standard}`;
  if (cost.discounted !== undefined && cost.discounted !== null) return `${cost.item} · ${cost.currency} ${cost.discounted}`;
  if (cost.amountOptions) return `${cost.item} · ${cost.currency} ${cost.amountOptions.join(" / ")}`;
  return cost.item;
}

function ticketsForDay(day) {
  if (!moduleEnabled("itinerary")) return [];
  return (state.data.ticketPlanning?.items || []).filter((ticket) =>
    ticket.dayId ? ticket.dayId === day.id : ticket.day === day.day
  );
}

function ticketsForSchedule(day, item) {
  if (!moduleEnabled("itinerary")) return [];
  const tickets = ticketsForDay(day);
  if (Array.isArray(item.ticketIds)) return tickets.filter((ticket) => item.ticketIds.includes(ticket.id));
  if (item.id) {
    const explicit = tickets.filter((ticket) => (ticket.scheduleItemIds || ticket.itemIds || []).includes(item.id));
    if (explicit.length) return explicit;
  }
  const lowerText = String(item.text || item.title || "").toLocaleLowerCase();
  return tickets.filter((ticket) => (ticket.scheduleMatchTerms || []).some((term) => lowerText.includes(term.toLocaleLowerCase())));
}

function isTicketPurchased(ticket) {
  return ticket.purchaseStatus === "purchased" || state.purchasedTickets.has(ticket.id);
}

function ticketRequirement(ticket) {
  return ({
    "advance-required": "需提前购票",
    "advance-recommended": "建议预约",
    "needs-confirmation": "购票方式待确认"
  })[ticket.requirement] || "门票信息";
}

function ticketTitle(ticket) {
  return ticket.name || ticket.attraction?.nameZh || ticket.attraction?.name || "门票详情";
}

function ticketGuidance(ticket) {
  const guidance = ticket.guidance || ticket.notes || [];
  return Array.isArray(guidance) ? guidance.join("·") : String(guidance || "");
}

function ticketDocument(ticket) {
  const document = ticket.document || ticket.booking?.document;
  if (document && typeof document === "object") {
    return { url: document.url || document.path || "", type: document.type || "", label: document.label || "查看票据" };
  }
  const url = ticket.documentUrl || ticket.booking?.documentUrl || "";
  return url ? { url, type: "", label: ticket.documentLabel || "查看票据" } : null;
}

function inlineTicketMarkup(ticket) {
  const purchased = isTicketPurchased(ticket);
  const title = ticketTitle(ticket);
  return `
    <div class="schedule-ticket ${purchased ? "is-purchased" : `is-${escapeHtml(ticket.requirement)}`}" data-inline-ticket="${escapeHtml(ticket.id)}">
      <label class="schedule-ticket__toggle">
        <input type="checkbox" value="${escapeHtml(ticket.id)}" ${purchased ? "checked" : ""} aria-label="${purchased ? "取消已购票" : "标记为已购票"}：${escapeHtml(title)}">
        <span class="schedule-ticket__check" aria-hidden="true">✓</span>
        <span class="schedule-ticket__content">
          <span class="schedule-ticket__status">${purchased ? "已购票" : escapeHtml(ticketRequirement(ticket))}</span>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(ticketGuidance(ticket))}</small>
        </span>
      </label>
      <button type="button" class="schedule-ticket__open" data-ticket-open="${escapeHtml(ticket.id)}" aria-haspopup="dialog" aria-controls="ticket-dialog">查看</button>
    </div>`;
}

/* ---------- shared itinerary ----------
   Every edit lands as ONE record keyed by `${day}::${itemId}`, never as a whole
   rewritten `days` array — that is what lets two people change different items
   at the same time without clobbering each other. `deleted: true` acts as a
   tombstone that suppresses the authored copy from trip-data.json; an item that
   only ever existed in the shared layer is removed by dropping its row instead. */

const ITINERARY_SEPARATOR = "::";
const SCHEDULE_TYPES = Object.freeze([
  ["attraction", "景点"], ["restaurant", "餐饮"], ["drive", "自驾"], ["hike", "徒步"],
  ["check-in", "入住"], ["check-out", "退房"], ["flight", "航班"], ["transfer", "交通"], ["note", "备忘"]
]);
const SCHEDULE_TYPE_LABELS = Object.freeze(Object.fromEntries(SCHEDULE_TYPES));

function itineraryRecordId(day, itemId) {
  return `${Number(day)}${ITINERARY_SEPARATOR}${String(itemId || "").trim()}`;
}

function normalizeItineraryRecord(raw) {
  const day = Number(raw?.day);
  const itemId = String(raw?.itemId || "").trim();
  if (!Number.isSafeInteger(day) || day < 1 || !itemId) return null;
  return {
    id: itineraryRecordId(day, itemId),
    day,
    itemId,
    time: String(raw?.time || "").trim().slice(0, 16),
    text: String(raw?.text || "").trim().slice(0, 200),
    type: String(raw?.type || "note").trim().slice(0, 24),
    completed: Boolean(raw?.completed),
    deleted: Boolean(raw?.deleted)
  };
}

/* trip-data.json leaves 20 schedule entries without an id, so derive a stable one
   from the position in the AUTHORED array. Deriving it from the merged array would
   make the key shift the moment anything is added. */
function authoredScheduleItemId(item, index) {
  return String(item?.id || "").trim() || `auto-${index + 1}`;
}

function itineraryRecordMap() {
  const map = new Map();
  for (const raw of state.itinerary || []) {
    const record = normalizeItineraryRecord(raw);
    if (record) map.set(record.id, record);
  }
  return map;
}

/* Merge the authored baseline with the shared overlay into the days the UI renders. */
function itineraryDays() {
  const source = state.data?.days || [];
  if (!source.length) return [];
  const records = itineraryRecordMap();
  return source.map((day) => {
    const items = [];
    const authoredIds = new Set();
    (day.schedule || []).forEach((item, index) => {
      const itemId = authoredScheduleItemId(item, index);
      authoredIds.add(itemId);
      const record = records.get(itineraryRecordId(day.day, itemId));
      if (record?.deleted) return;
      items.push({
        ...item,
        id: itemId,
        itemId,
        time: record ? record.time : String(item.time || ""),
        text: record ? record.text : String(item.text || ""),
        type: record ? record.type : String(item.type || "note"),
        completed: Boolean(record?.completed),
        isAdded: false
      });
    });
    const additions = [...records.values()]
      .filter((record) => record.day === day.day && !authoredIds.has(record.itemId) && !record.deleted && record.text)
      .sort((first, second) => String(first.time).localeCompare(String(second.time)) || first.itemId.localeCompare(second.itemId));
    for (const record of additions) {
      /* Slot new items in where the clock says they belong rather than dumping them
         at the bottom — adding a 09:00 stop to a day that starts at 11:00 otherwise
         showed up last and read as broken. */
      const time = String(record.time || "");
      const index = items.findIndex((existing) => String(existing.time || "").localeCompare(time) > 0);
      const entry = { id: record.itemId, itemId: record.itemId, time, text: record.text, type: record.type, completed: record.completed, isAdded: true };
      if (index < 0) items.push(entry);
      else items.splice(index, 0, entry);
    }
    return { ...day, schedule: items };
  });
}

function findItineraryEntry(day, itemId) {
  const target = itineraryDays().find((entry) => entry.day === Number(day));
  return target?.schedule.find((item) => item.itemId === itemId) || null;
}

/* Update local state first so the UI re-renders immediately; the shared write is
   fire-and-forget, matching how the pre-trip list persists. */
function saveItineraryRecord(day, itemId, patch) {
  const record = normalizeItineraryRecord({ day, itemId, ...patch });
  if (!record) return Promise.resolve(null);
  const index = state.itinerary.findIndex((item) => itineraryRecordId(item.day, item.itemId) === record.id);
  if (index >= 0) state.itinerary[index] = record;
  else state.itinerary.push(record);
  const adapter = state.runtimeAdapters.itinerary;
  if (!adapter) return Promise.resolve(record);
  return adapter.applyChange("itinerary", record, "upsert")
    .then(() => record)
    .catch((error) => {
      console.error("行程修改没有同步到共享层。", error);
      return record;
    });
}

function removeItineraryEntry(day, itemId, isAdded) {
  const id = itineraryRecordId(day, itemId);
  const adapter = state.runtimeAdapters.itinerary;
  if (isAdded) {
    /* Never existed in trip-data.json, so dropping the row is enough. */
    state.itinerary = state.itinerary.filter((item) => itineraryRecordId(item.day, item.itemId) !== id);
    if (adapter) adapter.applyChange("itinerary", { id }, "delete").catch((error) => console.error("行程删除没有同步到共享层。", error));
    return;
  }
  /* Authored item: keep a tombstone, otherwise the next reload resurrects it. */
  const entry = findItineraryEntry(day, itemId);
  saveItineraryRecord(day, itemId, {
    time: entry?.time || "",
    text: entry?.text || "",
    type: entry?.type || "note",
    completed: Boolean(entry?.completed),
    deleted: true
  });
}

function scheduleEditorMarkup(day, item) {
  return `
    <form class="schedule-editor" data-schedule-form="edit" data-schedule-day="${day.day}" data-schedule-completed="${item.completed ? "1" : "0"}">
      <div class="schedule-editor__grid">
        <label><span>时间</span><input type="time" name="time" value="${escapeHtml(item.time || "")}" required></label>
        <label><span>类型</span>
          <select name="type">${SCHEDULE_TYPES.map(([value, label]) => `<option value="${value}" ${item.type === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        </label>
      </div>
      <label><span>内容</span><input type="text" name="text" maxlength="200" value="${escapeHtml(item.text)}" required></label>
      <div class="schedule-editor__actions">
        <button type="submit">保存</button>
        <button type="button" class="schedule-editor__cancel" data-schedule-cancel>取消</button>
      </div>
    </form>`;
}

function scheduleItemMarkup(day, item) {
  const recordId = itineraryRecordId(day.day, item.itemId);
  const timeLabel = escapeHtml(item.time || "—");
  if (state.editingScheduleId === recordId) {
    return `
      <li class="schedule-item is-editing" data-schedule-id="${escapeHtml(recordId)}" data-schedule-day="${day.day}" data-schedule-item="${escapeHtml(item.itemId)}">
        <span class="schedule-time">${timeLabel}</span>
        <div class="schedule-content">${scheduleEditorMarkup(day, item)}</div>
      </li>`;
  }
  const mapLinks = navigationDestinations(item).map((destination) => `
    <button type="button" class="schedule-map-link" data-map-query="${escapeHtml(destination.query)}" data-map-url="${escapeHtml(destination.url || "")}" data-map-label="${escapeHtml(destination.label)}" aria-haspopup="dialog" aria-controls="place-map" aria-label="查看 ${escapeHtml(destination.label)} 的地图">📍 ${escapeHtml(destination.label)}</button>
  `).join("");
  const scheduleTickets = ticketsForSchedule(day, item).map(inlineTicketMarkup).join("");
  const typeLabel = SCHEDULE_TYPE_LABELS[item.type] || "";
  return `
    <li class="schedule-item${item.completed ? " is-done" : ""}${item.isAdded ? " is-added" : ""}" data-schedule-id="${escapeHtml(recordId)}" data-schedule-day="${day.day}" data-schedule-item="${escapeHtml(item.itemId)}">
      <span class="schedule-time">${timeLabel}</span>
      <div class="schedule-content">
        <div class="schedule-text">${escapeHtml(item.text)}${typeLabel ? `<span class="schedule-type">${escapeHtml(typeLabel)}</span>` : ""}${item.isAdded ? `<span class="schedule-type schedule-type--added">新增</span>` : ""}</div>
        ${scheduleTickets}
        ${mapLinks ? `<div class="schedule-map-links">${mapLinks}</div>` : ""}
        <div class="schedule-actions">
          <label class="schedule-done">
            <input type="checkbox" data-schedule-complete ${item.completed ? "checked" : ""} aria-label="${item.completed ? "取消完成" : "标记完成"}：${escapeHtml(item.text)}">
            <span class="schedule-done__label">${item.completed ? "已完成" : "标记完成"}</span>
          </label>
          <button type="button" class="schedule-action" data-schedule-edit aria-label="编辑：${escapeHtml(item.text)}">编辑</button>
          <button type="button" class="schedule-action schedule-action--danger" data-schedule-remove aria-label="删除：${escapeHtml(item.text)}">删除</button>
        </div>
      </div>
    </li>`;
}

/* 查看按键：总览 + DAY01-DAY11 单天查看（需求②b）。 */
function renderItineraryViewTabs(days) {
  const container = $("#itinerary-view-tabs");
  if (!container) return;
  const view = String(state.itineraryView);
  const tabs = [["all", "总览"], ...days.map((day) => [String(day.day), `DAY ${String(day.day).padStart(2, "0")}`])];
  container.innerHTML = tabs.map(([value, label]) =>
    `<button type="button" data-itinerary-view="${value}" aria-pressed="${view === value}">${escapeHtml(label)}</button>`).join("");
  container.onclick = (event) => {
    const button = event.target.closest("[data-itinerary-view]");
    if (!button) return;
    const value = button.dataset.itineraryView;
    state.itineraryView = value === "all" ? "all" : Number(value);
    if (state.itineraryView !== "all") state.collapsedDays.delete(state.itineraryView);
    renderTimeline();
  };
}

/* 全局新增表单的日期 / 类型下拉（表单在查看按键上方，属视图骨架，不随天卡重绘）。
   保留用户已选的日期，其它操作触发重绘时不会打断填写。 */
function renderScheduleAddForm(days) {
  const daySelect = $("#schedule-add-day");
  const typeSelect = $("#schedule-add-type");
  if (!daySelect || !typeSelect) return;
  const previous = daySelect.value;
  if (daySelect.options.length !== days.length) {
    daySelect.innerHTML = days.map((day) =>
      `<option value="${day.day}">DAY ${String(day.day).padStart(2, "0")} · ${escapeHtml(formatCompactDate(day.date))}</option>`).join("");
  }
  const fallback = String(currentTripDay() || days[0]?.day || 1);
  daySelect.value = days.some((day) => String(day.day) === previous) ? previous : fallback;
  if (!typeSelect.options.length) {
    typeSelect.innerHTML = SCHEDULE_TYPES.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  }
}

function dayCard(day) {
  const today = todayForTrip();
  const isToday = day.date === today;
  const expanded = !state.collapsedDays.has(day.day);
  const schedule = day.schedule.map((item) => scheduleItemMarkup(day, item)).join("");
  const notes = [...(day.notes || []), ...(day.sourceDateLabelConflict ? [day.sourceDateLabelConflict] : [])];
  const costs = (day.costReferences || []).map((cost) => `<span class="cost-tag">${escapeHtml(costText(cost))}</span>`).join("");
  const dayTickets = ticketsForDay(day);
  const pendingTicketCount = dayTickets.filter((ticket) => !isTicketPurchased(ticket)).length;
  const ticketSummary = dayTickets.length
    ? `<span class="day-ticket-summary ${pendingTicketCount ? "has-pending" : "is-complete"}">${pendingTicketCount ? `${pendingTicketCount} 项待购票` : "门票已准备"}</span>`
    : "";
  const doneCount = day.schedule.filter((item) => item.completed).length;
  const doneSummary = day.schedule.length
    ? `<span class="day-done-summary${doneCount === day.schedule.length ? " is-complete" : ""}">${doneCount}/${day.schedule.length} 已完成</span>`
    : "";
  return `
    <article class="day-card${isToday ? " is-today" : ""}" data-day="${day.day}">
      <span class="day-dot" aria-hidden="true"></span>
      <button class="day-toggle" type="button" aria-expanded="${expanded}" aria-controls="day-detail-${day.day}">
        <span>
          <span class="day-meta">DAY ${String(day.day).padStart(2, "0")} · ${escapeHtml(formatCompactDate(day.date))}${isToday ? " · 今天" : ""}</span>
          <span class="day-title">${escapeHtml(day.title)}</span>
          <span class="day-locations">${escapeHtml(day.locations.join(" → "))}</span>
          <span class="day-badges">${ticketSummary}${doneSummary}</span>
        </span>
        <span class="day-chevron${expanded ? " is-expanded" : ""}" aria-hidden="true">${expanded ? "−" : "+"}</span>
      </button>
      <div class="day-detail" id="day-detail-${day.day}" ${expanded ? "" : "hidden"}>
        <ol class="schedule">${schedule}</ol>
        ${costs ? `<div class="costs">${costs}</div>` : ""}
        ${notes.map((note) => `<p class="detail-note">${escapeHtml(note)}</p>`).join("")}
      </div>
    </article>
  `;
}

function navigationDestinations(item) {
  const policy = state.data.mapLinks?.navigationPolicy || { noNavigationTypes: [], selfNavigationTypes: [] };
  if (policy.noNavigationTypes.includes(item.type)) return [];
  const referencedPlaceIds = [...new Set([
    ...(Array.isArray(item.placeIds) ? item.placeIds : []),
    ...(item.placeId ? [item.placeId] : [])
  ])];
  if (referencedPlaceIds.length) {
    return referencedPlaceIds.map((placeId) => state.data.places.find((place) => place.id === placeId)).filter(Boolean).map((place) => ({
      id: place.id,
      label: place.nameZh || place.name,
      query: place.navigation?.query || place.googleMapsQuery || place.address || `${place.nameZh || place.name}${place.cityOrArea ? `, ${place.cityOrArea}` : ""}`,
      directUrl: Boolean(place.navigation?.url || place.googleMapsUrl),
      url: place.navigation?.url || place.googleMapsUrl || ""
    }));
  }
  const text = String(item.text || item.title || "");
  const lowerText = text.toLocaleLowerCase();
  const explicit = (state.data.mapLinks?.navigationPlaces || [])
    .filter((place) => place.matchTerms.some((term) => lowerText.includes(term.toLocaleLowerCase())))
    .map((place) => ({
      id: place.id,
      label: place.label,
      query: place.query,
      priority: place.priority || 1,
      matchIndex: Math.max(...place.matchTerms.map((term) => lowerText.lastIndexOf(term.toLocaleLowerCase())))
    }));
  const highestExplicitPriority = explicit.reduce((highest, place) => Math.max(highest, place.priority), 0);
  const selectedExplicit = highestExplicitPriority > 1
    ? explicit.filter((place) => place.priority === highestExplicitPriority)
    : explicit;

  const catalogPlaces = state.data.places
    .filter((place) => [place.name, place.nameZh].filter(Boolean).some((name) => lowerText.includes(name.toLocaleLowerCase())))
    .map((place) => ({
      id: place.id,
      label: place.nameZh || place.name,
      query: place.googleMapsUrl || [place.name, place.cityOrArea].filter(Boolean).join(", "),
      directUrl: Boolean(place.googleMapsUrl),
      matchIndex: Math.max(...[place.name, place.nameZh].filter(Boolean).map((name) => lowerText.lastIndexOf(name.toLocaleLowerCase())))
    }));

  const restaurants = state.data.restaurants
    .filter((restaurant) => lowerText.includes(restaurant.name.toLocaleLowerCase()))
    .map((restaurant) => ({
      id: `restaurant-${restaurant.name}`,
      label: restaurant.name,
      query: restaurant.googleMapsUrl || `${restaurant.name}, ${restaurant.city}`,
      directUrl: Boolean(restaurant.googleMapsUrl),
      matchIndex: lowerText.lastIndexOf(restaurant.name.toLocaleLowerCase())
    }));

  const specificExplicit = selectedExplicit.filter((place) => place.priority > 1);
  let destinations = specificExplicit.length
    ? [...specificExplicit, ...restaurants]
    : catalogPlaces.length
      ? [...catalogPlaces, ...restaurants]
      : [...selectedExplicit, ...restaurants];
  destinations = destinations.filter((place, index, all) => all.findIndex((candidate) => candidate.id === place.id) === index);

  if (policy.selfNavigationTypes.includes(item.type) && destinations.length > 1 && !specificExplicit.length) {
    destinations.sort((first, second) => second.matchIndex - first.matchIndex);
    return [destinations[0]];
  }
  return destinations;
}

function currentTripDay() {
  const today = todayForTrip();
  return state.data.days.find((day) => day.date === today)?.day || null;
}

/* Focus the editor that was just opened by 编辑. Looked up by dataset value rather
   than by selector because the id contains "::". */
function focusOpenScheduleEditor() {
  if (!state.editingScheduleId) return;
  const host = $$("[data-schedule-id]").find((node) => node.dataset.scheduleId === state.editingScheduleId);
  host?.querySelector('[name="text"]')?.focus();
}

function renderTimeline() {
  const days = itineraryDays();
  $("#day-count").textContent = `${days.length} DAYS`;
  renderItineraryViewTabs(days);
  renderScheduleAddForm(days);
  const visible = state.itineraryView === "all" ? days : days.filter((day) => day.day === state.itineraryView);
  $("#timeline").innerHTML = visible.map(dayCard).join("");
  $("#timeline").onclick = (event) => {
    const ticketButton = event.target.closest("[data-ticket-open]");
    if (ticketButton) {
      openTicketDialog(ticketButton.dataset.ticketOpen, ticketButton);
      return;
    }
    const editButton = event.target.closest("[data-schedule-edit]");
    if (editButton) {
      state.editingScheduleId = editButton.closest("[data-schedule-id]")?.dataset.scheduleId || null;
      renderTimeline();
      focusOpenScheduleEditor();
      return;
    }
    const cancelButton = event.target.closest("[data-schedule-cancel]");
    if (cancelButton) {
      state.editingScheduleId = null;
      renderTimeline();
      return;
    }
    const removeButton = event.target.closest("[data-schedule-remove]");
    if (removeButton) {
      const host = removeButton.closest("[data-schedule-id]");
      if (!host) return;
      removeItineraryEntry(Number(host.dataset.scheduleDay), host.dataset.scheduleItem, host.classList.contains("is-added"));
      renderTimeline();
      renderFocus();
      return;
    }
    /* 默认全部展开：点天头只在「收起 / 展开」这一张卡之间切换，不再互斥。 */
    const toggle = event.target.closest(".day-toggle");
    if (!toggle) return;
    const dayNumber = Number(toggle.closest(".day-card").dataset.day);
    if (state.collapsedDays.has(dayNumber)) state.collapsedDays.delete(dayNumber);
    else state.collapsedDays.add(dayNumber);
    renderTimeline();
  };
  $("#timeline").onchange = (event) => {
    const completeBox = event.target.closest("[data-schedule-complete]");
    if (completeBox) {
      const host = completeBox.closest("[data-schedule-id]");
      if (!host) return;
      const day = Number(host.dataset.scheduleDay);
      const itemId = host.dataset.scheduleItem;
      const entry = findItineraryEntry(day, itemId);
      if (!entry) return;
      saveItineraryRecord(day, itemId, {
        time: entry.time,
        text: entry.text,
        type: entry.type,
        completed: completeBox.checked
      });
      renderTimeline();
      renderFocus();
      return;
    }
    const checkbox = event.target.closest(".schedule-ticket input[type='checkbox']");
    if (!checkbox) return;
    if (checkbox.checked) state.purchasedTickets.add(checkbox.value);
    else state.purchasedTickets.delete(checkbox.value);
    saveTicketState(checkbox.value, checkbox.checked);
    updateInlineTicketState(checkbox.value, checkbox.checked);
  };
  /* 行内「编辑」表单：保存走共享层同一条覆盖记录（全局新增表单另有自己的 onsubmit）。 */
  $("#timeline").onsubmit = (event) => {
    const form = event.target.closest("[data-schedule-form]");
    if (!form || form.dataset.scheduleForm !== "edit") return;
    event.preventDefault();
    const day = Number(form.dataset.scheduleDay);
    const read = (name) => String(form.querySelector(`[name="${name}"]`)?.value ?? "").trim();
    const itemId = form.closest("[data-schedule-item]")?.dataset.scheduleItem || "";
    const time = read("time");
    const text = read("text");
    if (!itemId || !Number.isSafeInteger(day) || !time || !text) return;
    state.editingScheduleId = null;
    saveItineraryRecord(day, itemId, { time, text, type: read("type") || "note", completed: form.dataset.scheduleCompleted === "1" });
    renderTimeline();
    renderFocus();
  };
  /* 全局新增表单在查看按键上方；提交后切到对应天，让用户立刻看到新条目。 */
  const addForm = $("#schedule-add-form");
  if (addForm) addForm.onsubmit = (event) => {
    event.preventDefault();
    const read = (name) => String(addForm.querySelector(`[name="${name}"]`)?.value ?? "").trim();
    const day = Number(read("day"));
    const time = read("time");
    const text = read("text");
    const type = read("type") || "note";
    if (!Number.isSafeInteger(day) || !days.some((entry) => entry.day === day) || !time || !text) return;
    const itemId = `it-${day}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    saveItineraryRecord(day, itemId, { time, text, type, completed: false });
    addForm.reset();
    renderScheduleAddForm(days);
    state.itineraryView = day;
    state.collapsedDays.delete(day);
    renderTimeline();
    renderFocus();
  };
}

function updateInlineTicketState(ticketId, purchased) {
  const ticketData = state.data.ticketPlanning.items.find((item) => item.id === ticketId);
  if (!ticketData) return;
  $$(`[data-inline-ticket="${ticketId}"]`).forEach((ticket) => {
    ticket.classList.toggle("is-purchased", purchased);
    ticket.querySelector("input").checked = purchased;
    ticket.querySelector("input").setAttribute("aria-label", `${purchased ? "取消已购票" : "标记为已购票"}：${ticketTitle(ticketData)}`);
    ticket.querySelector(".schedule-ticket__status").textContent = purchased ? "已购票" : ticketRequirement(ticketData);
  });
  const day = state.data.days.find((item) => ticketData.dayId ? item.id === ticketData.dayId : item.day === ticketData.day);
  const dayCardElement = day ? $(`[data-day="${day.day}"]`) : null;
  const badge = dayCardElement ? $(".day-ticket-summary", dayCardElement) : null;
  const dayTickets = day ? ticketsForDay(day) : [];
  const pending = dayTickets.filter((ticket) => !isTicketPurchased(ticket)).length;
  if (!badge) return;
  badge.textContent = pending ? `${pending} 项待购票` : "门票已准备";
  badge.classList.toggle("has-pending", pending > 0);
  badge.classList.toggle("is-complete", pending === 0);
}

async function loadTicketState() {
  state.purchasedTickets = new Set();
}

function saveTicketState(ticketId, completed) {
  return saveSharedChange("tickets", { id: ticketId, completed }, completed ? "upsert" : "delete").catch(console.error);
}

function rentalStatus(rental) {
  const pickup = new Date(`${rental.pickup.date}T${rental.pickup.time}:00${rental.pickup.utcOffset || "+00:00"}`);
  const dropoff = new Date(`${rental.dropoff.date}T${rental.dropoff.time}:00${rental.dropoff.utcOffset || "+00:00"}`);
  const now = new Date();
  if (now < pickup) return { label: "距取车", target: pickup, complete: false };
  if (now < dropoff) return { label: "距还车", target: dropoff, complete: false };
  return { label: "已超过预约还车时间", target: dropoff, complete: true };
}

function renderRental() {
  const transport = state.data.groundTransport;
  const rental = transport.rentalCar;
  $("#rental-provider-label").textContent = rental.company;
  const status = rentalStatus(rental);
  const vehicle = rental.vehicle || {};
  const price = rental.price || {};
  $("#rental-card").innerHTML = `
    <article class="rental-panel">
      <div class="return-deadline">
        <span class="return-deadline__label">重要 · 还车截止时间</span>
        <strong>${escapeHtml(formatCompactDate(rental.dropoff.date))} <time>${escapeHtml(rental.dropoff.time)}</time> 前</strong>
        <span>${escapeHtml(rental.dropoff.timeZoneLabel)}</span>
        <p>${escapeHtml(rental.dropoff.vehicleReturnPoint)}</p>
        <div class="return-deadline__timer" id="return-deadline-timer"></div>
        <p class="return-deadline__warning">${escapeHtml(rental.dropoff.deadlineWarning)}</p>
        <small>建议 ${escapeHtml(rental.dropoff.recommendedArrivalTime)} 抵达机场区域，预留还车及值机时间。</small>
      </div>
      <div class="rental-countdown" id="rental-countdown">
        <span>${escapeHtml(status.label)}</span>
        <strong>${status.complete ? `请立即联系 ${escapeHtml(rental.company)}` : escapeHtml(countdownText(status.target))}</strong>
        <small>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)} 前 · ${escapeHtml(rental.dropoff.vehicleReturnPoint)}</small>
      </div>
      <div class="rental-details">
        <div class="rental-car">${escapeHtml(rental.company)} · ${escapeHtml(vehicle.example)}</div>
        <div class="rental-sub">${escapeHtml(vehicle.class)} · ${rental.unlimitedKilometers ? "无限里程" : "里程条款见订单"}</div>
        <div class="rental-stops">
          <div class="rental-stop">
            <span class="rental-stop__label">PICK UP</span>
            <div><b>${formatCompactDate(rental.pickup.date)} ${escapeHtml(rental.pickup.time)}</b><span>${escapeHtml(rental.pickup.location)}<br>${escapeHtml(rental.pickup.address)}</span></div>
          </div>
          <div class="rental-stop">
            <span class="rental-stop__label">RETURN</span>
            <div><b>${formatCompactDate(rental.dropoff.date)} ${escapeHtml(rental.dropoff.time)}</b><span>${escapeHtml(rental.dropoff.vehicleReturnPoint)}<br>建议 ${escapeHtml(rental.dropoff.recommendedArrivalTime)} 抵达机场区域</span></div>
          </div>
        </div>
        <div class="rental-price"><span>柜台支付 · ${rental.rentalPeriodDays} 天</span><strong>${escapeHtml(price.currency)} ${Number(price.payAtCounter).toFixed(2)}</strong></div>
      </div>
    </article>
  `;
  const insurance = (rental.insurance || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const panels = {
    checklist: transport.rentalChecklist.map((rule) => `<li>${escapeHtml(rule)}</li>`).join(""),
    insurance,
    driving: `${(transport.drivingNotes || []).map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}${(transport.drivingReferenceLinks || []).map((link) => `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a></li>`).join("")}`
  };
  const notes = $("#drive-notes");
  notes.innerHTML = `
    <div class="drive-note-tabs" role="group" aria-label="自驾注意事项">
      <button type="button" aria-expanded="true" aria-controls="drive-note-content" data-drive-note="checklist">取还车检查</button>
      <button type="button" aria-expanded="false" aria-controls="drive-note-content" data-drive-note="insurance">订单保障</button>
      <button type="button" aria-expanded="false" aria-controls="drive-note-content" data-drive-note="driving">驾驶提醒</button>
    </div>
    <div class="drive-note-panel" id="drive-note-content"><ul>${panels.checklist}</ul></div>`;
  notes.onclick = (event) => {
    const button = event.target.closest("button[data-drive-note]");
    if (!button) return;
    const collapse = button.getAttribute("aria-expanded") === "true";
    $$("button[data-drive-note]", notes).forEach((item) => item.setAttribute("aria-expanded", String(item === button && !collapse)));
    const panel = $(".drive-note-panel", notes);
    panel.hidden = collapse;
    if (!collapse) panel.innerHTML = `<ul>${panels[button.dataset.driveNote]}</ul>`;
  };
}

function updateRentalCountdown() {
  const dropoff = state.data.groundTransport.rentalCar.dropoff;
  const deadline = new Date(`${dropoff.date}T${dropoff.time}:00${dropoff.utcOffset}`);
  const remaining = deadline.getTime() - Date.now();
  $("#return-deadline-timer").textContent = remaining > 0
    ? `距还车截止 ${preciseCountdownText(deadline)}`
    : "预约还车时间已过 · 如尚未还车，请立即联系租车公司";
  $(".return-deadline").classList.toggle("is-urgent", remaining <= 86400000);
  const panel = $("#rental-countdown");
  if (!panel) return;
  const status = rentalStatus(state.data.groundTransport.rentalCar);
  $("span", panel).textContent = status.label;
  $("strong", panel).textContent = status.complete ? `请立即联系 ${state.data.groundTransport.rentalCar.company}` : countdownText(status.target);
}

function loadTodoState() { state.todos = []; }

function createRuntimeAdapters() {
  const storage = window.TravelRuntimeStorage;
  if (!storage?.createAdapter) throw new Error("runtime-storage.js is required");
  const persistence = state.config.persistence || { mode: "local" };
  const sharedCollections = new Set(Array.isArray(persistence.sharedCollections)
    ? persistence.sharedCollections
    : ["todos", "tickets", "ledger"]);
  const tripId = state.data.metadata.tripId;
  /* 记录集合 → 启用它的模块开关。新增共享集合时必须在这里登记：漏登记的话
     state.runtimeAdapters 里不会有它，写操作会被静默丢弃（只剩本地内存生效）。
     tickets / itinerary 都由 itinerary 模块渲染，所以同属一个开关。 */
  const COLLECTION_MODULES = {
    todos: "todo",
    tickets: "itinerary",
    itinerary: "itinerary",
    flights: "flights"
  };
  const enabledCollections = Object.entries(COLLECTION_MODULES)
    .filter(([, moduleName]) => moduleEnabled(moduleName))
    .map(([collection]) => collection);
  const localCollections = enabledCollections.filter((collection) => persistence.mode !== "d1" || !sharedCollections.has(collection));
  const d1Collections = enabledCollections.filter((collection) => persistence.mode === "d1" && sharedCollections.has(collection));
  const localAdapter = localCollections.length ? storage.createAdapter({ mode: "local", tripId, collections: localCollections }) : null;
  const d1Adapter = d1Collections.length ? storage.createAdapter({
    mode: "d1",
    tripId,
    apiBase: persistence.apiBase || "/api/trip",
    collections: d1Collections
  }) : null;
  state.runtimeAdapters = {};
  localCollections.forEach((collection) => { state.runtimeAdapters[collection] = localAdapter; });
  d1Collections.forEach((collection) => { state.runtimeAdapters[collection] = d1Adapter; });
}

async function loadSharedState() {
  const adapters = [...new Set(Object.values(state.runtimeAdapters).filter(Boolean))];
  const todoAdapter = state.runtimeAdapters.todos;
  let hasLocalTodoSnapshot = true;
  if (todoAdapter?.mode === "local" && todoAdapter.storageKey) {
    try { hasLocalTodoSnapshot = localStorage.getItem(todoAdapter.storageKey) !== null; }
    catch { hasLocalTodoSnapshot = false; }
  }
  const snapshots = await Promise.all(adapters.map(async (adapter) => [adapter, await adapter.load()]));
  const snapshotFor = (collection) => snapshots.find(([adapter]) => adapter === state.runtimeAdapters[collection])?.[1] || {};
  const todoSnapshot = snapshotFor("todos");
  const ticketSnapshot = snapshotFor("tickets");
  const itinerarySnapshot = snapshotFor("itinerary");
  state.todos = Array.isArray(todoSnapshot.todos) ? todoSnapshot.todos : [];
  state.itinerary = (Array.isArray(itinerarySnapshot.itinerary) ? itinerarySnapshot.itinerary : [])
    .map(normalizeItineraryRecord).filter(Boolean);
  const flightSnapshot = snapshotFor("flights");
  state.flights = (Array.isArray(flightSnapshot.flights) ? flightSnapshot.flights : [])
    .map(normalizeFlightRecord).filter(Boolean);
  state.purchasedTickets = new Set((Array.isArray(ticketSnapshot.tickets) ? ticketSnapshot.tickets : []).filter((item) => item.completed).map((item) => item.id));
  const authoredTodos = state.data.preTrip?.todoItems || state.data.preTrip?.packingItems || [];
  const sourceById = new Map(authoredTodos.map((item) => [String(item.id || ""), item]));

  // The pre-trip list is authored in trip-data.json, but `todos` is a shared
  // collection: once mode=d1 the module renders whatever the shared layer holds.
  // A freshly created D1 is empty, so the authored list has to be imported once
  // — otherwise the whole 行前准备 module silently reads as empty on the live
  // site while trip-data.json still looks complete.
  //
  // The two modes need different "have we imported yet?" guards, and they must
  // not share one: local mode already has an exact answer (is there a local
  // snapshot?), while D1 has no way to tell "never imported" from "user deleted
  // everything", so it uses a per-device flag. Keeping the flag out of local
  // mode matters because otherwise importing once under D1 would suppress the
  // import after switching persistence back to local, leaving the list empty.
  const seedFlagKey = `travel-plan:todos-seeded:v1:${String(state.data.metadata.tripId || "default")}`;
  let alreadySeeded = false;
  if (todoAdapter?.mode === "d1") {
    try { alreadySeeded = localStorage.getItem(seedFlagKey) === "1"; } catch { alreadySeeded = false; }
  }
  const needsImport = todoAdapter?.mode === "local" ? !hasLocalTodoSnapshot : !alreadySeeded;
  const shouldSeedTodos = Boolean(todoAdapter) && !state.todos.length && authoredTodos.length > 0 && needsImport;

  if (shouldSeedTodos) {
    const seedRecords = authoredTodos.map((item, index) => {
      const category = String(item.category || "其他");
      const owner = OWNER_SLOTS.includes(String(item.owner || ""))
        ? String(item.owner)
        : (isPerPersonCategory(category) ? "both" : "p1");
      return {
        id: String(item.id || `todo-initial-${index + 1}`),
        text: String(item.text || item.title || "").trim(),
        category,
        completed: Boolean(item.completed),
        owner
      };
    }).filter((item) => item.text);
    if (seedRecords.length) {
      // Chunked so one oversized request cannot fail the whole import. Every
      // record is an upsert keyed by its stable id, so a retry is idempotent.
      const SEED_CHUNK = 50;
      try {
        for (let offset = 0; offset < seedRecords.length; offset += SEED_CHUNK) {
          const chunk = seedRecords.slice(offset, offset + SEED_CHUNK);
          if (typeof todoAdapter.applyChanges === "function") {
            await todoAdapter.applyChanges("todos", chunk, "upsert");
          } else {
            await Promise.all(chunk.map((record) => todoAdapter.applyChange("todos", record, "upsert")));
          }
        }
        state.todos = seedRecords;
        // Latch the flag only after the import actually landed, so a failed or
        // offline first load retries instead of leaving the list permanently
        // empty. D1 only — see the guard comment above: writing it in local mode
        // would suppress the import after switching persistence to D1.
        if (todoAdapter.mode === "d1") {
          try { localStorage.setItem(seedFlagKey, "1"); } catch {}
        }
      } catch (error) {
        console.warn("TravelPlan could not import the authored pre-trip list into the shared layer.", error);
      }
    }
  } else if (sourceById.size) {
    // Reconcile a pre-existing browser snapshot with trip-data.json so grouped
    // headers + clean (prefix-free) names apply even for old saved snapshots.
    state.todos = state.todos.map((todo) => {
      const src = sourceById.get(String(todo.id || ""));
      let text = String(todo.text || "").trim();
      if (text.includes("：")) {
        const remainder = text.split("：").slice(1).join("：").trim();
        if (remainder) text = remainder;
      }
      const category = src ? String(src.category || "其他") : (todo.category || "其他");
      /* 分类以 trip-data.json 为权威（线上老数据的前缀是旧的：车载物品没编号、衣物类是 3.x），
         客户端会一并纠正；但 **owner 是用户可改的**，必须优先保留共享层里的值，
         否则用户在界面上改了责任人、刷新就被基线打回去了。 */
      const owner = OWNER_SLOTS.includes(String(todo.owner || ""))
        ? String(todo.owner)
        : (src && OWNER_SLOTS.includes(String(src.owner || "")) ? String(src.owner) : "p1");
      return { ...todo, text, category, owner, completed: Boolean(todo.completed ?? (src && src.completed)) };
    });
  }
}

async function saveSharedChange(collection, value, op = "upsert") {
  const adapter = state.runtimeAdapters[collection];
  if (!adapter) return null;
  return adapter.applyChange(collection, value, op);
}

function saveTodoState() { return Promise.all(state.todos.map((todo) => saveSharedChange("todos", todo))); }

const TODO_CATEGORY_ORDER = ["0.随身物品", "1.必带类", "2.准备类", "3.车载物品", "4.衣物类", "5.日用类", "6.食品及药品类", "7.相机类", "其他"];

/* 责任人（owner）：
   · p1 / p2 —— 指定的那个人负责，只有一个完成状态；
   · both    —— 两人各带一份，切到谁的视角就勾谁的那份（各存一个状态）。
   老记录没有 owner 字段，按旧的双人分类名兜底推断。 */
const LEGACY_PER_PERSON_CATEGORIES = Object.freeze(["1.必带类", "3.衣物类", "4.衣物类"]);
const PERSON_SLOTS = Object.freeze(["p1", "p2"]);
const OWNER_SLOTS = Object.freeze(["p1", "p2", "both"]);
const DEFAULT_PERSON_NAMES = Object.freeze(["我", "同行人"]);

function isPerPersonCategory(category) {
  return LEGACY_PER_PERSON_CATEGORIES.includes(String(category || ""));
}

/* Names come from the ledger's 同行人 list so the two modules agree on who is who.
   Renaming there changes the labels here; a trip with no travellers yet falls back
   to neutral labels rather than inventing names. */
function personNames() {
  let travelers = [];
  try {
    const snapshot = window.TravelLedger?.getSnapshot?.();
    travelers = Array.isArray(snapshot?.travelers) ? snapshot.travelers : [];
  } catch {
    travelers = [];
  }
  const named = travelers.map((traveler) => String(traveler?.name || "").trim()).filter(Boolean);
  return DEFAULT_PERSON_NAMES.map((fallback, index) => named[index] || fallback);
}

function normalizePersonSlots(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.fromEntries(PERSON_SLOTS.map((slot) => [slot, Boolean(raw[slot])]));
}

function personSlotsFor(todo) {
  const slots = normalizePersonSlots(todo?.completedBy);
  if (slots) return slots;
  /* Legacy record: one shared tick meant "packed", so credit both people. */
  return Object.fromEntries(PERSON_SLOTS.map((slot) => [slot, Boolean(todo?.completed)]));
}

function ownerFor(todo) {
  const raw = String(todo?.owner || "").trim();
  if (OWNER_SLOTS.includes(raw)) return raw;
  return isPerPersonCategory(todo?.category) ? "both" : "p1";
}

function ownerLabel(owner) {
  if (owner === "both") return "共同";
  return personNames()[owner === "p2" ? 1 : 0];
}

function todoCompleted(todo) {
  if (ownerFor(todo) !== "both") return Boolean(todo?.completed);
  const slots = personSlotsFor(todo);
  return PERSON_SLOTS.every((slot) => slots[slot]);
}

/* 「全部」视角看整体；切到某个人时只看他自己那份（各带一份的物品两人分别勾）。 */
function todoDoneInView(todo, view) {
  if (ownerFor(todo) === "both" && view !== "all") return Boolean(personSlotsFor(todo)[view]);
  return todoCompleted(todo);
}

function todoInView(todo, view) {
  if (view === "all") return true;
  const owner = ownerFor(todo);
  return owner === view || owner === "both";
}

function todoOwnerStats(slot) {
  const items = state.todos.filter((todo) => todoInView(todo, slot));
  return { done: items.filter((todo) => todoDoneInView(todo, slot)).length, total: items.length };
}

function todoItemMarkup(todo, names, view) {
  const owner = ownerFor(todo);
  const perPerson = owner === "both";
  const done = todoCompleted(todo);
  const slots = personSlotsFor(todo);
  const partial = perPerson && !done && PERSON_SLOTS.some((slot) => slots[slot]);

  /* 一行只有一个勾选框。「全部」视角下，两人各一份的项显示只读进度，
     想勾选就切到具体责任人——这样就不会再回到"一行两个框"的老样子。 */
  let control;
  if (perPerson && view === "all") {
    const ticked = PERSON_SLOTS.filter((slot) => slots[slot]).length;
    control = `<span class="todo-pair${ticked === PERSON_SLOTS.length ? " is-complete" : ""}" title="两人各一份，切到具体责任人分别勾选">${ticked}/${PERSON_SLOTS.length}</span>`;
  } else {
    const checked = perPerson ? Boolean(slots[view]) : Boolean(todo.completed);
    const who = perPerson ? names[view === "p2" ? 1 : 0] : "";
    control = `<label class="todo-box${checked ? " is-checked" : ""}"${who ? ` title="${escapeHtml(who)}"` : ""}>
        <input type="checkbox" data-todo-check ${checked ? "checked" : ""} aria-label="${escapeHtml(who || "完成")}：${escapeHtml(todo.text)}">
        <span class="todo-check" aria-hidden="true">✓</span>
        ${who ? `<span class="todo-box__name">${escapeHtml(who)}</span>` : ""}
      </label>`;
  }

  const options = [["p1", names[0]], ["p2", names[1]], ["both", "共同"]]
    .map(([value, label]) => `<option value="${value}"${value === owner ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");

  return `
    <div class="todo-item${done ? " is-complete" : ""}${partial ? " is-partial" : ""}${perPerson ? " is-per-person" : ""}" data-todo-id="${escapeHtml(todo.id)}" data-owner="${owner}">
      <div class="todo-item__main">${control}<span class="todo-text">${escapeHtml(todo.text)}</span></div>
      <label class="todo-owner" title="责任人"><span class="todo-owner__label">责任人</span>
        <select data-todo-owner aria-label="责任人：${escapeHtml(todo.text)}">${options}</select>
      </label>
      <button type="button" class="todo-delete" aria-label="删除：${escapeHtml(todo.text)}">删除</button>
    </div>`;
}

/* 责任人视角切换：按钮上直接给出各自的完成进度（需求②「按责任人展示准备情况」）。 */
function renderTodoOwners() {
  const container = $("#todo-owners");
  if (!container) return;
  const view = state.todoOwnerView || "all";
  const names = personNames();
  const tabs = [
    ["all", "全部", { done: state.todos.filter(todoCompleted).length, total: state.todos.length }],
    ["p1", names[0], todoOwnerStats("p1")],
    ["p2", names[1], todoOwnerStats("p2")]
  ];
  container.innerHTML = tabs.map(([value, label, stat]) =>
    `<button type="button" data-todo-view="${value}" aria-pressed="${view === value}">
      <span class="todo-owner-tab__name">${escapeHtml(label)}</span>
      <span class="todo-owner-tab__count">${stat.done} / ${stat.total}</span>
    </button>`).join("");
}

function renderTodoList() {
  const view = state.todoOwnerView || "all";
  const completed = state.todos.filter(todoCompleted).length;
  $("#todo-progress").textContent = `${completed} / ${state.todos.length}`;
  renderTodoOwners();
  if (!state.todos.length) {
    $("#todo-list").innerHTML = `<p class="todo-empty">还没有准备事项，添加第一项吧。</p>`;
    return;
  }
  const names = personNames();
  const groups = new Map();
  for (const todo of state.todos) {
    if (!todoInView(todo, view)) continue;
    const cat = todo.category || "其他";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(todo);
  }
  const orderedCats = TODO_CATEGORY_ORDER.filter((cat) => groups.has(cat));
  for (const cat of groups.keys()) {
    if (!orderedCats.includes(cat) && cat !== "其他") orderedCats.push(cat);
  }
  if (groups.has("其他")) orderedCats.push("其他");
  const filter = state.todoFilter || "all";
  const visibleCats = filter === "all" ? orderedCats : orderedCats.filter((cat) => cat === filter);
  const html = visibleCats.map((cat) => {
    const items = groups.get(cat);
    const done = items.filter((todo) => todoDoneInView(todo, view)).length;
    const hasPair = items.some((todo) => ownerFor(todo) === "both");
    return `<div class="todo-group${hasPair ? " is-per-person" : ""}">
      <div class="todo-group__head">
        <span class="todo-group__name">${escapeHtml(cat)}</span>
        <span class="todo-group__tools">
          <label class="todo-group-owner">
            <select data-group-owner data-group-category="${escapeHtml(cat)}" aria-label="批量设置「${escapeHtml(cat)}」全部条目的责任人">
              <option value="">批量责任人…</option>
              ${PERSON_SLOTS.map((slot, index) => `<option value="${slot}">${escapeHtml(names[index])}</option>`).join("")}
              <option value="both">共同</option>
            </select>
          </label>
          <span class="todo-group__count">${done} / ${items.length}</span>
        </span>
      </div>
      ${hasPair ? `<p class="todo-group__hint">标为「共同」的项两人各带一份，切到「${names.map((name) => escapeHtml(name)).join("」或「")}」左右各自勾选自己那份。</p>` : ""}
      ${items.map((todo) => todoItemMarkup(todo, names, view)).join("")}
    </div>`;
  }).join("");
  $("#todo-list").innerHTML = html || `<p class="todo-empty">该责任人名下暂无准备事项。</p>`;
}

function renderTodoFilters() {
  const container = $("#todo-filters");
  if (!container) return;
  const groups = new Map();
  for (const todo of state.todos) {
    const cat = todo.category || "其他";
    groups.set(cat, (groups.get(cat) || 0) + 1);
  }
  const ordered = TODO_CATEGORY_ORDER.filter((cat) => groups.has(cat));
  for (const cat of groups.keys()) {
    if (!ordered.includes(cat) && cat !== "其他") ordered.push(cat);
  }
  if (groups.has("其他")) ordered.push("其他");
  const stripPrefix = (label) => label.replace(/^\d+\.\s*/, "");
  const buttons = [`<button type="button" data-todo-filter="all" aria-pressed="${state.todoFilter === "all"}">总览</button>`]
    .concat(ordered.map((cat) => `<button type="button" data-todo-filter="${escapeHtml(cat)}" aria-pressed="${state.todoFilter === cat}">${escapeHtml(stripPrefix(cat))}</button>`));
  container.innerHTML = buttons.join("");
  container.onclick = (event) => {
    const button = event.target.closest("[data-todo-filter]");
    if (!button) return;
    state.todoFilter = button.dataset.todoFilter;
    $$("button", container).forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
    renderTodoList();
  };
}

/* 一键把某个分类下的全部条目划给同一位责任人（需求 2）。
   日用类有 65 条，用 applyChanges 一次批量写，绝不逐条 POST。 */
function bulkSetTodoOwner(category, owner) {
  const changed = [];
  for (const todo of state.todos) {
    if ((todo.category || "其他") !== category) continue;
    const wasPair = ownerFor(todo) === "both";
    todo.owner = owner;
    if (owner === "both") {
      const slots = personSlotsFor(todo);
      if (todo.completed) slots.p1 = true;
      todo.completedBy = slots;
      todo.completed = PERSON_SLOTS.every((slot) => slots[slot]);
    } else {
      /* 从「共同」改单人有沿用规则：保留第一人的勾选状态，避免整组凭空完成。 */
      if (wasPair) todo.completed = Boolean(personSlotsFor(todo).p1);
      delete todo.completedBy;
    }
    changed.push(todo);
  }
  if (!changed.length) return;
  const adapter = state.runtimeAdapters.todos;
  if (adapter?.applyChanges) {
    adapter.applyChanges("todos", changed, "upsert").catch((error) => console.error("批量责任人没有同步到共享层。", error));
  } else {
    changed.forEach((todo) => saveSharedChange("todos", todo).catch(console.error));
  }
  renderTodoList();
}

function renderTravelPrep() {
  renderTodoFilters();
  renderTodoList();
  const ownersBar = $("#todo-owners");
  if (ownersBar) ownersBar.onclick = (event) => {
    const button = event.target.closest("[data-todo-view]");
    if (!button) return;
    state.todoOwnerView = button.dataset.todoView;
    renderTodoList();
  };
  $("#todo-form").onsubmit = (event) => {
    event.preventDefault();
    const input = $("#todo-input");
    const text = input.value.trim();
    if (!text) return;
    /* 新增项默认归当前正在看的那个责任人，省一次切换。 */
    const owner = state.todoOwnerView === "p2" ? "p2" : "p1";
    state.todos.push({ id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, category: "其他", completed: false, owner });
    input.value = "";
    saveSharedChange("todos", state.todos.at(-1)).catch(console.error);
    renderTodoList();
  };
  $("#todo-list").onchange = (event) => {
    const groupSelect = event.target.closest("[data-group-owner]");
    if (groupSelect) {
      const owner = groupSelect.value;
      groupSelect.value = "";
      if (OWNER_SLOTS.includes(owner)) bulkSetTodoOwner(groupSelect.dataset.groupCategory, owner);
      return;
    }
    const item = event.target.closest("[data-todo-id]");
    if (!item) return;
    const todo = state.todos.find((entry) => entry.id === item.dataset.todoId);
    if (!todo) return;

    if (event.target.matches("[data-todo-owner]")) {
      const wasPair = ownerFor(todo) === "both";
      const requested = event.target.value;
      todo.owner = OWNER_SLOTS.includes(requested) ? requested : "p1";
      if (todo.owner === "both") {
        const slots = personSlotsFor(todo);
        if (todo.completed) slots.p1 = true;
        todo.completedBy = slots;
        todo.completed = PERSON_SLOTS.every((slot) => slots[slot]);
      } else {
        /* 从「两人各一份」改成单人负责：沿用第一个人的状态，避免白丢一次勾选。 */
        if (wasPair) todo.completed = Boolean(personSlotsFor(todo).p1);
        delete todo.completedBy;
      }
      saveSharedChange("todos", todo).catch(console.error);
      renderTodoList();
      return;
    }

    if (!event.target.matches("input[type='checkbox']")) return;
    const view = state.todoOwnerView || "all";
    if (ownerFor(todo) === "both" && view !== "all") {
      const slots = { ...personSlotsFor(todo), [view]: event.target.checked };
      todo.completedBy = slots;
      /* Keep the plain flag in sync so the stored record stays readable on its own. */
      todo.completed = PERSON_SLOTS.every((slot) => slots[slot]);
    } else {
      todo.completed = event.target.checked;
      delete todo.completedBy;
    }
    saveSharedChange("todos", todo).catch(console.error);
    renderTodoList();
  };
  $("#todo-list").onclick = (event) => {
    const button = event.target.closest(".todo-delete");
    if (!button) return;
    const item = button.closest("[data-todo-id]");
    state.todos = state.todos.filter((todo) => todo.id !== item.dataset.todoId);
    saveSharedChange("todos", { id: item.dataset.todoId }, "delete").catch(console.error);
    renderTodoList();
  };
}

function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function localAssetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin ? url.href : "";
  } catch {
    return "";
  }
}

let ticketDialogOpener = null;

function openTicketDialog(ticketId, opener) {
  const ticket = state.data.ticketPlanning?.items?.find((item) => item.id === ticketId);
  const dialog = $("#ticket-dialog");
  if (!ticket || !dialog) return;
  ticketDialogOpener = opener || null;
  $("#ticket-dialog-title").textContent = ticketTitle(ticket);
  const document = ticketDocument(ticket);
  const localDocument = localAssetUrl(document?.url);
  const externalDocument = !localDocument ? safeExternalUrl(document?.url) : "";
  const officialUrl = safeExternalUrl(ticket.officialUrl || ticket.booking?.officialUrl || ticket.booking?.purchaseUrl);
  const extension = localDocument.split(/[?#]/)[0].split(".").at(-1)?.toLocaleLowerCase();
  let preview = "";
  if (localDocument && ["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) {
    preview = `<img class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" alt="${escapeHtml(ticketTitle(ticket))}">`;
  } else if (localDocument) {
    preview = `<iframe class="ticket-dialog__preview" src="${escapeHtml(localDocument)}" title="${escapeHtml(ticketTitle(ticket))}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`;
  }
  const links = [
    localDocument ? `<a href="${escapeHtml(localDocument)}" target="_blank" rel="noopener noreferrer">在新窗口打开票据 ↗</a>` : "",
    externalDocument ? `<a href="${escapeHtml(externalDocument)}" target="_blank" rel="noopener noreferrer">${escapeHtml(document?.label || "查看票据")} ↗</a>` : "",
    officialUrl ? `<a href="${escapeHtml(officialUrl)}" target="_blank" rel="noopener noreferrer">打开官方页面 ↗</a>` : ""
  ].filter(Boolean).join("");
  $("#ticket-dialog-body").innerHTML = `
    <p class="ticket-dialog__status">${escapeHtml(isTicketPurchased(ticket) ? "已标记购票" : ticketRequirement(ticket))}</p>
    ${ticketGuidance(ticket) ? `<p class="ticket-dialog__guidance">${escapeHtml(ticketGuidance(ticket))}</p>` : ""}
    ${preview || (!links ? `<p class="ticket-dialog__empty">当前没有可预览的票据文件或官方链接。</p>` : "")}
    ${links ? `<div class="ticket-dialog__links">${links}</div>` : ""}`;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#ticket-dialog-close").focus();
}

function setupTicketDialog() {
  const dialog = $("#ticket-dialog");
  if (!dialog) return;
  const close = () => {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  };
  $("#ticket-dialog-close").onclick = close;
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("close", () => {
    const body = $("#ticket-dialog-body");
    if (!body.querySelector(".ticket-dialog__preview--pdf")) body.replaceChildren();
    ticketDialogOpener?.focus({ preventScroll: true });
    ticketDialogOpener = null;
  });
}

function setupPlaceMap() {
  const panel = $("#place-map");
  const frame = $("#place-map-frame");
  let opener;
  let previousOverflow = "";
  const close = () => {
    panel.hidden = true;
    frame.src = "about:blank";
    document.body.style.overflow = previousOverflow;
    opener?.focus();
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest("button[data-map-query]");
    if (!link) return;
    event.preventDefault();
    opener = link;
    $("#place-map-title").textContent = link.dataset.mapLabel;
    $("#place-map-external").href = safeExternalUrl(link.dataset.mapUrl) || mapsSearch(link.dataset.mapQuery);
    frame.title = `${link.dataset.mapLabel} Google Maps`;
    frame.src = `https://maps.google.com/maps?q=${encodeURIComponent(link.dataset.mapQuery)}&output=embed`;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.hidden = false;
    $("#place-map-close").focus();
  });
  $("#place-map-close").onclick = close;
  panel.addEventListener("click", (event) => { if (event.target === panel) close(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const first = $("#place-map-close");
      const last = $("#place-map-external");
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
}

/* ===== 每日天气：按需向 Open-Meteo 拉取最新预报 =====
   选它是因为免费、无需 API key，且允许浏览器直接跨域调用，不需要后端代理。
   中文地名无法直接检索，所以为 trip-data.json 出现过的地点各留一组坐标。 */
const WEATHER_COORDS = Object.freeze({
  "香港西九龙": [22.3049, 114.1687],
  "香港机场": [22.3080, 113.9185],
  "奥克兰": [-36.8485, 174.7633],
  "基督城": [-43.5321, 172.6362],
  "特卡波": [-44.0050, 170.4780],
  "库克山": [-43.7340, 170.0960],
  "普卡基湖": [-44.1900, 170.1300],
  "瓦纳卡": [-44.7000, 169.1500],
  "皇后镇": [-45.0312, 168.6626],
  "格林诺奇": [-44.8500, 168.3833],
  "但尼丁": [-45.8788, 170.5028],
  "奥马鲁": [-45.0966, 170.9710]
});

/* WMO 天气代码 → 中文描述与图标（Open-Meteo 用 WMO code 表示天气现象）。 */
const WMO_WEATHER = Object.freeze({
  0: ["晴", "☀️"], 1: ["大致晴朗", "🌤️"], 2: ["局部多云", "⛅"], 3: ["多云", "☁️"],
  45: ["有雾", "🌫️"], 48: ["雾凇", "🌫️"],
  51: ["轻微毛毛雨", "🌦️"], 53: ["毛毛雨", "🌦️"], 55: ["较强毛毛雨", "🌧️"],
  56: ["冻毛毛雨", "🌧️"], 57: ["强冻毛毛雨", "🌧️"],
  61: ["小雨", "🌦️"], 63: ["中雨", "🌧️"], 65: ["大雨", "🌧️"],
  66: ["冻雨", "🌧️"], 67: ["强冻雨", "🌧️"],
  71: ["小雪", "🌨️"], 73: ["中雪", "🌨️"], 75: ["大雪", "❄️"], 77: ["雪粒", "🌨️"],
  80: ["阵雨", "🌦️"], 81: ["中等阵雨", "🌧️"], 82: ["强阵雨", "⛈️"],
  85: ["阵雪", "🌨️"], 86: ["强阵雪", "❄️"],
  95: ["雷雨", "⛈️"], 96: ["雷雨伴冰雹", "⛈️"], 99: ["强雷雨伴冰雹", "⛈️"]
});

const WEATHER_CACHE_KEY = "travel-plan:weather-cache:v1";
/* 预报本身会过期，缓存只用于避免「刚更新完一刷新就退回原始值」，3 小时足够。 */
const WEATHER_CACHE_MAX_AGE = 3 * 60 * 60 * 1000;

const weatherCoordinates = (name) => WEATHER_COORDS[String(name || "").trim()] || null;
const describeWeatherCode = (code) => WMO_WEATHER[Number(code)] || ["—", "🌡️"];

function setWeatherNote(text, isError = false) {
  const note = $("#weather-note");
  if (!note) return;
  note.textContent = text || "";
  note.classList.toggle("is-error", Boolean(isError));
}

function formatWeatherTime(timestamp) {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function restoreWeatherCache() {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.weather) || Date.now() - Number(parsed.at || 0) > WEATHER_CACHE_MAX_AGE) return;
    state.data.weather = parsed.weather;
    state.weatherUpdatedAt = Number(parsed.at) || Date.now();
  } catch { /* 缓存损坏就当没有，回落原始预报 */ }
}

function saveWeatherCache() {
  try { localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), weather: state.data.weather })); }
  catch { /* 隐私模式写不了，忽略 */ }
}

async function requestWeather(lat, lon, startDate, endDate) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`天气服务返回 ${response.status}`);
  const payload = await response.json();
  const daily = payload?.daily;
  if (!daily?.time?.length) throw new Error("天气服务未返回数据（行程日期可能已超出预报范围）");
  const byDate = new Map();
  daily.time.forEach((date, index) => {
    byDate.set(date, {
      high: daily.temperature_2m_max?.[index],
      low: daily.temperature_2m_min?.[index],
      precip: daily.precipitation_probability_max?.[index],
      code: daily.weather_code?.[index]
    });
  });
  return byDate;
}

async function refreshWeather() {
  const button = $("#weather-refresh");
  if (button) { button.disabled = true; button.textContent = "更新中…"; }
  setWeatherNote("正在获取最新预报…");
  try {
    const authored = state.authoredWeather?.length ? state.authoredWeather : (state.data.weather || []);
    /* 先按地点归并需要查询的日期范围：同一个地点只发一次请求，而不是每格发一次。 */
    const spans = new Map();
    for (const day of authored) {
      for (const location of day.locations || []) {
        const name = String(location.location || "").trim();
        if (!weatherCoordinates(name)) continue;
        const span = spans.get(name) || { start: day.date, end: day.date };
        if (day.date < span.start) span.start = day.date;
        if (day.date > span.end) span.end = day.date;
        spans.set(name, span);
      }
    }
    if (!spans.size) throw new Error("没有匹配到可查询的地点坐标");

    const results = new Map();
    await Promise.all([...spans].map(async ([name, span]) => {
      const [lat, lon] = weatherCoordinates(name);
      results.set(name, await requestWeather(lat, lon, span.start, span.end));
    }));

    state.data.weather = authored.map((day) => ({
      ...day,
      locations: (day.locations || []).map((location) => {
        const found = results.get(String(location.location || "").trim())?.get(day.date);
        if (!found) return location;
        const [condition, icon] = describeWeatherCode(found.code);
        return {
          ...location,
          condition,
          icon,
          tempHigh: Number.isFinite(found.high) ? Math.round(found.high) : location.tempHigh,
          tempLow: Number.isFinite(found.low) ? Math.round(found.low) : location.tempLow,
          precip: Number.isFinite(found.precip) ? Math.round(found.precip) : location.precip
        };
      })
    }));
    state.weatherUpdatedAt = Date.now();
    saveWeatherCache();
    renderWeather();
    setWeatherNote(`已更新 · ${formatWeatherTime(state.weatherUpdatedAt)}`);
  } catch (error) {
    console.error("天气更新失败", error);
    setWeatherNote(`更新失败：${error.message || error}`, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = "更新天气"; }
  }
}

/* ---------- 住宿安排 / 门票预订：卡片轮播，交互对齐航班行程 ---------- */

/* 航班轮播的「滑动 → 高亮圆点 + 序号」逻辑在这里是同一套，抽成通用绑定。 */
function bindSimpleCarousel(carouselId, dotsId, indexId, total) {
  const carousel = $(`#${carouselId}`);
  if (!carousel) return;
  let scheduled = false;
  carousel.onscroll = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const cards = [...carousel.children];
      if (!cards.length) return;
      const center = carousel.scrollLeft + carousel.clientWidth / 2;
      let activeIndex = 0;
      let distance = Infinity;
      cards.forEach((card, index) => {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        if (Math.abs(cardCenter - center) < distance) {
          distance = Math.abs(cardCenter - center);
          activeIndex = index;
        }
      });
      $(`#${dotsId}`).innerHTML = cards.map((_, index) =>
        `<span class="carousel-dot${index === activeIndex ? " is-active" : ""}"></span>`).join("");
      if (indexId) $(`#${indexId}`).textContent = `${activeIndex + 1} / ${total}`;
    });
  };
}

function stayNights(accommodation) {
  const checkIn = Date.parse(`${accommodation.checkIn}T12:00:00`);
  const checkOut = Date.parse(`${accommodation.checkOut}T12:00:00`);
  if (Number.isNaN(checkIn) || Number.isNaN(checkOut)) return null;
  return Math.max(Math.round((checkOut - checkIn) / 86400000), 0);
}

function stayCard(accommodation, index, total) {
  const nights = stayNights(accommodation);
  return `
    <article class="flight-card stay-card" data-stay="${escapeHtml(accommodation.id)}">
      <div class="flight-card__top"><span>STAY ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span></div>
      <div class="stay-card__name">${escapeHtml(accommodation.name)}</div>
      <div class="stay-card__dates">
        <span>入住 ${escapeHtml(formatCompactDate(accommodation.checkIn))}</span>
        <i aria-hidden="true">→</i>
        <span>退房 ${escapeHtml(formatCompactDate(accommodation.checkOut))}</span>
        ${nights != null ? `<b>${nights} 晚</b>` : ""}
      </div>
      ${accommodation.note ? `<p class="stay-card__note">${escapeHtml(accommodation.note)}</p>` : ""}
    </article>`;
}

function renderStay() {
  const carousel = $("#stay-carousel");
  if (!carousel) return;
  const list = state.data.accommodations || [];
  carousel.innerHTML = list.length
    ? list.map((item, index) => stayCard(item, index, list.length)).join("")
    : `<article class="flight-card flight-card--placeholder"><div class="flight-placeholder"><span class="flight-placeholder__eyebrow">资料待补充</span><h3>住宿信息待补充</h3><p>系统没有猜测或伪造缺失的住宿事实。</p></div></article>`;
  $("#stay-index").textContent = `1 / ${Math.max(list.length, 1)}`;
  bindSimpleCarousel("stay-carousel", "stay-dots", "stay-index", Math.max(list.length, 1));
}

function renderTickets() {
  const carousel = $("#tickets-carousel");
  if (!carousel) return;
  const items = state.data.ticketPlanning?.items || [];
  carousel.innerHTML = items.length
    ? items.map((ticket, index) => ticketPlanCard(ticket, index, items.length)).join("")
    : `<article class="flight-card flight-card--placeholder"><div class="flight-placeholder"><span class="flight-placeholder__eyebrow">资料待补充</span><h3>门票信息待补充</h3><p>确定要预约的景点后，在 trip-data.json 的 ticketPlanning.items 里补充名称、日期与购票要求，这里会自动生成卡片。</p></div></article>`;
  $("#tickets-index").textContent = `1 / ${Math.max(items.length, 1)}`;
  bindSimpleCarousel("tickets-carousel", "tickets-dots", "tickets-index", Math.max(items.length, 1));
  carousel.onclick = (event) => {
    const button = event.target.closest("[data-ticket-open]");
    if (button) openTicketDialog(button.dataset.ticketOpen, button);
  };
}

function ticketPlanCard(ticket, index, total) {
  const purchased = isTicketPurchased(ticket);
  return `
    <article class="flight-card ticketplan-card${purchased ? " is-purchased" : ""}" data-plan-ticket="${escapeHtml(ticket.id)}">
      <div class="flight-card__top"><span>TICKET ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span></div>
      <div class="stay-card__name">${escapeHtml(ticketTitle(ticket))}</div>
      <div class="ticketplan-card__meta">
        <span class="ticketplan-card__status">${purchased ? "已购票" : escapeHtml(ticketRequirement(ticket))}</span>
        ${ticket.day ? `<span>DAY ${String(ticket.day).padStart(2, "0")}</span>` : ""}
      </div>
      ${ticketGuidance(ticket) ? `<p class="stay-card__note">${escapeHtml(ticketGuidance(ticket))}</p>` : ""}
      <button type="button" class="schedule-ticket__open" data-ticket-open="${escapeHtml(ticket.id)}" aria-haspopup="dialog" aria-controls="ticket-dialog">查看详情</button>
    </article>`;
}

function renderWeather() {
  const weather = state.data.weather || [];
  if (!weather.length) {
    const section = $("#weather");
    if (section) section.hidden = true;
    return;
  }
  /* 用 onclick 赋值而非 addEventListener：更新完成后会再次调用 renderWeather。 */
  const refreshButton = $("#weather-refresh");
  if (refreshButton) refreshButton.onclick = () => refreshWeather();
  setWeatherNote(state.weatherUpdatedAt ? `已更新 · ${formatWeatherTime(state.weatherUpdatedAt)}` : "");
  $("#weather-range").textContent = `${formatCompactDate(weather[0].date)} — ${formatCompactDate(weather[weather.length - 1].date)}`;
  $("#weather-grid").innerHTML = weather.map((day) => `
    <div class="weather-day">
      <div class="weather-day__head"><span>DAY ${String(day.day).padStart(2, "0")} · ${escapeHtml(formatCompactDate(day.date))}</span></div>
      <div class="weather-day__locs">
        ${day.locations.map((w) => `
          <div class="weather-loc">
            <span class="weather-loc__name">${escapeHtml(w.location)}</span>
            <span class="weather-loc__icon" aria-hidden="true">${escapeHtml(w.icon || "🌡️")}</span>
            <span class="weather-loc__cond">${escapeHtml(w.condition || "")}</span>
            <span class="weather-loc__temp"><span class="hi">${w.tempHigh != null ? `${w.tempHigh}°` : "—"}</span><span class="lo">${w.tempLow != null ? `${w.tempLow}°` : "—"}</span></span>
            ${w.precip != null ? `<span class="weather-loc__precip">降水 ${w.precip}%</span>` : ""}
          </div>`).join("")}
      </div>
    </div>`).join("");
}

function startCountdowns() {
  if (moduleEnabled("flights")) updateFlightCountdowns();
  if (moduleEnabled("driving")) updateRentalCountdown();
  if (state.focusTarget) updateFocusCountdown();
  if (moduleEnabled("flights") || moduleEnabled("driving") || state.focusTarget) {
    state.countdownTimer = window.setInterval(() => {
      if (moduleEnabled("flights")) updateFlightCountdowns();
      if (moduleEnabled("driving")) updateRentalCountdown();
      if (state.focusTarget) updateFocusCountdown();
    }, 1000);
  }
}

function preloadDefaultRouteMap() {
  const routeMap = state.data?.routeMap;
  const source = travelMapSource(routeMap, routeMap?.defaultRegionId);
  if (!source?.baseImage) return;
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = "high";
  image.src = source.baseImage;
  state.routeMapPreload = image;
}

async function init() {
  try {
    const response = await fetch("trip-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.config = normalizeTripConfig(state.data.config);
    /* 留一份原始预报做基线：天气更新只改 state.data.weather，反复更新不会逐次叠加。 */
    state.authoredWeather = state.data.weather || [];
    window.TRAVEL_PLAN_CONFIG = state.config;
    window.TRAVEL_PLAN_DATA = state.data;
    document.dispatchEvent(new CustomEvent("travel-data-ready", { detail: state.data }));
    applyModuleConfig();
    if (moduleEnabled("overview")) preloadDefaultRouteMap();
    renderHero();
    if (moduleEnabled("flights")) renderFlights();
    if (moduleEnabled("overview")) setupRouteExplorer();
    if (moduleEnabled("itinerary")) {
      setupPlaceMap();
      setupTicketDialog();
    }
    if (moduleEnabled("todo") || moduleEnabled("itinerary")) {
      createRuntimeAdapters();
      try {
        await loadSharedState();
      } catch (error) {
        console.error(`${state.config.persistence.mode === "d1" ? "Shared" : "Local"} runtime data could not be loaded`, error);
        state.todos = [];
        state.itinerary = [];
        state.flights = [];
        state.purchasedTickets = new Set();
      }
    }
    if (moduleEnabled("itinerary")) renderTimeline();
    restoreWeatherCache();
    if (state.data.weather?.length) renderWeather();
    renderStay();
    renderTickets();
    if (moduleEnabled("driving")) renderRental();
    if (moduleEnabled("todo")) renderTravelPrep();
    renderFocus();
    if (moduleEnabled("ledger")) {
      await window.TravelLedger?.init?.({ tripId: state.data.metadata.tripId, config: state.config });
      /* 行前准备 borrows the ledger's 同行人 names, and it rendered before the ledger
         had loaded — repaint now that the names are actually available, and again
         whenever someone is added or renamed. */
      if (moduleEnabled("todo")) {
        renderTravelPrep();
        if (!state.prepNameListenerBound) {
          state.prepNameListenerBound = true;
          document.addEventListener("travel-ledger:changed", () => {
            if (moduleEnabled("todo")) renderTravelPrep();
          });
        }
      }
    }
    if (window.TravelDining?.init) {
      const persistence = state.config.persistence || { mode: "local" };
      const diningShared = persistence.mode === "d1"
        && Array.isArray(persistence.sharedCollections)
        && persistence.sharedCollections.includes("dining");
      await window.TravelDining.init({
        tripId: state.data.metadata.tripId,
        config: state.config,
        persistence: diningShared
          ? { mode: "d1", apiBase: persistence.apiBase || "/api/trip" }
          : { mode: "local" },
        cities: ["深圳", "香港", ...(state.data.trip?.citiesAndAreas || [])],
        days: state.data.days
      });
    }
    startCountdowns();
  } catch (error) {
    console.error("Travel data could not be loaded", error);
    $("#loading-error").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
