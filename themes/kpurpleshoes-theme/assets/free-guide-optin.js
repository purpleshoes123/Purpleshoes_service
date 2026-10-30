(function () {
  var SECTION_SELECTOR = "[data-fgo-section]";
  var RETRYABLE_CODES = {
    RATE_LIMITED: true,
    MAILER_RATE_LIMITED: true,
    MAILER_PROVIDER_ERROR: true,
    MAILER_PROVIDER_TIMEOUT: true,
  };
  var CONFIG_CODES = {
    AUTH_PROXY_SIGNATURE_INVALID: true,
    MAILER_TEMPLATE_NOT_FOUND: true,
    MAILER_TEMPLATE_INACTIVE: true,
    MAILER_NOT_CONFIGURED: true,
    INTERNAL_ERROR: true,
  };
  var sectionStates = new WeakMap();
  var recaptchaPromises = {};

  function logInfo(message, details) {
    if (typeof details === "undefined") {
      console.info("[FGO]", message);
      return;
    }
    console.info("[FGO]", message, details);
  }
  function logWarn(message, details) {
    if (typeof details === "undefined") {
      console.warn("[FGO]", message);
      return;
    }
    console.warn("[FGO]", message, details);
  }
  function logError(message, details) {
    if (typeof details === "undefined") {
      console.error("[FGO]", message);
      return;
    }
    console.error("[FGO]", message, details);
  }

  function createRequestKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "fgo-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function createError(code, message, correlationId) {
    var error = new Error(message || "Mail request failed");
    error.code = code || "";
    error.correlationId = correlationId || "";
    return error;
  }

  function getSectionParts(root) {
    var form = root.querySelector("[data-fgo-form]");
    if (!form) {
      return null;
    }
    return {
      root: root,
      form: form,
      emailInput: form.querySelector("[data-fgo-email]"),
      marketingConsent: form.querySelector("[data-fgo-marketing-consent]"),
      submitButton: form.querySelector("[data-fgo-submit]"),
      status: form.querySelector("[data-fgo-status]"),
      captchaMessage: form.querySelector("[data-fgo-captcha-status]"),
      success: root.querySelector("[data-fgo-success]"),
      successTitle: root.querySelector(".fgo__success-title"),
      successSub: root.querySelector(".fgo__success-sub"),
      subscriptionNotice: root.querySelector("[data-fgo-subscription-notice]"),
    };
  }

  function setStatus(parts, message, tone) {
    if (!parts.status) {
      return;
    }
    parts.status.hidden = !message;
    parts.status.textContent = message || "";
    parts.status.classList.remove("fgo__status--error", "fgo__status--success");
    if (message && tone === "error") {
      parts.status.classList.add("fgo__status--error");
    }
    if (message && tone === "success") {
      parts.status.classList.add("fgo__status--success");
    }
  }

  function setCaptchaMessage(parts, message) {
    if (!parts.captchaMessage || !message) {
      return;
    }
    parts.captchaMessage.textContent = message;
  }

  function getState(parts) {
    var state = sectionStates.get(parts.root);
    if (!state) {
      state = {
        activeRequestKey: null,
        emailSnapshot: "",
        submitting: false,
        completed: false,
        defaultButtonLabel:
          parts.root.dataset.submitLabel ||
          (parts.submitButton ? parts.submitButton.textContent : ""),
        loadingButtonLabel: parts.root.dataset.submitLoadingLabel || "Sending...",
        defaultCaptchaMessage: parts.captchaMessage ? parts.captchaMessage.textContent : "",
        defaultSuccessTitle: parts.successTitle ? parts.successTitle.textContent : "",
        defaultSuccessSub: parts.successSub ? parts.successSub.textContent : "",
      };
      sectionStates.set(parts.root, state);
    }
    return state;
  }

  function resetRequestKey(state) {
    state.activeRequestKey = null;
    state.emailSnapshot = "";
  }

  function syncRequestKey(state, email) {
    if (state.emailSnapshot && state.emailSnapshot !== email) {
      state.activeRequestKey = null;
    }
    state.emailSnapshot = email;
  }

  function getOrCreateRequestKey(state) {
    if (!state.activeRequestKey) {
      state.activeRequestKey = createRequestKey();
    }
    return state.activeRequestKey;
  }

  function setSubmitting(parts, isSubmitting) {
    var state = getState(parts);
    state.submitting = isSubmitting;
    parts.emailInput.readOnly = isSubmitting;
    if (parts.marketingConsent) {
      parts.marketingConsent.disabled = isSubmitting;
    }
    if (parts.submitButton) {
      parts.submitButton.disabled = isSubmitting;
      parts.submitButton.setAttribute("aria-busy", isSubmitting ? "true" : "false");
      parts.submitButton.textContent = isSubmitting
        ? state.loadingButtonLabel
        : state.defaultButtonLabel;
    }
  }

  function ensureConfig(parts) {
    var templateSlug = (parts.root.dataset.templateSlug || "").trim();
    var siteKey = (parts.root.dataset.recaptchaSiteKey || "").trim();
    if (!templateSlug || !siteKey) {
      if (parts.submitButton) {
        parts.submitButton.disabled = true;
      }
      setCaptchaMessage(
        parts,
        "Email verification is unavailable right now. Please try again later.",
      );
      setStatus(parts, "This guide is temporarily unavailable. Please try again later.", "error");
      logWarn("Missing mailer configuration", {
        sectionId: parts.root.dataset.sectionId || "",
        hasTemplateSlug: Boolean(templateSlug),
        hasRecaptchaSiteKey: Boolean(siteKey),
      });
      return false;
    }
    return true;
  }

  function ensureRecaptcha(siteKey) {
    if (window.grecaptcha && typeof window.grecaptcha.execute === "function") {
      return Promise.resolve(window.grecaptcha);
    }
    if (recaptchaPromises[siteKey]) {
      return recaptchaPromises[siteKey];
    }
    recaptchaPromises[siteKey] = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var resolved = false;
      function finish() {
        if (resolved) {
          return;
        }
        if (window.grecaptcha && typeof window.grecaptcha.ready === "function") {
          window.grecaptcha.ready(function () {
            resolved = true;
            resolve(window.grecaptcha);
          });
          return;
        }
        reject(createError("RECAPTCHA_NOT_READY", "reCAPTCHA is not ready"));
      }
      script.src = "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(siteKey);
      script.async = true;
      script.defer = true;
      script.onload = finish;
      script.onerror = function () {
        reject(createError("RECAPTCHA_SCRIPT_LOAD_FAILED", "reCAPTCHA failed to load"));
      };
      document.head.appendChild(script);
    });
    return recaptchaPromises[siteKey];
  }

  function parseJson(response) {
    return response.json().catch(function () {
      return null;
    });
  }

  function getErrorMessage(error) {
    if (!error) {
      return "We could not send the guide right now. Please try again.";
    }
    if (error.code === "MAILER_INVALID_INPUT") {
      return "Please double-check your email address and try again.";
    }
    if (
      error.code === "MAILER_RECAPTCHA_FAILED" ||
      error.code === "RECAPTCHA_NOT_READY" ||
      error.code === "RECAPTCHA_SCRIPT_LOAD_FAILED"
    ) {
      return "We could not verify your request. Please refresh and try again.";
    }
    if (RETRYABLE_CODES[error.code] || error.isNetworkError) {
      return "The email service is busy right now. Please try again in a moment.";
    }
    if (CONFIG_CODES[error.code]) {
      return "This guide is temporarily unavailable. Please try again later.";
    }
    return "We could not send the guide right now. Please try again.";
  }

  function showSuccess(parts, payload) {
    var state = getState(parts);
    if (parts.successTitle) {
      parts.successTitle.textContent = state.defaultSuccessTitle;
    }
    if (parts.successSub) {
      parts.successSub.textContent = state.defaultSuccessSub;
    }
    parts.form.hidden = true;
    if (parts.success) {
      parts.success.hidden = false;
    }
    setStatus(parts, "", "");
  }

  function redirectToSuccessPage(parts) {
    var redirectUrl = (parts.root.dataset.successRedirectUrl || "").trim();
    if (!redirectUrl) {
      return;
    }
    window.location.assign(redirectUrl);
  }

  function saveLeadReceipt(payload) {
    try {
      if (payload && typeof payload.leadReceipt === "string" && payload.leadReceipt.length > 0) {
        window.sessionStorage.setItem("ps:squeeze:lead-receipt", payload.leadReceipt);
      }
    } catch (_error) {
      // The guide still succeeds if browser storage is unavailable.
    }
  }

  var privacyReady;
  function ensurePrivacyReady() {
    if (privacyReady) {
      return privacyReady;
    }
    privacyReady = new Promise(function (resolve) {
      if (!window.Shopify || typeof window.Shopify.loadFeatures !== "function") {
        resolve();
        return;
      }
      var timeout = setTimeout(resolve, 1500);
      try {
        window.Shopify.loadFeatures(
          [{ name: "consent-tracking-api", version: "0.1" }],
          function () {
            clearTimeout(timeout);
            resolve();
          },
        );
      } catch (_error) {
        clearTimeout(timeout);
        resolve();
      }
    });
    return privacyReady;
  }

  function buildRequestBody(parts, state, recaptchaToken) {
    var email = parts.emailInput.value.trim();
    var templateSlug = (parts.root.dataset.templateSlug || "").trim();
    syncRequestKey(state, email);
    var metaMarketingAllowed = false;
    try {
      var privacy = window.Shopify && window.Shopify.customerPrivacy;
      metaMarketingAllowed = Boolean(
        privacy &&
        typeof privacy.marketingAllowed === "function" &&
        privacy.marketingAllowed() &&
        typeof privacy.saleOfDataAllowed === "function" &&
        privacy.saleOfDataAllowed(),
      );
    } catch (_error) {
      // Tracking permission is unknown; send the guide without ad tracking.
    }
    return {
      templateSlug: templateSlug,
      email: email,
      pagePath: window.location.pathname,
      recaptchaToken: recaptchaToken,
      requestKey: getOrCreateRequestKey(state),
      metaMarketingAllowed: metaMarketingAllowed,
    };
  }

  function requestMail(body, endpoint) {
    return fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }).catch(function (error) {
      error.isNetworkError = true;
      throw error;
    });
  }

  async function subscriptionRequest(provider, url, options, verify) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 10000);
    try {
      options.signal = controller.signal;
      var response = await fetch(url, options);
      var accepted = response.ok && (await verify(response));
      if (!accepted) {
        throw createError("SUBSCRIPTION_UNCONFIRMED", String(response.status));
      }
      logInfo(provider + " subscription request accepted");
      return true;
    } catch (error) {
      logWarn(
        provider + " subscription not confirmed",
        JSON.stringify({
          code: error.name === "AbortError" ? "TIMEOUT" : error.code || "NETWORK_ERROR",
        }),
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function subscribeToKlaviyo(email, apiKey, listId) {
    if (!apiKey || !listId) {
      logWarn("[FGO] Klaviyo subscription skipped — api key or list id missing");
      return Promise.resolve(false);
    }
    return subscriptionRequest(
      "Klaviyo",
      "https://a.klaviyo.com/client/subscriptions/?company_id=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json", revision: "2026-07-15" },
        body: JSON.stringify({
          data: {
            type: "subscription",
            attributes: {
              custom_source: "Purple Shoes Starter Kit",
              profile: {
                data: {
                  type: "profile",
                  attributes: {
                    email: email,
                    subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } },
                  },
                },
              },
            },
            relationships: {
              list: {
                data: { type: "list", id: listId },
              },
            },
          },
        }),
      },
      function (response) {
        return response.status === 202;
      },
    );
  }

  async function runSubmit(parts) {
    var state = getState(parts);
    var endpoint = parts.root.dataset.mailerEndpoint || "/apps/bta-booking/mail/request";
    var siteKey = (parts.root.dataset.recaptchaSiteKey || "").trim();
    var action = (parts.root.dataset.recaptchaAction || "mail_request_submit").trim();
    var email = parts.emailInput.value.trim();
    var marketingConsent = Boolean(parts.marketingConsent && parts.marketingConsent.checked);

    await ensurePrivacyReady();

    setCaptchaMessage(parts, "Verifying your request...");

    var recaptcha = await ensureRecaptcha(siteKey);
    var recaptchaToken = await recaptcha.execute(siteKey, { action: action });

    if (!recaptchaToken) {
      throw createError("MAILER_RECAPTCHA_FAILED", "Missing reCAPTCHA token");
    }

    var response = await requestMail(buildRequestBody(parts, state, recaptchaToken), endpoint);
    var payload = await parseJson(response);

    if (!response.ok || !payload || !payload.ok) {
      throw createError(
        payload && payload.error ? payload.error.code : "",
        payload && payload.error ? payload.error.message : "Mail request failed",
        (payload && payload.meta && payload.meta.correlationId) ||
          response.headers.get("X-Correlation-Id") ||
          "",
      );
    }

    var data = payload.data || {};
    if (marketingConsent) {
      data.subscriptionIncomplete = !(await subscribeToKlaviyo(
        email,
        (parts.root.dataset.klaviyoApiKey || "").trim(),
        (parts.root.dataset.klaviyoListId || "").trim(),
      ));
    }

    resetRequestKey(state);
    return data;
  }

  function attachFormHandler(parts) {
    if (!parts.form || !parts.emailInput || !parts.submitButton) {
      return;
    }

    parts.emailInput.addEventListener("input", function () {
      var state = getState(parts);
      var value = parts.emailInput.value.trim();
      if (!value) {
        resetRequestKey(state);
      } else if (state.emailSnapshot && state.emailSnapshot !== value) {
        state.activeRequestKey = null;
        state.emailSnapshot = value;
      }
      setStatus(parts, "", "");
      setCaptchaMessage(parts, state.defaultCaptchaMessage);
    });

    parts.form.addEventListener("submit", async function (event) {
      var state = getState(parts);
      event.preventDefault();
      if (state.submitting || state.completed) {
        return;
      }

      if (!parts.emailInput.checkValidity()) {
        parts.emailInput.reportValidity();
        return;
      }
      if (!ensureConfig(parts)) {
        return;
      }

      setSubmitting(parts, true);
      setStatus(parts, "", "");

      try {
        var payload = await runSubmit(parts);
        state.completed = true;
        setCaptchaMessage(parts, state.defaultCaptchaMessage);
        showSuccess(parts, payload);
        saveLeadReceipt(payload);
        logInfo("Guide mail request succeeded");
        if (payload.subscriptionIncomplete && parts.subscriptionNotice) {
          parts.subscriptionNotice.hidden = false;
        } else {
          redirectToSuccessPage(parts);
        }
      } catch (error) {
        logError("Guide mail request failed", {
          code: error && error.code ? error.code : "",
          message: error && error.message ? error.message : "",
          correlationId: error && error.correlationId ? error.correlationId : "",
        });
        setStatus(parts, getErrorMessage(error), "error");
        setCaptchaMessage(parts, state.defaultCaptchaMessage);
      } finally {
        setSubmitting(parts, false);
      }
    });
  }

  function initSection(root) {
    var parts = getSectionParts(root);
    if (!parts || root.dataset.fgoInitialized === "true") {
      return;
    }
    root.dataset.fgoInitialized = "true";
    getState(parts);
    attachFormHandler(parts);
    logInfo("Initialized free guide opt-in (Klaviyo with Shopify integration sync)", {
      sectionId: root.dataset.sectionId || "",
    });
    ensureConfig(parts);
  }

  function initAll(scope) {
    var nodes = (scope || document).querySelectorAll(SECTION_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      initSection(nodes[i]);
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
