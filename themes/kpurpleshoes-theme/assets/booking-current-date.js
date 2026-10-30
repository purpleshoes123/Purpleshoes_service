(() => {
  let revision = 0;
  async function refresh() {
    const current = ++revision;
    const items = Array.from(document.querySelectorAll("[data-current-booking-date]"));
    const load = async (item) => {
      const { orderId, lineItemId, startLabel, loadingLabel, errorLabel } = item.dataset;
      item.textContent = loadingLabel;
      try {
        const query = new URLSearchParams({ orderId, lineItemId });
        const response = await fetch(`/apps/bta-booking/bookings/current?${query}`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const payload = await response.json();
        const data = payload.data;
        if (
          !response.ok ||
          !payload.ok ||
          data?.orderId !== orderId ||
          data?.lineItemId !== lineItemId ||
          !/^\d{4}-\d{2}-\d{2}$/.test(data.travelDate)
        ) {
          throw new Error("Booking lookup failed");
        }
        const date = new Date(`${data.travelDate}T00:00:00Z`);
        if (!Number.isFinite(date.getTime())) {
          throw new Error("Invalid booking date");
        }
        const label = new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(date);
        if (current === revision) {
          item.textContent = startLabel ? `${label} · ${startLabel}` : label;
        }
      } catch {
        if (current === revision) {
          item.textContent = errorLabel;
        }
      }
    };
    for (let i = 0; i < items.length; i += 3) {
      if (current !== revision) {
        return;
      }
      await Promise.all(items.slice(i, i + 3).map(load));
    }
  }
  refresh();
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      refresh();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refresh();
    }
  });
})();
