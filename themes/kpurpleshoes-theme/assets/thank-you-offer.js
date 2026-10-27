(function () {
  var SECTION_SELECTOR = "[data-ty-offer]";
  var sectionStates = new WeakMap();
  var ALREADY_ACTIVE_CODES = {
    EXTRA10_ALREADY_ACTIVE: true,
    EXTRA10_ALREADY_GRANTED: true,
    EXTRA10_ALREADY_ISSUED: true,
    EXTRA10_ALREADY_REDEEMED: true,
  };

  function createClientRequestId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return (prefix || "ty") + "-" + window.crypto.randomUUID();
    }

    return (prefix || "ty") + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function createError(code, message, correlationId) {
    var error = new Error(message || "Request failed");
    error.code = code || "";
    error.correlationId = correlationId || "";
    return error;
  }

  function getSectionParts(root) {
    return {
      root: root,
      timerWrap: root.querySelector("[data-guide50-timer]"),
      timerUrgency: root.querySelector("[data-guide50-urgency]"),
      timerDisplay: root.querySelector("[data-guide50-timer-display]"),
      timerExpired: root.querySelector("[data-guide50-timer-expired]"),
      timerNote: root.querySelector("[data-guide50-timer-note]"),
      referralSection: root.querySelector("[data-referral-section]"),
      shareButton: root.querySelector("[data-referral-share-button]"),
      copyButton: root.querySelector("[data-referral-copy-button]"),
      referralStatus: root.querySelector("[data-referral-status]"),
      referralLinkPreview: root.querySelector("[data-referral-link-preview]"),
    };
  }

  function getState(parts) {
    var state = sectionStates.get(parts.root);

    if (!state) {
      state = {
        timerId: null,
        shareButtonLabel: parts.shareButton ? parts.shareButton.textContent : "",
        copyButtonLabel: parts.copyButton ? parts.copyButton.textContent : "",
        referralUrl: (parts.root.dataset.referralUrl || window.location.origin || "").trim(),
      };
      sectionStates.set(parts.root, state);
    }

    return state;
  }

  function parseJson(response) {
    return response
      .json()
      .catch(function () {
        return null;
      });
  }

  async function requestEnvelope(endpoint, options) {
    if (window.psWelcomeOfferReady) await window.psWelcomeOfferReady;
    var fetchOptions = {
      method: options && options.method ? options.method : "GET",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    };

    if (options && options.body) {
      fetchOptions.headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.body);
    }

    var response;
    var payload;

    try {
      response = await fetch(endpoint, fetchOptions);
    } catch (error) {
      error.code = error.code || "NETWORK_ERROR";
      throw error;
    }

    payload = await parseJson(response);

    if (!response.ok || !payload || payload.ok === false) {
      throw createError(
        payload && payload.error ? payload.error.code : "",
        payload && payload.error ? payload.error.message : "Request failed",
        (payload && payload.meta && payload.meta.correlationId) || response.headers.get("X-Correlation-Id") || ""
      );
    }

    return payload;
  }

  function clearTimer(parts) {
    var state = getState(parts);

    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function setTimerNote(parts, message) {
    if (!parts.timerNote) {
      return;
    }

    parts.timerNote.hidden = !message;
    parts.timerNote.textContent = message || "";
  }

  function setTimerExpired(parts, message) {
    clearTimer(parts);

    if (!parts.timerWrap) {
      return;
    }

    parts.timerWrap.hidden = false;
    parts.timerWrap.classList.add("is-expired");

    if (parts.timerDisplay) {
      parts.timerDisplay.textContent = "00:00:00";
    }

    if (parts.timerExpired) {
      parts.timerExpired.hidden = false;
      parts.timerExpired.textContent = message || "Coupon expired";
    }
  }

  function pad(number) {
    return number < 10 ? "0" + number : String(number);
  }

  function formatDuration(totalSeconds) {
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    return pad(hours) + ":" + pad(minutes) + ":" + pad(seconds);
  }

  function resolveGuide50ExpiryMs(guide50) {
    if (!guide50 || typeof guide50 !== "object") {
      return null;
    }

    if (guide50.expiresAt) {
      var expiresAtMs = new Date(guide50.expiresAt).getTime();
      if (!isNaN(expiresAtMs)) {
        return expiresAtMs;
      }
    }

    if (typeof guide50.ttlSeconds === "number" && guide50.ttlSeconds > 0) {
      return Date.now() + (guide50.ttlSeconds * 1000);
    }

    return null;
  }

  function getLegacyExpiryMs(parts) {
    if (!parts.timerWrap) {
      return null;
    }

    var raw = (parts.timerWrap.getAttribute("data-legacy-end-time") || "").trim();
    var unixSeconds = raw ? parseInt(raw, 10) : NaN;

    if (isNaN(unixSeconds) || unixSeconds <= 0) {
      return null;
    }

    return unixSeconds * 1000;
  }

  function startGuide50Timer(parts, expiryMs, note) {
    var state = getState(parts);

    if (!parts.timerWrap || !parts.timerDisplay) {
      return;
    }

    clearTimer(parts);
    parts.timerWrap.hidden = false;
    parts.timerWrap.classList.remove("is-expired");

    if (parts.timerExpired) {
      parts.timerExpired.hidden = true;
      parts.timerExpired.textContent = "Coupon expired";
    }

    setTimerNote(parts, note || "");

    function tick() {
      var leftSeconds = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));

      if (leftSeconds <= 0) {
        setTimerNote(parts, "");
        setTimerExpired(parts, "Coupon expired");
        return;
      }

      parts.timerDisplay.textContent = formatDuration(leftSeconds);
    }

    tick();
    state.timerId = window.setInterval(tick, 1000);
  }

  function updateGuide50Timer(parts, data, options) {
    var guide50 = data && data.coupons ? data.coupons.guide50 : null;
    var expiryMs = resolveGuide50ExpiryMs(guide50);
    var legacyExpiryMs = getLegacyExpiryMs(parts);

    if (guide50 && guide50.available === true && expiryMs) {
      startGuide50Timer(parts, expiryMs, "");
      return;
    }

    if (options && options.allowLegacyFallback && legacyExpiryMs && legacyExpiryMs > Date.now()) {
      startGuide50Timer(parts, legacyExpiryMs, "Live coupon status could not be refreshed.");
      return;
    }

    if (guide50 && guide50.available === false) {
      setTimerNote(parts, "");
      setTimerExpired(parts, "Coupon expired");
      return;
    }

    if (options && options.hideWhenUnavailable && parts.timerWrap) {
      clearTimer(parts);
      parts.timerWrap.hidden = true;
      return;
    }

    setTimerNote(parts, "");
    setTimerExpired(parts, "Coupon status unavailable");
  }

  function setReferralStatus(parts, message, tone) {
    if (!parts.referralStatus) {
      return;
    }

    parts.referralStatus.hidden = !message;
    parts.referralStatus.textContent = message || "";
    parts.referralStatus.classList.remove("ty-offer__referral-status--success", "ty-offer__referral-status--error");

    if (message && tone === "success") {
      parts.referralStatus.classList.add("ty-offer__referral-status--success");
    }

    if (message && tone === "error") {
      parts.referralStatus.classList.add("ty-offer__referral-status--error");
    }
  }

  function setButtonState(button, isBusy, busyLabel, idleLabel) {
    if (!button) {
      return;
    }

    button.disabled = isBusy;
    button.textContent = isBusy ? busyLabel : idleLabel;
  }

  function updateReferralUi(parts, data, options) {
    var state = getState(parts);
    var extra10 = data && data.coupons ? data.coupons.extra10 : null;
    var activationState = extra10 && (extra10.activationState || extra10.shareActivationState || extra10.status || "");
    var isActive = !!(extra10 && extra10.available === true);
    var isActivatedState = activationState === "activated" || activationState === "issued" || activationState === "already_activated";
    var shouldShowActivated = isActive || isActivatedState;

    if (parts.referralLinkPreview) {
      parts.referralLinkPreview.textContent = state.referralUrl;
    }

    if (parts.shareButton) {
      parts.shareButton.hidden = shouldShowActivated;
    }

    if (parts.copyButton) {
      parts.copyButton.hidden = !shouldShowActivated || !state.referralUrl;
    }

    if (!options || !options.preserveStatus) {
      if (shouldShowActivated) {
        setReferralStatus(parts, "Your Extra $10 coupon is active. You can find it in My Coupons.", "success");
      } else {
        setReferralStatus(parts, "", "");
      }
    }
  }

  function showActivatedReferralUi(parts) {
    var state = getState(parts);

    if (parts.shareButton) {
      parts.shareButton.hidden = true;
    }

    if (parts.copyButton) {
      parts.copyButton.hidden = !state.referralUrl;
    }
  }

  async function loadCouponSummary(parts, options) {
    var endpoint = parts.root.dataset.summaryEndpoint || "/apps/bta-booking/coupons/summary";
    var payload = await requestEnvelope(endpoint, { method: "GET" });
    var data = payload.data || {};

    updateGuide50Timer(parts, data, options || {});
    updateReferralUi(parts, data, options || {});

    return data;
  }

  function getReferralErrorMessage(error) {
    if (!error) {
      return "We could not activate your coupon right now. Please try again.";
    }

    if (error.code === "AUTH_LOGIN_REQUIRED") {
      return "Please sign in again to activate your Extra $10 coupon.";
    }

    if (ALREADY_ACTIVE_CODES[error.code]) {
      return "Your Extra $10 coupon is already active in My Coupons.";
    }

    if (error.code === "VALIDATION_ERROR") {
      return "We could not prepare your share link. Please refresh and try again.";
    }

    if (error.code === "RATE_LIMITED" || error.code === "NETWORK_ERROR") {
      return "The share service is busy right now. Please try again in a moment.";
    }

    return "We could not activate your coupon right now. Please try again.";
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }

    var helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "readonly");
    helper.style.position = "absolute";
    helper.style.left = "-9999px";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    document.body.removeChild(helper);
  }

  async function shareReferralLink(parts) {
    var state = getState(parts);
    var shareUrl = state.referralUrl;

    if (!shareUrl) {
      return "ready";
    }

    if (navigator.share && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: parts.root.dataset.shareTitle || document.title,
          text: parts.root.dataset.shareText || "",
          url: shareUrl,
        });
        return "shared";
      } catch (error) {
        if (error && error.name === "AbortError") {
          return "dismissed";
        }
      }
    }

    await copyText(shareUrl);
    return "copied";
  }

  async function activateShareCoupon(parts) {
    var state = getState(parts);
    var endpoint = parts.root.dataset.shareActivateEndpoint || "/apps/bta-booking/coupons/extra10/activate-share";

    return requestEnvelope(endpoint, {
      method: "POST",
      body: {
        shareUrl: state.referralUrl,
        source: "thank-you-offer",
        clientRequestId: createClientRequestId("share"),
      },
    });
  }

  async function handleShareClick(parts) {
    var state = getState(parts);
    var outcome;

    if (!state.referralUrl) {
      setReferralStatus(parts, "A homepage link is not configured right now.", "error");
      return;
    }

    setButtonState(parts.shareButton, true, "Activating...", state.shareButtonLabel);
    setReferralStatus(parts, "", "");

    try {
      await activateShareCoupon(parts);
      await loadCouponSummary(parts, { preserveStatus: true });
      showActivatedReferralUi(parts);
      outcome = await shareReferralLink(parts);

      var customCopyMsg = parts.root.dataset.referralCopySuccess || "";
      if (outcome === "shared") {
        setReferralStatus(parts, customCopyMsg || "Your Extra $10 coupon is active. The homepage link has been shared.", "success");
      } else if (outcome === "copied") {
        setReferralStatus(parts, customCopyMsg || "Your Extra $10 coupon is active. The homepage link has been copied.", "success");
      } else {
        setReferralStatus(parts, customCopyMsg || "Your Extra $10 coupon is active. You can share the homepage link anytime.", "success");
      }
    } catch (error) {
      if (ALREADY_ACTIVE_CODES[error.code]) {
        await loadCouponSummary(parts, { preserveStatus: true, hideWhenUnavailable: false });
        showActivatedReferralUi(parts);
        setReferralStatus(parts, getReferralErrorMessage(error), "success");
      } else {
        setReferralStatus(parts, getReferralErrorMessage(error), "error");
      }
    } finally {
      setButtonState(parts.shareButton, false, "Activating...", state.shareButtonLabel);
    }
  }

  async function handleCopyClick(parts) {
    var state = getState(parts);

    if (!state.referralUrl) {
      setReferralStatus(parts, "A homepage link is not configured right now.", "error");
      return;
    }

    try {
      await copyText(state.referralUrl);
      setReferralStatus(parts, "The homepage link has been copied.", "success");
    } catch (error) {
      setReferralStatus(parts, "We could not copy the homepage link. Please try again.", "error");
    }
  }

  function attachHandlers(parts) {
    if (parts.shareButton) {
      parts.shareButton.addEventListener("click", function () {
        handleShareClick(parts);
      });
    }

    if (parts.copyButton) {
      parts.copyButton.addEventListener("click", function () {
        handleCopyClick(parts);
      });
    }
  }

  async function initSection(root) {
    var parts = getSectionParts(root);

    if (root.dataset.tyOfferInitialized === "true") {
      return;
    }

    root.dataset.tyOfferInitialized = "true";
    getState(parts);
    attachHandlers(parts);

    if (!root.dataset.customerId) {
      updateGuide50Timer(parts, {}, { hideWhenUnavailable: true });
      updateReferralUi(parts, {}, {});
      if (parts.shareButton) {
        parts.shareButton.hidden = true;
      }
      if (parts.copyButton) {
        parts.copyButton.hidden = true;
      }
      setReferralStatus(parts, "Please sign in again to view your coupon status.", "error");
      return;
    }

    try {
      await loadCouponSummary(parts, { allowLegacyFallback: false, hideWhenUnavailable: false });
    } catch (error) {
      updateGuide50Timer(parts, {}, { allowLegacyFallback: true, hideWhenUnavailable: false });
      updateReferralUi(parts, {}, {});
      if (error && error.code === "AUTH_LOGIN_REQUIRED") {
        if (parts.shareButton) {
          parts.shareButton.hidden = true;
        }
        if (parts.copyButton) {
          parts.copyButton.hidden = true;
        }
      }
      setReferralStatus(parts, getReferralErrorMessage(error), "error");
    }
  }

  function initAll(scope) {
    var sections = (scope || document).querySelectorAll(SECTION_SELECTOR);
    var index;

    for (index = 0; index < sections.length; index += 1) {
      initSection(sections[index]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initAll(document);
    });
  } else {
    initAll(document);
  }

  document.addEventListener("shopify:section:load", function (event) {
    initAll(event.target);
  });
})();
