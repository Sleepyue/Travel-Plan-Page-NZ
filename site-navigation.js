(() => {
  const TRAVEL_HASHES = new Set(["", "#top", "#flights", "#route", "#itinerary", "#drive", "#prep", "#weather"]);
  const isLedgerHash = (hash) => hash === "#ledger" || hash.startsWith("#ledger-");
  const isDiningHash = (hash) => hash === "#dining" || hash.startsWith("#dining-");
  const ledgerEnabled = () => !document.querySelector("#ledger-navigation-link")?.hidden;
  const diningEnabled = () => Boolean(document.querySelector("#dining-navigation-link"));
  const viewForHash = (hash) => {
    if (isLedgerHash(hash) && ledgerEnabled()) return "ledger";
    if (isDiningHash(hash) && diningEnabled()) return "dining";
    return "travel";
  };

  let activeView = "travel";
  const scrollPositions = { travel: 0, ledger: 0, dining: 0 };
  let scrollFrame = 0;
  let browserRouteFrame = 0;
  let pendingBrowserRestore = false;

  function elements() {
    return {
      travelView: document.querySelector('[data-site-view="travel"]'),
      ledgerView: document.querySelector('[data-site-view="ledger"]'),
      diningView: document.querySelector('[data-site-view="dining"]'),
      travelMenu: document.querySelector("#travel-navigation"),
      travelTrigger: document.querySelector("#travel-navigation-trigger"),
      ledgerLink: document.querySelector("#ledger-navigation-link"),
      diningLink: document.querySelector("#dining-navigation-link"),
      skipLink: document.querySelector("#skip-link")
    };
  }

  function setVisibleView(nextView, options = {}) {
    const { travelView, ledgerView, diningView, travelTrigger, ledgerLink, diningLink, skipLink } = elements();
    const views = { travel: travelView, ledger: ledgerView, dining: diningView };
    if (!travelView || !ledgerView || !diningView) return;

    const viewChanged = activeView !== nextView;
    if (viewChanged) scrollPositions[activeView] = window.scrollY;
    activeView = nextView;

    for (const [name, element] of Object.entries(views)) {
      const isActive = name === nextView;
      element.hidden = !isActive;
      element.toggleAttribute("inert", !isActive);
    }
    document.body.dataset.activeView = nextView;

    const currentTargets = { travel: travelTrigger, ledger: ledgerLink, dining: diningLink };
    for (const [name, element] of Object.entries(currentTargets)) {
      if (!element) continue;
      if (name === nextView) element.setAttribute("aria-current", "page");
      else element.removeAttribute("aria-current");
    }

    const skipTargets = { travel: "#main", ledger: "#ledger-root", dining: "#dining-root" };
    if (skipLink) skipLink.href = skipTargets[nextView] || "#main";

    if (nextView === "ledger") {
      const tab = location.hash === "#ledger-stats" ? "stats" : location.hash === "#ledger" ? "entry" : "";
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

  function setup() {
    const { travelMenu } = elements();
    history.scrollRestoration = "manual";
    activeView = viewForHash(location.hash);
    routeFromLocation({ restore: false, forceScroll: true });

    document.addEventListener("click", (event) => {
      const ledgerLink = event.target.closest("#ledger-navigation-link");
      if (ledgerLink) {
        event.preventDefault();
        travelMenu?.removeAttribute("open");
        navigate("#ledger");
        return;
      }

      const diningLink = event.target.closest("#dining-navigation-link");
      if (diningLink) {
        event.preventDefault();
        travelMenu?.removeAttribute("open");
        navigate("#dining");
        return;
      }

      const travelLink = event.target.closest(".travel-navigation-menu a, #wordmark");
      if (travelLink) {
        event.preventDefault();
        travelMenu?.removeAttribute("open");
        navigate(travelLink.getAttribute("href") || "#top");
        return;
      }

      if (travelMenu?.open && !event.target.closest("#travel-navigation")) travelMenu.removeAttribute("open");
    });

    window.addEventListener("popstate", () => scheduleBrowserRoute({ restore: true }));
    window.addEventListener("hashchange", () => scheduleBrowserRoute());
    window.addEventListener("travel-config:ready", () => {
      activeView = viewForHash(location.hash);
      routeFromLocation({ forceScroll: false });
    });
    window.addEventListener("travel-ledger:navigate", (event) => {
      const hash = event.detail?.tab === "stats" ? "#ledger-stats" : "#ledger";
      if (location.hash !== hash) history.pushState({ view: "ledger" }, "", hash);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
