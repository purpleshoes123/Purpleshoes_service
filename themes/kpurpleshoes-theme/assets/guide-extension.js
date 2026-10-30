(function () {
  "use strict";

  var TYPE_ORDER = ["PDF", "VIDEO", "BUNDLE"];
  var BASE_PATH = "/apps/bta-booking";
  var KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  var EXTENSION_DAYS_PER_UNIT = 30;

  var state = {
    root: null,
    customerId: null,
    status: "idle",
    entitlements: null,
    error: null,
    selectedType: null,
    monthsRaw: "1",
    months: 1,
    validationError: null,
    preview: null,
    checkoutStatus: "idle",
    checkoutError: null,
    lastCheckoutAction: null,
    pendingSelectType: null,
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildEntitlementsUrl(customerId, noCache) {
    var url =
      BASE_PATH +
      "/guide-extension/entitlements?logged_in_customer_id=" +
      encodeURIComponent(customerId);
    if (noCache) {
      url += "&_ts=" + Date.now();
    }
    return url;
  }

  function buildCheckoutUrl(customerId, useThemeCart) {
    var url =
      BASE_PATH +
      "/guide-extension/checkout?logged_in_customer_id=" +
      encodeURIComponent(customerId);
    if (!useThemeCart) {
      return url;
    }
    if (
      window.BtaThemeCartCheckout &&
      typeof window.BtaThemeCartCheckout.withCheckoutMode === "function"
    ) {
      return window.BtaThemeCartCheckout.withCheckoutMode(url);
    }
    return url + "&checkoutMode=theme_cart";
  }

  function normalizeError(err) {
    if (!err) {
      return {
        code: "UNKNOWN_ERROR",
        message: "Unknown error",
        correlationId: null,
        raw: err,
      };
    }

    if (err.code) {
      return {
        code: err.code,
        message: err.message || "An error occurred.",
        correlationId: err.correlationId || null,
        raw: err.raw || err,
      };
    }

    if (err.error && err.error.code) {
      return {
        code: err.error.code,
        message: err.error.message || "An error occurred.",
        correlationId: (err.meta && err.meta.correlationId) || null,
        raw: err,
      };
    }

    return {
      code: "UNKNOWN_ERROR",
      message: err.message || "An error occurred.",
      correlationId: null,
      raw: err,
    };
  }

  function messageForCode(code) {
    switch (code) {
      case "AUTH_PROXY_SIGNATURE_INVALID":
        return "Request validation failed. Refresh the page and try again.";
      case "GUIDE_EXTENSION_NOT_ELIGIBLE":
        return "This item is not eligible for extension purchase.";
      case "GUIDE_EXTENSION_EXPIRED":
        return "Expired entitlements cannot be extended.";
      case "GUIDE_EXTENSION_INVALID_INPUT":
        return "Enter a whole number from 1 to 24. Each unit adds 30 days.";
      case "RATE_LIMITED":
        return "Too many requests. Please try again later.";
      case "SHOPIFY_ADMIN_API_ERROR":
        return "Temporary error. Please try again later.";
      case "NETWORK_ERROR":
        return "A network error occurred. Please try again later.";
      case "TIMEOUT":
        return "The request timed out. Please try again later.";
      case "PARSE_ERROR":
        return "There was an error processing the response. Please try again later.";
      case "MISSING_CUSTOMER_ID":
        return "Customer information could not be verified. Please sign in again.";
      default:
        return "An error occurred. Please try again later.";
    }
  }

  async function fetchEnvelope(url, options) {
    var response = await fetch(
      url,
      Object.assign(
        {
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
          },
        },
        options || {},
      ),
    );

    var contentType = response.headers.get("content-type") || "";
    var isJson = contentType.indexOf("application/json") !== -1;
    var payload = null;

    if (isJson) {
      try {
        payload = await response.json();
      } catch (error) {
        throw {
          code: "PARSE_ERROR",
          message: "Failed to parse response JSON",
          correlationId: null,
          raw: error,
        };
      }
    }

    if (!payload || typeof payload !== "object") {
      if (!response.ok) {
        throw {
          code: "HTTP_ERROR",
          message: "HTTP " + response.status,
          correlationId: null,
          raw: payload,
        };
      }

      return {
        ok: true,
        data: payload,
        error: null,
        meta: { correlationId: null },
      };
    }

    if (!payload.ok) {
      throw {
        code: (payload.error && payload.error.code) || "ENVELOPE_ERROR",
        message: (payload.error && payload.error.message) || "An error occurred.",
        correlationId: (payload.meta && payload.meta.correlationId) || null,
        raw: payload,
      };
    }

    return payload;
  }

  function copyToClipboard(text) {
    if (!text) {
      return Promise.reject(new Error("EMPTY"));
    }

    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      var success = false;
      try {
        success = document.execCommand("copy");
      } catch (error) {
        success = false;
      }
      document.body.removeChild(textarea);
      if (success) {
        resolve();
      } else {
        reject(new Error("COPY_FAILED"));
      }
    });
  }

  function statusNote(status) {
    switch (status) {
      case "ACTIVE":
        return "Extension available";
      case "EXPIRED":
        return "Expired, extension unavailable";
      default:
        return "No purchase history found.";
    }
  }

  function getItemsByType(entitlements) {
    var itemsByType = {};
    if (entitlements && Array.isArray(entitlements.items)) {
      entitlements.items.forEach(function (item) {
        if (item && item.type) {
          itemsByType[item.type] = item;
        }
      });
    }
    return itemsByType;
  }

  function getActiveTypes(itemsByType) {
    return TYPE_ORDER.filter(function (type) {
      return itemsByType[type] && itemsByType[type].status === "ACTIVE";
    });
  }

  function formatExtensionPeriod(units) {
    var numeric = Number(units || 0);
    var days = numeric > 0 ? numeric * EXTENSION_DAYS_PER_UNIT : 0;
    return days ? days + " days" : "Select a period";
  }

  function validateMonths(rawValue) {
    if (rawValue === "") {
      return { value: null, error: "Enter the number of 30-day units." };
    }

    var numeric = Number(rawValue);
    if (!Number.isFinite(numeric) || Math.floor(numeric) !== numeric) {
      return { value: null, error: "Enter a whole number from 1 to 24. Each unit adds 30 days." };
    }

    if (numeric < 1 || numeric > 24) {
      return { value: null, error: "Enter a whole number from 1 to 24. Each unit adds 30 days." };
    }

    return { value: numeric, error: null };
  }

  function typeLabel(type) {
    switch (type) {
      case "BUNDLE":
        return "Korea Guide Kit";
      case "PDF":
        return "Guidebook";
      case "VIDEO":
        return "Video Guide";
      default:
        return type;
    }
  }

  function formatExpires(expiresAtKst) {
    if (!expiresAtKst) {
      return "None";
    }
    return "Your access expires on: " + escapeHtml(expiresAtKst);
  }

  function formatExpiryCompact(expiresAtKst) {
    if (!expiresAtKst) {
      return "None";
    }
    var str = String(expiresAtKst);
    var match = str.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (match) {
      return match[1] + "." + match[2] + "." + match[3] + "  " + match[4] + ":" + match[5];
    }
    return str;
  }

  function kstDateStartMs(value) {
    var date = value instanceof Date ? value : new Date(String(value));
    if (isNaN(date.getTime())) {
      return null;
    }
    var kstDate = new Date(date.getTime() + KST_OFFSET_MS);
    return Date.UTC(kstDate.getUTCFullYear(), kstDate.getUTCMonth(), kstDate.getUTCDate());
  }

  function formatDaysRemaining(expiresAtKst) {
    if (!expiresAtKst) {
      return "None";
    }
    var expiryDay = kstDateStartMs(expiresAtKst);
    var today = kstDateStartMs(new Date());
    if (expiryDay === null || today === null) {
      return "None";
    }
    var diffDays = Math.max(0, Math.floor((expiryDay - today) / MS_PER_DAY));
    return diffDays + (diffDays === 1 ? " day remaining" : " days remaining");
  }

  function renderLoading() {
    state.root.innerHTML = '<div class="guide-extension-loading">Loading...</div>';
  }

  function renderError(error) {
    var message = messageForCode(error.code);
    var isNotEligible = error.code === "GUIDE_EXTENSION_NOT_ELIGIBLE";
    var actionHtml = isNotEligible
      ? '<a class="button" href="/account">Go to My Page</a>'
      : '<button class="button" type="button" data-action="retry-entitlements">Retry</button>';

    state.root.innerHTML =
      "" +
      '<div class="guide-extension-error">' +
      "  <p>" +
      escapeHtml(message) +
      "</p>" +
      '  <div class="guide-extension-error-actions">' +
      actionHtml +
      "</div>" +
      "</div>";
  }

  function renderForm(entitlements) {
    var itemsByType = getItemsByType(entitlements);
    var activeTypes = getActiveTypes(itemsByType);

    if (!activeTypes.length) {
      return (
        '<section class="guide-extension-form">' +
        '<h2 class="h2">Extension Purchase</h2>' +
        "<p>No extendable entitlements are available.</p>" +
        "</section>"
      );
    }

    var typeOptions = TYPE_ORDER.map(function (type) {
      var item = itemsByType[type] || { status: "NONE" };
      var disabled = item.status !== "ACTIVE";
      var checked = state.selectedType === type;
      var disabledAttr = disabled ? "disabled" : "";
      var checkedAttr = checked ? "checked" : "";

      return (
        "" +
        '<label class="guide-extension-type-option">' +
        '  <input type="radio" name="guide-extension-type" value="' +
        escapeHtml(type) +
        '" ' +
        checkedAttr +
        " " +
        disabledAttr +
        " data-type-radio>" +
        '  <span class="guide-extension-type-label">' +
        escapeHtml(typeLabel(type)) +
        "</span>" +
        "</label>"
      );
    }).join("");

    var validationMessage = state.validationError ? escapeHtml(state.validationError) : "";
    var validationClass = state.validationError ? " guide-extension-error-text" : "";
    var isCheckoutLoading = state.checkoutStatus === "loading";
    var disableActions = isCheckoutLoading || !!state.validationError || !state.selectedType;
    var selectedPeriodDisplay = state.months
      ? formatExtensionPeriod(state.months)
      : "Select a period";

    var rawExpiry =
      state.preview && state.preview.currentExpiresAtKst
        ? state.preview.currentExpiresAtKst
        : state.selectedType && itemsByType[state.selectedType]
          ? itemsByType[state.selectedType].expiresAtKst
          : null;
    var expiryDateDisplay = rawExpiry ? formatDaysRemaining(rawExpiry) : "None";
    var extendedExpiry =
      rawExpiry && state.months
        ? new Date(
            new Date(rawExpiry).getTime() + state.months * EXTENSION_DAYS_PER_UNIT * MS_PER_DAY,
          )
        : null;
    var extendedExpiryDisplay =
      extendedExpiry && !isNaN(extendedExpiry.getTime())
        ? new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Seoul",
            year: "numeric",
            month: "long",
            day: "numeric",
          }).format(extendedExpiry)
        : "";

    var checkoutErrorHtml = "";
    if (state.checkoutError) {
      var checkoutMessage = messageForCode(state.checkoutError.code);
      var retryAllowed =
        state.checkoutError.code === "RATE_LIMITED" ||
        state.checkoutError.code === "SHOPIFY_ADMIN_API_ERROR" ||
        state.checkoutError.code === "NETWORK_ERROR" ||
        state.checkoutError.code === "TIMEOUT" ||
        state.checkoutError.code === "PARSE_ERROR";

      var retryButton = retryAllowed
        ? '<button class="button" type="button" data-action="retry-checkout">Retry</button>'
        : "";

      var accountLink =
        state.checkoutError.code === "GUIDE_EXTENSION_NOT_ELIGIBLE"
          ? '<a class="button" href="/account">Go to My Page</a>'
          : "";

      checkoutErrorHtml =
        "" +
        '<div class="guide-extension-checkout-error">' +
        "  <p>" +
        escapeHtml(checkoutMessage) +
        "</p>" +
        '  <div class="guide-extension-error-actions">' +
        retryButton +
        accountLink +
        "</div>" +
        "</div>";
    }

    return (
      "" +
      '<section class="guide-extension-form">' +
      '  <h2 class="h2 guide-extension-form__title">Extend Access Period</h2>' +
      '  <div class="guide-extension-types">' +
      typeOptions +
      "</div>" +
      '  <div class="guide-extension-months">' +
      '    <label class="form__label" for="GuideExtensionMonths">30-Day Extensions</label>' +
      '    <input id="GuideExtensionMonths" class="field__input" type="number" min="1" max="24" step="1" inputmode="numeric" data-months-input value="' +
      escapeHtml(state.monthsRaw) +
      '">' +
      '    <p class="guide-extension-price-note">$5 / 30 days — one-time payment at checkout </p>' +
      '    <p class="guide-extension-period-note">1 unit = 30 days. Selected period: ' +
      escapeHtml(selectedPeriodDisplay) +
      ".</p>" +
      '    <p class="guide-extension-validation' +
      validationClass +
      '">' +
      validationMessage +
      "</p>" +
      "  </div>" +
      '  <div class="guide-extension-expiry-block">' +
      '    <p class="guide-extension-expiry-block__label">Days Remaining</p>' +
      '    <p class="guide-extension-expiry-block__value">' +
      escapeHtml(expiryDateDisplay) +
      "</p>" +
      (extendedExpiryDisplay
        ? '<p class="guide-extension-period-note">Access after this extension: until ' +
          escapeHtml(extendedExpiryDisplay) +
          " (Korea time). Confirmed after payment.</p>"
        : "") +
      "  </div>" +
      '  <div class="guide-extension-actions">' +
      '    <button class="button" type="button" data-action="checkout" ' +
      (disableActions ? "disabled" : "") +
      ">" +
      (isCheckoutLoading ? "Processing..." : "Extend My Access") +
      "    </button>" +
      "  </div>" +
      checkoutErrorHtml +
      "</section>"
    );
  }

  function renderEntitlements(entitlements) {
    state.root.innerHTML = renderForm(entitlements);
  }

  function render() {
    if (!state.root) {
      return;
    }

    if (state.status === "loading") {
      renderLoading();
      return;
    }

    if (state.status === "error") {
      renderError(state.error);
      return;
    }

    if (state.status === "success") {
      renderEntitlements(state.entitlements);
    }
  }

  function initializeFormState() {
    var itemsByType = getItemsByType(state.entitlements);
    var activeTypes = getActiveTypes(itemsByType);
    if (!activeTypes.length) {
      state.selectedType = null;
    } else if (!state.selectedType || activeTypes.indexOf(state.selectedType) === -1) {
      state.selectedType = activeTypes[0];
    }

    if (state.pendingSelectType && activeTypes.indexOf(state.pendingSelectType) !== -1) {
      state.selectedType = state.pendingSelectType;
      state.pendingSelectType = null;
    }

    var validation = validateMonths(state.monthsRaw);
    state.validationError = validation.error;
    state.months = validation.value;
    state.preview = null;
    state.checkoutError = null;
    state.checkoutStatus = "idle";
  }

  function applyExternalSelectedType(type) {
    if (!type || TYPE_ORDER.indexOf(type) === -1) {
      return;
    }

    if (state.status !== "success" || !state.entitlements) {
      state.pendingSelectType = type;
      return;
    }

    var itemsByType = getItemsByType(state.entitlements);
    var item = itemsByType[type];
    if (!item || item.status !== "ACTIVE") {
      state.pendingSelectType = type;
      return;
    }

    state.selectedType = type;
    state.preview = null;
    state.checkoutError = null;
    state.checkoutStatus = "idle";
    render();

    setTimeout(function () {
      if (!state.root) {
        return;
      }
      var monthsInput = state.root.querySelector("[data-months-input]");
      if (monthsInput && typeof monthsInput.focus === "function") {
        monthsInput.focus();
      }
    }, 0);
  }

  async function fetchEntitlements(isRefresh) {
    state.status = "loading";
    state.error = null;
    state.checkoutError = null;
    render();

    try {
      var url = buildEntitlementsUrl(state.customerId, isRefresh);
      var payload = await fetchEnvelope(url, isRefresh ? { cache: "no-store" } : undefined);
      state.status = "success";
      state.entitlements = payload.data;
      state.error = null;
      initializeFormState();
      render();
    } catch (error) {
      state.status = "error";
      state.error = normalizeError(error);
      render();
    }
  }

  async function requestCheckout(action) {
    if (state.validationError || !state.selectedType || !state.months) {
      return;
    }

    state.checkoutStatus = "loading";
    state.checkoutError = null;
    state.lastCheckoutAction = action;
    render();

    try {
      var url = buildCheckoutUrl(state.customerId, action === "checkout");
      var payload = await fetchEnvelope(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: state.selectedType, months: state.months }),
      });

      var data = payload.data || {};
      state.preview = data.preview ? data.preview : null;

      if (action === "checkout") {
        if (
          window.BtaThemeCartCheckout &&
          typeof window.BtaThemeCartCheckout.isThemeCartIntent === "function" &&
          window.BtaThemeCartCheckout.isThemeCartIntent(data)
        ) {
          await window.BtaThemeCartCheckout.runIntent(data);
          return;
        }

        if (data.checkoutMode === "theme_cart") {
          throw {
            code: "INVALID_RESPONSE",
            message: "Checkout could not be prepared. Please try again.",
            raw: data,
          };
        }

        if (data.checkoutUrl) {
          var checkoutUrl = data.checkoutUrl;
          var isOnlyType = state.selectedType === "PDF" || state.selectedType === "VIDEO";
          if (isOnlyType) {
            var returnTo = "https://kpurpleshoes.com/pages/extention-thank";
            var sep = checkoutUrl.indexOf("?") !== -1 ? "&" : "?";
            checkoutUrl += sep + "return_to=" + encodeURIComponent(returnTo);
          }
          window.location.href = checkoutUrl;
          return;
        }

        throw {
          code: "INVALID_RESPONSE",
          message: "Checkout could not be prepared. Please try again.",
          raw: data,
        };
      }

      state.checkoutStatus = "idle";
      state.checkoutError = null;
      render();
    } catch (error) {
      var normalized = normalizeError(error);

      if (normalized.code === "GUIDE_EXTENSION_INVALID_INPUT") {
        state.validationError = "Enter a whole number from 1 to 24. Each unit adds 30 days.";
        state.checkoutStatus = "idle";
        state.checkoutError = null;
        render();
        return;
      }

      state.checkoutError = normalized;
      state.checkoutStatus = "idle";
      render();
    }
  }

  function handleRootClick(event) {
    var actionEl = event.target.closest("[data-action]");
    if (!actionEl) {
      return;
    }

    if (actionEl.dataset.action === "retry-entitlements") {
      event.preventDefault();
      fetchEntitlements();
      return;
    }

    if (actionEl.dataset.action === "refresh-entitlements") {
      event.preventDefault();
      fetchEntitlements(true);
      return;
    }

    if (actionEl.dataset.action === "preview") {
      event.preventDefault();
      requestCheckout("preview");
      return;
    }

    if (actionEl.dataset.action === "checkout") {
      event.preventDefault();
      requestCheckout("checkout");
      return;
    }

    if (actionEl.dataset.action === "retry-checkout") {
      event.preventDefault();
      if (state.lastCheckoutAction) {
        requestCheckout(state.lastCheckoutAction);
      }
      return;
    }
  }

  function handleRootChange(event) {
    var target = event.target;
    if (!target) {
      return;
    }

    if (target.matches("[data-type-radio]")) {
      state.selectedType = target.value;
      state.preview = null;
      state.checkoutError = null;
      render();
      return;
    }

    if (target.matches("[data-months-input]")) {
      state.monthsRaw = target.value;
      var validation = validateMonths(state.monthsRaw);
      state.validationError = validation.error;
      state.months = validation.value;
      state.preview = null;
      state.checkoutError = null;
      render();
    }
  }

  function init() {
    state.root = document.getElementById("GuideExtensionRoot");
    if (!state.root) {
      return;
    }

    state.customerId = state.root.getAttribute("data-customer-id");
    if (!state.customerId) {
      state.status = "error";
      state.error = normalizeError({ code: "MISSING_CUSTOMER_ID" });
      render();
      return;
    }

    state.root.addEventListener("click", handleRootClick);
    state.root.addEventListener("change", handleRootChange);
    state.root.addEventListener("input", handleRootChange);
    document.addEventListener("guide-extension:select-type", function (event) {
      var selectedType = event && event.detail ? event.detail.type : null;
      applyExternalSelectedType(selectedType);
    });
    fetchEntitlements();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
