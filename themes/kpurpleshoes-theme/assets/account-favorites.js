(function () {
  'use strict';

  var GLOBAL_NAME = 'KPSAccountFavorites';
  var DEFAULT_API_BASE = '/apps/bta-booking/mypage';
  var DEVICE_KEY = 'favorites:device-id:v1';
  var BATCH_LIMIT = 100;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function trimTrailingSlash(value) {
    value = String(value || DEFAULT_API_BASE);
    return value.slice(-1) === '/' ? value.slice(0, -1) : value;
  }

  function safeParse(value, fallback) {
    try {
      var parsed = JSON.parse(value || '');
      return parsed == null ? fallback : parsed;
    } catch (error) {
      return fallback;
    }
  }

  function readStorage(key, fallback) {
    try {
      return safeParse(window.localStorage.getItem(key), fallback);
    } catch (error) {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {}
  }

  function generateUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }

    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join('-');
  }

  function generateScopedId(prefix) {
    return prefix ? prefix + ':' + generateUuid() : generateUuid();
  }

  function isUuid(value) {
    return typeof value === 'string' && UUID_RE.test(value);
  }

  function getDeviceId() {
    var existing = '';
    try {
      existing = window.localStorage.getItem(DEVICE_KEY) || '';
    } catch (error) {}
    if (existing) return existing;

    var next = generateScopedId('theme-browser');
    try {
      window.localStorage.setItem(DEVICE_KEY, next);
    } catch (error) {}
    return next;
  }

  function compositeKey(type, targetId) {
    return String(type || '') + ':' + String(targetId || '');
  }

  function normalizeItem(item) {
    if (!item || !item.type || !item.targetId) return null;
    return {
      type: String(item.type),
      targetId: String(item.targetId),
      state: item.state ? String(item.state) : 'ACTIVE',
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null,
      deletedAt: item.deletedAt || null,
      display: item.display && typeof item.display === 'object' ? item.display : {},
      contentRef: item.contentRef && typeof item.contentRef === 'object' ? item.contentRef : {}
    };
  }

  function normalizeItems(items) {
    var map = {};
    (Array.isArray(items) ? items : []).forEach(function (item) {
      var normalized = normalizeItem(item);
      if (!normalized || normalized.state === 'DELETED') return;
      map[compositeKey(normalized.type, normalized.targetId)] = normalized;
    });
    return map;
  }

  function normalizeCache(cache) {
    if (!cache || typeof cache !== 'object') {
      return { itemsByTargetId: {}, lastHydratedAt: null };
    }
    return {
      itemsByTargetId:
        cache.itemsByTargetId && typeof cache.itemsByTargetId === 'object' && !Array.isArray(cache.itemsByTargetId)
          ? cache.itemsByTargetId
          : {},
      lastHydratedAt: cache.lastHydratedAt || null
    };
  }

  function normalizeMeta(meta) {
    if (!meta || typeof meta !== 'object') {
      return { syncCursor: null, serverTime: null, lastSyncedAt: null, lastErrorCode: null };
    }
    return {
      syncCursor: meta.syncCursor || null,
      serverTime: meta.serverTime || null,
      lastSyncedAt: meta.lastSyncedAt || null,
      lastErrorCode: meta.lastErrorCode || null
    };
  }

  function normalizePending(pending) {
    return Array.isArray(pending) ? pending.map(function (change) {
      if (!change || !change.type || !change.targetId || !change.action) return null;
      return Object.assign({}, change, {
        clientChangeId: isUuid(change.clientChangeId) ? change.clientChangeId : generateUuid()
      });
    }).filter(Boolean) : [];
  }

  function isAuthRequiredError(error) {
    return Boolean(error && (error.code === 'AUTH_LOGIN_REQUIRED' || error.code === 'HTTP_401' || error.code === 'HTTP_403'));
  }

  function isRejectedPendingDropCode(code) {
    return (
      code === 'FAVORITE_INVALID_TYPE' ||
      code === 'FAVORITE_INVALID_TARGET' ||
      code === 'FAVORITE_INVALID_CHANGE' ||
      code === 'FAVORITE_IDEMPOTENCY_CONFLICT'
    );
  }

  function createClient(options) {
    options = options || {};

    var apiBase = trimTrailingSlash(options.apiBase || DEFAULT_API_BASE);
    var customerId = String(options.customerId || '').trim();
    var customerKey = String(options.customerKey || customerId || '').trim();
    var hasCustomer = Boolean(customerId || customerKey);
    var scope = hasCustomer ? encodeURIComponent(customerKey || customerId) : 'guest';
    var keys = {
      items: 'favorites:' + scope + ':items:v1',
      pending: 'favorites:' + scope + ':pending:v1',
      meta: 'favorites:' + scope + ':meta:v1',
      migration: 'favorites:' + scope + ':migration:v1'
    };
    var legacyScope = hasCustomer && customerId && scope !== customerId ? customerId : '';
    var legacyKeys = legacyScope
      ? {
        items: 'favorites:' + legacyScope + ':items:v1',
        pending: 'favorites:' + legacyScope + ':pending:v1',
        meta: 'favorites:' + legacyScope + ':meta:v1',
        migration: 'favorites:' + legacyScope + ':migration:v1'
      }
      : null;
    var cache = normalizeCache(readStorage(keys.items, { itemsByTargetId: {}, lastHydratedAt: null }));
    var pending = compactPending(normalizePending(readStorage(keys.pending, [])).concat(
      legacyKeys ? normalizePending(readStorage(legacyKeys.pending, [])) : []
    ));
    var meta = normalizeMeta(readStorage(keys.meta, legacyKeys ? readStorage(legacyKeys.meta, null) : null));
    var subscribers = [];
    var syncInFlight = false;
    var syncScheduled = false;
    var authRequired = false;
    var deviceId = getDeviceId();

    function saveCache() {
      writeStorage(keys.items, cache);
    }

    function savePending() {
      writeStorage(keys.pending, pending);
    }

    function saveMeta() {
      writeStorage(keys.meta, meta);
    }

    if (pending.length) {
      savePending();
    }

    function snapshot() {
      return {
        customerId: customerId,
        customerKey: customerKey,
        scope: scope,
        authRequired: authRequired,
        itemsByTargetId: Object.assign({}, cache.itemsByTargetId),
        pending: pending.slice(),
        meta: Object.assign({}, meta)
      };
    }

    function notify() {
      var current = snapshot();
      subscribers.slice().forEach(function (subscriber) {
        try {
          subscriber(current);
        } catch (error) {}
      });
    }

    function buildUrl(path, query) {
      var url = apiBase + path;
      var params = [];
      Object.keys(query || {}).forEach(function (key) {
        var value = query[key];
        if (value === undefined || value === null || value === '') return;
        params.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      });
      return params.length ? url + '?' + params.join('&') : url;
    }

    async function fetchEnvelope(path, fetchOptions, query) {
      var requestOptions = Object.assign(
        {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        },
        fetchOptions || {}
      );
      requestOptions.headers = Object.assign({ Accept: 'application/json' }, requestOptions.headers || {});

      if (requestOptions.body && !requestOptions.headers['Content-Type']) {
        requestOptions.headers['Content-Type'] = 'application/json';
      }

      var response = await fetch(buildUrl(path, query), requestOptions);
      var payload = null;
      var contentType = response.headers.get('content-type') || '';
      if (contentType.indexOf('application/json') !== -1) {
        payload = await response.json();
      }

      if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'ok')) {
        if (!payload.ok) {
          var envelopeError = new Error((payload.error && payload.error.message) || 'Favorites request failed.');
          envelopeError.code = payload.error && payload.error.code ? payload.error.code : 'ENVELOPE_ERROR';
          envelopeError.raw = payload;
          throw envelopeError;
        }
        return payload;
      }

      if (!response.ok) {
        var httpError = new Error('HTTP ' + response.status);
        httpError.code = 'HTTP_' + response.status;
        httpError.raw = payload;
        throw httpError;
      }

      return {
        ok: true,
        data: payload || {},
        error: null,
        meta: { correlationId: null }
      };
    }

    function replaceTypes(items, types) {
      var incoming = normalizeItems(items);
      var typeLookup = {};
      (types || []).forEach(function (type) {
        if (type) typeLookup[String(type)] = true;
      });

      Object.keys(cache.itemsByTargetId).forEach(function (key) {
        var item = cache.itemsByTargetId[key];
        if (!types || !types.length || typeLookup[item.type]) {
          delete cache.itemsByTargetId[key];
        }
      });

      Object.keys(incoming).forEach(function (key) {
        cache.itemsByTargetId[key] = incoming[key];
      });
      cache.lastHydratedAt = new Date().toISOString();
      saveCache();
    }

    function applyPendingOptimisticState() {
      pending.forEach(applyOptimisticChange);
      saveCache();
    }

    function applyCanonical(data, types) {
      data = data || {};
      replaceTypes(data.items || [], types);
      applyPendingOptimisticState();
      meta.syncCursor = data.syncCursor || meta.syncCursor || null;
      meta.serverTime = data.serverTime || meta.serverTime || null;
      meta.lastSyncedAt = new Date().toISOString();
      meta.lastErrorCode = null;
      authRequired = false;
      saveMeta();
      notify();
    }

    function markError(error) {
      meta.lastErrorCode = error && error.code ? error.code : 'NETWORK_ERROR';
      if (isAuthRequiredError(error)) {
        authRequired = true;
        cache.itemsByTargetId = {};
        cache.lastHydratedAt = new Date().toISOString();
        saveCache();
      }
      saveMeta();
      notify();
    }

    async function hydrate(options) {
      options = options || {};
      notify();
      if (!hasCustomer) {
        authRequired = true;
        notify();
        return snapshot();
      }

      if (pending.length) {
        await sync();
        return snapshot();
      }

      try {
        var envelope = await fetchEnvelope('/favorites', { method: 'GET' }, {
          type: options.type || '',
          includeDeleted: options.includeDeleted ? 'true' : 'false'
        });
        applyCanonical(envelope.data || {}, options.type ? [options.type] : []);
      } catch (error) {
        markError(error);
      }
      return snapshot();
    }

    function getActiveItems(type) {
      return Object.keys(cache.itemsByTargetId)
        .map(function (key) {
          return cache.itemsByTargetId[key];
        })
        .filter(function (item) {
          return item && item.state !== 'DELETED' && (!type || item.type === type);
        });
    }

    function isActive(type, targetId) {
      var item = cache.itemsByTargetId[compositeKey(type, targetId)];
      return Boolean(item && item.state !== 'DELETED');
    }

    function compactPending(changes) {
      var byKey = {};
      changes.forEach(function (change) {
        byKey[compositeKey(change.type, change.targetId)] = change;
      });
      return Object.keys(byKey).map(function (key) {
        return byKey[key];
      });
    }

    function applyOptimisticChange(change) {
      var key = compositeKey(change.type, change.targetId);
      if (change.action === 'REMOVE') {
        delete cache.itemsByTargetId[key];
        return;
      }

      cache.itemsByTargetId[key] = normalizeItem({
        type: change.type,
        targetId: change.targetId,
        state: 'ACTIVE',
        updatedAt: change.changedAt,
        display: change.display || {},
        contentRef: change.contentRef || {}
      });
    }

    function queueChanges(changes, options) {
      options = options || {};
      var now = new Date().toISOString();
      var normalizedChanges = (Array.isArray(changes) ? changes : [changes]).map(function (change) {
        if (!change || !change.type || !change.targetId || !change.action) return null;
        return {
          clientChangeId: isUuid(change.clientChangeId) ? change.clientChangeId : generateUuid(),
          type: String(change.type),
          targetId: String(change.targetId),
          action: change.action === 'REMOVE' ? 'REMOVE' : 'ADD',
          changedAt: change.changedAt || now,
          display: change.display || {},
          contentRef: change.contentRef || {}
        };
      }).filter(Boolean);

      if (!normalizedChanges.length) return snapshot();

      normalizedChanges.forEach(applyOptimisticChange);
      pending = compactPending(pending.concat(normalizedChanges));
      cache.lastHydratedAt = now;
      saveCache();
      savePending();
      notify();

      if (options.sync !== false) {
        scheduleSync();
      }

      return snapshot();
    }

    function toggle(change, options) {
      if (!change || !change.type || !change.targetId) return snapshot();
      var action = isActive(change.type, change.targetId) ? 'REMOVE' : 'ADD';
      return queueChanges(Object.assign({}, change, { action: action }), options);
    }

    function removeFinishedPending(finishedIds) {
      var finishedLookup = {};
      finishedIds.forEach(function (id) {
        finishedLookup[id] = true;
      });
      pending = pending.filter(function (change) {
        return !finishedLookup[change.clientChangeId];
      });
      savePending();
    }

    async function sync() {
      if (!hasCustomer) {
        authRequired = true;
        notify();
        return snapshot();
      }
      if (syncInFlight) return snapshot();

      syncInFlight = true;
      try {
        while (pending.length) {
          var batch = pending.slice(0, BATCH_LIMIT);

          var envelope = await fetchEnvelope('/favorites/sync', {
            method: 'POST',
            body: JSON.stringify({
              deviceId: deviceId,
              baseCursor: meta.syncCursor || null,
              changes: batch
            })
          });

          var data = envelope.data || {};
          var finishedIds = (data.acceptedChangeIds || []).slice();
          (data.rejectedChanges || []).forEach(function (rejection) {
            var changeId = rejection && (rejection.clientChangeId || rejection.id);
            var code = rejection && rejection.code;
            if (changeId && isRejectedPendingDropCode(code)) {
              finishedIds.push(changeId);
            }
          });

          removeFinishedPending(finishedIds);
          applyCanonical(data);

          if (!finishedIds.length && pending.length && pending[0] === batch[0]) {
            break;
          }
        }
      } catch (error) {
        markError(error);
      } finally {
        syncInFlight = false;
      }

      notify();
      return snapshot();
    }

    function scheduleSync() {
      if (syncScheduled) return;
      syncScheduled = true;
      window.setTimeout(function () {
        syncScheduled = false;
        sync();
      }, 150);
    }

    function getMigrationState() {
      var current = readStorage(keys.migration, {});
      if (!legacyKeys) return current;

      var legacy = readStorage(legacyKeys.migration, {});
      var merged = Object.assign({}, legacy, current);
      var legacyPurpleMapLists =
        legacy.purpleMapLists && typeof legacy.purpleMapLists === 'object' && !Array.isArray(legacy.purpleMapLists)
          ? legacy.purpleMapLists
          : {};
      var currentPurpleMapLists =
        current.purpleMapLists && typeof current.purpleMapLists === 'object' && !Array.isArray(current.purpleMapLists)
          ? current.purpleMapLists
          : {};
      if (Object.keys(legacyPurpleMapLists).length || Object.keys(currentPurpleMapLists).length) {
        merged.purpleMapLists = Object.assign({}, legacyPurpleMapLists, currentPurpleMapLists);
      }
      return merged;
    }

    function setMigrationState(value) {
      writeStorage(keys.migration, value || {});
    }

    function subscribe(callback) {
      if (typeof callback !== 'function') {
        return function () {};
      }
      subscribers.push(callback);
      return function () {
        subscribers = subscribers.filter(function (subscriber) {
          return subscriber !== callback;
        });
      };
    }

    window.addEventListener('online', function () {
      if (pending.length) {
        sync();
      } else {
        hydrate();
      }
    });

    return {
      hydrate: hydrate,
      sync: sync,
      scheduleSync: scheduleSync,
      subscribe: subscribe,
      getSnapshot: snapshot,
      getActiveItems: getActiveItems,
      isActive: isActive,
      toggle: toggle,
      queueChanges: queueChanges,
      getMigrationState: getMigrationState,
      setMigrationState: setMigrationState,
      isAuthRequiredError: isAuthRequiredError,
      buildKey: compositeKey
    };
  }

  window[GLOBAL_NAME] = {
    createClient: createClient,
    isAuthRequiredError: isAuthRequiredError
  };
})();
