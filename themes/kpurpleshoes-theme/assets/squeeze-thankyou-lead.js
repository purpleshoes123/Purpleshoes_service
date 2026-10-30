(function () {
  if (window.location.pathname !== "/pages/squeezthank" || window.__psSqueezeLeadStarted) {
    return;
  }
  window.__psSqueezeLeadStarted = true;

  var receipt;
  try {
    receipt = window.sessionStorage.getItem("ps:squeeze:lead-receipt");
  } catch (_error) {
    return;
  }
  if (!receipt) {
    return;
  }

  function privacyReady() {
    return new Promise(function (resolve) {
      if (!window.Shopify || typeof window.Shopify.loadFeatures !== "function") {
        resolve(false);
        return;
      }
      var timeout = setTimeout(function () {
        resolve(false);
      }, 1500);
      try {
        window.Shopify.loadFeatures(
          [{ name: "consent-tracking-api", version: "0.1" }],
          function () {
            clearTimeout(timeout);
            try {
              var privacy = window.Shopify.customerPrivacy;
              resolve(
                Boolean(privacy && privacy.marketingAllowed() && privacy.saleOfDataAllowed()),
              );
            } catch (_error) {
              resolve(false);
            }
          },
        );
      } catch (_error) {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  function cookieValue(name) {
    var entry = document.cookie.split("; ").find(function (item) {
      return item.indexOf(name + "=") === 0;
    });
    try {
      return entry ? decodeURIComponent(entry.slice(name.length + 1)) : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  var busy = false;
  var completed = false;
  function attempt() {
    if (busy || completed) {
      return Promise.resolve();
    }
    busy = true;
    return privacyReady()
      .then(async function (allowed) {
        if (!allowed) {
          return;
        }
        var verified = await fetch("/apps/bta-booking/mail/lead", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            receipt: receipt,
            pagePath: window.location.pathname,
            marketingAllowed: true,
            verifyOnly: true,
          }),
        });
        var envelope = await verified.json();
        var data = envelope && envelope.data;
        if (
          !verified.ok ||
          !data ||
          data.eligible !== true ||
          !/^[a-z0-9_-]{5,100}$/i.test(data.eventId)
        ) {
          return;
        }
        if (!(await privacyReady())) {
          return;
        }
        completed = true;
        window.sessionStorage.removeItem("ps:squeeze:lead-receipt");
        try {
          if (window.Shopify.analytics && typeof window.Shopify.analytics.publish === "function") {
            await window.Shopify.analytics.publish("purpleshoes:starter_kit_success", {
              event_id: data.eventId,
              lead_type: "starter_kit",
              page_path: "/pages/squeezthank",
            });
          }
        } catch (_error) {
          /* An analytics consumer cannot block the existing Meta path. */
        }
        return fetch("/apps/bta-booking/mail/lead", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            receipt: receipt,
            pagePath: window.location.pathname,
            marketingAllowed: true,
            fbc: cookieValue("_fbc"),
            fbp: cookieValue("_fbp"),
          }),
        });
      })
      .catch(function () {
        // Tracking must never interrupt access to the Starter Kit.
      })
      .finally(function () {
        busy = false;
      });
  }
  document.addEventListener("visitorConsentCollected", attempt);
  attempt();
})();
