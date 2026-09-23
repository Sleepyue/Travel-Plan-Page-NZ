(() => {
  const TRAVEL_HASHES = new Set(["", "#top", "#focus-card-section", "#flights", "#route", "#stay", "#tickets", "#weather", "#drive"]);
  const isLedgerHash = (hash) => hash === "#ledger" || hash.startsWith("#ledger-");
  const isDiningHash = (hash) => hash === "#dining" || hash.startsWith("#dining-");
  const isItineraryHash = (hash) => hash === "#itinerary";
  const isPrepHash = (hash) => hash === "#prep";
  const ledgerEnabled = () => !document.querySelector("#ledger-navigation-link")?.hidden;
  const diningEnabled = () => Boolean(document.querySelector("#dining-navigation-link"));
  /* 行前准备是与「旅行信息」同级的独立视图；模块关闭时不接管 #prep。 */
  const itineraryLink = () => document.querySelector("#itinerary-navigation-link");
  const itineraryEnabled = () => {
    const link = itineraryLink();
    return Boolean(link) && !link.hidden;
  };
  const prepLink = () => document.querySelector("#prep-navigation-link");
  const prepEnabled = () => {
    const link = prepLink();
    return Boolean(link) && !link.hidden;
  };
  const viewForHash = (hash) => {
    if (isLedgerHash(hash) && ledgerEnabled()) return "ledger";
    if (isDiningHash(hash) && diningEnabled()) return "dining";
    if (isItineraryHash(hash) && itineraryEnabled()) return "itinerary";
    if (isPrepHash(hash) && prepEnabled()) return "prep";
    return "travel";
  };

  let activeView = "travel";
  const scrollPositions = { travel: 0, ledger: 0, dining: 0, itinerary: 0, prep: 0 };
  let scrollFrame = 0;
  let browserRouteFrame = 0;
  let pendingBrowserRestore = false;

  function elements() {
    return {
      travelView: document.querySelector('[data-site-view="travel"]'),
      ledgerView: document.querySelector('[data-site-view="ledger"]'),
      diningView: document.querySelector('[data-site-view="dining"]'),
      itineraryView: document.querySelector('[data-site-view="itinerary"]'),
      prepView: document.querySelector('[data-site-view="prep"]'),
      /* 顶栏「旅行信息」已是普通链接；栏目导航改由页内 .trip-nav 承担。 */
      travelTrigger: document.querySelector("#travel-navigation-link"),
      itineraryLink: document.querySelector("#itinerary-navigation-link"),
      ledgerLink: document.querySelector("#ledger-navigation-link"),
      diningLink: document.querySelector("#dining-navigation-link"),
      prepLink: document.querySelector("#prep-navigation-link"),
      skipLink: document.querySelector("#skip-link")
    };
  }

  function setVisibleView(nextView, options = {}) {
    const { travelView, ledgerView, diningView, itineraryView, prepView, travelTrigger, itineraryLink: itineraryNavigationLink, ledgerLink, diningLink, prepLink: prepNavigationLink, skipLink } = elements();
    const views = { travel: travelView, ledger: ledgerView, dining: diningView, itinerary: itineraryView, prep: prepView };
    if (!travelView || !ledgerView || !diningView || !itineraryView || !prepView) return;

    const viewChanged = activeView !== nextView;
    if (viewChanged) scrollPositions[activeView] = window.scrollY;
    activeView = nextView;

    for (const [name, element] of Object.entries(views)) {
      const isActive = name === nextView;
      element.hidden = !isActive;
      element.toggleAttribute("inert", !isActive);
    }
    document.body.dataset.activeView = nextView;

    const currentTargets = { travel: travelTrigger, itinerary: itineraryNavigationLink, ledger: ledgerLink, dining: diningLink, prep: prepNavigationLink };
    for (const [name, element] of Object.entries(currentTargets)) {
      if (!element) continue;
      if (name === nextView) element.setAttribute("aria-current", "page");
      else element.removeAttribute("aria-current");
    }

    const skipTargets = { travel: "#main", itinerary: "#itinerary", ledger: "#ledger-root", dining: "#dining-root", prep: "#prep" };
    if (skipLink) skipLink.href = skipTargets[nextView] || "#main";

    if (nextView === "ledger") {
      const tab = location.hash.match(/^#ledger-([a-z]+)$/)?.[1] || (location.hash === "#ledger" ? "entry" : "");
      if (tab) window.TravelLedger?.setActiveTab?.(tab, { updateHash: false });
    }
    if (nextView === "dining") {
      const tab = location.hash === "#dining-record" ? "record" : location.hash === "#dining-breakdown" ? "breakdown" : "";
      if (tab) window.TravelDining?.setActiveTab?.(tab);
    }

    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (nextView === "travel" && viewChanged) window.dispatchEvent(new Event("travel-view:shown"));
      if (options.targetId && nextView === "travel") {
        document.getElementById(options.targetId)?.scrollIntoView({ block: "start" });
      } else if ((viewChanged || options.forceScroll) && options.restore) {
        window.scrollTo({ top: scrollPositions[nextView] || 0 });
      } else if (viewChanged || options.forceScroll) {
        window.scrollTo({ top: 0 });
      }
    });
  }

  function routeFromLocation(options = {}) {
    const hash = location.hash;
    const nextView = viewForHash(hash);
    const targetId = nextView === "travel" && TRAVEL_HASHES.has(hash) ? hash.slice(1) : "";
    setVisibleView(nextView, { ...options, targetId });
  }

  function navigate(hash) {
    const nextView = viewForHash(hash);
    scrollPositions[activeView] = window.scrollY;
    if (location.hash === hash) {
      setVisibleView(nextView, { targetId: nextView === "travel" ? hash.slice(1) : "" });
      return;
    }
    history.pushState({ view: nextView }, "", hash);
    setVisibleView(nextView, { targetId: nextView === "travel" ? hash.slice(1) : "" });
  }

  function scheduleBrowserRoute({ restore = false } = {}) {
    pendingBrowserRestore ||= restore;
    if (browserRouteFrame) return;
    browserRouteFrame = requestAnimationFrame(() => {
      browserRouteFrame = 0;
      const shouldRestore = pendingBrowserRestore;
      pendingBrowserRestore = false;
      routeFromLocation({ restore: shouldRestore });
    });
  }

  /* 栏目导航的滚动高亮：吸附在顶栏下方后，需要一眼看出当前落在哪一栏。
     判定线取「顶栏高度 + 导航条自身高度」，最后一个越过该线的栏目即为当前项。 */
  function setupTripNavSpy() {
    const nav = document.querySelector("#trip-nav");
    if (!nav) return;
    const entries = [...nav.querySelectorAll("a")].map((link) => {
      const id = String(link.getAttribute("href") || "").replace(/^#/, "");
      return { link, el: id ? document.getElementById(id) : null };
    }).filter((entry) => entry.el);
    if (!entries.length) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      /* 视图未显示时（祖先 [hidden]）rect 全为 0，会把末项误判为当前项。 */
      if (!nav.offsetParent) return;
      const line = (document.querySelector("#topbar")?.offsetHeight || 48) + nav.offsetHeight + 8;
      /* 默认落在首个可见栏目：页面顶部时所有区块都在判定线以下，
         若从 null 起算则一个都不高亮。 */
      let active = entries.find((entry) => !entry.link.hidden && !entry.el.hidden) || null;
      for (const entry of entries) {
        if (entry.link.hidden || entry.el.hidden) continue;
        if (entry.el.getBoundingClientRect().top <= line) active = entry;
      }
      for (const entry of entries) {
        if (entry === active) entry.link.setAttribute("aria-current", "true");
        else entry.link.removeAttribute("aria-current");
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("travel-view:shown", schedule);
    window.addEventListener("travel-config:ready", schedule);
    schedule();
  }

  function setup() {
    history.scrollRestoration = "manual";
    activeView = viewForHash(location.hash);
    routeFromLocation({ restore: false, forceScroll: true });

    document.addEventListener("click", (event) => {
      const ledgerLink = event.target.closest("#ledger-navigation-link");
      if (ledgerLink) {
        event.preventDefault();
        navigate("#ledger");
        return;
      }

      const itineraryNavigationLink = event.target.closest("#itinerary-navigation-link");
      if (itineraryNavigationLink) {
        event.preventDefault();
        navigate("#itinerary");
        return;
      }

      const prepNavigationLink = event.target.closest("#prep-navigation-link");
      if (prepNavigationLink) {
        event.preventDefault();
        navigate("#prep");
        return;
      }

      const diningLink = event.target.closest("#dining-navigation-link");
      if (diningLink) {
        event.preventDefault();
        navigate("#dining");
        return;
      }

      const travelLink = event.target.closest(".trip-nav a, #travel-navigation-link, #wordmark");
      if (travelLink) {
        event.preventDefault();
        navigate(travelLink.getAttribute("href") || "#top");
        return;
      }

    });

    window.addEventListener("popstate", () => scheduleBrowserRoute({ restore: true }));
    window.addEventListener("hashchange", () => scheduleBrowserRoute());
    window.addEventListener("travel-config:ready", () => {
      activeView = viewForHash(location.hash);
      routeFromLocation({ forceScroll: false });
    });
    window.addEventListener("travel-ledger:navigate", (event) => {
      const tab = ["bills", "stats", "detail"].includes(event.detail?.tab) ? event.detail.tab : "entry";
      const hash = tab === "entry" ? "#ledger" : `#ledger-${tab}`;
      if (location.hash !== hash) history.pushState({ view: "ledger" }, "", hash);
    });

    setupTripNavSpy();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
