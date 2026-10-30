(function () {
  "use strict";

  var guard = document.querySelector("script[data-theme-release-url]");
  if (!guard || !window.fetch || !window.sessionStorage) {
    return;
  }

  var releaseUrl = guard.getAttribute("data-theme-release-url");
  var storageKey = "purpleshoes:theme-release";
  var checking = false;
  var pendingReload = false;

  if (!releaseUrl) {
    return;
  }

  function hasActiveBookingFlow() {
    return Boolean(
      document.querySelector(
        '[role="dialog"][aria-modal="true"]:not([hidden]), ' +
          ".travel-booking-dialog:not([hidden]), " +
          ".travel-booking-modal:not([hidden]), " +
          "[data-travel-booking-modal]:not([hidden])",
      ),
    );
  }

  function isEditingField() {
    var active = document.activeElement;
    return Boolean(
      active && active.matches && active.matches('input:not([type="hidden"]), textarea, select'),
    );
  }

  function canReloadNow() {
    return document.visibilityState === "visible" && !hasActiveBookingFlow() && !isEditingField();
  }

  function reloadForNewRelease(release) {
    if (!canReloadNow()) {
      pendingReload = true;
      return;
    }

    pendingReload = false;
    window.sessionStorage.setItem(storageKey, release);
    window.location.reload();
  }

  function checkRelease() {
    if (checking || document.visibilityState !== "visible") {
      return;
    }
    checking = true;

    var separator = releaseUrl.indexOf("?") === -1 ? "?" : "&";
    window
      .fetch(releaseUrl + separator + "__release_check=" + Date.now(), {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("release marker unavailable");
        }
        return response.json();
      })
      .then(function (payload) {
        var release = payload && typeof payload.release === "string" ? payload.release : "";
        if (!release) {
          return;
        }

        var knownRelease = window.sessionStorage.getItem(storageKey);
        if (!knownRelease) {
          window.sessionStorage.setItem(storageKey, release);
          return;
        }

        if (knownRelease !== release) {
          reloadForNewRelease(release);
        }
      })
      .catch(function () {
        // A failed update check must never interfere with browsing or checkout.
      })
      .finally(function () {
        checking = false;
      });
  }

  window.addEventListener("pageshow", checkRelease);
  window.addEventListener("focus", checkRelease);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      checkRelease();
    }
  });
  document.addEventListener("focusout", function () {
    if (pendingReload) {
      window.setTimeout(checkRelease, 150);
    }
  });
})();
