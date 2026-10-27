(function() {
  'use strict';

  var NAMESPACE = 'BtaThemeCartCheckout';
  var CHECKOUT_MODE = 'theme_cart';
  var DEFAULT_TIMEOUT_MS = 10000;
  var EMPTY_CART_RETRIES = 3;
  var EMPTY_CART_RETRY_DELAY_MS = 250;
  var CART_VERIFY_RETRIES = 12;
  var CART_VERIFY_RETRY_DELAY_MS = 500;

  function createCheckoutError(code, message, raw) {
    var error = new Error(message || 'Checkout could not be prepared. Please try again.');
    error.code = code || 'BTA_THEME_CART_ERROR';
    error.raw = raw || null;
    return error;
  }

  function delay(ms) {
    return new Promise(function(resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function isThemeCartIntent(intent) {
    return !!intent && intent.checkoutMode === CHECKOUT_MODE;
  }

  function withCheckoutMode(url) {
    var rawUrl = String(url || '');
    if (!rawUrl) return rawUrl;

    try {
      var isAbsolute = /^https?:\/\//i.test(rawUrl);
      var parsed = new URL(rawUrl, window.location.origin);
      parsed.searchParams.set('checkoutMode', CHECKOUT_MODE);
      return isAbsolute ? parsed.href : (parsed.pathname + parsed.search + parsed.hash);
    } catch (error) {
      if (rawUrl.indexOf('checkoutMode=') !== -1) {
        return rawUrl.replace(/([?&])checkoutMode=[^&#]*/g, '$1checkoutMode=' + CHECKOUT_MODE);
      }
      return rawUrl + (rawUrl.indexOf('?') === -1 ? '?' : '&') + 'checkoutMode=' + CHECKOUT_MODE;
    }
  }

  function getShopifyRoot() {
    return window.Shopify && window.Shopify.routes && window.Shopify.routes.root
      ? window.Shopify.routes.root
      : '/';
  }

  function cartUrl(path) {
    return (getShopifyRoot() + String(path || '')).replace(/\/{2,}/g, '/');
  }

  function getPayloadErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.description === 'string' && payload.description) return payload.description;
    if (typeof payload.message === 'string' && payload.message) return payload.message;
    if (typeof payload.errors === 'string' && payload.errors) return payload.errors;
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      var firstError = payload.errors[0];
      if (typeof firstError === 'string') return firstError;
      if (firstError && typeof firstError.message === 'string') return firstError.message;
      if (firstError && typeof firstError.description === 'string') return firstError.description;
    }
    if (payload.errors && typeof payload.errors === 'object') {
      if (typeof payload.errors.message === 'string') return payload.errors.message;
      var errorKeys = Object.keys(payload.errors);
      if (errorKeys.length) {
        var firstValue = payload.errors[errorKeys[0]];
        return Array.isArray(firstValue) ? String(firstValue[0] || '') : String(firstValue || '');
      }
    }
    return '';
  }

  function shouldParseJsonResponse(contentType, text) {
    var normalizedContentType = String(contentType || '').toLowerCase();
    if (normalizedContentType.indexOf('application/json') !== -1) return true;
    if (normalizedContentType.indexOf('text/javascript') !== -1) return true;
    if (normalizedContentType.indexOf('application/javascript') !== -1) return true;

    var trimmed = String(text || '').trim();
    return trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[';
  }

  function parseJsonResponseText(text, url, contentType) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw createCheckoutError('PARSE_ERROR', 'The checkout response could not be processed. Please try again.', {
        url: url,
        contentType: contentType,
        sample: String(text || '').slice(0, 200)
      });
    }
  }

  async function fetchJson(url, options) {
    var controller = new AbortController();
    var timeoutId = window.setTimeout(function() {
      controller.abort();
    }, (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS);

    var requestOptions = Object.assign({
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json'
      },
      signal: controller.signal
    }, options || {});

    requestOptions.headers = Object.assign({
      'Accept': 'application/json'
    }, (options && options.headers) || {});

    try {
      var response = await fetch(url, requestOptions);
      var contentType = response.headers.get('content-type') || '';
      var payload = null;
      var responseText = await response.text();

      if (shouldParseJsonResponse(contentType, responseText)) {
        payload = parseJsonResponseText(responseText, url, contentType);
      } else {
        payload = responseText;
      }

      if (!response.ok) {
        var message = getPayloadErrorMessage(payload) || 'Checkout could not be prepared. Please try again.';
        throw createCheckoutError('HTTP_ERROR', message, payload);
      }

      if (typeof payload === 'string') {
        throw createCheckoutError('SHOPIFY_PAYLOAD_ERROR', 'The checkout response could not be processed. Please try again.', {
          url: url,
          contentType: contentType,
          sample: payload.slice(0, 200)
        });
      }

      var payloadErrorMessage = getPayloadErrorMessage(payload);
      if (payloadErrorMessage) {
        throw createCheckoutError('SHOPIFY_PAYLOAD_ERROR', payloadErrorMessage, payload);
      }

      return payload;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw createCheckoutError('TIMEOUT', 'Checkout preparation timed out. Please try again.', error);
      }
      if (error && error.code) {
        throw error;
      }
      throw createCheckoutError('NETWORK_ERROR', error && error.message ? error.message : 'A network error occurred while preparing checkout.', error);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function normalizeVariantId(value) {
    return String(value || '').replace(/^gid:\/\/shopify\/ProductVariant\//, '');
  }

  function normalizeProperties(properties) {
    var normalized = {};
    if (!properties || typeof properties !== 'object') {
      return normalized;
    }

    Object.keys(properties).forEach(function(key) {
      var value = properties[key];
      if (value === null || typeof value === 'undefined') return;
      normalized[key] = String(value);
    });

    return normalized;
  }

  function normalizeIntentItems(intent) {
    if (!intent || !Array.isArray(intent.items) || intent.items.length === 0) {
      throw createCheckoutError('INVALID_RESPONSE', 'The checkout response could not be processed. Please try again.', intent);
    }

    return intent.items.map(function(item) {
      var id = normalizeVariantId(item && item.id);
      var quantity = Number(item && item.quantity ? item.quantity : 1);
      if (!id || !isFinite(quantity) || quantity <= 0) {
        throw createCheckoutError('INVALID_RESPONSE', 'The checkout response could not be processed. Please try again.', item);
      }

      return {
        id: id,
        quantity: quantity,
        properties: normalizeProperties(item.properties)
      };
    });
  }

  async function fetchCart() {
    return fetchJson(cartUrl('cart.js'), {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
  }

  async function clearCartDiscounts() {
    return fetchJson(cartUrl('cart/update.js'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        discount: ''
      })
    });
  }

  async function clearCart() {
    return fetchJson(cartUrl('cart/clear.js'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  async function waitForEmptyCart() {
    var lastCart = null;
    for (var i = 0; i < EMPTY_CART_RETRIES; i += 1) {
      lastCart = await fetchCart();
      if (lastCart && Number(lastCart.item_count || 0) === 0) {
        return lastCart;
      }
      await delay(EMPTY_CART_RETRY_DELAY_MS);
    }

    throw createCheckoutError('CART_CLEAR_FAILED', 'Checkout could not be prepared. Please try again.', lastCart);
  }

  async function addIntentItems(intent) {
    var items = normalizeIntentItems(intent);
    var results = [];
    var expectedQuantities = {};

    try {
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        expectedQuantities[item.id] = Number(expectedQuantities[item.id] || 0) + Number(item.quantity || 0);
        results.push(await addIntentItem(item, i, expectedQuantities[item.id]));
      }
    } catch (error) {
      try {
        await clearCart();
      } catch (cleanupError) {
        if (window.console && typeof window.console.warn === 'function') {
          window.console.warn('[BTA Theme Cart] Failed to clean up cart after add failure.', cleanupError);
        }
      }
      throw error;
    }

    return results;
  }

  function buildCartAddLineItem(item) {
    var lineItem = {
      id: item.id,
      quantity: item.quantity
    };
    var properties = item.properties || {};
    if (Object.keys(properties).length > 0) {
      lineItem.properties = properties;
    }
    return lineItem;
  }

  function buildCartAddPayload(item, requestFormat) {
    var lineItem = buildCartAddLineItem(item);
    if (requestFormat === 'items_array') {
      return {
        items: [lineItem]
      };
    }
    return lineItem;
  }

  function getResponseVariantId(response) {
    if (!response || typeof response !== 'object') return '';
    return normalizeVariantId(response.variant_id || response.id);
  }

  function responseIncludesVariant(response, variantId) {
    if (!response || typeof response !== 'object') return false;
    if (getResponseVariantId(response) === variantId) {
      return true;
    }

    if (Array.isArray(response.items)) {
      return response.items.some(function(responseItem) {
        return normalizeVariantId(responseItem.variant_id || responseItem.id) === variantId;
      });
    }

    return false;
  }

  function getCartQuantity(cart, variantId) {
    var actual = buildQuantityMapFromCart(cart || {});
    return Number(actual[variantId] || 0);
  }

  function cartHasExpectedQuantity(cart, variantId, expectedQuantity) {
    return getCartQuantity(cart, variantId) >= Number(expectedQuantity || 0);
  }

  function sanitizeCartAddContext(item, index, requestFormat, response, cart, expectedQuantity) {
    var context = {
      index: index + 1,
      requestFormat: requestFormat || 'single_item',
      variantId: item.id,
      quantity: item.quantity,
      expectedQuantity: Number(expectedQuantity || item.quantity || 0),
      responseType: response === null ? 'null' : typeof response,
      responseVariantId: getResponseVariantId(response),
      responseHasItems: !!(response && Array.isArray(response.items))
    };
    if (cart) {
      context.cartActualQuantity = getCartQuantity(cart, item.id);
      context.cartItemCount = Number(cart.item_count || 0);
    }
    return context;
  }

  function createCartAddError(item, index, requestFormat, response, cart, expectedQuantity) {
    return createCheckoutError(
      'CART_ADD_FAILED',
      'Checkout could not be prepared. Please try again.',
      sanitizeCartAddContext(item, index, requestFormat, response, cart, expectedQuantity)
    );
  }

  function warnCartAddFallback(context) {
    if (!window.console || typeof window.console.warn !== 'function') return;
    window.console.warn('[BTA Theme Cart] Cart add response was not conclusive; retrying with fallback.', context);
    try {
      window.console.warn('[BTA Theme Cart] Cart add context: ' + JSON.stringify(context));
    } catch (error) {
      // Keep checkout flow unaffected if a browser blocks structured logging.
    }
  }

  async function verifyCartAddResult(response, item, index, requestFormat, expectedQuantity) {
    if (responseIncludesVariant(response, item.id)) {
      return response;
    }

    var cart = await fetchCart();
    if (cartHasExpectedQuantity(cart, item.id, expectedQuantity)) {
      return response;
    }

    throw createCartAddError(item, index, requestFormat, response, cart, expectedQuantity);
  }

  async function postCartAdd(item, requestFormat) {
    return fetchJson(cartUrl('cart/add.js'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildCartAddPayload(item, requestFormat))
    });
  }

  function shouldRetryCartAddFallback(error) {
    return !!error && [
      'CART_ADD_FAILED',
      'HTTP_ERROR',
      'SHOPIFY_PAYLOAD_ERROR',
      'PARSE_ERROR'
    ].indexOf(error.code) !== -1;
  }

  async function recoverCartAddFromCart(item, expectedQuantity) {
    var cart = await fetchCart();
    if (cartHasExpectedQuantity(cart, item.id, expectedQuantity)) {
      return {
        recovered: true,
        id: item.id,
        quantity: item.quantity
      };
    }
    return null;
  }

  async function addIntentItem(item, index, expectedQuantity) {
    var requestFormats = ['single_item', 'items_array'];
    var lastError = null;

    for (var i = 0; i < requestFormats.length; i += 1) {
      var requestFormat = requestFormats[i];
      try {
        var response = await postCartAdd(item, requestFormat);
        return await verifyCartAddResult(response, item, index, requestFormat, expectedQuantity);
      } catch (error) {
        lastError = error;
        try {
          var recovered = await recoverCartAddFromCart(item, expectedQuantity);
          if (recovered) {
            return recovered;
          }
        } catch (cartError) {
          if (!shouldRetryCartAddFallback(error)) {
            throw cartError;
          }
        }
        if (shouldRetryCartAddFallback(error) && i < requestFormats.length - 1) {
          var fallbackContext = error.raw && typeof error.raw === 'object'
            ? error.raw
            : sanitizeCartAddContext(item, index, requestFormat, null, null, expectedQuantity);
          fallbackContext.errorCode = error.code || '';
          warnCartAddFallback(fallbackContext);
          continue;
        }
        throw error;
      }
    }

    throw lastError || createCartAddError(item, index, 'unknown', null, null, expectedQuantity);
  }

  async function updateCartAttributesAndDiscounts(intent) {
    var discountCodes = Array.isArray(intent.discountCodes) ? intent.discountCodes.filter(Boolean) : [];
    var attributes = intent.cartAttributes && typeof intent.cartAttributes === 'object'
      ? intent.cartAttributes
      : {};

    return fetchJson(cartUrl('cart/update.js'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        attributes: attributes,
        discount: discountCodes.length ? discountCodes.join(',') : ''
      })
    });
  }

  function getCartItemProperties(item) {
    if (!item || !item.properties) return {};
    if (Array.isArray(item.properties)) {
      return item.properties.reduce(function(acc, pair) {
        var key = pair && (pair.name || pair.first || pair.key);
        var value = pair && (pair.value || pair.last);
        if (key) acc[key] = value;
        return acc;
      }, {});
    }
    return item.properties;
  }

  function buildQuantityMapFromIntent(intent) {
    return normalizeIntentItems(intent).reduce(function(map, item) {
      map[item.id] = (map[item.id] || 0) + item.quantity;
      return map;
    }, {});
  }

  function buildQuantityMapFromCart(cart) {
    return (cart.items || []).reduce(function(map, item) {
      var id = normalizeVariantId(item.variant_id || item.id);
      map[id] = (map[id] || 0) + Number(item.quantity || 0);
      return map;
    }, {});
  }

  function isCartPayload(payload) {
    return !!payload && typeof payload === 'object' && Array.isArray(payload.items);
  }

  function getIntentProperty(intent, key) {
    if (!intent) return '';
    if (intent.cartAttributes && intent.cartAttributes[key]) {
      return String(intent.cartAttributes[key]);
    }

    var items = Array.isArray(intent.items) ? intent.items : [];
    for (var i = 0; i < items.length; i += 1) {
      var properties = items[i] && items[i].properties ? items[i].properties : {};
      if (properties[key]) {
        return String(properties[key]);
      }
    }

    return '';
  }

  function getCartProperty(cart, key) {
    if (!cart) return '';
    if (cart.attributes && cart.attributes[key]) {
      return String(cart.attributes[key]);
    }

    var items = Array.isArray(cart.items) ? cart.items : [];
    for (var i = 0; i < items.length; i += 1) {
      var properties = getCartItemProperties(items[i]);
      if (properties[key]) {
        return String(properties[key]);
      }
    }

    return '';
  }

  function buildQuantityMismatches(expected, actual) {
    return Object.keys(expected).reduce(function(mismatches, variantId) {
      var expectedQuantity = Number(expected[variantId] || 0);
      var actualQuantity = Number(actual[variantId] || 0);
      if (actualQuantity !== expectedQuantity) {
        mismatches.push({
          variantId: variantId,
          expected: expectedQuantity,
          actual: actualQuantity
        });
      }
      return mismatches;
    }, []);
  }

  function buildCartVerificationContext(cart, intent, attempt, source, error) {
    var expected = buildQuantityMapFromIntent(intent);
    var actual = buildQuantityMapFromCart(cart || {});
    var raw = error && error.raw && typeof error.raw === 'object' ? error.raw : {};

    return {
      attempt: attempt,
      source: source || 'cart.js',
      code: error && error.code ? error.code : 'CART_VERIFICATION_FAILED',
      prepareId: getIntentProperty(intent, 'bta_prepare_id') || getIntentProperty(intent, '_bta_prepare_id'),
      cartPrepareId: getCartProperty(cart, 'bta_prepare_id') || getCartProperty(cart, '_bta_prepare_id'),
      checkoutKind: getIntentProperty(intent, 'bta_checkout_kind') || getIntentProperty(intent, '_bta_checkout_kind'),
      cartCheckoutKind: getCartProperty(cart, 'bta_checkout_kind') || getCartProperty(cart, '_bta_checkout_kind'),
      itemCount: Number(cart && cart.item_count ? cart.item_count : 0),
      expected: expected,
      actual: actual,
      mismatches: buildQuantityMismatches(expected, actual),
      propertyMismatch: raw.variantId && raw.expectedKeys ? {
        variantId: raw.variantId,
        expectedKeys: raw.expectedKeys
      } : null
    };
  }

  function warnCartVerificationRetry(context) {
    if (!window.console || typeof window.console.warn !== 'function') return;
    window.console.warn('[BTA Theme Cart] Cart verification mismatch; retrying.', context);
    try {
      window.console.warn('[BTA Theme Cart] Cart verification context: ' + JSON.stringify(context));
    } catch (error) {
      // Keep checkout flow unaffected if a browser blocks structured logging.
    }
  }

  function assertPublicProperties(cart, intent) {
    var expectedItems = normalizeIntentItems(intent);
    expectedItems.forEach(function(expected) {
      var expectedKeys = Object.keys(expected.properties || {}).filter(function(key) {
        return key.charAt(0) !== '_';
      });
      if (!expectedKeys.length) return;

      var matchingCartItems = (cart.items || []).filter(function(item) {
        return normalizeVariantId(item.variant_id || item.id) === expected.id;
      });

      var hasMatchingProperties = matchingCartItems.some(function(item) {
        var props = getCartItemProperties(item);
        return expectedKeys.every(function(key) {
          return String(props[key] || '') === String(expected.properties[key] || '');
        });
      });

      if (!hasMatchingProperties) {
        throw createCheckoutError('CART_VERIFICATION_FAILED', 'Checkout could not be prepared. Please try again.', {
          variantId: expected.id,
          expectedKeys: expectedKeys
        });
      }
    });
  }

  function assertCartMatchesIntent(cart, intent) {
    var expected = buildQuantityMapFromIntent(intent);
    var actual = buildQuantityMapFromCart(cart || {});

    Object.keys(expected).forEach(function(variantId) {
      if (Number(actual[variantId] || 0) !== Number(expected[variantId] || 0)) {
        throw createCheckoutError('CART_VERIFICATION_FAILED', 'Checkout could not be prepared. Please try again.', {
          variantId: variantId,
          expected: expected[variantId],
          actual: actual[variantId] || 0
        });
      }
    });

    assertPublicProperties(cart || {}, intent);
  }

  function verifyCartSnapshot(cart, intent, attempt, source) {
    try {
      assertCartMatchesIntent(cart, intent);
      return null;
    } catch (error) {
      if (!error || error.code !== 'CART_VERIFICATION_FAILED') {
        throw error;
      }

      var context = buildCartVerificationContext(cart, intent, attempt, source, error);
      error.raw = context;
      return error;
    }
  }

  async function waitForCartMatchesIntent(intent, initialCart) {
    var lastError = null;
    var attempt = 1;

    if (isCartPayload(initialCart)) {
      lastError = verifyCartSnapshot(initialCart, intent, attempt, 'cart_update_response');
      if (!lastError) {
        return initialCart;
      }

      warnCartVerificationRetry(lastError.raw);
      await delay(CART_VERIFY_RETRY_DELAY_MS);
      attempt += 1;
    }

    for (; attempt <= CART_VERIFY_RETRIES; attempt += 1) {
      var cart = await fetchCart();
      lastError = verifyCartSnapshot(cart, intent, attempt, 'cart.js');
      if (!lastError) {
        return cart;
      }

      if (attempt >= CART_VERIFY_RETRIES) {
        throw lastError;
      }

      warnCartVerificationRetry(lastError.raw);
      await delay(CART_VERIFY_RETRY_DELAY_MS);
    }

    throw lastError || createCheckoutError('CART_VERIFICATION_FAILED', 'Checkout could not be prepared. Please try again.');
  }

  function redirectToCheckout(intent) {
    window.location.href = intent.redirectPath || '/checkout';
  }

  async function runIntent(intent, options) {
    if (!isThemeCartIntent(intent)) {
      throw createCheckoutError('INVALID_RESPONSE', 'The checkout response could not be processed. Please try again.', intent);
    }

    var opts = options || {};
    var onStep = typeof opts.onStep === 'function' ? opts.onStep : function() {};

    onStep('discount_clear');
    await clearCartDiscounts();

    onStep('cart_clear');
    await clearCart();

    onStep('cart_empty_verify');
    await waitForEmptyCart();

    onStep('cart_add');
    await addIntentItems(intent);

    onStep('cart_update');
    var updatedCart = await updateCartAttributesAndDiscounts(intent);

    onStep('cart_verify');
    await waitForCartMatchesIntent(intent, updatedCart);

    onStep('redirect');
    redirectToCheckout(intent);

    return {
      redirecting: true
    };
  }

  window[NAMESPACE] = {
    isThemeCartIntent: isThemeCartIntent,
    withCheckoutMode: withCheckoutMode,
    runIntent: runIntent,
    fetchCart: fetchCart
  };
})();
