/**
 */

(function() {
  'use strict';

  /**
   * @returns {Promise<{ok: boolean, data: any, error: any, meta: any}>}
   */
  async function proxyFetch(path, options = {}) {
    const BASE_PATH = '/apps/bta-booking';
    const TIMEOUT_MS = 8000;

    const url = BASE_PATH + (path.startsWith('/') ? path : '/' + path);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const defaultHeaders = {
      'Accept': 'application/json'
    };

    const headers = Object.assign({}, defaultHeaders, options.headers || {});

    const fetchOptions = {
      method: options.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      signal: controller.signal,
      ...options
    };

    if (options.body && typeof options.body === 'object') {
      fetchOptions.body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');

      let responseData;
      if (isJson) {
        try {
          responseData = await response.json();
        } catch (e) {
          throw {
            kind: 'envelope',
            status: response.status,
            code: 'PARSE_ERROR',
            message: 'Failed to parse the response JSON',
            correlationId: null,
            raw: { parseError: e.message }
          };
        }
      } else {
        responseData = await response.text();
      }

      if (!response.ok) {
        if (isJson && typeof responseData === 'object' && 'ok' in responseData) {
          const envelope = responseData;
          throw {
            kind: 'envelope',
            status: response.status,
            code: envelope.error?.code || 'HTTP_ERROR',
            message: envelope.error?.message || `HTTP ${response.status}`,
            correlationId: envelope.meta?.correlationId || null,
            raw: envelope
          };
        } else {
          throw {
            kind: 'http',
            status: response.status,
            code: 'HTTP_ERROR',
            message: `HTTP ${response.status}: ${response.statusText}`,
            correlationId: null,
            raw: { status: response.status, statusText: response.statusText, body: responseData }
          };
        }
      }

      if (isJson && typeof responseData === 'object') {
        if ('ok' in responseData) {
          const envelope = responseData;
          
          if (!envelope.ok) {
            throw {
              kind: 'envelope',
              status: response.status,
              code: envelope.error?.code || 'ENVELOPE_ERROR',
              message: envelope.error?.message || 'Unknown error',
              correlationId: envelope.meta?.correlationId || null,
              raw: envelope
            };
          }

          return envelope;
        }
      }

      return {
        ok: true,
        data: responseData,
        error: null,
        meta: { correlationId: null }
      };

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.kind) {
        throw error;
      }

      if (error.name === 'AbortError') {
        throw {
          kind: 'timeout',
          status: 0,
          code: 'TIMEOUT',
          message: 'Request timed out',
          correlationId: null,
          raw: { timeout: TIMEOUT_MS }
        };
      }

      throw {
        kind: 'network',
        status: 0,
        code: 'NETWORK_ERROR',
        message: error.message || 'Network error',
        correlationId: null,
        raw: { error: error.message }
      };
    }
  }

  /**
   * @returns {{isLoggedIn: boolean, name: string|null, email: string|null}}
   */
  function getCustomerContext() {
    if (typeof window.__TRAVEL_CUSTOMER__ !== 'undefined') {
      return window.__TRAVEL_CUSTOMER__;
    }
    return {
      isLoggedIn: false,
      name: null,
      email: null
    };
  }

  /**
   * @returns {boolean}
   */
  function isLoggedIn() {
    const ctx = getCustomerContext();
    return ctx.isLoggedIn === true;
  }

  /**
   * @returns {string}
   */
  function buildLoginUrl() {
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    return '/account/login?return_url=' + returnUrl;
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function updateCtaForLoginState(root, config, state) {
    const ctaBtn = root.querySelector('[data-travel-proceed-checkout]');
    if (!ctaBtn) return;

    const newBtn = ctaBtn.cloneNode(true);
    ctaBtn.parentNode.replaceChild(newBtn, ctaBtn);

    if (!isLoggedIn()) {
      newBtn.textContent = 'Login';
      newBtn.setAttribute('data-mode', 'login');
      newBtn.disabled = false;
      
      newBtn.addEventListener('click', function() {
        window.location.href = buildLoginUrl();
      });
    } else {
      newBtn.textContent = config.ctaCheckoutLabel || 'Proceed to checkout';
      newBtn.setAttribute('data-mode', 'booking');
      
      const statusEl = root.querySelector('[data-travel-status]');
      if (statusEl) {
        newBtn.addEventListener('click', async function() {
          updateStateFromDOM(root, state);
          const validation = validateBookingInput(state);
          if (!validation.valid) {
            showStatus(statusEl, validation.message, 'error');
            return;
          }
          if (state.checkoutExtrasModal && typeof state.checkoutExtrasModal.open === 'function') {
            newBtn.disabled = true;
            const modalResult = await state.checkoutExtrasModal.open(newBtn);
            if (!modalResult || modalResult.ok !== true) {
              newBtn.disabled = false;
              return;
            }
          }
          setButtonLoading(newBtn, true);
          newBtn.disabled = true;
          try {
            await runBookingFlow(root, config, state);
          } catch (error) {
            console.error('[Travel Booking] runBookingFlow error:', error);
            setButtonLoading(newBtn, false);
            newBtn.disabled = false;
          }
        });
      }
    }
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} state - booking state
   */
  function requireLoginOrStop(root, state) {
    if (!isLoggedIn()) {
      state.flowState = 'error';
      state.flowErrorMessage = 'Please log in to continue.';
      renderFlowStatus(root, state);
      return false;
    }
    return true;
  }

  /**
   * @param {object} params - { productId, date, travelers: {adult, child, infant}, currency }
   * @returns {Promise<{total: number, breakdown: Array<{label: string, amount: number}>, discountPreview: object|null}>}
   */
  async function getQuote(params) {
    const { productId, travelers, currency = 'USD', date } = params;
    
    if (!productId) {
      throw new Error('productId is required.');
    }
    if (!travelers || travelers.adult < 1) {
      throw new Error('adult must be at least 1.');
    }
    
    const requestBody = {
      productId: String(productId),
      travelers: {
        adult: Number(travelers.adult || 0),
        child: Number(travelers.child || 0),
        infant: Number(travelers.infant || 0)
      },
      currency: currency
    };
    if (date) {
      requestBody.date = String(date);
    }
    
    const envelope = await proxyFetch('/quote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: requestBody
    });
    
    if (!envelope.ok || !envelope.data) {
      throw new Error(envelope.error?.message || 'Failed to load the quote.');
    }
    
    return {
      total: envelope.data.total || 0,
      breakdown: envelope.data.breakdown || [],
      discountPreview: envelope.data.discountPreview || null
    };
  }

  /**
   * @returns {Promise<object|null>}
   */
  async function getCouponSummary() {
    if (window.psWelcomeOfferReady) await window.psWelcomeOfferReady;
    const envelope = await proxyFetch('/coupons/summary', { method: 'GET' });
    if (!envelope.ok || !envelope.data) {
      throw new Error(envelope.error?.message || 'Failed to load the coupon summary.');
    }
    return envelope.data;
  }

  /**
   * @returns {Promise<object|null>}
   */
  async function refreshCreditStatus() {
    const envelope = await proxyFetch('/tour/credit-status', { method: 'GET' });
    if (!envelope.ok || !envelope.data) {
      throw new Error(envelope.error?.message || 'Failed to load the credit status.');
    }
    return envelope.data;
  }

  /**
   */
  async function initTravelBooking() {
    const travelRoot = document.querySelector('[data-travel-root]');
    if (!travelRoot) {
      return;
    }

    initGalleryThumbs(travelRoot);
    if (travelRoot.hasAttribute('data-travel-public-only')) return;

    const sectionId = travelRoot.getAttribute('data-section');
    if (!sectionId) {
      console.warn('[Travel Booking] Section ID not found');
      return;
    }

    const configScript = document.getElementById(`TravelBookingConfig-${sectionId}`);
    if (!configScript) {
      console.warn('[Travel Booking] Config script not found');
      return;
    }

    let config;
    try {
      config = JSON.parse(configScript.textContent);
    } catch (e) {
      console.error('[Travel Booking] Failed to parse config:', e);
      return;
    }

    try {
      let contextPath = config.memberCatalogKey
        ? '/member/catalog?key=' + encodeURIComponent(config.memberCatalogKey)
        : '/booking-context';
      if (config.memberCatalogKey && new URLSearchParams(window.location.search).get('private_checkout_preview') === '1') {
        contextPath += '&private_checkout_preview=1';
      }
      const envelope = await proxyFetch(contextPath, { method: 'GET' });
      if (config.memberCatalogKey) {
        if (!envelope.data || envelope.data.kind !== 'tour') throw new Error('Invalid member tour.');
        Object.assign(config, envelope.data.config);
      }
      const bookingContext = envelope.data && envelope.data.bookingContext;
      if (!bookingContext) throw new Error('Missing booking context.');
      // The opaque context is the only product reference sent to booking APIs.
      config.productId = bookingContext;
      travelRoot.setAttribute('data-product-id', bookingContext);
    } catch (error) {
      console.error('[Travel Booking] Failed to initialize booking context:', error);
      const statusEl = travelRoot.querySelector('[data-travel-status]');
      if (statusEl) showStatus(statusEl, 'The booking service could not be initialized. Please refresh the page.', 'error');
      return;
    }

    if (typeof window.TravelBookingAdapter === 'undefined') {
      window.TravelBookingAdapter = createAdapterStub(config);
    }

    const state = createBookingState(config);
    travelRoot.bookingState = state;

    initHealthCheck(travelRoot, config, state);

    if (isLoggedIn()) {
      initCouponSummary(travelRoot, state);
      initCreditStatus(travelRoot, state);
    }

    const useInlineUI = travelRoot.hasAttribute('data-travel-inline-ui');

    if (useInlineUI) {
      initInlineBookingSelectors(travelRoot, config, state);
    } else {
      initTravelerModal(travelRoot, config);

      initCalendarModal(travelRoot, config);
    }
    state.checkoutExtrasModal = initCheckoutExtrasModal(travelRoot, state);
    initBookingSummary(travelRoot, config, state);

    initCheckAvailability(travelRoot, config, state);
    // initProceedCheckout(travelRoot, config, state);
    attachAvailabilityRetryHandler(travelRoot, config, state);
    attachFlowRetryHandler(travelRoot, config, state);
    attachQuoteRetryHandler(travelRoot, config, state);
    
    updateCheckAvailabilityButton(travelRoot, state);
    updateCheckoutButton(travelRoot, state);
    
  }

  /**
   * @param {HTMLElement} root
   * @param {object} state
   */
  async function initCouponSummary(root, state) {
    try {
      const summary = await getCouponSummary();
      state.couponSummary = summary;
      updateExtra10Availability(root, state);
      updateTour15Availability(root, state);
    } catch (error) {
      state.couponSummary = null;
      updateExtra10Availability(root, state);
      updateTour15Availability(root, state);
      if (error && error.correlationId) {
        console.warn('[booking-proxy] coupon summary failed', {
          correlationId: error.correlationId,
          status: error.status,
          code: error.code
        });
      }
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {object} state
   */
  async function initCreditStatus(root, state) {
    try {
      const creditStatus = await refreshCreditStatus();
      state.creditStatus = creditStatus || null;
      updateTour15Availability(root, state);
    } catch (error) {
      if (error && error.correlationId) {
        console.warn('[booking-proxy] credit-status failed', {
          correlationId: error.correlationId,
          status: error.status,
          code: error.code
        });
      }
      state.creditStatus = null;
      updateTour15Availability(root, state);
    }
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  async function initHealthCheck(root, config, state) {
    state.proxyHealth = 'checking';

    const statusEl = root.querySelector('[data-travel-status]');
    const checkBtn = root.querySelector('[data-travel-check-availability]');
    const checkoutBtn = root.querySelector('[data-travel-proceed-checkout]');

    try {
      const envelope = await proxyFetch('/health', { method: 'GET' });

      if (envelope.ok && envelope.data && envelope.data.status === 'ok') {
        state.proxyHealth = 'up';
        
        if (window.__TRAVEL_DEBUG__) {
          console.log('[booking-proxy] Health check: UP', {
            correlationId: envelope.meta?.correlationId,
            service: envelope.data.service,
            version: envelope.data.version
          });
        }

      } else {
        state.proxyHealth = 'down';
        
        if (window.__TRAVEL_DEBUG__) {
          console.warn('[booking-proxy] Health check: DOWN', {
            correlationId: envelope.meta?.correlationId,
            data: envelope.data
          });
        }

        if (checkBtn) checkBtn.disabled = true;
        if (checkoutBtn) checkoutBtn.disabled = true;

        if (statusEl) {
          showStatus(statusEl, 'The booking service is temporarily unavailable. Please try again shortly.', 'error');
        }
      }
    } catch (error) {
      state.proxyHealth = 'down';

      const correlationId = error.correlationId || null;
      if (correlationId) {
        console.warn('[booking-proxy] Health check failed', {
          correlationId: correlationId,
          kind: error.kind,
          code: error.code
        });
      } else {
        console.warn('[booking-proxy] Health check failed', {
          kind: error.kind,
          code: error.code
        });
      }

      if (checkBtn) checkBtn.disabled = true;
      if (checkoutBtn) checkoutBtn.disabled = true;

      if (statusEl) {
        showStatus(statusEl, 'The booking service is temporarily unavailable. Please try again shortly.', 'error');
      }
    }
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function initDebugUI(root, config, state) {
    const debugPanel = root.querySelector('[data-travel-debug]');
    if (!debugPanel) {
      return;
    }

    const isDebugMode = window.__TRAVEL_DEBUG__ === true || 
                        root.getAttribute('data-travel-debug-enabled') === 'true';

    if (isDebugMode) {
      debugPanel.style.display = 'block';
      debugPanel.setAttribute('data-travel-debug', 'true');
      debugPanel.setAttribute('aria-hidden', 'false');
    }

    function updateDebugInfo() {
      const healthEl = debugPanel.querySelector('[data-travel-debug-health]');
      const poolKeyEl = debugPanel.querySelector('[data-travel-debug-pool-key]');

      if (healthEl) {
        healthEl.textContent = state.proxyHealth || 'unknown';
      }

      if (poolKeyEl) {
        poolKeyEl.textContent = config.poolKey || 'DEFAULT';
      }
    }

    updateDebugInfo();

  }

  /**
   */
  function initGalleryThumbs(root) {
    if (root.hasAttribute('data-gallery-initialized')) {
      return;
    }
    const mainImg = root.querySelector('.travel-product__gallery-main-img');
    const thumbs = root.querySelectorAll('.travel-product__thumb');
    const prevBtn = root.querySelector('[data-gallery-prev]');
    const nextBtn = root.querySelector('[data-gallery-next]');
    
    if (!mainImg || !thumbs.length) {
      return;
    }

    root.setAttribute('data-gallery-initialized', 'true');
    let currentIndex = 0;
    const thumbList = Array.from(thumbs);
    const media = root.querySelector('.travel-product__media');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let imageRequest = 0;
    let switching = false;
    let hovered = false;
    let fadeAnimation = null;
    let autoplay = null;

    function stopAutoplay() {
      clearInterval(autoplay);
      autoplay = null;
    }

    function setActive(index, fade) {
      if (!thumbs.length) return;
      const nextIndex = (index + thumbList.length) % thumbList.length;
      const activeThumb = thumbList[nextIndex];
      const src = activeThumb.getAttribute('data-src');
      const request = ++imageRequest;
      switching = true;

      function showImage() {
        if (request !== imageRequest) return;
        switching = false;
        currentIndex = nextIndex;
        thumbList.forEach(function(b, i) {
          b.classList.toggle('is-active', i === currentIndex);
        });
        if (src) {
          mainImg.removeAttribute('srcset');
          mainImg.removeAttribute('sizes');
          mainImg.setAttribute('src', src);
        }
        const thumbImg = activeThumb.querySelector('.travel-product__thumb-img');
        if (thumbImg && thumbImg.getAttribute('alt')) {
          mainImg.setAttribute('alt', thumbImg.getAttribute('alt'));
        }
        if (fadeAnimation) fadeAnimation.cancel();
        if (fade && !reducedMotion.matches && mainImg.animate) {
          fadeAnimation = mainImg.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 600,
            easing: 'ease-out'
          });
        }
      }

      if (fade && src) {
        const preload = new Image();
        preload.onload = showImage;
        preload.onerror = function() {
          if (request === imageRequest) switching = false;
        };
        preload.src = src;
      } else {
        showImage();
      }
    }

    thumbList.forEach(function(btn) {
      btn.addEventListener('click', function() {
        stopAutoplay();
        const idx = thumbList.indexOf(btn);
        setActive(idx, true);
      });
    });

    if (prevBtn) {
      prevBtn.addEventListener('click', function() {
        stopAutoplay();
        setActive(currentIndex - 1, true);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', function() {
        stopAutoplay();
        setActive(currentIndex + 1, true);
      });
    }

    const activeThumb = root.querySelector('.travel-product__thumb.is-active');
    if (activeThumb) {
      const idx = thumbList.indexOf(activeThumb);
      setActive(idx >= 0 ? idx : 0);
    } else {
      setActive(0);
    }

    // Thumb strip slider: max 6 visible, translateX-based
    var thumbsTrack = root.querySelector('.travel-product__gallery-thumbs-track');
    var thumbPrevBtn = root.querySelector('[data-thumb-prev]');
    var thumbNextBtn = root.querySelector('[data-thumb-next]');
    var THUMB_W = 92;
    var THUMB_GAP = 10;
    var ITEM_STEP = THUMB_W + THUMB_GAP;
    var viewport = root.querySelector('.travel-product__gallery-thumbs');
    var visibleCount = function () {
      return Math.max(1, Math.floor(((viewport && viewport.clientWidth) || ITEM_STEP) / ITEM_STEP));
    };
    var thumbOffset = 0; // number of thumbs scrolled off the left

    function updateThumbNav() {
      if (!thumbsTrack || !thumbPrevBtn || !thumbNextBtn) return;
      var total = thumbList.length;
      var visible = visibleCount();
      var maxOffset = Math.max(0, total - visible);
      thumbOffset = Math.min(thumbOffset, maxOffset);
      thumbsTrack.style.transform = 'translateX(-' + (thumbOffset * ITEM_STEP) + 'px)';
      if (total <= visible) {
        thumbPrevBtn.style.display = 'none';
        thumbNextBtn.style.display = 'none';
        return;
      }
      thumbPrevBtn.style.display = thumbOffset <= 0 ? 'none' : '';
      thumbNextBtn.style.display = thumbOffset >= maxOffset ? 'none' : '';
      thumbsTrack.style.transform = 'translateX(-' + (thumbOffset * ITEM_STEP) + 'px)';
    }

    if (thumbPrevBtn && thumbNextBtn && thumbsTrack) {
      thumbPrevBtn.addEventListener('click', function() {
        stopAutoplay();
        thumbOffset = Math.max(0, thumbOffset - visibleCount());
        updateThumbNav();
      });
      thumbNextBtn.addEventListener('click', function() {
        stopAutoplay();
        var maxOffset = Math.max(0, thumbList.length - visibleCount());
        thumbOffset = Math.min(maxOffset, thumbOffset + visibleCount());
        updateThumbNav();
      });
      updateThumbNav();
      window.addEventListener('resize', updateThumbNav);
    }
    if (media) {
      media.addEventListener('pointerenter', function(event) {
        if (event.pointerType === 'mouse') hovered = true;
      });
      media.addEventListener('pointerleave', function() { hovered = false; });
    }
    if (thumbList.length > 1) {
      autoplay = setInterval(function() {
        if (!root.isConnected) {
          stopAutoplay();
          window.removeEventListener('resize', updateThumbNav);
          return;
        }
        if (document.hidden || reducedMotion.matches || switching || hovered ||
          (media && media.contains(document.activeElement))) return;
        setActive(currentIndex + 1, true);
      }, 5000);
    }
  }

  /**
   */
  function createTravelerState(config) {
    return {
      counts: {
        adult: 0,
        teenOrChild: 0,
        infant: 0
      },
      maxPax: config.maxPax || 8,
      adultMinRequired: config.adultMinRequired !== false,
      travelerLabels: {
        adult: config.travelerLabelAdult || 'Adult',
        teen: config.travelerLabelTeen || 'Teen',
        infant: config.travelerLabelInfant || 'Infant'
      },
      get partySize() {
        return this.counts.adult + this.counts.teenOrChild + this.counts.infant;
      },
      get summaryText() {
        const parts = [];
        if (this.counts.adult > 0) {
          parts.push(this.travelerLabels.adult + ' ' + this.counts.adult);
        }
        if (this.counts.teenOrChild > 0) {
          parts.push(this.travelerLabels.teen + ' ' + this.counts.teenOrChild);
        }
        if (this.counts.infant > 0) {
          parts.push(this.travelerLabels.infant + ' ' + this.counts.infant);
        }
        return parts.length > 0 ? parts.join(', ') : '';
      },
      canIncrement: function(type) {
        return this.partySize < this.maxPax;
      },
      canDecrement: function(type) {
        if (this.counts[type] <= 0) return false;
        if (type === 'adult' && this.adultMinRequired) {
          return this.counts.adult > 1;
        }
        return true;
      },
      increment: function(type) {
        if (this.canIncrement(type)) {
          this.counts[type]++;
        }
      },
      decrement: function(type) {
        if (this.canDecrement(type)) {
          this.counts[type]--;
        }
      },
      isValid: function() {
        if (this.partySize < 1) return false;
        if (this.adultMinRequired && this.counts.adult < 1) return false;
        return true;
      }
    };
  }

  /**
   */
  function initInlineBookingSelectors(root, config, bookingState) {
    const inlineWrap = root.querySelector('[data-travel-inline-booking]');
    const peopleInput = root.querySelector('[data-travel-input="people"]');
    const peopleSummary = root.querySelector('[data-travel-traveler-summary]');
    const dateInput = root.querySelector('[data-travel-input="date"]');
    const dateSummary = root.querySelector('[data-travel-date-summary]');
    const inlineCalendar = root.querySelector('[data-travel-inline-calendar]');

    if (!inlineWrap || !peopleInput || !dateInput || !inlineCalendar) {
      return false;
    }

    const travelerState = createTravelerState(config);
    if (travelerState.adultMinRequired) {
      travelerState.counts.adult = 1;
    }

    const counts = {
      adult: inlineWrap.querySelector('[data-travel-inline-count="adult"]'),
      teenOrChild: inlineWrap.querySelector('[data-travel-inline-count="teenOrChild"]'),
      infant: inlineWrap.querySelector('[data-travel-inline-count="infant"]')
    };

    function applyTravelerSelectionInline() {
      if (peopleSummary) {
        peopleSummary.textContent = travelerState.summaryText || 'Select travelers';
      }
      peopleInput.setAttribute('data-travel-party-size', travelerState.partySize);
      peopleInput.setAttribute('data-travel-traveler-counts', JSON.stringify(travelerState.counts));

      bookingState.partySize = travelerState.partySize;
      bookingState.travelerCounts = {
        adult: travelerState.counts.adult,
        teenOrChild: travelerState.counts.teenOrChild,
        infant: travelerState.counts.infant
      };
      bookingState.availability = null;
      bookingState.availabilityState = 'idle';
      bookingState.availabilityMessage = null;

      renderAvailabilityMessage(root, bookingState);
      updateCheckAvailabilityButton(root, bookingState);
      updateCheckoutButton(root, bookingState);
      debouncePrecheck(root, bookingState.config, bookingState);
      debounceQuote(root, bookingState.config, bookingState);
    }

    function renderTravelerCounts() {
      ['adult', 'teenOrChild', 'infant'].forEach(function(type) {
        if (counts[type]) counts[type].textContent = travelerState.counts[type];
        const minusBtn = inlineWrap.querySelector('[data-travel-inline-stepper="' + type + '-minus"]');
        const plusBtn = inlineWrap.querySelector('[data-travel-inline-stepper="' + type + '-plus"]');
        if (minusBtn) minusBtn.disabled = !travelerState.canDecrement(type);
        if (plusBtn) plusBtn.disabled = !travelerState.canIncrement(type);
      });
    }

    ['adult', 'teenOrChild', 'infant'].forEach(function(type) {
      const minusBtn = inlineWrap.querySelector('[data-travel-inline-stepper="' + type + '-minus"]');
      const plusBtn = inlineWrap.querySelector('[data-travel-inline-stepper="' + type + '-plus"]');
      if (minusBtn) {
        minusBtn.addEventListener('click', function() {
          travelerState.decrement(type);
          renderTravelerCounts();
          applyTravelerSelectionInline();
        });
      }
      if (plusBtn) {
        plusBtn.addEventListener('click', function() {
          travelerState.increment(type);
          renderTravelerCounts();
          applyTravelerSelectionInline();
        });
      }
    });

    renderTravelerCounts();
    applyTravelerSelectionInline();

    if (typeof flatpickr === 'undefined') {
      console.warn('[Travel Booking] flatpickr is not loaded');
      return true;
    }

    let selectedDate = null;
    let serverDisabledDatesSet = new Set();

    const weekdayMap = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
    const operatingWeekdays = config.operatingWeekdays || [];
    const allowedDays = operatingWeekdays.map(function(day) {
      return weekdayMap[String(day || '').toLowerCase()];
    }).filter(function(day) {
      return day !== undefined;
    });

    let blackoutDates = config.blackoutDates || [];
    if (typeof blackoutDates === 'string') {
      try {
        blackoutDates = JSON.parse(blackoutDates);
      } catch (error) {
        blackoutDates = [];
      }
    }
    if (!Array.isArray(blackoutDates)) blackoutDates = [];
    const blackoutSet = new Set(blackoutDates);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + (config.bookingWindowDays || 180));
    const emptyMonthNotice = root.querySelector('[data-calendar-empty]');

    function updateEmptyMonthNotice(instance) {
      if (!emptyMonthNotice || !instance) return;
      const monthStart = new Date(instance.currentYear, instance.currentMonth, 1);
      const nextMonth = new Date(instance.currentYear, instance.currentMonth + 1, 1);
      let hasAvailableDate = false;
      for (let day = new Date(monthStart); day < nextMonth; day.setDate(day.getDate() + 1)) {
        if (day >= today && day <= maxDate && !shouldDisableDate(day)) { hasAvailableDate = true; break; }
      }
      emptyMonthNotice.hidden = hasAvailableDate;
    }

    function formatDate(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return year + '-' + month + '-' + day;
    }

    function shouldDisableDate(dateObj) {
      const dateStr = formatDate(dateObj);
      if (blackoutSet.has(dateStr)) return true;
      if (allowedDays.length > 0 && allowedDays.length < 7 && allowedDays.indexOf(dateObj.getDay()) === -1) return true;
      if (serverDisabledDatesSet.has(dateStr)) return true;
      return false;
    }

    function applyDateSelectionInline() {
      if (!selectedDate) return;
      const dateObj = new Date(selectedDate + 'T00:00:00');
      if (dateSummary) {
        dateSummary.textContent = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
      }

      dateInput.setAttribute('data-travel-selected-date', selectedDate);
      bookingState.selectedDate = selectedDate;
      bookingState.pendingSummaryFocusDate = selectedDate;
      bookingState.quoteState = 'idle';
      bookingState.availability = null;
      bookingState.availabilityState = 'idle';
      bookingState.availabilityMessage = null;

      renderAvailabilityMessage(root, bookingState);
      updateCheckAvailabilityButton(root, bookingState);
      updateCheckoutButton(root, bookingState);
      debouncePrecheck(root, bookingState.config, bookingState);
      debounceQuote(root, bookingState.config, bookingState);
    }

    function normalizeInlineCalendarWidth(instance) {
      if (!instance || !instance.calendarContainer) return;

      const calendar = instance.calendarContainer;
      const yearInput = instance.currentYearElement;
      if (yearInput && yearInput.parentElement) {
        const yearWrapper = yearInput.parentElement;
        yearWrapper.hidden = true;
        yearWrapper.style.display = 'none';
        yearInput.tabIndex = -1;
        let yearLabel = calendar.querySelector('.travel-product__calendar-year');
        if (!yearLabel) {
          yearLabel = document.createElement('span');
          yearLabel.className = 'travel-product__calendar-year';
          yearLabel.style.marginInlineStart = '0.35em';
          yearWrapper.after(yearLabel);
        }
        yearLabel.textContent = String(instance.currentYear);
      }
      const rContainer = calendar.querySelector('.flatpickr-rContainer');
      const days = calendar.querySelector('.flatpickr-days');
      const dayContainers = calendar.querySelectorAll('.dayContainer');

      calendar.style.width = '100%';
      calendar.style.minWidth = '100%';
      calendar.style.maxWidth = '100%';

      if (rContainer) {
        rContainer.style.width = '100%';
        rContainer.style.minWidth = '100%';
        rContainer.style.maxWidth = '100%';
      }

      if (days) {
        days.style.width = '100%';
        days.style.minWidth = '100%';
        days.style.maxWidth = '100%';
      }

      dayContainers.forEach(function(container) {
        container.style.width = '100%';
        container.style.minWidth = '100%';
        container.style.maxWidth = '100%';

        const daysInContainer = Array.from(container.querySelectorAll('.flatpickr-day'));
        daysInContainer.forEach(function(dayEl) {
          dayEl.style.display = '';
        });

        if (daysInContainer.length >= 7) {
          const lastWeek = daysInContainer.slice(daysInContainer.length - 7);
          const allNextMonth = lastWeek.every(function(dayEl) {
            return dayEl.classList.contains('nextMonthDay');
          });
          if (allNextMonth) {
            lastWeek.forEach(function(dayEl) {
              dayEl.style.display = 'none';
            });
          }
        }
      });
    }

    async function refreshInlineDisabledDates(instance) {
      try {
        let rangeFrom;
        let rangeTo;
        if (instance && typeof instance.currentYear === 'number' && typeof instance.currentMonth === 'number') {
          const monthStart = new Date(instance.currentYear, instance.currentMonth, 1);
          const fromDate = monthStart < today ? today : monthStart;
          rangeFrom = formatDateYYYYMMDD(fromDate);

          const nextMonth = instance.currentMonth + 1;
          const nextMonthYear = nextMonth > 11 ? instance.currentYear + 1 : instance.currentYear;
          const nextMonthIndex = nextMonth > 11 ? 0 : nextMonth;
          const nextMonthLastDay = new Date(nextMonthYear, nextMonthIndex + 1, 0);
          rangeTo = formatDateYYYYMMDD(nextMonthLastDay);
        } else {
          const range = calculateDateRange(config);
          rangeFrom = range.from;
          rangeTo = range.to;
        }

        const maxDateStr = formatDateYYYYMMDD(maxDate);
        if (rangeTo > maxDateStr) rangeTo = maxDateStr;

        const productId = config.productId || root.getAttribute('data-product-id');
        const poolKey = config.poolKey || 'DEFAULT';
        serverDisabledDatesSet = await getDisabledDates({
          productId: productId,
          from: rangeFrom,
          to: rangeTo,
          poolKey: poolKey,
          state: bookingState
        });

        if (selectedDate && serverDisabledDatesSet.has(selectedDate)) {
          selectedDate = null;
          inlinePicker.clear();
          if (dateSummary) dateSummary.textContent = 'Select date';
          dateInput.removeAttribute('data-travel-selected-date');
          bookingState.selectedDate = null;
          updateCheckAvailabilityButton(root, bookingState);
          updateCheckoutButton(root, bookingState);
        }

        inlinePicker.redraw();
        updateEmptyMonthNotice(inlinePicker);
        normalizeInlineCalendarWidth(inlinePicker);
        requestAnimationFrame(function() {
          normalizeInlineCalendarWidth(inlinePicker);
        });
      } catch (error) {
        serverDisabledDatesSet = new Set();
      }
    }

    const inlinePicker = flatpickr(inlineCalendar, {
      mode: 'single',
      showMonths: 1,
      monthSelectorType: 'static',
      dateFormat: 'Y-m-d',
      minDate: today,
      maxDate: maxDate,
      inline: true,
      static: true,
      disable: [function(date) { return shouldDisableDate(date); }],
      onChange: function(selectedDates, dateStr) {
        if (!selectedDates || !selectedDates.length) return;
        selectedDate = dateStr;
        applyDateSelectionInline();
      },
      onMonthChange: function(_selectedDates, _dateStr, instance) {
        refreshInlineDisabledDates(instance);
        normalizeInlineCalendarWidth(instance);
      },
      onYearChange: function(_selectedDates, _dateStr, instance) {
        refreshInlineDisabledDates(instance);
        normalizeInlineCalendarWidth(instance);
      },
      onReady: function(_selectedDates, _dateStr, instance) {
        normalizeInlineCalendarWidth(instance);
      },
      locale: { firstDayOfWeek: 0 }
    });

    normalizeInlineCalendarWidth(inlinePicker);
    refreshInlineDisabledDates(inlinePicker);
    return true;
  }

  /**
   */
  function initTravelerModal(root, config) {
    const trigger = root.querySelector('[data-travel-input="people"]');
    const summarySpan = root.querySelector('[data-travel-traveler-summary]');
    const modal = root.querySelector('[data-travel-modal="travelers"]');
    
    if (!trigger || !modal) {
      return;
    }

    const state = createTravelerState(config);
    const modalQuoteEl = modal.querySelector('[data-travel-modal-quote]');
    const modalQuoteState = {
      selectedDate: null,
      travelerCounts: {
        adult: 0,
        teenOrChild: 0,
        infant: 0
      },
      allowQuoteWithoutDate: true,
      proxyHealth: 'checking',
      quoteState: 'idle',
      quoteData: null,
      quoteErrorMessage: null
    };
    let triggerElement = null;

    trigger.addEventListener('click', function(e) {
      e.preventDefault();
      triggerElement = document.activeElement;
      openTravelerModal();
    });

    const overlay = modal.querySelector('.travel-product__modal-overlay');
    const closeBtn = modal.querySelector('[data-travel-modal-close]');
    const applyBtn = modal.querySelector('[data-travel-modal-apply]');
    const steppers = {
      adult: {
        minus: modal.querySelector('[data-travel-stepper="adult-minus"]'),
        plus: modal.querySelector('[data-travel-stepper="adult-plus"]'),
        count: modal.querySelector('[data-travel-stepper="adult-count"]')
      },
      teenOrChild: {
        minus: modal.querySelector('[data-travel-stepper="teenOrChild-minus"]'),
        plus: modal.querySelector('[data-travel-stepper="teenOrChild-plus"]'),
        count: modal.querySelector('[data-travel-stepper="teenOrChild-count"]')
      },
      infant: {
        minus: modal.querySelector('[data-travel-stepper="infant-minus"]'),
        plus: modal.querySelector('[data-travel-stepper="infant-plus"]'),
        count: modal.querySelector('[data-travel-stepper="infant-count"]')
      }
    };

    Object.keys(steppers).forEach(function(type) {
      const s = steppers[type];
      if (s.minus) {
        s.minus.addEventListener('click', function() {
          state.decrement(type);
          updateStepperDisplay(type);
          updateApplyButton();
          triggerModalQuote();
        });
      }
      if (s.plus) {
        s.plus.addEventListener('click', function() {
          state.increment(type);
          updateStepperDisplay(type);
          updateApplyButton();
          triggerModalQuote();
        });
      }
    });

    if (applyBtn) {
      applyBtn.addEventListener('click', function() {
        if (state.isValid()) {
          applyTravelerSelection();
          closeTravelerModal();
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', closeTravelerModal);
    }
    if (overlay) {
      overlay.addEventListener('click', closeTravelerModal);
    }

    modal.addEventListener('click', function(e) {
      if (e.target && e.target.matches('[data-travel-quote-retry]')) {
        e.preventDefault();
        triggerModalQuote();
        e.stopPropagation();
      }
    });

    modal.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeTravelerModal();
      }
    });

    function openTravelerModal() {
      modal.setAttribute('open', '');
      document.body.classList.add('overflow-hidden');
      
      if (typeof trapFocus === 'function') {
        trapFocus(modal, closeBtn || applyBtn);
      } else {
        const firstFocusable = modal.querySelector('button, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) firstFocusable.focus();
      }
      
      updateStepperDisplay('adult');
      updateStepperDisplay('teenOrChild');
      updateStepperDisplay('infant');
      updateApplyButton();
      triggerModalQuote();
    }

    function closeTravelerModal() {
      modal.removeAttribute('open');
      document.body.classList.remove('overflow-hidden');
      
      if (typeof removeTrapFocus === 'function') {
        removeTrapFocus(triggerElement);
      } else if (triggerElement) {
        triggerElement.focus();
      }
      
      triggerElement = null;
    }

    function updateStepperDisplay(type) {
      const s = steppers[type];
      if (!s.count) return;
      
      s.count.textContent = state.counts[type];
      
      if (s.minus) {
        s.minus.disabled = !state.canDecrement(type);
      }
      if (s.plus) {
        s.plus.disabled = !state.canIncrement(type);
      }
    }

    function updateApplyButton() {
      if (applyBtn) {
        applyBtn.disabled = !state.isValid();
      }
    }

    function syncModalQuoteState() {
      modalQuoteState.travelerCounts.adult = state.counts.adult;
      modalQuoteState.travelerCounts.teenOrChild = state.counts.teenOrChild;
      modalQuoteState.travelerCounts.infant = state.counts.infant;
      if (!root.bookingState) return;
      modalQuoteState.selectedDate = root.bookingState.selectedDate;
      modalQuoteState.proxyHealth = root.bookingState.proxyHealth;
    }

    function triggerModalQuote() {
      if (!modalQuoteEl) return;
      syncModalQuoteState();
      debounceQuote(modal, config, modalQuoteState);
    }

    function applyTravelerSelection() {
      const summaryValue = root.querySelector('[data-travel-traveler-summary]');
      if (summaryValue) {
        summaryValue.textContent = state.summaryText || 'Select travelers';
      }
      
      const peopleInput = root.querySelector('[data-travel-input="people"]');
      if (peopleInput) {
        peopleInput.setAttribute('data-travel-party-size', state.partySize);
        peopleInput.setAttribute('data-travel-traveler-counts', JSON.stringify(state.counts));
      }
      
      if (root.bookingState) {
        root.bookingState.partySize = state.partySize;
        root.bookingState.travelerCounts = {
          adult: state.counts.adult,
          teenOrChild: state.counts.teenOrChild,
          infant: state.counts.infant
        };
        root.bookingState.availability = null;
        root.bookingState.availabilityState = 'idle';
        root.bookingState.availabilityMessage = null;
        renderAvailabilityMessage(root, root.bookingState);
        updateCheckAvailabilityButton(root, root.bookingState);
        updateCheckoutButton(root, root.bookingState);
        debouncePrecheck(root, root.bookingState.config, root.bookingState);
        debounceQuote(root, root.bookingState.config, root.bookingState);
      }
    }
  }

  /**
   */
  const disabledDatesCache = new Map();

  /**
   */
  const precheckCache = new Map(); // Map<queryKey, { ts: number, result: {available, message?, remaining?} }>
  const precheckTTLms = 30000;
  const inFlight = new Map();
  let precheckDebounceTimer = null;

  /**
   */
  let inFlightLock = null;
  let lastRunKey = null;

  /**
   */
  const quoteCache = new Map(); // Map<queryKey, { ts: number, result: {total, breakdown} }>
  const quoteTTLms = 30000;
  const quoteInFlight = new Map(); // Map<queryKey, Promise>
  let quoteDebounceTimer = null;

  /**
   * @param {object} config - booking config
   */
  function calculateDateRange(config) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const from = formatDateYYYYMMDD(today);

    const currentMonth = today.getMonth();
    const currentYear = today.getFullYear();
    
    const nextMonth = currentMonth + 1;
    const nextMonthYear = nextMonth > 11 ? currentYear + 1 : currentYear;
    const nextMonthIndex = nextMonth > 11 ? 0 : nextMonth;
    
    const nextMonthLastDay = new Date(nextMonthYear, nextMonthIndex + 1, 0);
    const to = formatDateYYYYMMDD(nextMonthLastDay);

    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + (config.bookingWindowDays || 180));
    const maxDateStr = formatDateYYYYMMDD(maxDate);

    const finalTo = to > maxDateStr ? maxDateStr : to;

    return { from, to: finalTo };
  }

  /**
   */
  function formatDateYYYYMMDD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  /**
   * @param {object} params - {productId, date, pax, bookingMode, poolKey, guideUnitsRequired, state}
   * @param {object} options - {mode: 'precheck'|'final', skipCache: boolean}
   * @returns {Promise<{available: boolean, remaining?: number, cutoffMinutes?: number, message?: string | null, error?: {message: string, correlationId?: string}}>}
   */
  async function checkAvailability({ productId, date, pax, bookingMode, poolKey, guideUnitsRequired, state }, options = {}) {
    const { mode = 'final', skipCache = false } = options;

    if (state && state.proxyHealth !== 'up') {
      return {
        available: false,
        message: null,
        error: {
          message: 'The booking system connection is unstable.',
          correlationId: null
        }
      };
    }

    const queryKey = `${productId}|${date}|${pax}|${poolKey || 'DEFAULT'}|${guideUnitsRequired || 1}|${bookingMode || 'private'}`;

    if (mode === 'precheck' && !skipCache) {
      if (inFlight.has(queryKey)) {
        if (window.__TRAVEL_DEBUG__) {
          console.log('[booking-proxy] Reusing in-flight availability request', { queryKey });
        }
        return await inFlight.get(queryKey);
      }

      if (precheckCache.has(queryKey)) {
        const cached = precheckCache.get(queryKey);
        const age = Date.now() - cached.ts;
        if (age < precheckTTLms) {
          if (window.__TRAVEL_DEBUG__) {
            console.log('[booking-proxy] Cache hit for availability', { queryKey, age });
          }
          return cached.result;
        } else {
          precheckCache.delete(queryKey);
        }
      }
    }

    if (mode === 'final' && !skipCache) {
      if (precheckCache.has(queryKey)) {
        const cached = precheckCache.get(queryKey);
        const age = Date.now() - cached.ts;
        if (age < 3000) {
          if (window.__TRAVEL_DEBUG__) {
            console.log('[booking-proxy] Reusing recent availability result', { queryKey, age });
          }
          return cached.result;
        }
      }
    }

    const fetchPromise = (async () => {
      try {
        const params = new URLSearchParams({
          productId: String(productId),
          date: String(date), // YYYY-MM-DD
          pax: String(pax),
          bookingMode: String(bookingMode || 'private'),
          poolKey: String(poolKey || 'DEFAULT'),
          guideUnitsRequired: String(guideUnitsRequired || 1)
        });

        const envelope = await proxyFetch(`/availability?${params.toString()}`, {
          method: 'GET'
        });

        const data = envelope.data || {};
        const result = {
          available: data.available === true,
          remaining: data.remaining !== undefined ? data.remaining : null,
          cutoffMinutes: data.cutoffMinutes !== undefined ? data.cutoffMinutes : null,
          message: data.message || null,
          error: null
        };

        if (mode === 'precheck') {
          precheckCache.set(queryKey, {
            ts: Date.now(),
            result: result
          });
        }

        return result;

      } catch (error) {
        if (window.__TRAVEL_DEBUG__) {
          const correlationId = error.correlationId || null;
          if (correlationId) {
            console.warn('[booking-proxy] checkAvailability failed', {
              correlationId: correlationId,
              kind: error.kind,
              code: error.code
            });
          } else {
            console.warn('[booking-proxy] checkAvailability failed', {
              kind: error.kind,
              code: error.code
            });
          }
        }

        return {
          available: false,
          message: null,
          error: {
            message: 'Failed to check availability. Please try again shortly.',
            correlationId: error.correlationId || null
          }
        };
      } finally {
        inFlight.delete(queryKey);
      }
    })();

    if (mode === 'precheck') {
      inFlight.set(queryKey, fetchPromise);
    }

    return await fetchPromise;
  }

  /**
   * @param {object} params - {productId, from, to, poolKey, state}
   */
  async function getDisabledDates({ productId, from, to, poolKey, state }) {
    if (state && state.proxyHealth === 'down') {
      if (window.__TRAVEL_DEBUG__) {
        console.warn('[booking-proxy] Health check DOWN, skipping disabled-dates call');
      }
      return new Set();
    }

    const cacheKey = `${productId}|${poolKey || 'DEFAULT'}|${from}|${to}`;

    if (disabledDatesCache.has(cacheKey)) {
      if (window.__TRAVEL_DEBUG__) {
        console.log('[booking-proxy] Cache hit for disabled-dates', { cacheKey });
      }
      return disabledDatesCache.get(cacheKey);
    }

    if (window.__TRAVEL_DEBUG__) {
      console.log('[booking-proxy] Cache miss for disabled-dates', { cacheKey });
    }

    try {
      const params = new URLSearchParams({
        productId: String(productId),
        from: from,
        to: to
      });
      if (poolKey) {
        params.append('poolKey', poolKey);
      }

      const envelope = await proxyFetch(`/disabled-dates?${params.toString()}`, {
        method: 'GET'
      });

      const disabledDatesArray = envelope.data?.disabledDates || [];
      const disabledDatesSet = new Set(disabledDatesArray);

      disabledDatesCache.set(cacheKey, disabledDatesSet);

      if (window.__TRAVEL_DEBUG__ && envelope.meta?.correlationId) {
        console.log('[booking-proxy] Disabled dates loaded', {
          correlationId: envelope.meta.correlationId,
          count: disabledDatesArray.length
        });
      }

      return disabledDatesSet;

    } catch (error) {
      if (window.__TRAVEL_DEBUG__) {
        const correlationId = error.correlationId || null;
        if (correlationId) {
          console.warn('[booking-proxy] Failed to load disabled dates', {
            correlationId: correlationId,
            kind: error.kind,
            code: error.code
          });
        } else {
          console.warn('[booking-proxy] Failed to load disabled dates', {
            kind: error.kind,
            code: error.code
          });
        }
      }

      const emptySet = new Set();
      disabledDatesCache.set(cacheKey, emptySet);
      return emptySet;
    }
  }

  /**
   */
  function initCalendarModal(root, config) {
    const trigger = root.querySelector('[data-travel-input="date"]');
    const summarySpan = root.querySelector('[data-travel-date-summary]');
    const modal = root.querySelector('[data-travel-modal="calendar"]');
    const calendarContainer = root.querySelector('[data-travel-calendar-container]');
    
    if (!trigger || !modal || !calendarContainer) {
      return;
    }

    let triggerElement = null;
    let flatpickrInstance = null;
    let selectedDate = null;

    if (typeof flatpickr === 'undefined') {
      console.warn('[Travel Booking] flatpickr is not loaded');
      return;
    }

    const weekdayMap = {
      'mon': 1,
      'tue': 2,
      'wed': 3,
      'thu': 4,
      'fri': 5,
      'sat': 6,
      'sun': 0
    };

    const operatingWeekdays = config.operatingWeekdays || [];
    const allowedDays = operatingWeekdays.map(function(day) {
      return weekdayMap[day.toLowerCase()] !== undefined ? weekdayMap[day.toLowerCase()] : null;
    }).filter(function(day) {
      return day !== null;
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + (config.bookingWindowDays || 180));

    let blackoutDates = config.blackoutDates || [];
    if (typeof blackoutDates === 'string') {
      try {
        blackoutDates = JSON.parse(blackoutDates);
      } catch (e) {
        console.warn('[Travel Booking] Failed to parse blackoutDates:', e);
        blackoutDates = [];
      }
    }
    if (!Array.isArray(blackoutDates)) {
      blackoutDates = [];
    }
    const blackoutSet = new Set(blackoutDates);

    let serverDisabledDatesSet = new Set();
    
    let isLoadingDisabledDates = false;
    
    let disabledDatesError = null; // null | { message, correlationId? }
    let currentCalendarRange = null; // { from, to } | null
    let visibleMonthAnchor = null; // YYYY-MM-DD | null
    
    const state = root.bookingState;
    
    const loadingEl = root.querySelector('[data-disabled-dates-loading]');
    const errorEl = root.querySelector('[data-disabled-dates-error]');
    const retryBtn = root.querySelector('[data-disabled-dates-retry]');

    function shouldDisableDate(date) {
      if (!(date instanceof Date)) {
        return false;
      }
      
      const dateStr = formatDate(date);
      
      if (blackoutSet.has(dateStr)) {
        return true;
      }

      if (allowedDays.length > 0 && allowedDays.length < 7) {
        const dayOfWeek = date.getDay();
        if (allowedDays.indexOf(dayOfWeek) === -1) {
          return true;
        }
      }

      if (serverDisabledDatesSet.has(dateStr)) {
        return true;
      }

      return false;
    }

    function formatDate(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return year + '-' + month + '-' + day;
    }

    /**
     */
    function renderDisabledDatesLoading(isLoading) {
      if (!loadingEl) return;
      
      if (isLoading) {
        loadingEl.style.display = 'flex';
        loadingEl.setAttribute('aria-hidden', 'false');
      } else {
        loadingEl.style.display = 'none';
        loadingEl.setAttribute('aria-hidden', 'true');
      }
    }

    /**
     */
    function renderDisabledDatesError(errorOrNull) {
      if (!errorEl) return;
      
      if (errorOrNull) {
        errorEl.style.display = 'block';
        errorEl.setAttribute('aria-hidden', 'false');
        disabledDatesError = errorOrNull;
      } else {
        errorEl.style.display = 'none';
        errorEl.setAttribute('aria-hidden', 'true');
        disabledDatesError = null;
      }
    }

    /**
     */
    async function onCalendarMonthChange(flatpickrInstance) {
      if (!flatpickrInstance || isLoadingDisabledDates) {
        return;
      }

      try {
        const currentMonth = flatpickrInstance.currentMonth;
        const currentYear = flatpickrInstance.currentYear;
        
        const anchorDate = new Date(currentYear, currentMonth, 1);
        visibleMonthAnchor = formatDateYYYYMMDD(anchorDate);
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const monthStart = new Date(currentYear, currentMonth, 1);
        const fromDate = monthStart < today ? today : monthStart;
        const from = formatDateYYYYMMDD(fromDate);
        
        const nextMonth = currentMonth + 1;
        const nextMonthYear = nextMonth > 11 ? currentYear + 1 : currentYear;
        const nextMonthIndex = nextMonth > 11 ? 0 : nextMonth;
        const nextMonthLastDay = new Date(nextMonthYear, nextMonthIndex + 1, 0);
        let to = formatDateYYYYMMDD(nextMonthLastDay);
        
        const maxDate = new Date(today);
        maxDate.setDate(today.getDate() + (config.bookingWindowDays || 180));
        const maxDateStr = formatDateYYYYMMDD(maxDate);
        if (to > maxDateStr) {
          to = maxDateStr;
        }
        
        currentCalendarRange = { from, to };
        
        const productId = config.productId || root.getAttribute('data-product-id');
        const poolKey = config.poolKey || 'DEFAULT';
        
        isLoadingDisabledDates = true;
        renderDisabledDatesLoading(true);
        renderDisabledDatesError(null);
        
        const disabledDates = await getDisabledDates({
          productId: productId,
          from: from,
          to: to,
          poolKey: poolKey,
          state: state
        });
        
        serverDisabledDatesSet = disabledDates;
        
        setTimeout(function() {
          applyDisableToDays();
        }, 100);
        
        renderDisabledDatesLoading(false);
        renderDisabledDatesError(null);
        
      } catch (error) {
        renderDisabledDatesLoading(false);
        
        if (window.__TRAVEL_DEBUG__) {
          const correlationId = error.correlationId || null;
          if (correlationId) {
            console.warn('[booking-proxy] Month change reload failed', {
              correlationId: correlationId,
              kind: error.kind,
              code: error.code
            });
          } else {
            console.warn('[booking-proxy] Month change reload failed', {
              kind: error.kind,
              code: error.code
            });
          }
        }
        
      } finally {
        isLoadingDisabledDates = false;
      }
    }

    /**
     */
    function attachDisabledDatesRetryHandler() {
      if (!retryBtn) return;
      
      retryBtn.addEventListener('click', async function() {
        if (!currentCalendarRange || isLoadingDisabledDates) {
          return;
        }

        renderDisabledDatesError(null);
        renderDisabledDatesLoading(true);
        isLoadingDisabledDates = true;

        try {
          const productId = config.productId || root.getAttribute('data-product-id');
          const poolKey = config.poolKey || 'DEFAULT';

          const disabledDates = await getDisabledDates({
            productId: productId,
            from: currentCalendarRange.from,
            to: currentCalendarRange.to,
            poolKey: poolKey,
            state: state
          });

          serverDisabledDatesSet = disabledDates;

          if (flatpickrInstance) {
            setTimeout(function() {
              applyDisableToDays();
            }, 100);
          }

          renderDisabledDatesLoading(false);
          renderDisabledDatesError(null);

        } catch (error) {
          renderDisabledDatesLoading(false);
          
          const errorObj = {
            message: 'Some dates could not be checked.',
            correlationId: error.correlationId || null
          };
          renderDisabledDatesError(errorObj);

          if (window.__TRAVEL_DEBUG__) {
            const correlationId = error.correlationId || null;
            if (correlationId) {
              console.warn('[booking-proxy] Retry failed', {
                correlationId: correlationId,
                kind: error.kind,
                code: error.code
              });
            } else {
              console.warn('[booking-proxy] Retry failed', {
                kind: error.kind,
                code: error.code
              });
            }
          }
        } finally {
          isLoadingDisabledDates = false;
        }
      });
    }

    function applyDisableToDays() {
      if (!flatpickrInstance || !flatpickrInstance.daysContainer) {
        return;
      }
      
      const allDayElements = flatpickrInstance.daysContainer.querySelectorAll('.flatpickr-day');
      let hiddenRemovedCount = 0;
      allDayElements.forEach(function(dayElem) {
        if (dayElem.classList.contains('prevMonthDay') || dayElem.classList.contains('nextMonthDay')) {
          if (dayElem.classList.contains('hidden')) {
            dayElem.classList.remove('hidden');
            hiddenRemovedCount += 1;
          }
          dayElem.classList.remove('flatpickr-disabled', 'selected', 'startRange', 'endRange', 'inRange');
          dayElem.classList.add('flatpickr-day--placeholder');
          dayElem.setAttribute('aria-hidden', 'true');
          dayElem.setAttribute('aria-selected', 'false');
          dayElem.setAttribute('tabindex', '-1');
          dayElem.style.visibility = 'hidden';
          dayElem.style.pointerEvents = 'none';
          dayElem.style.color = 'transparent';
          dayElem.style.background = 'transparent';
          dayElem.style.borderColor = 'transparent';
          dayElem.style.boxShadow = 'none';
        }
      });

      const dayContainers = flatpickrInstance.daysContainer.querySelectorAll('.dayContainer');
      
      const dayElements = flatpickrInstance.daysContainer.querySelectorAll('.flatpickr-day:not(.flatpickr-disabled)');
      
      let disabledCount = 0;
      dayElements.forEach(function(dayElem) {
        if (dayElem.dateObj && dayElem.dateObj instanceof Date) {
          const dateStr = formatDate(dayElem.dateObj);
          const shouldDisable = shouldDisableDate(dayElem.dateObj);
          
          if (shouldDisable) {
            dayElem.classList.add('flatpickr-disabled');
            dayElem.setAttribute('aria-disabled', 'true');
            dayElem.style.pointerEvents = 'none';
            dayElem.style.opacity = '0.4';
            disabledCount++;
            
            dayElem.addEventListener('click', function(e) {
              e.preventDefault();
              e.stopPropagation();
              return false;
            });
          }
        }
      });

      if (window.__TRAVEL_DEBUG__ === true) {
        const firstDayOfWeek = flatpickrInstance.l10n?.firstDayOfWeek ?? 0;
        const dayContainers = flatpickrInstance.daysContainer.querySelectorAll('.dayContainer');
        dayContainers.forEach(function(container) {
          const days = Array.from(container.querySelectorAll('.flatpickr-day'));
          const firstCurrentDayIndex = days.findIndex(function(day) {
            return !day.classList.contains('prevMonthDay') &&
              !day.classList.contains('nextMonthDay') &&
              day.dateObj instanceof Date &&
              day.dateObj.getDate() === 1;
          });

          if (firstCurrentDayIndex >= 0) {
            const firstDay = days[firstCurrentDayIndex];
            const expectedColumn = (firstDay.dateObj.getDay() - firstDayOfWeek + 7) % 7;
            const actualColumn = firstCurrentDayIndex % 7;
            if (expectedColumn !== actualColumn) {
              console.warn('[Travel Booking] Calendar alignment mismatch', {
                expectedColumn,
                actualColumn,
                date: firstDay.dateObj
              });
            }
          }
        });
      }

    }

    function initFlatpickr() {
      try {
        flatpickrInstance = flatpickr(calendarContainer, {
          mode: 'single',
          showMonths: 2,
          dateFormat: 'Y-m-d',
          minDate: today,
          maxDate: maxDate,
          inline: true,
          static: true,
          disable: [],
          onDayCreate: function(dObj, fp, dayElem, dayElemStr) {
            if (dayElem && dObj instanceof Date) {
              if (dayElem.classList.contains('prevMonthDay') || dayElem.classList.contains('nextMonthDay')) {
                if (dayElem.classList.contains('hidden')) {
                  dayElem.classList.remove('hidden');
                }
                dayElem.classList.remove('flatpickr-disabled', 'selected', 'startRange', 'endRange', 'inRange');
                dayElem.classList.add('flatpickr-day--placeholder');
                dayElem.setAttribute('aria-hidden', 'true');
                dayElem.setAttribute('aria-selected', 'false');
                dayElem.setAttribute('tabindex', '-1');
                dayElem.style.visibility = 'hidden';
                dayElem.style.pointerEvents = 'none';
                dayElem.style.color = 'transparent';
                dayElem.style.background = 'transparent';
                dayElem.style.borderColor = 'transparent';
                dayElem.style.boxShadow = 'none';
                return;
              }

              const dateStr = formatDate(dObj);
              const shouldDisable = shouldDisableDate(dObj);
              
              if (shouldDisable) {
                dayElem.classList.add('flatpickr-disabled');
                dayElem.setAttribute('aria-disabled', 'true');
                dayElem.style.pointerEvents = 'none';
                dayElem.style.opacity = '0.4';
                
                dayElem.addEventListener('click', function(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                });
              }
            }
          },
          onChange: function(selectedDates, dateStr) {
            if (selectedDates.length > 0) {
              selectedDate = dateStr;
              applyDateSelection();
              applyDisableToDays();
              closeCalendarModal();
            }
          },
          locale: {
            firstDayOfWeek: 0
          }
        });

        if (flatpickrInstance) {
          flatpickrInstance.redraw();
        }

        setTimeout(applyDisableToDays, 100);
        setTimeout(applyDisableToDays, 500);
        
        if (flatpickrInstance) {
          flatpickrInstance.config.onMonthChange.push(applyDisableToDays);
          flatpickrInstance.config.onYearChange.push(applyDisableToDays);
          
          flatpickrInstance.config.onMonthChange.push(function(selectedDates, dateStr, instance) {
            onCalendarMonthChange(instance);
          });
          flatpickrInstance.config.onYearChange.push(function(selectedDates, dateStr, instance) {
            onCalendarMonthChange(instance);
          });
        }
      } catch (error) {
        console.error('[Travel Booking] flatpickr init error:', error);
        throw error;
      }
    }

    trigger.addEventListener('click', function(e) {
      e.preventDefault();
      triggerElement = document.activeElement;
      openCalendarModal();
    });

    const closeBtn = modal.querySelector('[data-travel-calendar-close]');
    const overlay = modal.querySelector('.travel-product__modal-overlay');
    
    if (closeBtn) {
      closeBtn.addEventListener('click', closeCalendarModal);
    }
    if (overlay) {
      overlay.addEventListener('click', closeCalendarModal);
    }

    modal.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeCalendarModal();
      }
    });

    async function openCalendarModal() {
      modal.setAttribute('open', '');
      document.body.classList.add('overflow-hidden');

      
      if (!flatpickrInstance) {
        initFlatpickr();
        attachDisabledDatesRetryHandler();
      }
      
      if (typeof trapFocus === 'function') {
        trapFocus(modal, closeBtn || calendarContainer);
      } else {
        const firstFocusable = modal.querySelector('button, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) firstFocusable.focus();
      }

      renderDisabledDatesError(null);

      if (isLoadingDisabledDates) {
        return;
      }

      isLoadingDisabledDates = true;
      renderDisabledDatesLoading(true);

      try {
        const dateRange = calculateDateRange(config);
        
        currentCalendarRange = dateRange;
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        visibleMonthAnchor = formatDateYYYYMMDD(new Date(today.getFullYear(), today.getMonth(), 1));
        
        const productId = config.productId || root.getAttribute('data-product-id');
        const poolKey = config.poolKey || 'DEFAULT';

        const disabledDates = await getDisabledDates({
          productId: productId,
          from: dateRange.from,
          to: dateRange.to,
          poolKey: poolKey,
          state: state
        });

        serverDisabledDatesSet = disabledDates;

        if (flatpickrInstance) {
          setTimeout(function() {
            applyDisableToDays();
          }, 100);
        }

        renderDisabledDatesLoading(false);
        renderDisabledDatesError(null);

      } catch (error) {
        if (window.__TRAVEL_DEBUG__) {
          console.warn('[Travel Booking] Failed to load disabled dates in modal', error);
        }

        renderDisabledDatesLoading(false);
        
        const errorObj = {
          message: 'Some dates could not be checked.',
          correlationId: error.correlationId || null
        };
        renderDisabledDatesError(errorObj);

      } finally {
        isLoadingDisabledDates = false;
      }
    }

    function closeCalendarModal() {
      modal.removeAttribute('open');
      document.body.classList.remove('overflow-hidden');
      
      if (typeof removeTrapFocus === 'function') {
        removeTrapFocus(triggerElement);
      } else if (triggerElement) {
        triggerElement.focus();
      }
      
      triggerElement = null;
    }

    function applyDateSelection() {
      if (!selectedDate) return;

      if (summarySpan) {
        const dateObj = new Date(selectedDate + 'T00:00:00');
        const formattedDate = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        summarySpan.textContent = formattedDate;
      }

      if (trigger) {
        trigger.setAttribute('data-travel-selected-date', selectedDate);
      }

      if (root.bookingState) {
        root.bookingState.selectedDate = selectedDate;
        root.bookingState.pendingSummaryFocusDate = selectedDate;
        root.bookingState.quoteState = 'idle';
        root.bookingState.availability = null;
        root.bookingState.availabilityState = 'idle';
        root.bookingState.availabilityMessage = null;
        renderAvailabilityMessage(root, root.bookingState);
        updateCheckAvailabilityButton(root, root.bookingState);
        updateCheckoutButton(root, root.bookingState);
        debouncePrecheck(root, root.bookingState.config, root.bookingState);
        debounceQuote(root, root.bookingState.config, root.bookingState);
      }

      if (selectedDate && serverDisabledDatesSet.has(selectedDate)) {
        selectedDate = null;
        if (flatpickrInstance) {
          flatpickrInstance.clear();
        }
        if (summarySpan) {
          summarySpan.textContent = 'Select date';
        }
        if (trigger) {
          trigger.removeAttribute('data-travel-selected-date');
        }
        if (root.bookingState) {
          root.bookingState.selectedDate = null;
          updateCheckAvailabilityButton(root, root.bookingState);
          updateCheckoutButton(root, root.bookingState);
        }
        
        const statusEl = root.querySelector('[data-travel-status]');
        if (statusEl) {
          showStatus(statusEl, 'This date cannot be selected.', 'error');
        }
      }
    }
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} state - booking state
   * @returns {{open: function}|null}
   */
  function initBookingSummary(root, config, state) {
    const summary = root.querySelector('[data-travel-booking-summary]');
    if (!summary) return;

    const tour15Input = summary.querySelector('[data-travel-summary-discount="tour15"]');
    const mediaConsentInput = summary.querySelector('[data-travel-summary-discount="media-consent"]');
    const extra10Input = summary.querySelector('[data-travel-summary-discount="extra10"]');
    const proceedBtn = summary.querySelector('[data-travel-summary-proceed]');
    const detailsBtn = summary.querySelector('[data-travel-media-consent-details]');
    const consentDialog = root.querySelector('[data-travel-media-consent-dialog]');

    if (tour15Input) {
      tour15Input.addEventListener('change', function() {
        state.checkoutExtras.useTour15 = tour15Input.checked;
        state.tour15PreferenceSet = true;
        renderBookingSummary(root, state);
      });
    }

    if (mediaConsentInput) {
      mediaConsentInput.addEventListener('change', function() {
        state.checkoutExtras.mediaConsent = mediaConsentInput.checked;
        renderBookingSummary(root, state);
      });
    }

    if (extra10Input) {
      extra10Input.addEventListener('change', function() {
        state.checkoutExtras.useExtra10 = extra10Input.checked;
        state.extra10PreferenceSet = true;
        renderBookingSummary(root, state);
      });
    }

    if (proceedBtn) {
      proceedBtn.addEventListener('click', async function() {
        if (!isLoggedIn()) {
          window.location.href = buildLoginUrl();
          return;
        }

        updateStateFromDOM(root, state);
        const validation = validateBookingInput(state);
        const statusEl = root.querySelector('[data-travel-status]');
        if (!validation.valid) {
          if (statusEl) showStatus(statusEl, validation.message, 'error');
          return;
        }

        if (state.checkoutExtrasModal && typeof state.checkoutExtrasModal.open === 'function') {
          proceedBtn.disabled = true;
          const modalResult = await state.checkoutExtrasModal.open(proceedBtn);
          if (!modalResult || modalResult.ok !== true) {
            proceedBtn.disabled = false;
            return;
          }
        }

        setButtonLoading(proceedBtn, true);
        proceedBtn.disabled = true;
        try {
          await runBookingFlow(root, config, state);
        } catch (error) {
          console.error('[Travel Booking] runBookingFlow error:', error);
          setButtonLoading(proceedBtn, false);
          proceedBtn.disabled = false;
        }
      });
    }

    if (detailsBtn && consentDialog) {
      detailsBtn.addEventListener('click', function() {
        if (typeof consentDialog.showModal === 'function') {
          consentDialog.showModal();
        } else {
          consentDialog.setAttribute('open', '');
        }
      });
    }

    if (consentDialog) {
      consentDialog.querySelectorAll('[data-travel-media-consent-close]').forEach(function(button) {
        button.addEventListener('click', function() {
          if (typeof consentDialog.close === 'function') {
            consentDialog.close();
          } else {
            consentDialog.removeAttribute('open');
          }
        });
      });
      consentDialog.addEventListener('click', function(event) {
        if (event.target === consentDialog) consentDialog.close();
      });
    }
  }

  /**
   * @param {object} state
   * @returns {Intl.NumberFormat}
   */
  function getBookingCurrencyFormatter(state) {
    const currency = (state.quoteData && state.quoteData.currency) || 'USD';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2
    });
  }

  /**
   * Discount amounts are always calculated from the original subtotal. The
   * checkout endpoint remains the source of truth and revalidates all credits.
   * @param {object} state
   * @returns {{subtotal: number, tour15: number, media: number, extra10: number, total: number}}
   */
  function getBookingDiscounts(state) {
    const subtotal = Number(state.quoteData && state.quoteData.total) || 0;
    const tour15 = state.tour15Available && state.checkoutExtras.useTour15 ? subtotal * 0.15 : 0;
    const media = state.checkoutExtras.mediaConsent ? subtotal * 0.05 : 0;
    const extra10 = state.extra10Available && state.checkoutExtras.useExtra10 ? Math.min(10, subtotal) : 0;
    return {
      subtotal: subtotal,
      tour15: tour15,
      media: media,
      extra10: extra10,
      total: Math.max(0, subtotal - tour15 - media - extra10)
    };
  }

  /**
   * @param {HTMLElement|null} container
   * @param {Array<{label: string, amount: number}>} rows
   * @param {string} className
   * @param {Intl.NumberFormat} formatter
   */
  function renderBookingMoneyRows(container, rows, className, formatter) {
    if (!container) return;
    container.innerHTML = '';
    rows.forEach(function(row) {
      if (!row || !row.label || !Number.isFinite(Number(row.amount))) return;
      const line = document.createElement('div');
      line.className = className;
      const label = document.createElement('span');
      const amount = document.createElement('strong');
      label.textContent = row.label;
      amount.textContent = formatter.format(Number(row.amount));
      line.appendChild(label);
      line.appendChild(amount);
      container.appendChild(line);
    });
  }

  /**
   * @param {object} state
   * @returns {string}
   */
  function formatBookingDate(state) {
    if (!state.selectedDate) return 'Date to be confirmed';
    const date = new Date(state.selectedDate + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return state.selectedDate;
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    }).format(date);
  }

  /**
   * @param {object} state
   * @returns {string}
   */
  function formatBookingTravelers(state) {
    const counts = state.travelerCounts || {};
    const rows = [];
    if (counts.adult) rows.push('Adult × ' + counts.adult);
    if (counts.teenOrChild) rows.push('Teen × ' + counts.teenOrChild);
    if (counts.infant) rows.push('Infant × ' + counts.infant);
    return rows.join(' · ') || 'Travelers to be confirmed';
  }

  /**
   * The quote API returns extended price rows (for example, "Adult x2").
   * Convert traveler rows to their per-person price for the redesigned UI,
   * while leaving non-traveler adjustments such as service fees unchanged.
   * @param {object} state
   * @returns {Array<{label: string, amount: number}>}
   */
  function getBookingPriceRows(state) {
    const breakdown = Array.isArray(state.quoteData && state.quoteData.breakdown) ? state.quoteData.breakdown : [];
    const counts = state.travelerCounts || {};
    return breakdown.map(function(item) {
      const originalLabel = String(item && item.label || '');
      const normalizedLabel = originalLabel.toLowerCase();
      let count = 0;
      let displayLabel = originalLabel;
      if (normalizedLabel.indexOf('adult') !== -1) {
        count = Number(counts.adult) || 0;
      } else if (normalizedLabel.indexOf('teen') !== -1 || normalizedLabel.indexOf('child') !== -1) {
        count = Number(counts.teenOrChild) || 0;
        displayLabel = originalLabel.replace(/child/ig, 'Teen');
      } else if (normalizedLabel.indexOf('infant') !== -1) {
        count = Number(counts.infant) || 0;
      }
      const amount = Number(item && item.amount) || 0;
      return {
        label: count > 0 ? displayLabel + ' (per person)' : displayLabel,
        amount: count > 0 ? amount / count : amount
      };
    });
  }

  /**
   * @param {object} state
   * @returns {string}
   */
  function getRefundDeadline(state) {
    if (!state.selectedDate) return 'Free cancellation until 7 days before departure at 9:00 AM KST.';
    const date = new Date(state.selectedDate + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return 'Free cancellation until 7 days before departure at 9:00 AM KST.';
    date.setDate(date.getDate() - 7);
    const formatted = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    }).format(date);
    return 'Free cancellation until ' + formatted + ', 9:00 AM KST.';
  }

  /**
   * @param {HTMLElement} root
   * @param {object} state
   */
  function focusBookingSummary(root, state, summary) {
    const date = state.pendingSummaryFocusDate;
    if (!date || date !== state.selectedDate || summary.hidden ||
        state.availabilityState !== 'available' || state.quoteState !== 'success') return;
    state.pendingSummaryFocusDate = null;
    requestAnimationFrame(function() {
      if (!root.isConnected || summary.hidden || date !== state.selectedDate ||
          state.pendingSummaryFocusDate || state.availabilityState !== 'available' ||
          state.quoteState !== 'success') return;
      const heading = summary.querySelector('.travel-product__booking-summary-kicker') || summary;
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      summary.style.scrollMarginTop = 'calc(var(--header-height, 80px) + 16px)';
      summary.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'start'
      });
    });
  }

  function renderBookingSummary(root, state) {
    const summary = root.querySelector('[data-travel-booking-summary]');
    if (!summary) return;

    const isReady = state.availabilityState === 'available' &&
      state.quoteState === 'success' && state.quoteData;
    summary.hidden = !isReady;
    if (!isReady) return;

    const formatter = getBookingCurrencyFormatter(state);
    const discounts = getBookingDiscounts(state);
    const selectionEl = summary.querySelector('[data-travel-summary-selection]');
    const subtotalEl = summary.querySelector('[data-travel-summary-subtotal]');
    const totalEl = summary.querySelector('[data-travel-summary-total]');
    const refundEl = summary.querySelector('[data-travel-summary-refund]');
    const tour15Wrapper = summary.querySelector('[data-travel-summary-tour15-wrapper]');
    const tour15Input = summary.querySelector('[data-travel-summary-discount="tour15"]');
    const mediaInput = summary.querySelector('[data-travel-summary-discount="media-consent"]');
    const extra10Wrapper = summary.querySelector('[data-travel-summary-extra10-wrapper]');
    const extra10Input = summary.querySelector('[data-travel-summary-discount="extra10"]');
    const proceedBtn = summary.querySelector('[data-travel-summary-proceed]');

    if (selectionEl) selectionEl.textContent = formatBookingDate(state) + ' · ' + formatBookingTravelers(state);
    renderBookingMoneyRows(summary.querySelector('[data-travel-summary-price-lines]'), getBookingPriceRows(state), 'travel-product__booking-summary-price-line', formatter);
    if (subtotalEl) subtotalEl.textContent = formatter.format(discounts.subtotal);
    if (tour15Wrapper) tour15Wrapper.hidden = !state.tour15Available;
    if (tour15Input) {
      tour15Input.checked = Boolean(state.tour15Available && state.checkoutExtras.useTour15);
      tour15Input.disabled = !state.tour15Available;
    }
    if (mediaInput) mediaInput.checked = Boolean(state.checkoutExtras.mediaConsent);
    if (extra10Wrapper) extra10Wrapper.hidden = !state.extra10Available;
    if (extra10Input) extra10Input.checked = Boolean(state.extra10Available && state.checkoutExtras.useExtra10);
    const tour15Amount = summary.querySelector('[data-travel-summary-tour15-amount]');
    const mediaAmount = summary.querySelector('[data-travel-summary-media-amount]');
    const extra10Amount = summary.querySelector('[data-travel-summary-extra10-amount]');
    if (tour15Amount) tour15Amount.textContent = '-' + formatter.format(discounts.tour15);
    if (mediaAmount) mediaAmount.textContent = '-' + formatter.format(discounts.media);
    if (extra10Amount) extra10Amount.textContent = '-' + formatter.format(discounts.extra10);
    if (totalEl) totalEl.textContent = formatter.format(discounts.total) + ' USD';
    if (refundEl) refundEl.textContent = getRefundDeadline(state);
    if (proceedBtn) proceedBtn.disabled = !isLoggedIn();

    const note = summary.querySelector('[data-travel-summary-discount-note]');
    if (note) {
      note.textContent = isLoggedIn()
        ? 'Discounts are confirmed again during checkout.'
        : 'Log in to apply eligible discounts and credits.';
    }
    focusBookingSummary(root, state, summary);
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} state - booking state
   * @returns {{open: function}|null}
   */
  function initCheckoutExtrasModal(root, state) {
    const modal = root.querySelector('[data-travel-modal="checkout-extras"]');
    if (!modal) {
      return null;
    }

    const pickupInput = modal.querySelector('[data-travel-checkout-extra="pickup-location"]');
    const dietaryInput = modal.querySelector('[data-travel-checkout-extra="dietary-restrictions"]');
    const reservationNameInput = modal.querySelector('[data-travel-checkout-extra="reservation-contact-name"]');
    const reservationPhoneInput = modal.querySelector('[data-travel-checkout-extra="reservation-contact-phone"]');
    const reservationPhoneDialSelect = modal.querySelector('[data-travel-phone-dial-code]');
    const mediaConsentInput = root.querySelector('[data-travel-summary-discount="media-consent"]') || modal.querySelector('[data-travel-checkout-extra="media-consent"]');
    const tour15Input = root.querySelector('[data-travel-summary-discount="tour15"]') || modal.querySelector('[data-travel-checkout-extra="use-tour15"]');
    const extra10Input = root.querySelector('[data-travel-summary-discount="extra10"]') || modal.querySelector('[data-travel-checkout-extra="use-extra10"]');
    const applyBtn = modal.querySelector('[data-travel-modal-apply]');
    const backBtn = modal.querySelector('[data-travel-modal-back]');
    const closeBtn = modal.querySelector('[data-travel-modal-close]');
    const overlay = modal.querySelector('.travel-product__modal-overlay');
    const modalBody = modal.querySelector('.travel-product__modal-body');
    const reviewPanel = modal.querySelector('[data-travel-checkout-step="review"]');
    const dietaryModes = modal.querySelectorAll('[data-travel-dietary-mode]');
    const dietaryDetails = modal.querySelector('[data-travel-dietary-details]');
    const pickupError = modal.querySelector('[data-travel-checkout-error="pickup-location"]');
    const dietaryError = modal.querySelector('[data-travel-checkout-error="dietary-restrictions"]');
    const reservationNameError = modal.querySelector('[data-travel-checkout-error="reservation-contact-name"]');
    const reservationPhoneError = modal.querySelector('[data-travel-checkout-error="reservation-contact-phone"]');

    if (!pickupInput || !dietaryInput || !reservationNameInput || !reservationPhoneInput || !applyBtn) {
      return null;
    }

    let triggerElement = null;
    let resolver = null;
    let submitted = false;
    let currentStep = 'details';

    function getDietaryValue() {
      const selectedMode = Array.from(dietaryModes).find(function(input) { return input.checked; });
      return selectedMode && selectedMode.value === 'details'
        ? dietaryInput.value
        : 'No dietary restrictions';
    }

    function syncDietaryMode() {
      const selectedMode = Array.from(dietaryModes).find(function(input) { return input.checked; });
      const hasDetails = Boolean(selectedMode && selectedMode.value === 'details');
      if (dietaryDetails) dietaryDetails.hidden = !hasDetails;
      dietaryInput.disabled = !hasDetails;
    }

    function showStep(step) {
      currentStep = step;
      const isReview = step === 'review';
      if (reviewPanel) reviewPanel.hidden = !isReview;
      if (modalBody) {
        Array.from(modalBody.children).forEach(function(child) {
          if (child !== reviewPanel) child.hidden = isReview;
        });
      }
      if (backBtn) backBtn.hidden = !isReview;
      if (applyBtn) {
        applyBtn.textContent = isReview ? 'Proceed to secure checkout' : 'Review booking';
        applyBtn.disabled = isReview ? false : !updateApplyButton().valid;
      }
      modal.querySelectorAll('[data-travel-checkout-step-indicator]').forEach(function(indicator) {
        indicator.classList.toggle('is-current', indicator.getAttribute('data-travel-checkout-step-indicator') === step);
      });
    }

    function renderCheckoutReview() {
      if (!reviewPanel) return;
      const formatter = getBookingCurrencyFormatter(state);
      const discounts = getBookingDiscounts(state);
      const productTitle = root.getAttribute('data-product-title') ||
        (root.querySelector('.travel-product__section-title, .travel-product__title, .product__title, h1') || {}).textContent ||
        'Tour';
      const reviewTour = reviewPanel.querySelector('[data-travel-review-tour]');
      const reviewDate = reviewPanel.querySelector('[data-travel-review-date]');
      const reviewTravelers = reviewPanel.querySelector('[data-travel-review-travelers]');
      const reviewPickup = reviewPanel.querySelector('[data-travel-review-pickup]');
      const reviewContact = reviewPanel.querySelector('[data-travel-review-contact]');
      const reviewDietary = reviewPanel.querySelector('[data-travel-review-dietary]');
      const reviewTotal = reviewPanel.querySelector('[data-travel-review-total]');
      const reviewRefund = reviewPanel.querySelector('[data-travel-review-refund]');
      if (reviewTour) reviewTour.textContent = productTitle.trim();
      if (reviewDate) reviewDate.textContent = formatBookingDate(state);
      if (reviewTravelers) reviewTravelers.textContent = formatBookingTravelers(state);
      if (reviewPickup) reviewPickup.textContent = state.checkoutExtras.pickupLocation;
      if (reviewContact) reviewContact.textContent = state.checkoutExtras.reservationContactName + ' / ' + state.checkoutExtras.reservationContactPhoneE164;
      if (reviewDietary) reviewDietary.textContent = state.checkoutExtras.dietaryRestrictions;
      renderBookingMoneyRows(reviewPanel.querySelector('[data-travel-review-price-lines]'), getBookingPriceRows(state), 'travel-product__checkout-review-price-line', formatter);
      const discountRows = [];
      if (discounts.tour15) discountRows.push({ label: 'Korea Guide Kit customer discount (15%)', amount: -discounts.tour15 });
      if (discounts.media) discountRows.push({ label: 'Media participation consent (5%)', amount: -discounts.media });
      if (discounts.extra10) discountRows.push({ label: 'Referral credit', amount: -discounts.extra10 });
      renderBookingMoneyRows(reviewPanel.querySelector('[data-travel-review-discount-lines]'), discountRows, 'travel-product__checkout-review-discount-line', formatter);
      if (reviewTotal) reviewTotal.textContent = formatter.format(discounts.total);
      if (reviewRefund) reviewRefund.textContent = getRefundDeadline(state);
      if (applyBtn) applyBtn.textContent = 'Proceed to secure checkout · ' + formatter.format(discounts.total);
    }

    function openModal(triggerEl) {
      triggerElement = triggerEl || document.activeElement;
      submitted = false;
      clearErrors();

      pickupInput.value = state.checkoutExtras.pickupLocation || '';
      dietaryInput.value = state.checkoutExtras.dietaryRestrictions || '';
      const hasSavedDietaryDetails = dietaryInput.value && dietaryInput.value !== 'No dietary restrictions';
      dietaryModes.forEach(function(input) {
        input.checked = hasSavedDietaryDetails ? input.value === 'details' : input.value === 'none';
      });
      syncDietaryMode();
      reservationNameInput.value = state.checkoutExtras.reservationContactName || '';
      var storedPhone = state.checkoutExtras.reservationContactPhoneE164 || '';
      if (reservationPhoneDialSelect && storedPhone && storedPhone.startsWith('+')) {
        var bestDial = '';
        Array.from(reservationPhoneDialSelect.options).forEach(function(opt) {
          if (storedPhone.startsWith(opt.value) && opt.value.length > bestDial.length) {
            bestDial = opt.value;
          }
        });
        if (bestDial) {
          reservationPhoneDialSelect.value = bestDial;
          reservationPhoneInput.value = storedPhone.slice(bestDial.length);
        } else {
          reservationPhoneInput.value = storedPhone;
        }
      } else {
        reservationPhoneInput.value = storedPhone;
      }
      if (mediaConsentInput) {
        mediaConsentInput.checked = Boolean(state.checkoutExtras.mediaConsent);
      }
      if (tour15Input) {
        tour15Input.checked = Boolean(state.checkoutExtras.useTour15);
      }
      if (extra10Input) {
        extra10Input.checked = Boolean(state.checkoutExtras.useExtra10);
      }
      updateExtra10Availability(root, state);
      updateTour15Availability(root, state);

      modal.setAttribute('open', '');
      document.body.classList.add('overflow-hidden');
      showStep('details');

      if (typeof trapFocus === 'function') {
        trapFocus(modal, closeBtn || applyBtn);
      } else {
        const firstFocusable = modal.querySelector('input, textarea, button, [tabindex]:not([tabindex="-1"])');
        if (firstFocusable) firstFocusable.focus();
      }

      return new Promise(function(resolve) {
        resolver = resolve;
      });
    }

    function closeModal(result) {
      showStep('details');
      modal.removeAttribute('open');
      document.body.classList.remove('overflow-hidden');

      if (typeof removeTrapFocus === 'function') {
        removeTrapFocus(triggerElement);
      } else if (triggerElement) {
        triggerElement.focus();
      }

      triggerElement = null;

      if (resolver) {
        resolver(result);
        resolver = null;
      }
    }

    function clearErrors() {
      if (pickupError) pickupError.textContent = '';
      if (dietaryError) dietaryError.textContent = '';
      if (reservationNameError) reservationNameError.textContent = '';
      if (reservationPhoneError) reservationPhoneError.textContent = '';
      pickupInput.classList.remove('is-invalid');
      dietaryInput.classList.remove('is-invalid');
      reservationNameInput.classList.remove('is-invalid');
      reservationPhoneInput.classList.remove('is-invalid');
      if (reservationPhoneDialSelect) reservationPhoneDialSelect.classList.remove('is-invalid');
    }

    function renderErrors(errors) {
      const pickupMessage = errors.pickupLocation || '';
      const dietaryMessage = errors.dietaryRestrictions || '';
      const reservationNameMessage = errors.reservationContactName || '';
      const reservationPhoneMessage = errors.reservationContactPhoneE164 || '';

      if (pickupError) pickupError.textContent = pickupMessage;
      if (dietaryError) dietaryError.textContent = dietaryMessage;
      if (reservationNameError) reservationNameError.textContent = reservationNameMessage;
      if (reservationPhoneError) reservationPhoneError.textContent = reservationPhoneMessage;

      pickupInput.classList.toggle('is-invalid', Boolean(pickupMessage));
      dietaryInput.classList.toggle('is-invalid', Boolean(dietaryMessage));
      reservationNameInput.classList.toggle('is-invalid', Boolean(reservationNameMessage));
      reservationPhoneInput.classList.toggle('is-invalid', Boolean(reservationPhoneMessage));
      if (reservationPhoneDialSelect) reservationPhoneDialSelect.classList.toggle('is-invalid', Boolean(reservationPhoneMessage));
    }

    function getPhoneInputValue() {
      var dial = reservationPhoneDialSelect ? reservationPhoneDialSelect.value : '';
      var num = reservationPhoneInput.value;
      if (!num.trim()) return '';
      return dial + num;
    }

    function updateApplyButton() {
      const validation = validateCheckoutExtras({
        pickupLocation: pickupInput.value,
        dietaryRestrictions: getDietaryValue(),
        reservationContactName: reservationNameInput.value,
        reservationContactPhoneE164: getPhoneInputValue()
      });

      applyBtn.disabled = !validation.valid;
      if (submitted) {
        renderErrors(validation.errors);
      }
      return validation;
    }

    pickupInput.addEventListener('input', updateApplyButton);
    dietaryInput.addEventListener('input', updateApplyButton);
    dietaryModes.forEach(function(input) {
      input.addEventListener('change', function() {
        syncDietaryMode();
        updateApplyButton();
      });
    });
    reservationNameInput.addEventListener('input', updateApplyButton);
    reservationPhoneInput.addEventListener('input', updateApplyButton);
    if (reservationPhoneDialSelect) reservationPhoneDialSelect.addEventListener('change', updateApplyButton);
    if (mediaConsentInput) {
      mediaConsentInput.addEventListener('change', function() {
        state.checkoutExtras.mediaConsent = mediaConsentInput.checked;
      });
    }
    if (tour15Input) {
      tour15Input.addEventListener('change', function() {
        state.checkoutExtras.useTour15 = tour15Input.checked;
      });
    }
    if (extra10Input) {
      extra10Input.addEventListener('change', function() {
        state.checkoutExtras.useExtra10 = extra10Input.checked;
        state.extra10PreferenceSet = true;
      });
    }

    if (applyBtn) {
      applyBtn.addEventListener('click', function() {
        if (currentStep === 'review') {
          closeModal({ ok: true });
          return;
        }
        submitted = true;
        const validation = updateApplyButton();
        if (!validation.valid) {
          return;
        }

        state.checkoutExtras.pickupLocation = validation.normalized.pickupLocation;
        state.checkoutExtras.dietaryRestrictions = validation.normalized.dietaryRestrictions;
        state.checkoutExtras.reservationContactName = validation.normalized.reservationContactName;
        state.checkoutExtras.reservationContactPhoneE164 = validation.normalized.reservationContactPhoneE164;
        if (mediaConsentInput) {
          state.checkoutExtras.mediaConsent = mediaConsentInput.checked;
        }
        if (tour15Input) {
          state.checkoutExtras.useTour15 = tour15Input.checked;
        }
        if (extra10Input) {
          state.checkoutExtras.useExtra10 = extra10Input.checked;
        }
        renderBookingSummary(root, state);
        renderCheckoutReview();
        showStep('review');
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', function() {
        submitted = false;
        clearErrors();
        showStep('details');
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function() {
        closeModal({ ok: false });
      });
    }

    if (overlay) {
      overlay.addEventListener('click', function() {
        closeModal({ ok: false });
      });
    }

    modal.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closeModal({ ok: false });
      }
    });

    return {
      open: openModal
    };
  }

  /**
   * @param {HTMLElement} root
   * @param {object} state
   */
  function updateExtra10Availability(root, state) {
    const extra10Input = root.querySelector('[data-travel-summary-discount="extra10"]') ||
      root.querySelector('[data-travel-checkout-extra="use-extra10"]');
    const extra10Wrapper = root.querySelector('[data-travel-summary-extra10-wrapper]');

    const available = Boolean(state.couponSummary &&
      state.couponSummary.coupons &&
      state.couponSummary.coupons.extra10 &&
      state.couponSummary.coupons.extra10.available);

    state.extra10Available = available;

    if (extra10Wrapper) extra10Wrapper.hidden = !available;

    if (extra10Input) {
      extra10Input.disabled = !available;

      if (!available) {
        extra10Input.checked = false;
        state.checkoutExtras.useExtra10 = false;
      } else if (!state.extra10PreferenceSet) {
        extra10Input.checked = true;
        state.checkoutExtras.useExtra10 = true;
      } else {
        extra10Input.checked = Boolean(state.checkoutExtras.useExtra10);
      }
    }

    renderBookingSummary(root, state);
  }

  /**
   * @param {HTMLElement} root
   * @param {object} state
   */
  function updateTour15Availability(root, state) {
    const wrapper = root.querySelector('[data-travel-summary-tour15-wrapper]');
    const tour15Input = root.querySelector('[data-travel-summary-discount="tour15"]') ||
      root.querySelector('[data-travel-checkout-extra="use-tour15"]');

    let balance = 0;
    if (state.couponSummary && state.couponSummary.tour) {
      const summaryBalance = Number(state.couponSummary.tour.tour15CreditBalance);
      if (Number.isFinite(summaryBalance)) {
        balance = summaryBalance;
      }
    } else if (state.creditStatus) {
      const creditBalance = Number(state.creditStatus.creditBalance || state.creditStatus.balance || 0);
      if (Number.isFinite(creditBalance)) {
        balance = creditBalance;
      }
    }

    const available = balance >= 1;
    state.tour15Available = available;

    if (wrapper) {
      wrapper.hidden = !available;
    }

    if (tour15Input) {
      tour15Input.disabled = !available;
      if (!available) {
        tour15Input.checked = false;
        state.checkoutExtras.useTour15 = false;
        state.tour15PreferenceSet = false;
      } else if (!state.tour15PreferenceSet) {
        tour15Input.checked = true;
        state.checkoutExtras.useTour15 = true;
      } else {
        tour15Input.checked = Boolean(state.checkoutExtras.useTour15);
      }
    }
    renderBookingSummary(root, state);
  }

  /**
   */
  function createBookingState(config) {
    return {
      availability: null,
      selectedDate: null, // YYYY-MM-DD
      partySize: 0,
      travelerCounts: {
        adult: 0,
        teenOrChild: 0,
        infant: 0
      },
      proxyHealth: 'checking', // Phase 5-0: 'up' | 'down' | 'checking'
      availabilityState: 'idle', // 'idle' | 'prechecking' | 'available' | 'unavailable' | 'error'
      availabilityMessage: null, // string | null
      availabilityMeta: { correlationId: null }, // dev only
      lastAvailabilityQueryKey: null, // `${productId}|${date}|${pax}|${poolKey}|${guideUnitsRequired}|${bookingMode}`
      flowState: 'idle', // 'idle' | 'running' | 'success' | 'error' | 'conflict'
      flowStep: null, // 'availability' | 'hold' | 'prepare' | 'holdRelease' | 'cartClear' | 'cartAdd' | 'redirect' | null
      flowErrorMessage: null, // string | null
      holdId: null, // string | null
      holdExpiresAt: null, // number | null (timestamp)
      clientRequestId: null,
      quoteState: 'idle', // 'idle' | 'loading' | 'success' | 'error'
      quoteData: null, // { total: number, breakdown: Array, discountPreview: object|null } | null
      quoteErrorMessage: null, // string | null
      checkoutExtras: {
        pickupLocation: '',
        dietaryRestrictions: '',
        reservationContactName: '',
        reservationContactPhoneE164: '',
        mediaConsent: false,
        useExtra10: false,
        useTour15: false
      },
      couponSummary: null,
      creditStatus: null,
      extra10Available: false,
      extra10PreferenceSet: false,
      tour15Available: false,
      tour15PreferenceSet: false,
      config: config
    };
  }

  /**
   * @param {object} state - booking state
   */
  function getSelectedDate(state) {
    return state.selectedDate || null;
  }

  /**
   * @param {object} state - booking state
   * @returns {{adult: number, child: number, infant: number}}
   */
  function getTravelers(state) {
    return {
      adult: state.travelerCounts.adult || 0,
      child: state.travelerCounts.teenOrChild || 0,
      infant: state.travelerCounts.infant || 0
    };
  }

  /**
   */
  function calculatePax(travelers) {
    return (travelers.adult || 0) + (travelers.child || 0) + (travelers.infant || 0);
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizePickupLocation(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizeDietaryRestrictions(value) {
    return String(value || '').trim();
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizeReservationContactName(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizePhoneE164(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const compact = raw.replace(/[\s\-().]/g, '');
    if (!compact.startsWith('+')) {
      return compact;
    }

    return '+' + compact.slice(1).replace(/\D/g, '');
  }

  /**
   * @param {{pickupLocation: string, dietaryRestrictions: string, reservationContactName: string, reservationContactPhoneE164: string}} values
   * @returns {{valid: boolean, errors: object, normalized: object}}
   */
  function validateCheckoutExtras(values) {
    const normalized = {
      pickupLocation: normalizePickupLocation(values.pickupLocation),
      dietaryRestrictions: normalizeDietaryRestrictions(values.dietaryRestrictions),
      reservationContactName: normalizeReservationContactName(values.reservationContactName),
      reservationContactPhoneE164: normalizePhoneE164(values.reservationContactPhoneE164)
    };
    const errors = {};

    if (normalized.pickupLocation.length < 2 || normalized.pickupLocation.length > 120) {
      errors.pickupLocation = 'Enter a pickup location between 2 and 120 characters.';
    }

    if (normalized.dietaryRestrictions.length < 1 || normalized.dietaryRestrictions.length > 500) {
      errors.dietaryRestrictions = 'Enter dietary restrictions between 1 and 500 characters.';
    }

    if (normalized.reservationContactName.length < 2 || normalized.reservationContactName.length > 60) {
      errors.reservationContactName = 'Enter a reservation contact name between 2 and 60 characters.';
    }

    if (!/^\+[1-9]\d{7,14}$/.test(normalized.reservationContactPhoneE164)) {
      errors.reservationContactPhoneE164 = 'Enter a phone number with country code, for example +82 10-1234-5678.';
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors: errors,
      normalized: normalized
    };
  }

  /**
   * @param {object} state - booking state
   * @returns {object}
   */
  function getCheckoutExtrasProperties(state) {
    const extras = state.checkoutExtras || {};
    const pickupLocation = normalizePickupLocation(extras.pickupLocation || '');
    const dietaryRestrictions = normalizeDietaryRestrictions(extras.dietaryRestrictions || '');
    const reservationContactName = normalizeReservationContactName(extras.reservationContactName || '');
    const reservationContactPhoneE164 = normalizePhoneE164(extras.reservationContactPhoneE164 || '');
    const properties = {};

    if (pickupLocation) {
      properties.pickup_location = pickupLocation;
    }
    if (dietaryRestrictions) {
      properties.dietary_restrictions = dietaryRestrictions;
    }
    if (reservationContactName) {
      properties.reservation_contact_name = reservationContactName;
    }
    if (reservationContactPhoneE164) {
      properties.reservation_contact_phone_e164 = reservationContactPhoneE164;
    }

    return properties;
  }

  /**
   * @param {string} productId - Product ID
   * @param {string} date - YYYY-MM-DD
   */
  function generateClientRequestId(productId, date, travelers) {
    return `${productId}|${date}|${travelers.adult}|${travelers.child}|${travelers.infant}|${Date.now()}`;
  }

  /**
   * @returns {string} - numeric variant id
   */
  function convertVariantIdToNumeric(variantId) {
    if (!variantId) {
      return '';
    }
    
    if (typeof variantId === 'string' && /^\d+$/.test(variantId)) {
      return variantId;
    }
    
    if (typeof variantId === 'string' && variantId.includes('gid://shopify/ProductVariant/')) {
      const match = variantId.match(/gid:\/\/shopify\/ProductVariant\/(\d+)/);
      if (match && match[1]) {
        return match[1];
      }
      const lastNumber = variantId.match(/\d+$/);
      if (lastNumber) {
        return lastNumber[0];
      }
    }
    
    return String(variantId);
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function debouncePrecheck(root, config, state) {
    const requestVersion = state.availabilityRequestVersion = (state.availabilityRequestVersion || 0) + 1;
    if (precheckDebounceTimer !== null) {
      clearTimeout(precheckDebounceTimer);
      precheckDebounceTimer = null;
    }

    precheckDebounceTimer = setTimeout(async () => {
      precheckDebounceTimer = null;

      const date = getSelectedDate(state);
      if (!date) {
        state.availabilityState = 'idle';
        state.availabilityMessage = 'Select a date to check availability.';
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
        return;
      }

      const travelers = getTravelers(state);
      const pax = calculatePax(travelers);
      if (travelers.adult < 1 || pax < 1) {
        state.availabilityState = 'idle';
        state.availabilityMessage = 'Select at least 1 adult traveler.';
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
        return;
      }
      if (config.maxPax && pax > config.maxPax) {
        state.availabilityState = 'idle';
        state.availabilityMessage = `Traveler limit exceeded (max ${config.maxPax}).`;
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
        return;
      }

      const dateObj = new Date(date + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const maxDate = new Date(today);
      maxDate.setDate(today.getDate() + (config.bookingWindowDays || 180));
      if (dateObj < today || dateObj > maxDate) {
        state.availabilityState = 'idle';
        state.availabilityMessage = 'Selected date is outside the booking window.';
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
        return;
      }
      
      let blackoutDates = config.blackoutDates || [];
      if (typeof blackoutDates === 'string') {
        try {
          blackoutDates = JSON.parse(blackoutDates);
        } catch (e) {
          blackoutDates = [];
        }
      }
      if (!Array.isArray(blackoutDates)) {
        blackoutDates = [];
      }
      const blackoutSet = new Set(blackoutDates);
      const dateStr = date;
      if (blackoutSet.has(dateStr)) {
        state.availabilityState = 'idle';
        state.availabilityMessage = 'This date is not bookable.';
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
        return;
      }
      
      const weekdayMap = {
        'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4,
        'fri': 5, 'sat': 6, 'sun': 0
      };
      const operatingWeekdays = config.operatingWeekdays || [];
      const allowedDays = operatingWeekdays.map(function(day) {
        return weekdayMap[day.toLowerCase()] !== undefined ? weekdayMap[day.toLowerCase()] : null;
      }).filter(function(day) {
        return day !== null;
      });
      if (allowedDays.length > 0 && allowedDays.length < 7) {
        const dayOfWeek = dateObj.getDay();
        if (allowedDays.indexOf(dayOfWeek) === -1) {
          state.availabilityState = 'idle';
          state.availabilityMessage = 'This weekday is not available.';
          renderAvailabilityMessage(root, state);
          updateCheckoutButton(root, state);
          return;
        }
      }

      // 4) healthStatus === 'UP'
      if (state.proxyHealth !== 'up') {
        state.availabilityState = 'idle';
        state.availabilityMessage = 'Booking service connection is being checked.';
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
        return;
      }

      state.availabilityState = 'prechecking';
      state.availabilityMessage = null;
      renderAvailabilityMessage(root, state);
      updateCheckoutButton(root, state);

      try {
        const productId = config.productId || root.getAttribute('data-product-id');
        const bookingMode = config.bookingMode || 'private';
        const poolKey = config.poolKey || 'DEFAULT';
        const guideUnitsRequired = config.guideUnitsRequired || 1;

        const result = await checkAvailability({
          productId: productId,
          date: date,
          pax: pax,
          bookingMode: bookingMode,
          poolKey: poolKey,
          guideUnitsRequired: guideUnitsRequired,
          state: state
        }, { mode: 'precheck' });

        if (requestVersion !== state.availabilityRequestVersion) return;
        if (result.error) {
          state.availabilityState = 'error';
          state.availabilityMessage = result.error.message;
          state.availabilityMeta.correlationId = result.error.correlationId || null;
        } else if (result.available === true) {
          state.availabilityState = 'available';
          state.availabilityMessage = sanitizeApiMessage(result.message, 'Available');
          state.availabilityMeta.correlationId = null;
          state.availability = {
            ok: true,
            checkedAt: Date.now()
          };
        } else {
          state.availabilityState = 'unavailable';
          state.availabilityMessage = sanitizeApiMessage(result.message, 'Unavailable for the selected date');
          state.availabilityMeta.correlationId = null;
          state.availability = {
            ok: false,
            checkedAt: Date.now()
          };
        }

        state.lastAvailabilityQueryKey = `${productId}|${date}|${pax}|${poolKey}|${guideUnitsRequired}|${bookingMode}`;

        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);

      } catch (error) {
        if (requestVersion !== state.availabilityRequestVersion) return;
        console.error('[Travel Booking] debouncePrecheck error:', error);
        state.availabilityState = 'error';
        state.availabilityMessage = 'Check failed, please try again';
        state.availabilityMeta.correlationId = null;
        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
      }
    }, 500); // 500ms debounce
  }

  /**
   */
  function validateBookingInput(state) {
    if (!state.selectedDate) {
      return {
        valid: false,
        message: 'Please select a date.'
      };
    }

    if (state.partySize < 1) {
      return {
        valid: false,
        message: 'Please select travelers.'
      };
    }

    if (state.config.adultMinRequired && state.travelerCounts.adult < 1) {
      return {
        valid: false,
        message: 'At least one adult is required.'
      };
    }

    return {
      valid: true,
      message: null
    };
  }

  /**
   */
  function initCheckAvailability(root, config, state) {
    const checkBtn = root.querySelector('[data-travel-check-availability]');
    const statusEl = root.querySelector('[data-travel-status]');
    
    if (!checkBtn || !statusEl) {
      return;
    }

    checkBtn.addEventListener('click', async function() {
      updateStateFromDOM(root, state);

      const validation = validateBookingInput(state);
      if (!validation.valid) {
        showStatus(statusEl, validation.message, 'error');
        return;
      }

      if (state.proxyHealth !== 'up') {
        showStatus(statusEl, 'The booking system connection is unstable. Please try again shortly.', 'error');
        return;
      }

      setButtonLoading(checkBtn, true);
      state.availabilityState = 'checking';
      state.availabilityMessage = null;
      renderAvailabilityMessage(root, state);

      try {
        const date = getSelectedDate(state);
        const travelers = getTravelers(state);
        const pax = calculatePax(travelers);
        const productId = config.productId || root.getAttribute('data-product-id');
        const bookingMode = config.bookingMode || 'private';
        const poolKey = config.poolKey || 'DEFAULT';
        const guideUnitsRequired = config.guideUnitsRequired || 1;

        const result = await checkAvailability({
          productId: productId,
          date: date,
          pax: pax,
          bookingMode: bookingMode,
          poolKey: poolKey,
          guideUnitsRequired: guideUnitsRequired,
          state: state
        });

        if (result.error) {
          state.availabilityState = 'error';
          state.availabilityMessage = result.error.message;
          showStatus(statusEl, result.error.message, 'error');
          state.availability = null;
        } else if (result.available === true) {
          state.availabilityState = 'available';
          state.availabilityMessage = sanitizeApiMessage(result.message, 'Available for booking.');
          showStatus(statusEl, sanitizeApiMessage(result.message, 'Available for booking.'), 'success');
          state.availability = {
            ok: true,
            checkedAt: Date.now()
          };
        } else {
          state.availabilityState = 'unavailable';
          state.availabilityMessage = sanitizeApiMessage(result.message, 'Not available for booking.');
          showStatus(statusEl, sanitizeApiMessage(result.message, 'Not available for booking.'), 'error');
          state.availability = {
            ok: false,
            checkedAt: Date.now()
          };
        }

        renderAvailabilityMessage(root, state);
        updateCheckoutButton(root, state);
      } catch (error) {
        console.error('[Travel Booking] checkAvailability error:', error);
        state.availabilityState = 'error';
        state.availabilityMessage = 'An error occurred while checking availability.';
        showStatus(statusEl, state.availabilityMessage, 'error');
        state.availability = null;
        renderAvailabilityMessage(root, state);
      } finally {
        setButtonLoading(checkBtn, false);
      }
    });
  }

  /**
   */
  function showStatus(element, message, type) {
    if (!element) return;
    
    element.textContent = message;
    element.className = 'travel-product__status travel-product__status--' + type;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
  }

  /**
   */
  function setButtonLoading(button, loading) {
    if (!button) return;
    
    if (loading) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  /**
   * Replace Korean BTA API messages with English fallback
   */
  function sanitizeApiMessage(message, fallback) {
    if (!message) return fallback;
    const hasKorean = /[가-힣ᄀ-ᇿ㄰-㆏]/.test(message);
    if (!hasKorean) return message;
    const knownTranslations = {
      '예약 진행 중인 날짜': 'A booking is currently in progress for this date.',
      '예약이 완료된 날짜': 'This date is already fully booked.',
      '예약 불가': 'Not available for booking.',
      '예약 가능': 'Available for booking.'
    };
    for (const [ko, en] of Object.entries(knownTranslations)) {
      if (message.includes(ko)) return en;
    }
    return fallback;
  }

  /**
   */
  function getReasonMessage(reason) {
    const messages = {
      'invalid_input': 'The entered information is invalid.',
      'provider_error': 'An error occurred while checking availability. Please try again shortly.',
      'blackout': 'The selected date is not available.',
      'private_already_booked': 'This date has already been booked.',
      'guide_pool_exceeded': 'The guide schedule is full.'
    };
    return messages[reason] || 'Not available for booking.';
  }

  /**
   */
  function updateStateFromDOM(root, state) {
    const dateInput = root.querySelector('[data-travel-input="date"]');
    if (dateInput) {
      const dateAttr = dateInput.getAttribute('data-travel-selected-date');
      state.selectedDate = dateAttr || null;
    }

    const peopleInput = root.querySelector('[data-travel-input="people"]');
    if (peopleInput) {
      const partySizeAttr = peopleInput.getAttribute('data-travel-party-size');
      state.partySize = partySizeAttr ? parseInt(partySizeAttr, 10) : 0;

      const countsAttr = peopleInput.getAttribute('data-travel-traveler-counts');
      if (countsAttr) {
        try {
          const counts = JSON.parse(countsAttr);
          state.travelerCounts = {
            adult: counts.adult || 0,
            teenOrChild: counts.teenOrChild || 0,
            infant: counts.infant || 0
          };
        } catch (e) {
          console.warn('[Travel Booking] Failed to parse traveler counts:', e);
        }
      }
    }
  }

  /**
   */
  function updateCheckAvailabilityButton(root, state) {
    const checkBtn = root.querySelector('[data-travel-check-availability]');
    if (!checkBtn) return;

    const validation = validateBookingInput(state);
    checkBtn.disabled = !validation.valid;
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function debounceQuote(root, config, state) {
    const requestVersion = state.quoteRequestVersion = (state.quoteRequestVersion || 0) + 1;
    if (quoteDebounceTimer) {
      clearTimeout(quoteDebounceTimer);
    }
    
    quoteDebounceTimer = setTimeout(async () => {
      const date = getSelectedDate(state);
      const travelers = getTravelers(state);
      const productId = config.productId;
      const allowWithoutDate = state && state.allowQuoteWithoutDate === true;
      
      if ((!date && !allowWithoutDate) || !travelers || travelers.adult < 1) {
        state.quoteState = 'idle';
        state.quoteData = null;
        renderQuote(root, state);
        return;
      }
      
      if (state.proxyHealth !== 'up') {
        state.quoteState = 'idle';
        state.quoteErrorMessage = 'The quote is currently unavailable.';
        renderQuote(root, state);
        return;
      }
      
      const dateKey = date || 'no-date';
      const queryKey = `${productId}|${dateKey}|${travelers.adult}|${travelers.child}|${travelers.infant}`;
      
      const cached = quoteCache.get(queryKey);
      if (cached && (Date.now() - cached.ts) < quoteTTLms) {
        state.quoteState = 'success';
        state.quoteData = cached.result;
        state.quoteErrorMessage = null;
        renderQuote(root, state);
        return;
      }
      
      if (quoteInFlight.has(queryKey)) {
        try {
          const result = await quoteInFlight.get(queryKey);
          if (requestVersion !== state.quoteRequestVersion) return;
          state.quoteState = 'success';
          state.quoteData = result;
          state.quoteErrorMessage = null;
          renderQuote(root, state);
          return;
        } catch (error) {
        }
      }
      
      state.quoteState = 'loading';
      state.quoteErrorMessage = null;
      renderQuote(root, state);
      
      const quotePromise = getQuote({
        productId: productId,
        date: date,
        travelers: travelers,
        currency: 'USD'
      });
      
      quoteInFlight.set(queryKey, quotePromise);
      
      try {
        const result = await quotePromise;
        if (requestVersion !== state.quoteRequestVersion) return;
        
        quoteCache.set(queryKey, {
          ts: Date.now(),
          result: result
        });
        
        state.quoteState = 'success';
        state.quoteData = result;
        state.quoteErrorMessage = null;
        renderQuote(root, state);
      } catch (error) {
        if (requestVersion !== state.quoteRequestVersion) return;
        state.quoteState = 'error';
        state.quoteData = null;
        state.quoteErrorMessage = error.message || 'Failed to load the price.';
        renderQuote(root, state);
      } finally {
        quoteInFlight.delete(queryKey);
      }
    }, 300); // 300ms debounce
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} state - booking state
   */
  function renderAvailabilityMessage(root, state) {
    renderBookingSummary(root, state);
    const messageEl = root.querySelector('[data-travel-availability-message]');
    if (!messageEl) return;

    const { availabilityState, availabilityMessage } = state;
    const retryBtn = messageEl.querySelector('[data-travel-availability-retry]');

    if (availabilityState === 'idle' && !availabilityMessage) {
      messageEl.style.display = 'none';
      messageEl.setAttribute('aria-hidden', 'true');
      const textNodes = [];
      for (let node of messageEl.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodes.push(node);
        }
      }
      textNodes.forEach(node => node.remove());
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
      return;
    }

    messageEl.style.display = 'block';
    messageEl.setAttribute('aria-hidden', 'false');

    let displayMessage = '';
    if (availabilityState === 'idle') {
      displayMessage = availabilityMessage || '';
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
    } else if (availabilityState === 'prechecking') {
      displayMessage = 'Checking availability...';
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
    } else if (availabilityState === 'available') {
      displayMessage = availabilityMessage || 'Available';
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
    } else if (availabilityState === 'unavailable') {
      displayMessage = availabilityMessage || 'Unavailable';
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
    } else if (availabilityState === 'error') {
      displayMessage = availabilityMessage || 'Check failed, try again';
      if (retryBtn) {
        retryBtn.style.display = 'inline-block';
        retryBtn.setAttribute('aria-hidden', 'false');
      }
    }

    const textNodes = [];
    for (let node of messageEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        textNodes.push(node);
      }
    }
    if (textNodes.length > 0) {
      textNodes[0].textContent = displayMessage;
      for (let i = 1; i < textNodes.length; i++) {
        textNodes[i].remove();
      }
    } else {
      const textContent = document.createTextNode(displayMessage);
      if (retryBtn && retryBtn.parentNode === messageEl) {
        messageEl.insertBefore(textContent, retryBtn);
      } else {
        messageEl.appendChild(textContent);
      }
    }

    messageEl.className = 'travel-product__availability-message';
    if (availabilityState === 'available') {
      messageEl.classList.add('travel-product__availability-message--success');
    } else if (availabilityState === 'idle') {
      messageEl.classList.add('travel-product__availability-message--checking');
    } else if (availabilityState === 'unavailable' || availabilityState === 'error') {
      messageEl.classList.add('travel-product__availability-message--error');
    } else if (availabilityState === 'prechecking') {
      messageEl.classList.add('travel-product__availability-message--checking');
    }
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} state - booking state
   */
  function renderQuote(root, state) {
    const quoteEl = root.querySelector('[data-travel-quote]') ||
      root.querySelector('[data-travel-modal-quote]');
    // The legacy inline quote card was removed in favor of Booking summary.
    // Keep this rendering entry point because price updates still refresh that summary.
    if (!quoteEl) {
      renderBookingSummary(root, state);
      return;
    }
    
    if (state.quoteState === 'loading') {
      quoteEl.innerHTML = `
        <div class="travel-product__quote-loading">
          <span class="travel-product__quote-spinner"></span>
          <span>Calculating price...</span>
        </div>
      `;
      quoteEl.className = 'travel-product__quote travel-product__quote--loading';
    } else if (state.quoteState === 'success' && state.quoteData) {
      const total = state.quoteData.total || 0;
      const breakdown = state.quoteData.breakdown || [];
      const discountPreview = state.quoteData.discountPreview || null;
      
      const formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2
      });

      function toNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      }
      
      let breakdownHtml = '';
      if (breakdown.length > 0) {
        breakdownHtml = '<ul class="travel-product__quote-breakdown">';
        breakdown.forEach(function(item) {
          if (item && item.label && typeof item.amount === 'number') {
            breakdownHtml += `<li>
              <span class="travel-product__quote-breakdown-label">${item.label}</span>
              <span class="travel-product__quote-breakdown-amount">${formatter.format(item.amount)}</span>
            </li>`;
          }
        });
        breakdownHtml += '</ul>';
      }

      let discountInfo = null;
      let loginPromptHtml = '';
      if (isLoggedIn() && discountPreview) {
        const maxFinalTotal = toNumber(discountPreview.maxFinalTotal);
        const maxDiscountAmount = toNumber(discountPreview.maxDiscountAmount);
        const maxPercentRate = toNumber(discountPreview.maxPercentRate);
        const extra10Applied = discountPreview.extra10Applied === true ||
          (toNumber(discountPreview.extra10Amount) || 0) > 0;

        if (maxFinalTotal !== null && maxDiscountAmount !== null) {
          const percentText = maxPercentRate !== null ? Math.round(maxPercentRate * 100) + '%' : null;
          const summaryParts = [];
          if (percentText) summaryParts.push(percentText);
          if (extra10Applied) summaryParts.push('$10');
          const discountLabel = summaryParts.length > 0
            ? `Includes up to ${summaryParts.join(' + ')}`
            : 'Discount';
          discountInfo = { maxFinalTotal, maxDiscountAmount, discountLabel };
        }
      } else if (!isLoggedIn()) {
        loginPromptHtml = `
          <div class="travel-product__quote-discount travel-product__quote-discount--login">
            Log in to apply the maximum discount
          </div>
        `;
      }

      const heroPrice = discountInfo ? discountInfo.maxFinalTotal : total;

      let detailRowsHtml = breakdownHtml;
      if (discountInfo) {
        detailRowsHtml += `
          <div class="travel-product__quote-detail-row">
            <span class="travel-product__quote-detail-label">Estimated total</span>
            <span class="travel-product__quote-detail-amount">${formatter.format(total)}</span>
          </div>
          <div class="travel-product__quote-detail-row travel-product__quote-detail-row--discount">
            <span class="travel-product__quote-detail-label">${discountInfo.discountLabel}</span>
            <span class="travel-product__quote-detail-amount">-${formatter.format(Math.abs(discountInfo.maxDiscountAmount))}</span>
          </div>
        `;
      }

      quoteEl.innerHTML = `
        <div class="travel-product__quote-hero">
          <span class="travel-product__quote-hero-label">Final Price</span>
          <span class="travel-product__quote-hero-amount">${formatter.format(heroPrice)}</span>
        </div>
        <div class="travel-product__quote-rule"></div>
        ${detailRowsHtml}
        ${loginPromptHtml}
      `;
      quoteEl.className = 'travel-product__quote travel-product__quote--success' + (discountInfo ? ' travel-product__quote--has-discount' : '');
    } else if (state.quoteState === 'error') {
      quoteEl.innerHTML = `
        <div class="travel-product__quote-error">
          <span>${state.quoteErrorMessage || 'Failed to load the price.'}</span>
          <button type="button" class="travel-product__quote-retry" data-travel-quote-retry>Retry</button>
        </div>
      `;
      quoteEl.className = 'travel-product__quote travel-product__quote--error';
    } else {
      quoteEl.innerHTML = '';
      quoteEl.className = 'travel-product__quote travel-product__quote--idle';
    }
    renderBookingSummary(root, state);
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function attachAvailabilityRetryHandler(root, config, state) {
    const retryBtn = root.querySelector('[data-travel-availability-retry]');
    if (!retryBtn) return;

    retryBtn.addEventListener('click', function() {
      debouncePrecheck(root, config, state);
    });
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function attachQuoteRetryHandler(root, config, state) {
    root.addEventListener('click', function(e) {
      if (e.target && e.target.matches('[data-travel-quote-retry]')) {
        e.preventDefault();
        debounceQuote(root, config, state);
      }
    });
  }

  /**
   * @param {object} params - {productId, date, pax, bookingMode, poolKey, guideUnitsRequired, state}
   * @returns {Promise<void>}
   */
  async function finalAvailabilityRevalidate({ productId, date, pax, bookingMode, poolKey, guideUnitsRequired, state }) {
    const result = await checkAvailability({
      productId: productId,
      date: date,
      pax: pax,
      bookingMode: bookingMode,
      poolKey: poolKey,
      guideUnitsRequired: guideUnitsRequired,
      state: state
    }, { mode: 'final', skipCache: true });

    if (result.error) {
      const error = new Error(result.error.message);
      error.correlationId = result.error.correlationId;
      throw error;
    }

    if (result.available !== true) {
      const error = new Error(result.message || 'The selected date is not available for booking.');
      error.available = false;
      throw error;
    }
  }

  /**
   * @param {object} params - {productId, date, travelers, pax, bookingMode, poolKey, guideUnitsRequired, clientRequestId, state}
   * @returns {Promise<{holdId: string, expiresAt: number}>}
   */
  async function createReservationHold({ productId, date, travelers, pax, bookingMode, poolKey, guideUnitsRequired, clientRequestId, state }) {
    try {
      const requestBody = {
        productId: String(productId),
        date: String(date), // YYYY-MM-DD
        travelers: {
          adult: travelers.adult || 0,
          child: travelers.child || 0,
          infant: travelers.infant || 0
        },
        pax: Number(pax),
        bookingMode: String(bookingMode || 'private'),
        poolKey: String(poolKey || 'DEFAULT'),
        guideUnitsRequired: Number(guideUnitsRequired || 1)
      };

      if (clientRequestId) {
        requestBody.clientRequestId = String(clientRequestId);
      }

      const customerCtx = getCustomerContext();
      if (customerCtx.isLoggedIn) {
        const customerName = normalizeReservationContactName(customerCtx.name || '') || 'Customer';
        requestBody.customer = {
          name: customerName
        };
        if (customerCtx.email) {
          requestBody.customer.email = customerCtx.email;
        }
      }

      const envelope = await proxyFetch('/reservations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const data = envelope.data || {};
      const holdId = data.holdId || data.hold_id || null;
      const expiresAt = data.expiresAt || data.expires_at || null;

      if (!holdId) {
        throw new Error('Failed to create a hold. No holdId was returned.');
      }

      if (state) {
        state.holdId = holdId;
        state.holdExpiresAt = expiresAt ? (typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt) : null;
      }

      return {
        holdId: holdId,
        expiresAt: expiresAt ? (typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt) : Date.now() + 900000
      };

    } catch (error) {
      if (error.status === 409 || error.code === 'CONFLICT' || error.code === 'BOOKING_NOT_AVAILABLE') {
        const conflictError = new Error('Another reservation just took that slot. Please try again.');
        conflictError.status = 409;
        conflictError.code = 'CONFLICT';
        conflictError.correlationId = error.correlationId || null;
        throw conflictError;
      }

      throw error;
    }
  }

  /**
   * @param {object} params
   * @returns {Promise<{checkoutUrl?: string, intent?: object, decision?: string, appliedCodes?: object, correlationId?: string|null}>}
   */
  async function prepareTourCheckout({
    productId,
    date,
    travelers,
    bookingMode,
    poolKey,
    guideUnitsRequired,
    holdId,
    properties,
    mediaConsent,
    useTour15,
    useExtra10,
    clientRequestId
  }) {
    const requestBody = {
      productId: String(productId),
      date: String(date),
      travelers: {
        adult: travelers.adult || 0,
        child: travelers.child || 0,
        infant: travelers.infant || 0
      },
      bookingMode: String(bookingMode || 'private'),
      poolKey: String(poolKey || 'DEFAULT'),
      guideUnitsRequired: Number(guideUnitsRequired || 1),
      mediaConsent: Boolean(mediaConsent),
      useTour15: useTour15 !== false,
      useExtra10: Boolean(useExtra10)
    };

    if (holdId) {
      requestBody.holdId = String(holdId);
    }
    if (properties && Object.keys(properties).length > 0) {
      requestBody.properties = properties;
    }
    if (clientRequestId) {
      requestBody.clientRequestId = String(clientRequestId);
    }

    const themeCartCheckout = window.BtaThemeCartCheckout;
    let preparePath = themeCartCheckout && typeof themeCartCheckout.withCheckoutMode === 'function'
      ? themeCartCheckout.withCheckoutMode('/tour/prepare-checkout')
      : '/tour/prepare-checkout?checkoutMode=theme_cart';
    const memberTour = document.querySelector('.travel-product--member-page');
    if (memberTour) {
      preparePath = '/tour/prepare-checkout?checkoutMode=private_draft';
      if (new URLSearchParams(window.location.search).get('private_checkout_preview') === '1') {
        preparePath += '&private_checkout_preview=1';
      }
    }

    const envelope = await proxyFetch(preparePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: requestBody
    });

    const data = envelope.data || {};
    const checkoutUrl = data.checkoutUrl || data.checkout_url || null;
    if (memberTour && data.checkoutMode !== 'private_draft') throw new Error('Member checkout is not available.');

    if (data.checkoutMode === 'theme_cart') {
      return {
        intent: data,
        checkoutMode: data.checkoutMode,
        decision: data.decision,
        appliedCodes: data.appliedCodes,
        correlationId: envelope.meta?.correlationId || null
      };
    }

    if (!checkoutUrl) {
      const err = new Error('No checkout URL was returned.');
      err.status = 500;
      throw err;
    }

    return {
      checkoutUrl: checkoutUrl,
      decision: data.decision,
      appliedCodes: data.appliedCodes,
      correlationId: envelope.meta?.correlationId || null
    };
  }

  /**
   * Phase 5-3+5-4: Cart Prepare
   * @param {object} params - {productId, date, travelers, pax, bookingMode, poolKey, guideUnitsRequired, holdId, state}
   * @returns {Promise<{items: Array, properties: Object}>}
   */
  async function prepareCart({ productId, date, travelers, pax, bookingMode, poolKey, guideUnitsRequired, holdId, clientRequestId, state }) {
    const requestBody = {
      productId: String(productId),
      date: String(date), // YYYY-MM-DD
      travelers: {
        adult: travelers.adult || 0,
        child: travelers.child || 0,
        infant: travelers.infant || 0
      },
      pax: Number(pax),
      bookingMode: String(bookingMode || 'private'),
      poolKey: String(poolKey || 'DEFAULT'),
      guideUnitsRequired: Number(guideUnitsRequired || 1)
    };

    if (holdId) {
      requestBody.holdId = String(holdId);
    }

    const envelope = await proxyFetch('/cart/prepare', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const data = envelope.data || {};
    const items = data.items || [];
    const properties = data.properties || {};

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Failed to prepare the cart. No items were returned.');
    }

    const convertedItems = items.map(item => ({
      ...item,
      id: convertVariantIdToNumeric(item.variantId || item.id),
      quantity: item.quantity || 1
    }));

    const finalProperties = { ...properties };
    if (holdId && !finalProperties.hold_id && !finalProperties.holdId) {
      finalProperties.hold_id = String(holdId);
    }
    if (date && !finalProperties.travel_date && !finalProperties.travelDate) {
      finalProperties.travel_date = String(date);
    }
    if (!finalProperties.pool_key && !finalProperties.poolKey) {
      finalProperties.pool_key = String(poolKey || 'DEFAULT');
    }
    if (!finalProperties.guide_units_required && !finalProperties.guideUnitsRequired) {
      finalProperties.guide_units_required = String(guideUnitsRequired || 1);
    }
    if (!finalProperties.booking_mode && !finalProperties.bookingMode) {
      finalProperties.booking_mode = String(bookingMode || 'private');
    }
    if (!finalProperties.travelers_json && !finalProperties.travelersJson && !finalProperties.travelers) {
      const normalizedTravelers = {
        adult: Number(travelers.adult || 0),
        child: Number(travelers.child || 0),
        infant: Number(travelers.infant || 0)
      };
      finalProperties.travelers_json = JSON.stringify(normalizedTravelers);
    }
    if (!finalProperties.travelers_adult && !finalProperties.traveler_adult) {
      finalProperties.travelers_adult = String(Number(travelers.adult || 0));
    }
    if (!finalProperties.travelers_child && !finalProperties.traveler_child) {
      finalProperties.travelers_child = String(Number(travelers.child || 0));
    }
    if (!finalProperties.travelers_infant && !finalProperties.traveler_infant) {
      finalProperties.travelers_infant = String(Number(travelers.infant || 0));
    }
    if (clientRequestId) {
      if (!finalProperties.client_request_id) {
        finalProperties.client_request_id = String(clientRequestId);
      }
      if (!finalProperties.clientRequestId) {
        finalProperties.clientRequestId = String(clientRequestId);
      }
    }

    return {
      items: convertedItems,
      properties: finalProperties
    };
  }

  /**
   */
  async function releaseReservationHold(holdId, { productId, date, clientRequestId }) {
    if (!holdId) {
      return true;
    }

    const requestBody = {
      holdId: String(holdId)
    };

    if (productId) {
      requestBody.productId = String(productId);
    }
    if (date) {
      requestBody.date = String(date);
    }
    if (clientRequestId) {
      requestBody.clientRequestId = String(clientRequestId);
    }

    const envelope = await proxyFetch('/reservations/release', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!envelope.ok) {
      const errorMessage = envelope.error?.message || envelope.error?.description || 'Failed to release the reservation hold.';
      
      if (envelope.error?.status === 401 || envelope.error?.status === 403) {
        throw new Error('Please log in to continue.');
      }
      
      throw new Error(errorMessage);
    }

    return true;
  }

  /**
   */
  async function clearCart() {
    const clearUrl = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root 
      ? window.Shopify.routes.root 
      : '/') + 'cart/clear.js';

    const response = await fetch(clearUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.description || errorData.message || 'Failed to clear the cart.');
    }

    return true;
  }

  /**
   * @param {Array} items - [{id, quantity}, ...] (numeric variant id)
   * @returns {Promise<boolean>}
   */
  async function addToCart(items, properties) {
    const cartItems = items.map(item => ({
      id: String(item.id), // numeric variant id
      quantity: Number(item.quantity || 1),
      properties: properties || {}
    }));

    const cartUrl = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root 
      ? window.Shopify.routes.root 
      : '/') + 'cart/add.js';

    const response = await fetch(cartUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ items: cartItems })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.description || errorData.message || 'Failed to add the item to the cart.');
    }

    return true;
  }

  /**
   */
  function redirectToCheckout() {
    const checkoutUrl = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root 
      ? window.Shopify.routes.root 
      : '/') + 'checkout';
    
    window.location.href = checkoutUrl;
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} state - booking state
   */
  function renderFlowStatus(root, state) {
    const statusEl = root.querySelector('[data-travel-flow-status]');
    if (!statusEl) return;

    const { flowState, flowStep, flowErrorMessage } = state;
    const retryBtn = statusEl.querySelector('[data-travel-flow-retry]');

    if (flowState === 'idle' || flowState === 'success') {
      statusEl.style.display = 'none';
      statusEl.setAttribute('aria-hidden', 'true');
      const textNodes = [];
      for (let node of statusEl.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodes.push(node);
        }
      }
      textNodes.forEach(node => node.remove());
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
      return;
    }

    statusEl.style.display = 'block';
    statusEl.setAttribute('aria-hidden', 'false');

    let displayMessage = '';
    if (flowState === 'running') {
      switch (flowStep) {
        case 'availability':
          displayMessage = 'Checking availability...';
          break;
        case 'hold':
          displayMessage = 'Holding your reservation...';
          break;
        case 'prepare':
          displayMessage = 'Preparing checkout...';
          break;
        case 'holdRelease':
          displayMessage = 'Cleaning up the reservation...';
          break;
        case 'cartClear':
          displayMessage = 'Clearing the cart...';
          break;
        case 'cartAdd':
          displayMessage = 'Adding to cart...';
          break;
        case 'redirect':
          displayMessage = 'Redirecting to checkout...';
          break;
        default:
          displayMessage = 'Processing...';
      }
      if (retryBtn) {
        retryBtn.style.display = 'none';
        retryBtn.setAttribute('aria-hidden', 'true');
      }
    } else if (flowState === 'error') {
      displayMessage = flowErrorMessage || 'An error occurred while processing the reservation.';
      if (retryBtn) {
        retryBtn.style.display = 'inline-block';
        retryBtn.setAttribute('aria-hidden', 'false');
      }
    } else if (flowState === 'conflict') {
      displayMessage = flowErrorMessage || 'Another party booked it first.';
      if (retryBtn) {
        retryBtn.style.display = 'inline-block';
        retryBtn.setAttribute('aria-hidden', 'false');
      }
    }

    const textNodes = [];
    for (let node of statusEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        textNodes.push(node);
      }
    }
    if (textNodes.length > 0) {
      textNodes[0].textContent = displayMessage;
      for (let i = 1; i < textNodes.length; i++) {
        textNodes[i].remove();
      }
    } else {
      const textContent = document.createTextNode(displayMessage);
      if (retryBtn && retryBtn.parentNode === statusEl) {
        statusEl.insertBefore(textContent, retryBtn);
      } else {
        statusEl.appendChild(textContent);
      }
    }

    statusEl.className = 'travel-product__flow-status';
    if (flowState === 'running') {
      statusEl.classList.add('travel-product__flow-status--running');
    } else if (flowState === 'error' || flowState === 'conflict') {
      statusEl.classList.add('travel-product__flow-status--error');
    }
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  function attachFlowRetryHandler(root, config, state) {
    const retryBtn = root.querySelector('[data-travel-flow-retry]');
    if (!retryBtn) return;

    retryBtn.addEventListener('click', async function() {
      const checkoutBtn = root.querySelector('[data-travel-summary-proceed]');
      if (!checkoutBtn) return;

      setButtonLoading(checkoutBtn, true);
      checkoutBtn.disabled = true;

      try {
        await runBookingFlow(root, config, state);
      } catch (error) {
        console.error('[Travel Booking] Flow retry error:', error);
        setButtonLoading(checkoutBtn, false);
        checkoutBtn.disabled = false;
      }
    });
  }

  /**
   * @param {HTMLElement} root - travel root element
   * @param {object} config - booking config
   * @param {object} state - booking state
   */
  async function runBookingFlow(root, config, state) {
    if (inFlightLock !== null) {
      return;
    }

    const flowPromise = (async () => {
      let activeHoldId = null;
      let activeHoldContext = null;

      try {
        // Step 1: Input normalize + local validation
        state.flowState = 'running';
        state.flowStep = null;
        state.flowErrorMessage = null;
        renderFlowStatus(root, state);

        const date = getSelectedDate(state);
        const travelers = getTravelers(state);
        const pax = calculatePax(travelers);
        const productId = config.productId || root.getAttribute('data-product-id');
        const bookingMode = config.bookingMode || 'private';
        const poolKey = config.poolKey || 'DEFAULT';
        const guideUnitsRequired = config.guideUnitsRequired || 1;

        if (!date) {
          throw new Error('Please select a date.');
        }
        if (travelers.adult < 1 || pax < 1) {
          throw new Error('Please select travelers.');
        }
        if (config.maxPax && pax > config.maxPax) {
          throw new Error(`You can book up to ${config.maxPax} travelers.`);
        }

        const dateObj = new Date(date + 'T00:00:00');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const maxDate = new Date(today);
        maxDate.setDate(today.getDate() + (config.bookingWindowDays || 180));
        if (dateObj < today || dateObj > maxDate) {
          throw new Error('The selected date is outside the bookable window.');
        }

        let blackoutDates = config.blackoutDates || [];
        if (typeof blackoutDates === 'string') {
          try {
            blackoutDates = JSON.parse(blackoutDates);
          } catch (e) {
            blackoutDates = [];
          }
        }
        if (!Array.isArray(blackoutDates)) {
          blackoutDates = [];
        }
        const blackoutSet = new Set(blackoutDates);
        if (blackoutSet.has(date)) {
          throw new Error('The selected date is not available for booking.');
        }

        const weekdayMap = {
          'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4,
          'fri': 5, 'sat': 6, 'sun': 0
        };
        const operatingWeekdays = config.operatingWeekdays || [];
        const allowedDays = operatingWeekdays.map(function(day) {
          return weekdayMap[day.toLowerCase()] !== undefined ? weekdayMap[day.toLowerCase()] : null;
        }).filter(function(day) {
          return day !== null;
        });
        if (allowedDays.length > 0 && allowedDays.length < 7) {
          const dayOfWeek = dateObj.getDay();
          if (allowedDays.indexOf(dayOfWeek) === -1) {
            throw new Error('The selected date is not an operating day.');
          }
        }

        if (!isLoggedIn()) {
          state.flowState = 'error';
          state.flowErrorMessage = 'Please log in to continue.';
          renderFlowStatus(root, state);
          return;
        }

        if (state.proxyHealth !== 'up') {
          throw new Error('The booking system connection is unstable. Please try again shortly.');
        }

        const clientRequestId = generateClientRequestId(productId, date, travelers);
        state.clientRequestId = clientRequestId;
        activeHoldContext = {
          productId: productId,
          date: date,
          clientRequestId: clientRequestId
        };

        // Step 3: Final availability revalidation
        state.flowStep = 'availability';
        renderFlowStatus(root, state);
        await finalAvailabilityRevalidate({
          productId: productId,
          date: date,
          pax: pax,
          bookingMode: bookingMode,
          poolKey: poolKey,
          guideUnitsRequired: guideUnitsRequired,
          state: state
        });

        state.flowStep = 'holdRelease';
        renderFlowStatus(root, state);

        const cartUrl = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root 
          ? window.Shopify.routes.root 
          : '/') + 'cart.js';
        
        const cartResponse = await fetch(cartUrl);
        if (cartResponse.ok) {
          const cartData = await cartResponse.json();
          
          let existingHoldId = null;
          if (cartData.items && cartData.items.length > 0) {
            for (const item of cartData.items) {
              if (item.properties) {
                const props = Array.isArray(item.properties) 
                  ? Object.fromEntries(item.properties.map(p => [p.name || p.first, p.value || p.last]))
                  : item.properties;
                
                existingHoldId = props.hold_id || props.holdId || null;
                if (existingHoldId) break;
              }
            }
          }
          
          if (existingHoldId) {
            await releaseReservationHold(existingHoldId, {
              productId: productId,
              date: date,
              clientRequestId: clientRequestId
            });
          }
        }

        state.flowStep = 'hold';
        renderFlowStatus(root, state);
        const holdResult = await createReservationHold({
          productId: productId,
          date: date,
          travelers: travelers,
          pax: pax,
          bookingMode: bookingMode,
          poolKey: poolKey,
          guideUnitsRequired: guideUnitsRequired,
          clientRequestId: clientRequestId,
          state: state
        });
        activeHoldId = holdResult.holdId || null;

        state.flowStep = 'prepare';
        renderFlowStatus(root, state);
        const extrasProperties = getCheckoutExtrasProperties(state);
        const prepareResult = await prepareTourCheckout({
          productId: productId,
          date: date,
          travelers: travelers,
          bookingMode: bookingMode,
          poolKey: poolKey,
          guideUnitsRequired: guideUnitsRequired,
          holdId: holdResult.holdId,
          clientRequestId: clientRequestId,
          properties: extrasProperties,
          mediaConsent: Boolean(state.checkoutExtras.mediaConsent),
          useTour15: Boolean(state.checkoutExtras.useTour15),
          useExtra10: Boolean(state.checkoutExtras.useExtra10)
        });

        const themeCartCheckout = window.BtaThemeCartCheckout;
        if (themeCartCheckout && typeof themeCartCheckout.isThemeCartIntent === 'function' && themeCartCheckout.isThemeCartIntent(prepareResult.intent)) {
          state.flowState = 'running';
          await themeCartCheckout.runIntent(prepareResult.intent, {
            onStep: function(step) {
              if (step === 'cart_add') {
                state.flowStep = 'cartAdd';
              } else if (step === 'redirect') {
                state.flowStep = 'redirect';
              } else {
                state.flowStep = 'cartClear';
              }
              renderFlowStatus(root, state);
            }
          });
          return;
        }

        if (prepareResult.intent && prepareResult.intent.checkoutMode === 'theme_cart') {
          throw new Error('Checkout could not be prepared. Please try again.');
        }

        // Step 7: Redirect to Checkout
        state.flowStep = 'redirect';
        state.flowState = 'success';
        renderFlowStatus(root, state);
        window.location.href = prepareResult.checkoutUrl;

      } catch (error) {
        if (activeHoldId) {
          try {
            await releaseReservationHold(activeHoldId, activeHoldContext || {});
            activeHoldId = null;
          } catch (releaseError) {
            console.warn('[booking-proxy] Failed to release reservation hold after checkout error', {
              status: releaseError && releaseError.status,
              code: releaseError && releaseError.code
            });
          }
        }

        const isConflict = error.status === 409 || error.code === 'CONFLICT';
        state.flowState = isConflict ? 'conflict' : 'error';
        state.flowErrorMessage = error.message || (isConflict
          ? 'Another request is already being processed. Please try again shortly.'
          : 'An error occurred while processing the reservation.');

        if (error.status === 403) {
          state.flowErrorMessage = 'Please log in to continue.';
        }
        
        if (error && error.available === false) {
          state.availabilityState = 'unavailable';
          state.availabilityMessage = error.message || 'The selected date is not available for booking.';
          renderAvailabilityMessage(root, state);
          updateCheckoutButton(root, state);
        }

        if (error && error.correlationId) {
          console.warn('[booking-proxy] runBookingFlow failed', {
            correlationId: error.correlationId,
            status: error.status,
            code: error.code,
            step: state.flowStep
          });
        }

        renderFlowStatus(root, state);

        if (error.status === 403) {
          window.location.href = buildLoginUrl();
        }

        throw error;
      }
    })();

    inFlightLock = flowPromise;

    try {
      await flowPromise;
    } finally {
      inFlightLock = null;
    }
  }

  /**
   */
  function updateCheckoutButton(root, state) {
    const checkoutBtn = root.querySelector('[data-travel-proceed-checkout]');
    if (!checkoutBtn) return;

    const mode = checkoutBtn.getAttribute('data-mode');
    if (mode === 'login') {
      checkoutBtn.disabled = false;
      return;
    }

    const validation = validateBookingInput(state);
    
    const canProceed = validation.valid && 
                       state.proxyHealth === 'up' && 
                       state.availabilityState === 'available' &&
                       isLoggedIn();

    checkoutBtn.disabled = !canProceed;
  }

  /**
   */
  function initProceedCheckout(root, config, state) {
    const checkoutBtn = root.querySelector('[data-travel-proceed-checkout]');
    const statusEl = root.querySelector('[data-travel-status]');
    
    if (!checkoutBtn || !statusEl) {
      return;
    }

    checkoutBtn.addEventListener('click', async function() {
      updateStateFromDOM(root, state);

      const validation = validateBookingInput(state);
      if (!validation.valid) {
        showStatus(statusEl, validation.message, 'error');
        return;
      }

      setButtonLoading(checkoutBtn, true);
      checkoutBtn.disabled = true;

      try {
        await runBookingFlow(root, config, state);
      } catch (error) {
        console.error('[Travel Booking] runBookingFlow error:', error);
        setButtonLoading(checkoutBtn, false);
        checkoutBtn.disabled = false;
      }
    });
  }

  /**
   */
  async function mapTravelerToVariants(root, state, config) {
    const productId = root.getAttribute('data-product-id');
    if (!productId) {
      return { success: false, message: 'Product information could not be found.' };
    }

    try {
      const adultKeywords = ['adult', '성인'];
      const teenKeywords = ['teen', 'child', '청소년', '어린이'];
      const infantKeywords = ['infant', 'baby', '유아', '영아'];

      const variants = {
        adult: null,
        teenOrChild: null,
        infant: null
      };

      const productVariants = Array.isArray(config.variants) ? config.variants : [];
      if (productVariants.length > 0) {
        for (let i = 0; i < productVariants.length; i++) {
          const variant = productVariants[i];
          if (!variant || !variant.id) continue;

          const optionValues = variant.options || [];
          const optionValueStr = optionValues.join(' ').toLowerCase();

          if (!variants.adult && adultKeywords.some(keyword => optionValueStr.includes(keyword.toLowerCase()))) {
            variants.adult = variant.id;
          }
          if (!variants.teenOrChild && teenKeywords.some(keyword => optionValueStr.includes(keyword.toLowerCase()))) {
            variants.teenOrChild = variant.id;
          }
          if (!variants.infant && infantKeywords.some(keyword => optionValueStr.includes(keyword.toLowerCase()))) {
            variants.infant = variant.id;
          }
        }
      }

      const missing = [];
      if (state.travelerCounts.adult > 0 && !variants.adult) missing.push('Adult');
      if (state.travelerCounts.teenOrChild > 0 && !variants.teenOrChild) missing.push('Teen/Child');
      if (state.travelerCounts.infant > 0 && !variants.infant) missing.push('Infant');

      if (missing.length > 0) {
        return { 
          success: false, 
          message: `No variant could be found for these options: ${missing.join(', ')}` 
        };
      }

      return { success: true, variants: variants };
    } catch (error) {
      console.error('[Travel Booking] variant mapping error:', error);
      return { success: false, message: 'An error occurred while mapping variants.' };
    }
  }

  /**
   */
  function buildCartPayload(state, variants, config) {
    const items = [];
    const bookingGroupId = generateUUID();

    const summaryParts = [];
    if (state.travelerCounts.adult > 0) {
      summaryParts.push((config.travelerLabelAdult || 'Adult') + ' ' + state.travelerCounts.adult);
    }
    if (state.travelerCounts.teenOrChild > 0) {
      summaryParts.push((config.travelerLabelTeen || 'Teen') + ' ' + state.travelerCounts.teenOrChild);
    }
    if (state.travelerCounts.infant > 0) {
      summaryParts.push((config.travelerLabelInfant || 'Infant') + ' ' + state.travelerCounts.infant);
    }
    const travelerSummary = summaryParts.join(', ');

    const selectedDateISO = state.selectedDate ? new Date(state.selectedDate + 'T00:00:00').toISOString() : null;
    const properties = {
      booking_group_id: bookingGroupId,
      travel_date: state.selectedDate,
      start_date: selectedDateISO,
      booking_date: state.selectedDate,
      _booking_date: state.selectedDate,
      start: state.selectedDate,
      date: state.selectedDate,
      'booking[date]': state.selectedDate,
      'booking[start]': state.selectedDate,
      'Booking Date': state.selectedDate,
      'Start Date': state.selectedDate,
      'Booking Start': state.selectedDate,
      'Start': state.selectedDate,
      'Date': state.selectedDate,
      start_time_label: config.startTimeLabel || '',
      tour_duration: config.tourDurationLabel || '',
      traveler_summary: travelerSummary,
      adult_count: state.travelerCounts.adult.toString(),
      teen_count: state.travelerCounts.teenOrChild.toString(),
      infant_count: state.travelerCounts.infant.toString(),
      party_size: state.partySize.toString(),
      booking_mode: config.bookingMode || 'private',
      pool_key: config.poolKey || 'DEFAULT',
      guide_units_required: (config.guideUnitsRequired || 1).toString()
    };

    const checkoutExtrasProperties = getCheckoutExtrasProperties(state);
    Object.assign(properties, checkoutExtrasProperties);

    const propertiesArray = Object.keys(properties).map(key => ({
      name: key,
      value: properties[key]
    }));

    if (state.travelerCounts.adult > 0 && variants.adult) {
      items.push({
        id: String(variants.adult),
        quantity: state.travelerCounts.adult,
        properties: properties,
      });
    }

    if (state.travelerCounts.teenOrChild > 0 && variants.teenOrChild) {
      items.push({
        id: String(variants.teenOrChild),
        quantity: state.travelerCounts.teenOrChild,
        properties: properties
      });
    }

    if (state.travelerCounts.infant > 0 && variants.infant) {
      items.push({
        id: String(variants.infant),
        quantity: state.travelerCounts.infant,
        properties: properties
      });
    }

    return { items: items };
  }

  /**
   */
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   */
  function createAdapterStub(config) {
    return {
      baseUrl: config.adapterBaseUrl || '',
      config: config,

      /**
       * @param {string} productHandle
       * @param {string} from - YYYY-MM-DD
       * @param {string} to - YYYY-MM-DD
       * @returns {Promise<{disabled_dates: string[], reason_map?: object}>}
       */
      getDisabledDates: function(productHandle, from, to) {
        console.log('[Travel Booking Adapter Stub] getDisabledDates called', { productHandle, from, to });
        return Promise.resolve({
          disabled_dates: [],
          reason_map: {}
        });
      },

      /**
       * @param {string} productHandle
       * @param {string} date - YYYY-MM-DD
       * @param {number} partySize
       * @param {object} meta
       * @returns {Promise<{available: boolean, reason?: string}>}
       */
      checkAvailability: function(productHandle, date, partySize, meta) {
        if (!productHandle || !date || !partySize || partySize < 1) {
          return Promise.resolve({
            available: false,
            reason: 'invalid_input'
          });
        }

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('force_unavailable') === '1') {
          return Promise.resolve({
            available: false,
            reason: 'provider_error'
          });
        }

        return Promise.resolve({
          available: true,
          reason: null
        });
      },

      /**
       */
      reserve: function(productHandle, date, partySize, meta) {
        console.log('[Travel Booking Adapter Stub] reserve called', { productHandle, date, partySize, meta });
        return Promise.resolve({
          reserved: false,
          reservationToken: null
        });
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTravelBooking);
  } else {
    initTravelBooking();
  }

  window.TravelBookingHelpers = {
    proxyFetch: proxyFetch,
    releaseReservationHold: releaseReservationHold
  };
})();
