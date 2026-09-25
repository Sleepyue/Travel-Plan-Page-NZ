(() => {
  "use strict";

  const STORAGE_VERSION = 1;
  const DEFAULT_KEY_PREFIX = "travel-plan:runtime:v1";
  const RECORD_COLLECTIONS = Object.freeze([
    "bills",
    "travelers",
    "todos",
    "tickets",
    "itinerary",
    "flights",
    "accommodations",
    "ticketPlans",
    "diningRestaurants",
    "diningRecords"
  ]);
  const SUPPORTED_COLLECTIONS = new Set([...RECORD_COLLECTIONS, "settings"]);
  /* settings 在共享层是「单例记录」：库里只有一行，id 固定。服务端也按这个 id 归一化。 */
  const SETTINGS_RECORD_ID = "settings";

  function deepClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function emptySnapshot() {
    return {
      version: STORAGE_VERSION,
      settings: null,
      bills: [],
      travelers: [],
      todos: [],
      tickets: [],
      itinerary: [],
      flights: [],
      accommodations: [],
      ticketPlans: [],
      diningRestaurants: [],
      diningRecords: [],
      updatedAt: new Date().toISOString()
    };
  }

  function normalizeSnapshot(raw) {
    const fallback = emptySnapshot();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
    return {
      ...raw,
      version: Number.isSafeInteger(raw.version) ? raw.version : STORAGE_VERSION,
      settings: raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
        ? deepClone(raw.settings)
        : null,
      bills: Array.isArray(raw.bills) ? deepClone(raw.bills) : [],
      travelers: Array.isArray(raw.travelers) ? deepClone(raw.travelers) : [],
      todos: Array.isArray(raw.todos) ? deepClone(raw.todos) : [],
      tickets: Array.isArray(raw.tickets) ? deepClone(raw.tickets) : [],
      itinerary: Array.isArray(raw.itinerary) ? deepClone(raw.itinerary) : [],
      flights: Array.isArray(raw.flights) ? deepClone(raw.flights) : [],
      accommodations: Array.isArray(raw.accommodations) ? deepClone(raw.accommodations) : [],
      ticketPlans: Array.isArray(raw.ticketPlans) ? deepClone(raw.ticketPlans) : [],
      diningRestaurants: Array.isArray(raw.diningRestaurants) ? deepClone(raw.diningRestaurants) : [],
      diningRecords: Array.isArray(raw.diningRecords) ? deepClone(raw.diningRecords) : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt
    };
  }

  function normalizeMode(mode) {
    return String(mode || "").trim().toLowerCase() === "d1" ? "d1" : "local";
  }

  function normalizeCollections(collections, fallback = []) {
    if (!Array.isArray(collections) || !collections.length) return [...fallback];
    const selected = [...new Set(collections.filter((collection) => SUPPORTED_COLLECTIONS.has(collection)))];
    return selected;
  }

  function normalizeApiBase(value = "/api/trip") {
    const raw = String(value || "").trim();
    if (!/^\/(?!\/)/.test(raw) || raw.includes("\\") || /[?#]/.test(raw)) {
      throw new Error("D1 apiBase must be a same-origin absolute path");
    }
    return raw.replace(/\/+$/, "") || "/";
  }

  function scopeSnapshot(raw, ownedCollections) {
    const snapshot = normalizeSnapshot(raw);
    if (!ownedCollections.includes("settings")) snapshot.settings = null;
    RECORD_COLLECTIONS.forEach((collection) => {
      if (!ownedCollections.includes(collection)) snapshot[collection] = [];
    });
    return snapshot;
  }

  function normalizeTripId(value) {
    const tripId = String(value || "").trim();
    return tripId || "default-trip";
  }

  function makeStorageKey(tripId, prefix = DEFAULT_KEY_PREFIX) {
    return `${String(prefix || DEFAULT_KEY_PREFIX)}:${encodeURIComponent(normalizeTripId(tripId))}`;
  }

  function resolveStorage(candidate) {
    if (candidate) return candidate;
    try {
      return globalThis.localStorage || null;
    } catch {
      return null;
    }
  }

  function updateSnapshot(snapshot, collection, value, op = "upsert") {
    if (!SUPPORTED_COLLECTIONS.has(collection)) {
      throw new Error(`Unsupported runtime collection: ${collection}`);
    }
    if (!["upsert", "delete"].includes(op)) {
      throw new Error(`Unsupported runtime operation: ${op}`);
    }
    const next = normalizeSnapshot(snapshot);
    if (collection === "settings") {
      next.settings = op === "delete" ? null : deepClone(value || {});
    } else {
      const id = String(typeof value === "object" && value !== null ? value.id || "" : value || "").trim();
      if (!id) throw new Error(`${collection} records require a stable id`);
      const index = next[collection].findIndex((item) => String(item?.id || "") === id);
      if (op === "delete") {
        if (index >= 0) next[collection].splice(index, 1);
      } else {
        const record = { ...deepClone(value), id };
        if (index >= 0) next[collection][index] = record;
        else next[collection].push(record);
      }
    }
    next.version = STORAGE_VERSION;
    next.updatedAt = new Date().toISOString();
    return next;
  }

  function createLocalAdapter(options = {}) {
    const tripId = normalizeTripId(options.tripId);
    const storageKey = options.storageKey || makeStorageKey(tripId, options.storageKeyPrefix);
    let storage = resolveStorage(options.storage);
    let memorySnapshot = null;
    let queue = Promise.resolve();
    const ownedCollections = normalizeCollections(options.collections, [...SUPPORTED_COLLECTIONS]);

    function readStoredSnapshot() {
      if (!storage) return memorySnapshot ? normalizeSnapshot(memorySnapshot) : emptySnapshot();
      try {
        const serialized = storage.getItem(storageKey);
        if (!serialized) return memorySnapshot ? normalizeSnapshot(memorySnapshot) : emptySnapshot();
        const parsed = JSON.parse(serialized);
        memorySnapshot = normalizeSnapshot(parsed);
        return normalizeSnapshot(memorySnapshot);
      } catch (error) {
        console.warn("TravelRuntimeStorage could not read localStorage; using memory for this tab.", error);
        storage = null;
        return memorySnapshot ? normalizeSnapshot(memorySnapshot) : emptySnapshot();
      }
    }

    function persistSnapshot(snapshot) {
      const normalized = normalizeSnapshot(snapshot);
      memorySnapshot = normalized;
      if (storage) {
        try {
          storage.setItem(storageKey, JSON.stringify(normalized));
        } catch (error) {
          console.warn("TravelRuntimeStorage could not write localStorage; using memory for this tab.", error);
          storage = null;
        }
      }
      return normalizeSnapshot(normalized);
    }

    function enqueue(operation) {
      const pending = queue.then(operation, operation);
      queue = pending.catch(() => {});
      return pending;
    }

    // Apply many records against one snapshot and persist once. The authored
    // pre-trip list is 150+ records; going through applyChange per record would
    // rewrite localStorage once per record.
    function applyLocalChanges(collection, values, op) {
      let stored = readStoredSnapshot();
      for (const value of values) stored = updateSnapshot(stored, collection, value, op);
      return persistSnapshot(stored);
    }

    return {
      mode: "local",
      tripId,
      storageKey,
      async load() {
        return readStoredSnapshot();
      },
      async save(snapshot) {
        return enqueue(() => {
          const stored = readStoredSnapshot();
          const incoming = normalizeSnapshot(snapshot);
          for (const collection of ownedCollections) {
            stored[collection] = deepClone(incoming[collection]);
          }
          stored.version = STORAGE_VERSION;
          stored.updatedAt = incoming.updatedAt;
          const saved = persistSnapshot(stored);
          Object.assign(snapshot, saved);
          return saved;
        });
      },
      async applyChange(collection, value, op = "upsert") {
        return enqueue(() => applyLocalChanges(collection, [value], op));
      },
      async applyChanges(collection, values, op = "upsert") {
        return enqueue(() => applyLocalChanges(collection, Array.isArray(values) ? values : [values], op));
      }
    };
  }

  function createD1Adapter(options = {}) {
    const tripId = normalizeTripId(options.tripId);
    const apiBase = normalizeApiBase(options.apiBase || "/api/trip");
    const ownedCollections = normalizeCollections(options.collections);
    const ownedRecordCollections = RECORD_COLLECTIONS.filter((collection) => ownedCollections.includes(collection));
    const ownsSettings = ownedCollections.includes("settings");
    if (!ownedRecordCollections.length && !ownsSettings) {
      throw new Error("D1 mode requires an explicit shared record collection allowlist");
    }
    /* settings（本位币 / 常用外币 / 消费类型）以前只存本机，导致「我加的消费类型，同行人那边选不到」。
       现在它作为**单例记录**跟其他集合走同一条共享通道（id 固定 "settings"），跨设备同步。
       本机那份仍保留，作用有二：① 离线/首屏兜底；② 作为老数据的**迁移来源**（见 mergeSettings）。 */
    const settingsAdapter = createLocalAdapter({
      tripId,
      storage: options.storage,
      storageKey: options.settingsStorageKey,
      storageKeyPrefix: options.storageKeyPrefix || `${DEFAULT_KEY_PREFIX}:d1-settings`,
      collections: ["settings"]
    });
    /* 请求时把 settings 一并取回（服务端会以对象形式返回，而非数组）。 */
    const requestedCollections = [...ownedRecordCollections, ...(ownsSettings ? ["settings"] : [])];
    let pendingSettingsSeed = null;
    let previous = null;
    let queue = Promise.resolve();

    function endpoint() {
      return `${apiBase}/${encodeURIComponent(tripId)}?collections=${encodeURIComponent(requestedCollections.join(","))}`;
    }

    /* 合并远端快照里的 settings：
       · 远端有 → **以远端为准**（多端共享的真相），顺手刷新本机缓存供离线使用；
       · 远端没有但本机有 → 是「改动前的老数据」，先用本机值兜底（页面配置不丢），
         并记下来稍后上推一次，两台设备即可收敛到同一份。 */
    async function mergeSettings(remote) {
      const snapshot = scopeSnapshot(remote, ownedCollections);
      if (!ownsSettings) return snapshot;
      const remoteSettings = snapshot.settings && typeof snapshot.settings === "object" ? snapshot.settings : null;
      if (remoteSettings) {
        settingsAdapter.applyChange("settings", remoteSettings, "upsert")
          .catch((error) => console.warn("TravelRuntimeStorage 未能缓存共享设置到本机。", error));
        return snapshot;
      }
      const localSettings = (await settingsAdapter.load()).settings;
      if (localSettings) {
        snapshot.settings = localSettings;
        pendingSettingsSeed = deepClone(localSettings);
      }
      return snapshot;
    }

    /* 把本机旧设置上推到共享层（只在远端为空时做一次）。失败不阻塞页面，下次 load 会再试。 */
    async function flushSettingsSeed() {
      if (!pendingSettingsSeed) return;
      const value = pendingSettingsSeed;
      pendingSettingsSeed = null;
      try {
        await request("POST", [{ op: "upsert", collection: "settings", id: SETTINGS_RECORD_ID, value }]);
      } catch (error) {
        pendingSettingsSeed = value;
        console.warn("TravelRuntimeStorage 未能把本机记账设置同步到共享层，稍后重试。", error);
      }
    }

    async function request(method, changes) {
      const init = method === "GET"
        ? { cache: "no-store" }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ changes })
          };
      const response = await fetch(endpoint(), init);
      if (!response.ok) throw new Error(`API ${response.status}`);
      previous = await mergeSettings(await response.json());
      return normalizeSnapshot(previous);
    }

    function enqueue(operation) {
      const pending = queue.then(operation, operation);
      queue = pending.catch(() => {});
      return pending;
    }

    // Batched write. The wire format already carries an array of changes, so a
    // whole chunk travels in one POST and lands in one D1 batch() — importing
    // the authored pre-trip list one record at a time would mean 150+ sequential
    // round trips.
    async function applyD1Changes(collection, values, op) {
      return enqueue(async () => {
        if (!ownedCollections.includes(collection)) {
          throw new Error(`Runtime collection is not enabled for this D1 adapter: ${collection}`);
        }
        if (collection === "settings") {
          /* settings 是单例：值就是整个 settings 对象，id 由服务端固定。 */
          const value = values.length ? values[values.length - 1] : null;
          const change = !value || op === "delete"
            ? { op: "delete", collection: "settings", id: SETTINGS_RECORD_ID }
            : { op: "upsert", collection: "settings", id: SETTINGS_RECORD_ID, value: deepClone(value) };
          return request("POST", [change]);
        }
        const changes = values.map((value) => {
          const id = String(typeof value === "object" && value !== null ? value.id || "" : value || "").trim();
          if (!id) throw new Error(`${collection} records require a stable id`);
          return { op, collection, id, ...(op === "upsert" ? { value: deepClone(value) } : {}) };
        });
        if (!changes.length) return previous ? normalizeSnapshot(previous) : mergeSettings(emptySnapshot());
        return request("POST", changes);
      });
    }

    return {
      mode: "d1",
      tripId,
      apiBase,
      async load() {
        const snapshot = await request("GET");
        await flushSettingsSeed();
        return snapshot;
      },
      async save(snapshot) {
        return enqueue(async () => {
          const next = normalizeSnapshot(snapshot);
          const changes = [];
          for (const collection of ownedRecordCollections) {
            const before = new Map((previous?.[collection] || []).map((item) => [String(item.id), item]));
            const after = new Map(next[collection].map((item) => [String(item.id), item]));
            before.forEach((_, id) => {
              if (!after.has(id)) changes.push({ op: "delete", collection, id });
            });
            after.forEach((record, id) => {
              if (JSON.stringify(before.get(id)) !== JSON.stringify(record)) {
                changes.push({ op: "upsert", collection, id, value: record });
              }
            });
          }
          /* settings 也是共享的：作为单例记录参与同一批 diff / 写入，不再单独写本机。 */
          if (ownsSettings) {
            const beforeSettings = previous?.settings && typeof previous.settings === "object" ? previous.settings : null;
            const afterSettings = next.settings && typeof next.settings === "object" ? next.settings : null;
            if (afterSettings && JSON.stringify(beforeSettings) !== JSON.stringify(afterSettings)) {
              changes.push({ op: "upsert", collection: "settings", id: SETTINGS_RECORD_ID, value: deepClone(afterSettings) });
            } else if (!afterSettings && beforeSettings) {
              changes.push({ op: "delete", collection: "settings", id: SETTINGS_RECORD_ID });
            }
          }
          if (!changes.length) {
            const merged = normalizeSnapshot(previous);
            for (const collection of ownedRecordCollections) {
              merged[collection] = deepClone(next[collection]);
            }
            if (ownsSettings) merged.settings = deepClone(next.settings);
            merged.updatedAt = next.updatedAt;
            previous = merged;
            Object.assign(snapshot, normalizeSnapshot(previous));
            return normalizeSnapshot(previous);
          }
          const saved = await request("POST", changes);
          Object.assign(snapshot, saved);
          return saved;
        });
      },
      async applyChange(collection, value, op = "upsert") {
        return applyD1Changes(collection, [value], op);
      },
      async applyChanges(collection, values, op = "upsert") {
        return applyD1Changes(collection, Array.isArray(values) ? values : [values], op);
      }
    };
  }

  function createAdapter(options = {}) {
    return normalizeMode(options.mode) === "d1"
      ? createD1Adapter(options)
      : createLocalAdapter(options);
  }

  const publicApi = Object.freeze({
    createAdapter,
    createLocalAdapter,
    createD1Adapter,
    emptySnapshot,
    makeStorageKey,
    normalizeMode,
    normalizeCollections,
    normalizeApiBase,
    normalizeSnapshot
  });

  if (typeof module === "object" && module.exports) module.exports = publicApi;
  if (typeof window !== "undefined") window.TravelRuntimeStorage = publicApi;
})();
