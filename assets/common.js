/* ISLA-PLATEU shared helpers (icons, API calls, logout) */
(function () {
  "use strict";
  const ISLA = {
    ROLE_LABEL: { CUSTOMER: "Customer", RESTAURANT_STAFF: "Restaurant Staff", ADMINISTRATOR: "Administrator" },
    refreshIcons() {
      if (window.lucide && typeof window.lucide.createIcons === "function") {
        window.lucide.createIcons({ attrs: { "aria-hidden": "true", focusable: "false" } });
      }
    },
    async api(url, options = {}) {
      const init = { credentials: "same-origin", headers: {}, ...options };
      if (options.body !== undefined) {
        init.method = options.method || "POST";
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(options.body);
      }
      try {
        const res = await fetch(url, init);
        let data = null;
        try { data = await res.json(); } catch { /* non-JSON response */ }
        return { ok: res.ok, status: res.status, data: data || {} };
      } catch {
        return { ok: false, status: 0, data: { error: "Could not reach the server. Check that it is running and try again." } };
      }
    },
    async logout() {
      await ISLA.api("/api/logout", { method: "POST", body: {} });
      window.location.assign("/login");
    },
    wireLogout() {
      document.querySelectorAll("[data-logout]").forEach(btn => btn.addEventListener("click", async () => {
        btn.disabled = true;
        await ISLA.logout();
      }));
    }
  };
  window.ISLA = ISLA;
  document.addEventListener("DOMContentLoaded", () => { ISLA.refreshIcons(); ISLA.wireLogout(); });
})();
