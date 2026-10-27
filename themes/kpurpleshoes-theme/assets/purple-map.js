(function () {
  'use strict';

  var PAGE_SIZE = Number.MAX_SAFE_INTEGER;
  var REQUEST_TIMEOUT_MS = 15000;
  var TM_SIDEBAR_STORAGE = 'tm-purple-map-sidebar-collapsed';
  var KAKAO_SDK_URL = 'https://dapi.kakao.com/v2/maps/sdk.js';
  var AREA_TAG_PREFIX = 'area:';
  var SEOUL_JUNG_GU_CENTER = { lat: 37.5636, lng: 126.9976 };
  var DEFAULT_MAP_LEVEL = 5;
  var LOCATION_STATUS_HIDE_MS = 4500;
  var BOUNDS_CHANGE_EPSILON = 0.0005;
  var kakaoLoadPromise = null;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeText(value) {
    var text = String(value == null ? '' : value);
    if (typeof text.normalize === 'function') {
      text = text.normalize('NFKC');
    }
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function normalizeImageUrl(value) {
    var text = String(value == null ? '' : value).trim();
    return text || '';
  }

  function normalizeToken(value) {
    return normalizeText(value)
      .replace(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function uniqueStrings(values) {
    var seen = {};
    var result = [];

    (values || []).forEach(function (value) {
      var text = String(value == null ? '' : value).trim();
      var token = normalizeToken(text);
      if (!text || !token || seen[token]) return;
      seen[token] = true;
      result.push(text);
    });

    return result;
  }

  function getDataAttr(root, name, fallback) {
    var value = root.getAttribute(name);
    return value == null || value === '' ? fallback : value;
  }

  function getQueryParam(names) {
    var params = new URLSearchParams(window.location.search || '');
    for (var i = 0; i < names.length; i++) {
      var value = params.get(names[i]);
      if (value) {
        return value;
      }
    }
    return '';
  }

  function optionExists(selectEl, value) {
    if (!selectEl || !value) return false;
    return $all('option', selectEl).some(function (option) {
      return option.value === value;
    });
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function resolvePlaceholder(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return fallback;

    var normalized = normalizeText(text);
    if (
      normalized === 'select region' ||
      normalized === 'select category' ||
      normalized === 'select a region and category to see the list.'
    ) {
      return fallback;
    }

    return text;
  }

  function sortLabels(values) {
    return values.sort(function (a, b) {
      return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
    });
  }

  function normalizeMeatType(value) {
    var normalized = String(value == null ? '' : value).trim().toUpperCase();
    if (
      normalized === 'BEEF' ||
      normalized === 'PORK' ||
      normalized === 'CHICKEN' ||
      normalized === 'LAMB' ||
      normalized === 'SEAFOOD' ||
      normalized === 'FISH' ||
      normalized === 'OTHER'
    ) {
      return normalized;
    }
    return null;
  }

  function formatMeatTypeLabel(value) {
    switch (value) {
      case 'BEEF':
        return 'Beef';
      case 'PORK':
        return 'Pork';
      case 'CHICKEN':
        return 'Chicken';
      case 'LAMB':
        return 'Lamb';
      case 'SEAFOOD':
        return 'Seafood';
      case 'FISH':
        return 'Fish';
      case 'OTHER':
        return 'Other';
      default:
        return value;
    }
  }

  function isLandmarkCategory(value) {
    return normalizeToken(value) === 'landmark';
  }

  var markerImageCache = Object.create(null);

  function getMapMarkerImage(kakao, root, category, selected) {
    var kind = isLandmarkCategory(category) ? 'landmark' : 'restaurant';
    var key = (selected ? 'selected-' : '') + kind;
    var src = getDataAttr(root, 'data-tm-marker-' + key, '');
    var width = selected ? 56 : 44;
    var height = selected ? 70 : 55;
    var cacheKey = src + ':' + width;
    if (!markerImageCache[cacheKey]) {
      markerImageCache[cacheKey] = new kakao.maps.MarkerImage(
        src,
        new kakao.maps.Size(width, height),
        { offset: new kakao.maps.Point(width / 2, height * 66 / 80) }
      );
    }
    return markerImageCache[cacheKey];
  }

  function buildScopedEndpoint(root, listId, templateAttrName, fallbackTemplate) {
    var base = getDataAttr(root, 'data-tm-api-base', '/apps/bta-booking/mypage').replace(/\/$/, '');
    var template = getDataAttr(root, templateAttrName, fallbackTemplate);
    var path = template.replace('{id}', encodeURIComponent(listId));

    if (path.charAt(0) !== '/') {
      path = '/' + path;
    }

    return base + path;
  }

  async function fetchEnvelope(url, options) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeoutId = null;

    if (controller) {
      timeoutId = window.setTimeout(function () {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
    }

    var requestOptions = Object.assign(
      {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      },
      options || {}
    );

    if (controller) {
      requestOptions.signal = controller.signal;
    }

    var response;
    try {
      response = await fetch(url, requestOptions);
    } catch (error) {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      throw error;
    }

    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }

    var payload = null;
    var contentType = response.headers.get('content-type') || '';
    if (contentType.indexOf('application/json') !== -1) {
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('PARSE_ERROR');
      }
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, 'ok')) {
      if (!payload.ok) {
        var envelopeError = new Error(
          (payload.error && payload.error.message) || 'An error occurred while loading restaurants.'
        );
        envelopeError.code = payload.error && payload.error.code ? payload.error.code : 'ENVELOPE_ERROR';
        envelopeError.correlationId = payload.meta && payload.meta.correlationId ? payload.meta.correlationId : null;
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
      data: payload,
      error: null,
      meta: { correlationId: null }
    };
  }

  function isAccessDeniedError(error) {
    return !!(
      error &&
      (error.code === 'AUTH_LOGIN_REQUIRED' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403')
    );
  }

  function extractRestaurants(data) {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && Array.isArray(data.items)) {
      return data.items;
    }
    return [];
  }

  function extractAreaLabel(tags, address) {
    var taggedArea = (tags || []).find(function (tag) {
      return String(tag || '').toLowerCase().indexOf(AREA_TAG_PREFIX) === 0;
    });
    if (taggedArea) {
      var areaFromTag = String(taggedArea).slice(AREA_TAG_PREFIX.length).trim();
      if (areaFromTag) {
        return areaFromTag;
      }
    }

    if (!address) return '';
    var areaFromAddress = String(address).split(',')[0];
    return areaFromAddress ? areaFromAddress.trim() : '';
  }

  function resolveRestaurantArea(item, rawTags, address) {
    var areaOption = normalizeFilterOption(item && item.area ? item.area : null);
    if (areaOption) {
      return areaOption;
    }

    var fallbackAreaLabel = extractAreaLabel(rawTags, address);
    if (!fallbackAreaLabel) {
      return null;
    }

    return normalizeFilterOption({
      name: fallbackAreaLabel,
      slug: normalizeToken(fallbackAreaLabel)
    });
  }

  function normalizeRestaurant(item) {
    if (!item || !item.id || !item.name) {
      return null;
    }

    var rawTags = uniqueStrings(item.tags || []);
    var visibleTags = rawTags.filter(function (tag) {
      return String(tag || '').toLowerCase().indexOf(AREA_TAG_PREFIX) !== 0;
    });
    var dietary = item.dietary && typeof item.dietary === 'object' ? item.dietary : {};
    var meatTypes = uniqueStrings(dietary.meatTypes || [])
      .map(normalizeMeatType)
      .filter(function (value) {
        return value !== null;
      });
    var lat = Number(item.lat);
    var lng = Number(item.lng);
    var priority = Number(item.priority);
    var category = item.category ? String(item.category).trim() : '';
    var address = item.address ? String(item.address).trim() : '';
    var memo = item.memo ? String(item.memo).trim() : '';
    var dietaryNotes = dietary.notes ? String(dietary.notes).trim() : '';
    var area = resolveRestaurantArea(item, rawTags, address);
    var areaLabel = area ? area.name : '';
    var photoUrl = normalizeImageUrl(item.photoUrl);
    var photoThumbnailUrl = normalizeImageUrl(item.photoThumbnailUrl);

    return {
      id: String(item.id),
      name: String(item.name).trim(),
      category: category,
      address: address,
      photoUrl: photoUrl,
      photoThumbnailUrl: photoThumbnailUrl,
      area: area,
      areaLabel: areaLabel,
      lat: isFiniteNumber(lat) ? lat : null,
      lng: isFiniteNumber(lng) ? lng : null,
      tags: visibleTags,
      memo: memo,
      priority: isFiniteNumber(priority) ? priority : Number.MAX_SAFE_INTEGER,
      mapUrl: item.mapUrl ? String(item.mapUrl).trim() : '',
      dietary: {
        isVeganOnly: !!dietary.isVeganOnly,
        hasVeganOptions: !!dietary.hasVeganOptions,
        veganLevel: String(dietary.veganLevel || 'UNKNOWN').toUpperCase(),
        meatTypes: meatTypes,
        halalLevel: String(dietary.halalLevel || 'UNKNOWN').toUpperCase(),
        notes: dietaryNotes
      }
    };
  }

  function compareRestaurants(a, b) {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }

  function buildFallbackFilterOptions(items) {
    var categories = {};
    var areas = {};

    items.forEach(function (item) {
      if (item.category) {
        categories[item.category] = true;
      }
      if (item.area && item.area.name) {
        areas[item.area.value || item.area.name] = item.area;
      } else if (item.areaLabel) {
        areas[item.areaLabel] = normalizeFilterOption({
          name: item.areaLabel,
          slug: normalizeToken(item.areaLabel)
        });
      }
    });

    return {
      categories: sortLabels(Object.keys(categories)).map(function (name) {
        return normalizeFilterOption({ name: name, slug: normalizeToken(name) });
      }),
      areas: sortLabels(Object.keys(areas)).map(function (key) {
        return areas[key];
      })
    };
  }

  function normalizeFilterOption(option) {
    if (option == null) return null;

    var id = '';
    var name = '';
    var slug = '';

    if (typeof option === 'string') {
      name = option.trim();
      slug = normalizeToken(name);
    } else if (typeof option === 'object') {
      id = option.id == null ? '' : String(option.id).trim();
      name = option.name == null ? '' : String(option.name).trim();
      slug = option.slug == null ? '' : String(option.slug).trim();
    }

    if (!name && slug) {
      name = slug;
    }
    if (!name && id) {
      name = id;
    }
    if (!name) {
      return null;
    }

    var value = slug || id || name;
    var matchTokens = uniqueStrings([name, slug, id]);

    return {
      id: id,
      name: name,
      slug: slug || normalizeToken(name),
      value: value,
      matchTokens: matchTokens,
      normalizedMatchTokens: matchTokens
        .map(function (entry) {
          return normalizeToken(entry);
        })
        .filter(Boolean)
    };
  }

  function normalizeFilterOptions(data) {
    var source = data && typeof data === 'object' ? data : {};

    return {
      areas: (source.areas || []).map(normalizeFilterOption).filter(Boolean),
      categories: (source.categories || []).map(normalizeFilterOption).filter(Boolean)
    };
  }

  function findOptionByValue(options, value) {
    if (!value) return null;

    var exact = (options || []).find(function (option) {
      return option.value === value;
    });
    if (exact) return exact;

    var normalized = normalizeToken(value);
    if (!normalized) return null;

    return (
      (options || []).find(function (option) {
        return option.normalizedMatchTokens.indexOf(normalized) !== -1;
      }) || null
    );
  }

  function resolveOptionValue(options, preferredValue) {
    var option = findOptionByValue(options, preferredValue);
    return option ? option.value : '';
  }

  function matchesOptionLabel(option, itemLabel) {
    if (!option) return false;
    if (itemLabel && typeof itemLabel === 'object') {
      var candidateTokens = Array.isArray(itemLabel.normalizedMatchTokens)
        ? itemLabel.normalizedMatchTokens
        : [];
      return candidateTokens.some(function (token) {
        return option.normalizedMatchTokens.indexOf(token) !== -1;
      });
    }
    var normalizedItemLabel = normalizeToken(itemLabel);
    if (!normalizedItemLabel) return false;
    return option.normalizedMatchTokens.indexOf(normalizedItemLabel) !== -1;
  }

  function buildMetaText(item) {
    if (item.address) return item.address;
    if (item.areaLabel) return item.areaLabel;
    return '';
  }

  function buildBadge(item) {
    if (item.dietary.halalLevel === 'CERTIFIED') {
      return { label: 'Halal Certified', className: '' };
    }
    if (item.dietary.halalLevel === 'NO_PORK') {
      return { label: 'No Pork', className: '' };
    }
    if (item.dietary.isVeganOnly) {
      return { label: 'Vegan', className: '' };
    }
    if (item.dietary.hasVeganOptions) {
      return { label: 'Vegan Options', className: '' };
    }
    if (item.category) {
      return { label: item.category, className: ' tm-badge--closed' };
    }
    return { label: 'Restaurant', className: ' tm-badge--closed' };
  }

  function buildAccentText(item) {
    if (item.areaLabel) {
      return item.areaLabel;
    }
    if (item.tags.length) {
      return item.tags
        .slice(0, 2)
        .map(function (tag) {
          return tag.charAt(0) === '#' ? tag : '#' + tag;
        })
        .join(' ');
    }
    return 'Listed';
  }

  function buildTagList(item) {
    var badges = [];

    if (item.dietary.isVeganOnly) {
      badges.push('Vegan');
    } else if (item.dietary.hasVeganOptions) {
      badges.push('Vegan options');
    }

    if (item.dietary.halalLevel === 'CERTIFIED') {
      badges.push('Halal certified');
    } else if (item.dietary.halalLevel === 'NO_PORK') {
      badges.push('No pork');
    }

    (item.dietary.meatTypes || []).forEach(function (type) {
      badges.push(formatMeatTypeLabel(type));
    });

    return uniqueStrings(badges.concat(item.tags)).slice(0, 4);
  }

  function buildMapDetailUrl(item, useNaver) {
    if (useNaver) {
      if (!item) return '';
      try {
        var url = new URL(item.mapUrl || '');
        var placePath = /\/place\/\d+(?:\/|$)/.test(url.pathname);
        var sharedPlace = url.hostname === 'naver.me' && /^\/[A-Za-z0-9]+\/?$/.test(url.pathname);
        var placePage = ['m.place.naver.com', 'pcmap.place.naver.com'].indexOf(url.hostname) >= 0 && /^\/[a-z]+\/\d+(?:\/|$)/.test(url.pathname);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
          (sharedPlace || placePage || (url.hostname === 'map.naver.com' && placePath))) return url.href;
      } catch (_) { /* Older records may only contain a Kakao link. */ }
      return 'https://map.naver.com/p/search/' + encodeURIComponent([item.name, item.address].filter(Boolean).join(' '));
    }
    return item && item.mapUrl ? item.mapUrl : '';
  }

  function buildMapDirectionsUrl(item, useNaver) {
    if (!item || !isFiniteNumber(item.lat) || !isFiniteNumber(item.lng)) {
      return '';
    }
    if (useNaver) {
      return 'https://map.naver.com/index.nhn?elng=' + item.lng + '&elat=' + item.lat +
        '&etext=' + encodeURIComponent(item.name) + '&menu=route';
    }
    return 'https://map.kakao.com/link/to/' + encodeURIComponent(item.name) + ',' + item.lat + ',' + item.lng;
  }

  function getRestaurantListImageUrl(item) {
    if (!item) return '';
    return item.photoThumbnailUrl || item.photoUrl || '';
  }

  function getRestaurantDetailImageUrl(item) {
    if (!item) return '';
    return item.photoUrl || item.photoThumbnailUrl || '';
  }

  function photoPlaceholderSvg() {
    return (
      '<svg class="tm-photo-placeholder__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M4.75 6.75h3.6l1.2-1.75h4.9l1.2 1.75h3.6c1.1 0 2 .9 2 2v8.5c0 1.1-.9 2-2 2H4.75c-1.1 0-2-.9-2-2v-8.5c0-1.1.9-2 2-2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<circle cx="12" cy="13" r="3.25" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '</svg>'
    );
  }

  function buildPhotoPlaceholderHtml(className, hidden) {
    return (
      '<span class="' +
      className +
      '" data-tm-photo-placeholder' +
      (hidden ? ' hidden' : '') +
      ' aria-hidden="true">' +
      photoPlaceholderSvg() +
      '</span>'
    );
  }

  function ensureKakaoLoaded(appKey) {
    if (!appKey) {
      return Promise.reject(new Error('MISSING_KAKAO_APP_KEY'));
    }

    if (window.kakao && window.kakao.maps && typeof window.kakao.maps.load === 'function') {
      return new Promise(function (resolve) {
        window.kakao.maps.load(function () {
          resolve(window.kakao);
        });
      });
    }

    if (kakaoLoadPromise) {
      return kakaoLoadPromise;
    }

    kakaoLoadPromise = new Promise(function (resolve, reject) {
      function handleLoad() {
        if (!window.kakao || !window.kakao.maps || typeof window.kakao.maps.load !== 'function') {
          reject(new Error('KAKAO_MAPS_UNAVAILABLE'));
          return;
        }
        window.kakao.maps.load(function () {
          resolve(window.kakao);
        });
      }

      var existingScript = document.querySelector('script[data-tm-kakao-sdk="1"]');
      if (existingScript) {
        existingScript.addEventListener('load', handleLoad, { once: true });
        existingScript.addEventListener(
          'error',
          function () {
            reject(new Error('KAKAO_SCRIPT_LOAD_FAILED'));
          },
          { once: true }
        );
        return;
      }

      var script = document.createElement('script');
      script.async = true;
      script.defer = true;
      script.setAttribute('data-tm-kakao-sdk', '1');
      script.src = KAKAO_SDK_URL + '?autoload=false&libraries=clusterer&appkey=' + encodeURIComponent(appKey);
      script.addEventListener('load', handleLoad, { once: true });
      script.addEventListener(
        'error',
        function () {
          reject(new Error('KAKAO_SCRIPT_LOAD_FAILED'));
        },
        { once: true }
      );
      document.head.appendChild(script);
    }).catch(function (error) {
      kakaoLoadPromise = null;
      throw error;
    });

    return kakaoLoadPromise;
  }

  function init() {
    var root = document.querySelector('[data-purple-map]');
    if (!root) return;

    var listEl = $('[data-tm-list]', root);
    var paginationEl = $('[data-tm-pagination]', root);
    var categorySelect = $('[data-tm-category-select]', root);
    var filtersWrap = $('[data-tm-filters-wrap]', root);
    var filtersEl = $('[data-tm-chips-filters]', root);
    var favoriteFilterButton = $('[data-tm-favorite-filter]', root);
    var selectHint = $('[data-tm-select-hint]', root);
    var mapCanvas = $('.tm-map__canvas', root);
    var listJumpButton = $('[data-tm-list-jump]', root);
    var searchAreaButton = $('[data-tm-search-area]', root);
    var resetMapButton = $('[data-tm-reset-map]', root);
    var locationStatus = $('[data-tm-location-status]', root);
    var mapPlaceholder = $('[data-tm-map-placeholder]', root);
    var mapPlaceholderText = $('[data-tm-map-placeholder-text]', root) || (mapPlaceholder ? $('p', mapPlaceholder) : null);
    var mapPlaceholderTitle = mapPlaceholder ? $('h2', mapPlaceholder) : null;
    var categoryPlaceholder = resolvePlaceholder(
      categorySelect && categorySelect.options.length ? categorySelect.options[0].textContent : '',
      'All categories'
    );
    var initialCategory = getQueryParam(['category']);
    var apiBase = getDataAttr(root, 'data-tm-api-base', '/apps/bta-booking/mypage').replace(/\/$/, '');
    var customerId = (getDataAttr(root, 'data-tm-customer-id', '') || '').trim();
    var customerKey = (getDataAttr(root, 'data-tm-customer-gid', '') || customerId).trim();
    var initialListId = getQueryParam(['listId', 'restaurantListId']) || getDataAttr(root, 'data-tm-default-list-id', '');
    var legacyFavoritesKey = 'tm-favorites:' + (customerId || 'guest') + ':' + (initialListId || 'default');

    var messages = {
      promptNone: getDataAttr(root, 'data-tm-prompt-none', 'No restaurants match your filters.'),
      loading: getDataAttr(root, 'data-tm-loading-text', 'Loading restaurants...'),
      error: getDataAttr(root, 'data-tm-error-text', "Couldn't load the restaurant list right now."),
      missingListId: getDataAttr(root, 'data-tm-missing-list-id-text', 'Restaurant list is not configured yet.'),
      mapLoading: getDataAttr(root, 'data-tm-map-loading-text', 'Loading Kakao Map...'),
      mapKeyMissing: getDataAttr(root, 'data-tm-map-key-missing-text', 'Add a Kakao JavaScript key to display the map.'),
      mapError: getDataAttr(root, 'data-tm-map-error-text', "The map couldn't be loaded right now."),
      retry: getDataAttr(root, 'data-tm-retry-label', 'Retry'),
      locationDefault: 'Showing Seoul Jung-gu.',
      favoriteEmpty: 'No favorite places in this area.'
    };

    var state = {
      items: [],
      status: 'idle',
      error: null,
      apiBase: apiBase,
      customerId: customerId,
      customerKey: customerKey,
      listId: initialListId,
      kakaoAppKey: getDataAttr(root, 'data-tm-kakao-app-key', ''),
      naverClientId: getDataAttr(root, 'data-tm-naver-client-id', '').trim(),
      legacyFavoritesKey: legacyFavoritesKey,
      favoritesClient: window.KPSAccountFavorites
        ? window.KPSAccountFavorites.createClient({
          customerId: customerId,
          customerKey: customerKey,
          apiBase: apiBase,
          namespace: 'purple-map'
        })
        : null,
      category: '',
      pendingCategory: initialCategory || '',
      favoriteOnly: false,
      options: {
        areas: [],
        categories: []
      },
      page: 1,
      selectedId: null,
      pendingScrollToSelected: false,
      photoErrorRefreshAttempted: false,
      location: {
        initialResolved: false,
        center: null,
        statusTimer: null
      },
      map: {
        api: null,
        instance: null,
        markers: [],
        infoWindow: null,
        hoverInfoWindow: null,
        hoverId: null,
        hoverContent: null,
        hoverCloseTimer: null,
        clusterer: null,
        renderToken: 0,
        searchBounds: null,
        loadFailed: false
      }
    };
    var photoModal = null;
    if (state.naverClientId) {
      messages.mapLoading = 'Loading Naver Map...';
      messages.mapError = 'Unable to load Naver Map. Please try again.';
    }
    var photoModalTitle = null;
    var photoModalImage = null;
    var photoModalFrame = null;
    var photoModalPlaceholder = null;
    var photoModalClose = null;
    var lastPhotoFocus = null;

    function getMapBoundsObject() {
      if (!state.map.instance || typeof state.map.instance.getBounds !== 'function') {
        return null;
      }

      var bounds = state.map.instance.getBounds();
      if (
        !bounds ||
        typeof bounds.getSouthWest !== 'function' ||
        typeof bounds.getNorthEast !== 'function'
      ) {
        return null;
      }

      var southWest = bounds.getSouthWest();
      var northEast = bounds.getNorthEast();
      if (
        !southWest ||
        !northEast ||
        typeof southWest.getLat !== 'function' ||
        typeof southWest.getLng !== 'function' ||
        typeof northEast.getLat !== 'function' ||
        typeof northEast.getLng !== 'function'
      ) {
        return null;
      }

      var minLat = Number(southWest.getLat());
      var minLng = Number(southWest.getLng());
      var maxLat = Number(northEast.getLat());
      var maxLng = Number(northEast.getLng());
      if (
        !isFiniteNumber(minLat) ||
        !isFiniteNumber(minLng) ||
        !isFiniteNumber(maxLat) ||
        !isFiniteNumber(maxLng)
      ) {
        return null;
      }

      return {
        minLat: Math.min(minLat, maxLat),
        maxLat: Math.max(minLat, maxLat),
        minLng: Math.min(minLng, maxLng),
        maxLng: Math.max(minLng, maxLng)
      };
    }

    function boundsChanged(a, b) {
      if (!a || !b) return false;
      return (
        Math.abs(a.minLat - b.minLat) > BOUNDS_CHANGE_EPSILON ||
        Math.abs(a.maxLat - b.maxLat) > BOUNDS_CHANGE_EPSILON ||
        Math.abs(a.minLng - b.minLng) > BOUNDS_CHANGE_EPSILON ||
        Math.abs(a.maxLng - b.maxLng) > BOUNDS_CHANGE_EPSILON
      );
    }

    function itemIsInsideBounds(item, bounds) {
      if (!bounds || !isFiniteNumber(item.lat) || !isFiniteNumber(item.lng)) return false;
      return (
        item.lat >= bounds.minLat &&
        item.lat <= bounds.maxLat &&
        item.lng >= bounds.minLng &&
        item.lng <= bounds.maxLng
      );
    }

    function setSearchAreaVisible(visible) {
      if (!searchAreaButton) return;
      searchAreaButton.hidden = !visible;
    }

    function updateSearchAreaButton() {
      if (!state.map.instance || !state.map.searchBounds || state.status !== 'ready') {
        setSearchAreaVisible(false);
        return;
      }

      setSearchAreaVisible(boundsChanged(state.map.searchBounds, getMapBoundsObject()));
    }

    function captureSearchBoundsFromMap() {
      var bounds = getMapBoundsObject();
      if (!bounds) return false;
      state.map.searchBounds = bounds;
      setSearchAreaVisible(false);
      return true;
    }

    function sortFilteredItems(items) {
      return items.slice().sort(compareRestaurants);
    }

    function getLegacyFavorites(key) {
      try {
        var parsed = JSON.parse(window.localStorage.getItem(key) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    function setLegacyFavorites(favorites) {
      try {
        window.localStorage.setItem(state.legacyFavoritesKey, JSON.stringify(favorites || {}));
      } catch (error) {}
    }

    function getFavoritePlaceId(item) {
      if (!item) return '';
      var ref = item.contentRef || {};
      var refListId = String(ref.restaurantListId || '');
      if (refListId && refListId !== state.listId) return '';
      if (ref.placeId) return String(ref.placeId);

      var targetId = String(item.targetId || '');
      var prefix = state.listId + ':';
      if (targetId.indexOf(prefix) === 0) {
        return targetId.slice(prefix.length);
      }
      return '';
    }

    function getFavorites() {
      if (state.favoritesClient && state.customerId) {
        var accountFavorites = {};
        state.favoritesClient.getActiveItems('PURPLEMAP_PLACE').forEach(function (item) {
          var placeId = getFavoritePlaceId(item);
          if (placeId) accountFavorites[placeId] = true;
        });
        return accountFavorites;
      }
      return getLegacyFavorites(state.legacyFavoritesKey);
    }

    function isFavorite(itemId, favorites) {
      var source = favorites || getFavorites();
      return Boolean(source[itemId]);
    }

    function buildPurpleMapFavoriteChange(itemId, action) {
      var item = findRestaurantById(itemId);
      return {
        type: 'PURPLEMAP_PLACE',
        targetId: state.listId + ':' + itemId,
        action: action,
        display: {
          name: item && item.name ? item.name : itemId
        },
        contentRef: {
          restaurantListId: state.listId,
          placeId: itemId
        }
      };
    }

    function toggleFavorite(itemId) {
      if (!itemId) return;

      if (state.favoritesClient && state.customerId) {
        state.favoritesClient.toggle(buildPurpleMapFavoriteChange(itemId));
      } else {
        var favorites = getFavorites();
        if (favorites[itemId]) {
          delete favorites[itemId];
        } else {
          favorites[itemId] = true;
        }
        setLegacyFavorites(favorites);
      }

      state.page = 1;
      if (state.favoriteOnly && !isFavorite(itemId) && state.selectedId === itemId) {
        state.selectedId = null;
      }
      renderAll();
    }

    function migrateLegacyPurpleMapFavorites() {
      if (!state.favoritesClient || !state.customerId || !state.listId) return;

      var migration = state.favoritesClient.getMigrationState();
      var migratedLists = migration.purpleMapLists && typeof migration.purpleMapLists === 'object'
        ? migration.purpleMapLists
        : {};
      if (migratedLists[state.listId]) return;

      var keys = [state.legacyFavoritesKey, 'tm-favorites:guest:' + state.listId];
      var seenKeys = {};
      var seenTargets = {};
      var changes = [];

      keys.forEach(function (key) {
        if (!key || seenKeys[key]) return;
        seenKeys[key] = true;
        var legacyFavorites = getLegacyFavorites(key);
        Object.keys(legacyFavorites).forEach(function (placeId) {
          if (!legacyFavorites[placeId]) return;
          var change = buildPurpleMapFavoriteChange(placeId, 'ADD');
          if (seenTargets[change.targetId]) return;
          seenTargets[change.targetId] = true;
          changes.push(change);
        });
      });

      if (changes.length) {
        state.favoritesClient.queueChanges(changes);
      }

      migratedLists[state.listId] = new Date().toISOString();
      migration.purpleMapLists = migratedLists;
      state.favoritesClient.setMigrationState(migration);
    }

    function favoriteIconSvg(active) {
      return (
        '<svg class="tm-favorite-btn__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" ' +
        'fill="' +
        (active ? 'currentColor' : 'none') +
        '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>'
      );
    }

    function updateFavoriteFilterToggle() {
      if (!favoriteFilterButton) return;

      favoriteFilterButton.classList.toggle('is-active', state.favoriteOnly);
      favoriteFilterButton.setAttribute('aria-pressed', state.favoriteOnly ? 'true' : 'false');
      favoriteFilterButton.textContent = 'Favorites only';
    }

    function baseFilteredItems() {
      var selectedCategory = findOptionByValue(state.options.categories, state.category);
      var favorites = state.favoriteOnly ? getFavorites() : null;

      return state.items.filter(function (item) {
        if (state.favoriteOnly && !isFavorite(item.id, favorites)) return false;
        if (state.category && !matchesOptionLabel(selectedCategory, item.category)) return false;
        return true;
      });
    }

    function currentFilteredItems() {
      var items = baseFilteredItems();

      if (!state.favoriteOnly && state.map.searchBounds) {
        items = items.filter(function (item) {
          return itemIsInsideBounds(item, state.map.searchBounds);
        });
      }

      return sortFilteredItems(items);
    }

    function ensureSelectedItemVisible(items) {
      if (!state.selectedId) return;
      var exists = items.some(function (item) {
        return item.id === state.selectedId;
      });
      if (!exists) {
        state.selectedId = null;
      }
    }

    function setMapPlaceholder(message, visible) {
      if (!mapPlaceholder) return;
      if (mapPlaceholderText) {
        mapPlaceholderText.textContent = message || '';
      }
      mapPlaceholder.hidden = !visible;
      if (mapCanvas) {
        mapCanvas.classList.toggle('is-hidden', visible);
      }
    }

    function setLocationStatus(message, persist) {
      if (!locationStatus) return;

      if (state.location.statusTimer) {
        window.clearTimeout(state.location.statusTimer);
        state.location.statusTimer = null;
      }

      var text = String(message || '').trim();
      locationStatus.textContent = text;
      locationStatus.hidden = !text;

      if (text && !persist) {
        state.location.statusTimer = window.setTimeout(function () {
          locationStatus.hidden = true;
          locationStatus.textContent = '';
          state.location.statusTimer = null;
        }, LOCATION_STATUS_HIDE_MS);
      }
    }

    function resolveInitialLocation(center, message) {
      if (state.location.initialResolved) return;
      state.location.center = center || SEOUL_JUNG_GU_CENTER;
      state.location.initialResolved = true;
      setLocationStatus(message);
      renderAll();
    }

    function requestInitialLocation() {
      resolveInitialLocation(SEOUL_JUNG_GU_CENTER, messages.locationDefault);
    }

    function moveMapToCenter(center) {
      if (!state.map.instance || !state.map.api || !center) return false;

      state.map.instance.setLevel(DEFAULT_MAP_LEVEL);
      state.map.instance.setCenter(new state.map.api.maps.LatLng(center.lat, center.lng));
      state.map.instance.relayout();
      captureSearchBoundsFromMap();
      state.page = 1;
      state.selectedId = null;
      renderAll();
      return true;
    }

    function findRestaurantById(id) {
      return (
        state.items.find(function (item) {
          return item.id === id;
        }) || null
      );
    }

    function setPhotoPlaceholderState(frame, image, placeholder, isPlaceholder) {
      if (frame) {
        frame.classList.toggle('is-placeholder', !!isPlaceholder);
        if (frame.tagName === 'BUTTON') {
          frame.disabled = !!isPlaceholder;
        }
      }
      if (image) {
        image.hidden = !!isPlaceholder;
      }
      if (placeholder) {
        placeholder.hidden = !isPlaceholder;
      }
    }

    function handleRestaurantPhotoError(image) {
      if (!image || image.getAttribute('data-tm-photo-failed') === '1') return;

      image.setAttribute('data-tm-photo-failed', '1');
      var frame = image.closest('[data-tm-photo-frame]');
      var placeholder = frame ? $('[data-tm-photo-placeholder]', frame) : null;
      setPhotoPlaceholderState(frame, image, placeholder, true);
      image.removeAttribute('src');

      if (!state.photoErrorRefreshAttempted && image.getAttribute('data-tm-photo-source')) {
        state.photoErrorRefreshAttempted = true;
        fetchRestaurants(true);
      }
    }

    function focusWithoutScroll(element) {
      if (!element || typeof element.focus !== 'function') return;
      try {
        element.focus({ preventScroll: true });
      } catch (error) {
        element.focus();
      }
    }

    function ensurePhotoModal() {
      if (photoModal) return photoModal;

      photoModal = document.createElement('div');
      photoModal.className = 'tm-photo-modal';
      photoModal.setAttribute('data-tm-photo-modal', '');
      photoModal.hidden = true;
      photoModal.innerHTML =
        '<div class="tm-photo-modal__backdrop" data-tm-photo-backdrop></div>' +
        '<section class="tm-photo-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="tm-photo-modal-title">' +
        '<div class="tm-photo-modal__header">' +
        '<p class="tm-photo-modal__title" id="tm-photo-modal-title" data-tm-photo-title></p>' +
        '<button type="button" class="tm-photo-modal__close" data-tm-photo-close aria-label="Close photo preview">&times;</button>' +
        '</div>' +
        '<div class="tm-photo-modal__frame" data-tm-photo-frame>' +
        '<img class="tm-photo-modal__image" data-tm-photo-img alt="" width="1080" height="1080" decoding="async">' +
        buildPhotoPlaceholderHtml('tm-photo-modal__placeholder', true) +
        '</div>' +
        '</section>';

      document.body.appendChild(photoModal);
      photoModalTitle = $('[data-tm-photo-title]', photoModal);
      photoModalImage = $('[data-tm-photo-img]', photoModal);
      photoModalFrame = $('[data-tm-photo-frame]', photoModal);
      photoModalPlaceholder = $('[data-tm-photo-placeholder]', photoModal);
      photoModalClose = $('[data-tm-photo-close]', photoModal);

      if (photoModalImage) {
        photoModalImage.addEventListener('error', function () {
          handleRestaurantPhotoError(photoModalImage);
        });
      }
      if (photoModalClose) {
        photoModalClose.addEventListener('click', closePhotoPreview);
      }
      photoModal.addEventListener('click', function (event) {
        if (event.target && event.target.getAttribute('data-tm-photo-backdrop') !== null) {
          closePhotoPreview();
        }
      });

      return photoModal;
    }

    function closePhotoPreview() {
      if (!photoModal) return;

      photoModal.hidden = true;
      document.documentElement.classList.remove('tm-photo-modal-open');
      if (photoModalImage) {
        photoModalImage.removeAttribute('src');
      }
      focusWithoutScroll(lastPhotoFocus);
      lastPhotoFocus = null;
    }

    function openPhotoPreview(item, trigger) {
      var imageUrl = getRestaurantDetailImageUrl(item);
      if (!imageUrl) return;

      ensurePhotoModal();
      lastPhotoFocus = trigger || document.activeElement;

      if (photoModalTitle) {
        photoModalTitle.textContent = item.name;
      }
      if (photoModalImage) {
        photoModalImage.removeAttribute('data-tm-photo-failed');
        photoModalImage.setAttribute('data-tm-photo-source', imageUrl);
        photoModalImage.alt = item.name + ' photo';
        photoModalImage.src = imageUrl;
      }
      setPhotoPlaceholderState(photoModalFrame, photoModalImage, photoModalPlaceholder, false);

      photoModal.hidden = false;
      document.documentElement.classList.add('tm-photo-modal-open');
      focusWithoutScroll(photoModalClose);
    }

    function openPhotoPreviewById(itemId, trigger) {
      var item = findRestaurantById(itemId);
      if (!item) return;
      openPhotoPreview(item, trigger);
    }

    function bindRestaurantPhotoHandlers(container) {
      if (!container) return;

      $all('[data-tm-photo-img]', container).forEach(function (image) {
        image.addEventListener('error', function () {
          handleRestaurantPhotoError(image);
        });
      });

      $all('[data-tm-photo-viewer]', container).forEach(function (element) {
        element.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          openPhotoPreviewById(element.getAttribute('data-tm-photo-viewer'), element);
        });
      });
    }

    function createPhotoPlaceholderElement(className, hidden) {
      var placeholder = document.createElement('span');
      placeholder.className = className;
      placeholder.setAttribute('data-tm-photo-placeholder', '');
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.innerHTML = photoPlaceholderSvg();
      placeholder.hidden = !!hidden;
      return placeholder;
    }

    function createRestaurantPhotoImage(item, imageUrl, className, size) {
      var image = document.createElement('img');
      image.className = className;
      image.alt = item.name + ' photo';
      image.width = size;
      image.height = size;
      image.decoding = 'async';
      image.loading = 'lazy';
      image.setAttribute('data-tm-photo-img', '');
      image.setAttribute('data-tm-photo-source', imageUrl);
      image.addEventListener('error', function () {
        handleRestaurantPhotoError(image);
      });
      image.src = imageUrl;
      return image;
    }

    function clearMapMarkers() {
      closeHoverPlace(false);
      if (state.map.clusterer) {
        state.map.clusterer.clear();
        state.map.clusterer = null;
      }
      state.map.markers.forEach(function (marker) {
        marker.setMap(null);
      });
      state.map.markers = [];
      if (state.map.infoWindow) {
        state.map.infoWindow.close();
      }
    }

    function resetProtectedRestaurantState() {
      state.items = [];
      state.options = { areas: [], categories: [] };
      state.category = '';
      state.pendingCategory = '';
      state.favoriteOnly = false;
      state.page = 1;
      state.selectedId = null;
      state.pendingScrollToSelected = false;
      state.photoErrorRefreshAttempted = false;

      if (categorySelect) {
        categorySelect.value = '';
      }

      closePhotoPreview();
      clearMapMarkers();
    }

    function cancelHoverClose() {
      window.clearTimeout(state.map.hoverCloseTimer);
      state.map.hoverCloseTimer = null;
    }

    function closeHoverPlace(restoreSelection) {
      cancelHoverClose();
      var wasOpen = !!state.map.hoverId;
      state.map.hoverId = null;
      state.map.hoverContent = null;
      if (state.map.hoverInfoWindow) state.map.hoverInfoWindow.close();
      if (wasOpen && restoreSelection && state.selectedId && state.map.infoWindow) {
        var marker = state.map.markers.find(function (candidate) {
          return candidate.tmRestaurantId === state.selectedId;
        });
        if (marker) state.map.infoWindow.open(state.map.instance, marker);
      }
      return wasOpen;
    }

    function scheduleHoverClose(id) {
      if (state.map.hoverId !== id) return;
      cancelHoverClose();
      state.map.hoverCloseTimer = window.setTimeout(function () {
        if (state.map.hoverContent && state.map.hoverContent.contains(document.activeElement)) return;
        closeHoverPlace(true);
      }, 300);
    }

    function showHoverPlace(item, marker) {
      if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      if (!state.map.hoverInfoWindow) return;
      cancelHoverClose();
      if (state.selectedId === item.id) {
        closeHoverPlace(true);
        return;
      }
      if (state.map.hoverId === item.id) return;
      state.map.hoverId = item.id;
      state.map.hoverContent = buildMapInfoContent(item, { hover: true });
      state.map.infoWindow.close();
      state.map.hoverInfoWindow.setContent(state.map.hoverContent);
      state.map.hoverInfoWindow.open(state.map.instance, marker);
    }

    function buildMapInfoContent(item, options) {
      var isHover = options && options.hover;
      var imageUrl = getRestaurantListImageUrl(item);
      var detailImageUrl = getRestaurantDetailImageUrl(item);
      var detailUrl = buildMapDetailUrl(item, !!state.naverClientId);
      var directionsUrl = buildMapDirectionsUrl(item, !!state.naverClientId);
      var badge = buildBadge(item);
      var tags = buildTagList(item);
      var favoriteActive = isFavorite(item.id);
      var favoriteLabel = favoriteActive ? 'Remove from favorites' : 'Add to favorites';
      var content = document.createElement('div');
      var layout = document.createElement('div');
      var media = document.createElement(detailImageUrl ? 'button' : 'span');
      var body = document.createElement('div');
      var head = document.createElement('div');
      var title = document.createElement('p');
      var meta = document.createElement('p');
      var badgeText = document.createElement('p');
      var favoriteButton = document.createElement('button');
      var tagsEl = document.createElement('div');
      var snippet = document.createElement('p');
      var actions = document.createElement('div');
      var closeButton = document.createElement('button');
      var placeholder = createPhotoPlaceholderElement('tm-mapinfo__photo-placeholder', !!imageUrl);

      content.className = 'tm-mapinfo' + (state.naverClientId ? ' tm-mapinfo--naver' : '');
      if (isHover) {
        content.setAttribute('data-tm-hover-preview', item.id);
        content.addEventListener('mouseenter', cancelHoverClose);
        content.addEventListener('mouseleave', function () { scheduleHoverClose(item.id); });
        content.addEventListener('focusin', cancelHoverClose);
        content.addEventListener('focusout', function () { scheduleHoverClose(item.id); });
      }
      layout.className = 'tm-mapinfo__layout';
      media.className = 'tm-mapinfo__media' + (imageUrl ? '' : ' is-placeholder');
      media.setAttribute('data-tm-photo-frame', '');
      body.className = 'tm-mapinfo__body';
      head.className = 'tm-mapinfo__head';
      title.className = 'tm-mapinfo__title';
      meta.className = 'tm-mapinfo__meta';
      badgeText.className = 'tm-mapinfo__badge';
      favoriteButton.className = 'tm-favorite-btn' + (favoriteActive ? ' is-active' : '');
      favoriteButton.type = 'button';
      favoriteButton.setAttribute('aria-label', favoriteLabel);
      favoriteButton.setAttribute('aria-pressed', favoriteActive ? 'true' : 'false');
      favoriteButton.setAttribute('title', favoriteLabel);
      favoriteButton.innerHTML = favoriteIconSvg(favoriteActive);
      tagsEl.className = 'tm-tags tm-mapinfo__tags';
      snippet.className = 'tm-snippet tm-mapinfo__snippet';
      actions.className = 'tm-card__actions tm-mapinfo__actions';
      closeButton.className = 'tm-mapinfo__close';
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', 'Close place information');
      closeButton.setAttribute('title', 'Close');
      closeButton.innerHTML = '&times;';

      title.textContent = item.name;
      meta.textContent = buildMetaText(item) || item.address || item.category || 'Restaurant';
      badgeText.textContent = badge.label;

      favoriteButton.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(item.id);
      });

      closeButton.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (isHover) {
          closeHoverPlace(true);
          restorePlaceCardFocus(item.id);
          return;
        }
        closeSelectedPlace({ restoreFocus: true });
      });

      if (detailImageUrl) {
        media.type = 'button';
        media.setAttribute('data-tm-photo-viewer', item.id);
        media.setAttribute('aria-label', 'View photo of ' + item.name);
        media.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          openPhotoPreview(item, media);
        });
      }

      if (imageUrl) {
        media.appendChild(createRestaurantPhotoImage(item, imageUrl, 'tm-mapinfo__image', 512));
      }
      media.appendChild(placeholder);
      head.appendChild(title);
      head.appendChild(favoriteButton);
      body.appendChild(head);
      body.appendChild(meta);
      body.appendChild(badgeText);
      if (tags.length) {
        tags.forEach(function (tag) {
          var tagEl = document.createElement('span');
          tagEl.className = 'tm-tag';
          tagEl.textContent = tag;
          tagsEl.appendChild(tagEl);
        });
        body.appendChild(tagsEl);
      }
      if (item.memo || item.dietary.notes) {
        snippet.textContent = item.memo || item.dietary.notes;
        body.appendChild(snippet);
      }
      if (detailUrl) {
        var detailsLink = document.createElement('a');
        detailsLink.className = 'tm-card__directions';
        detailsLink.href = detailUrl;
        detailsLink.target = '_blank';
        detailsLink.rel = 'noopener noreferrer';
        detailsLink.textContent = 'Details ↗';
        actions.appendChild(detailsLink);
      }
      if (directionsUrl) {
        var directionsLink = document.createElement('a');
        directionsLink.className = 'tm-card__directions tm-card__directions--secondary';
        directionsLink.href = directionsUrl;
        directionsLink.target = '_blank';
        directionsLink.rel = 'noopener noreferrer';
        directionsLink.textContent = 'Directions ↗';
        actions.appendChild(directionsLink);
      }
      if (actions.childNodes.length) {
        body.appendChild(actions);
      }
      layout.appendChild(media);
      layout.appendChild(body);
      content.appendChild(closeButton);
      content.appendChild(layout);

      return content;
    }

    function paginate(items) {
      var totalPages = items.length ? Math.ceil(items.length / PAGE_SIZE) : 0;
      if (!totalPages) {
        return { slice: [], totalPages: 0 };
      }

      if (state.page > totalPages) {
        state.page = totalPages;
      }
      if (state.page < 1) {
        state.page = 1;
      }

      var start = (state.page - 1) * PAGE_SIZE;
      return {
        slice: items.slice(start, start + PAGE_SIZE),
        totalPages: totalPages
      };
    }

    function populateSelectOptions(selectEl, placeholder, values, preferredValue) {
      if (!selectEl) return '';

      var html = ['<option value="">' + escapeHtml(placeholder) + '</option>'];
      (values || []).forEach(function (option) {
        html.push('<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.name) + '</option>');
      });
      selectEl.innerHTML = html.join('');

      var resolvedValue = resolveOptionValue(values, preferredValue);
      if (resolvedValue && optionExists(selectEl, resolvedValue)) {
        selectEl.value = resolvedValue;
        return resolvedValue;
      }

      selectEl.value = '';
      return '';
    }

    function renderFilterChips() {
      if (!filtersWrap || !filtersEl) return;

      var selectedCategory = findOptionByValue(state.options.categories, state.category);
      var hasAppliedSelectFilter = !!state.category;
      var shouldShowWrap = hasAppliedSelectFilter;

      if (!shouldShowWrap) {
        filtersEl.innerHTML = '';
        filtersWrap.setAttribute('hidden', '');
        return;
      }

      filtersWrap.removeAttribute('hidden');
      var appliedHtml = '';
      if (state.category) {
        appliedHtml +=
          '<span class="tm-chip is-active tm-chip--applied">' +
          escapeHtml(selectedCategory ? selectedCategory.name : state.category) +
          '</span>';
      }

      var clearHtml = hasAppliedSelectFilter
        ? '<button type="button" class="tm-chip tm-chip--clear" data-tm-clear-filters>Clear</button>'
        : '';
      filtersEl.innerHTML = appliedHtml + clearHtml;

      var clearButton = $('[data-tm-clear-filters]', filtersEl);
      if (clearButton) {
        clearButton.addEventListener('click', function () {
          state.category = '';
          state.pendingCategory = '';
          if (categorySelect) categorySelect.value = '';
          state.page = 1;
          state.selectedId = null;
          renderAll();
        });
      }
    }

    function syncFilterControls() {
      var desiredCategory = state.category || state.pendingCategory;

      state.category = populateSelectOptions(categorySelect, categoryPlaceholder, state.options.categories, desiredCategory);

      if (state.category === state.pendingCategory) {
        state.pendingCategory = '';
      }

      renderFilterChips();
    }

    function renderPagination(totalPages, totalItems) {
      if (!paginationEl) return;

      if (!totalItems || totalPages <= 1) {
        paginationEl.innerHTML = '';
        paginationEl.setAttribute('hidden', '');
        return;
      }

      paginationEl.removeAttribute('hidden');

      var prevDisabled = state.page <= 1 ? ' disabled' : '';
      var nextDisabled = state.page >= totalPages ? ' disabled' : '';
      var buttons = [];

      for (var page = 1; page <= totalPages; page++) {
        buttons.push(
          '<button type="button" class="tm-page-btn' +
            (page === state.page ? ' is-current' : '') +
            '" data-tm-page="' +
            page +
            '">' +
            page +
            '</button>'
        );
      }

      paginationEl.innerHTML =
        '<button type="button" class="tm-page-btn" data-tm-prev' +
        prevDisabled +
        ' aria-label="Previous">&lt;</button>' +
        buttons.join('') +
        '<button type="button" class="tm-page-btn" data-tm-next' +
        nextDisabled +
        ' aria-label="Next">&gt;</button>';

      var prev = $('[data-tm-prev]', paginationEl);
      var next = $('[data-tm-next]', paginationEl);

      if (prev && !prev.disabled) {
        prev.addEventListener('click', function () {
          state.page -= 1;
          renderList();
        });
      }

      if (next && !next.disabled) {
        next.addEventListener('click', function () {
          state.page += 1;
          renderList();
        });
      }

      $all('[data-tm-page]', paginationEl).forEach(function (button) {
        button.addEventListener('click', function () {
          state.page = parseInt(button.getAttribute('data-tm-page'), 10) || 1;
          renderList();
        });
      });
    }

    function renderList() {
      if (!listEl) return;

      if (selectHint) {
        selectHint.hidden = true;
      }

      if (state.status === 'loading') {
        listEl.innerHTML =
          '<div class="tm-empty"><p class="tm-empty__message">' +
          escapeHtml(messages.loading) +
          '</p></div>';
        renderPagination(0, 0);
        return;
      }

      if (state.status === 'error') {
        listEl.innerHTML =
          '<div class="tm-empty">' +
          '<p class="tm-empty__message">' +
          escapeHtml(state.error || messages.error) +
          '</p>' +
          '<button type="button" class="tm-page-btn tm-empty__action" data-tm-retry>' +
          escapeHtml(messages.retry) +
          '</button>' +
          '</div>';
        renderPagination(0, 0);

        var retryButton = $('[data-tm-retry]', listEl);
        if (retryButton) {
          retryButton.addEventListener('click', function () {
            fetchRestaurants(true);
          });
        }
        return;
      }

      if (!state.listId) {
        listEl.innerHTML =
          '<div class="tm-empty"><p class="tm-empty__message">' +
          escapeHtml(messages.missingListId) +
          '</p></div>';
        renderPagination(0, 0);
        return;
      }

      if (!state.location.initialResolved || ((state.naverClientId || state.kakaoAppKey) && !state.map.searchBounds && !state.map.loadFailed)) {
        listEl.innerHTML =
          '<div class="tm-empty"><p class="tm-empty__message">' +
          escapeHtml(messages.loading) +
          '</p></div>';
        renderPagination(0, 0);
        return;
      }

      var filteredItems = currentFilteredItems();
      ensureSelectedItemVisible(filteredItems);

      var paged = paginate(filteredItems);
      if (!paged.slice.length) {
        var emptyMessage = state.favoriteOnly ? messages.favoriteEmpty : messages.promptNone;
        listEl.innerHTML =
          '<div class="tm-empty"><p class="tm-empty__message">' +
          escapeHtml(emptyMessage) +
          '</p></div>';
        renderPagination(0, 0);
        return;
      }

      var favoritesForRender = getFavorites();
      listEl.innerHTML = paged.slice
        .map(function (item) {
          var badge = buildBadge(item);
          var tags = buildTagList(item);
          var detailUrl = buildMapDetailUrl(item, !!state.naverClientId);
          var directionsUrl = buildMapDirectionsUrl(item, !!state.naverClientId);
          var favoriteActive = isFavorite(item.id, favoritesForRender);
          var favoriteLabel = favoriteActive ? 'Remove from favorites' : 'Add to favorites';
          var listImageUrl = getRestaurantListImageUrl(item);
          var detailImageUrl = getRestaurantDetailImageUrl(item);
          var photoAlt = item.name + ' photo';
          var mediaOpen = detailImageUrl
            ? '<button type="button" class="tm-card__media' +
              (listImageUrl ? '' : ' is-placeholder') +
              '" data-tm-photo-frame data-tm-photo-viewer="' +
              escapeHtml(item.id) +
              '" aria-label="View photo of ' +
              escapeHtml(item.name) +
              '">'
            : '<div class="tm-card__media is-placeholder" data-tm-photo-frame>';
          var mediaHtml =
            mediaOpen +
            (listImageUrl
              ? '<img class="tm-card__image" data-tm-photo-img data-tm-photo-source="' +
                escapeHtml(listImageUrl) +
                '" src="' +
                escapeHtml(listImageUrl) +
                '" alt="' +
                escapeHtml(photoAlt) +
                '" width="512" height="512" loading="lazy" decoding="async">'
              : '') +
            buildPhotoPlaceholderHtml('tm-card__photo-placeholder', !!listImageUrl) +
            (detailImageUrl ? '</button>' : '</div>');
          var favoriteButtonHtml =
            '<button type="button" class="tm-favorite-btn' +
            (favoriteActive ? ' is-active' : '') +
            '" data-tm-favorite="' +
            escapeHtml(item.id) +
            '" aria-label="' +
            favoriteLabel +
            '" aria-pressed="' +
            (favoriteActive ? 'true' : 'false') +
            '" title="' +
            favoriteLabel +
            '">' +
            favoriteIconSvg(favoriteActive) +
            '</button>';
          var tagsHtml = tags.length
            ? '<div class="tm-tags" aria-hidden="true">' +
              tags
                .map(function (tag) {
                  return '<span class="tm-tag">' + escapeHtml(tag) + '</span>';
                })
                .join('') +
              '</div>'
            : '';
          var actionLinks = [];
          if (detailUrl) {
            actionLinks.push(
              '<a class="tm-card__directions" data-tm-card-action data-tm-details href="' +
                escapeHtml(detailUrl) +
                '" target="_blank" rel="noopener noreferrer">' +
                'Details <span aria-hidden="true">↗</span>' +
              '</a>'
            );
          }
          if (directionsUrl) {
            actionLinks.push(
              '<a class="tm-card__directions tm-card__directions--secondary" data-tm-card-action data-tm-directions href="' +
                escapeHtml(directionsUrl) +
                '" target="_blank" rel="noopener noreferrer">' +
                'Directions <span aria-hidden="true">↗</span>' +
              '</a>'
            );
          }
          var actionsHtml = actionLinks.length
            ? '<div class="tm-card__actions">' + actionLinks.join('') + '</div>'
            : '';
          var snippetText = item.memo || item.dietary.notes || '';
          var snippetHtml = snippetText
            ? '<p class="tm-snippet">' + escapeHtml(snippetText) + '</p>'
            : '';

          return (
            '<article class="tm-card' +
            (item.id === state.selectedId ? ' is-selected' : '') +
            '" data-tm-card="' +
            escapeHtml(item.id) +
            '" role="button" aria-pressed="' + (item.id === state.selectedId ? 'true' : 'false') + '" tabindex="0">' +
            mediaHtml +
            '<div class="tm-card__body">' +
            '<div class="tm-card__head">' +
            '<p class="tm-card__name">' +
            escapeHtml(item.name) +
            '</p>' +
            favoriteButtonHtml +
            '</div>' +
            '<p class="tm-card__meta">' +
            escapeHtml(buildMetaText(item) || 'Restaurant') +
            '</p>' +
            '<div class="tm-card__row">' +
            '<span class="tm-badge' +
            badge.className +
            '">' +
            escapeHtml(badge.label) +
            '</span>' +
            '</div>' +
            tagsHtml +
            snippetHtml +
            actionsHtml +
            '</div>' +
            '</article>'
          );
        })
        .join('');

      bindRestaurantPhotoHandlers(listEl);

      $all('[data-tm-card]', listEl).forEach(function (element) {
        element.addEventListener('click', function () {
          selectRestaurant(element.getAttribute('data-tm-card'));
        });

        element.addEventListener('keydown', function (event) {
          if (event.target && event.target.closest('a, button, input, select, textarea')) {
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            element.click();
          }
        });
      });

      $all('[data-tm-favorite]', listEl).forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          toggleFavorite(button.getAttribute('data-tm-favorite'));
        });
      });

      $all('[data-tm-card-action]', listEl).forEach(function (element) {
        element.addEventListener('click', function (event) {
          event.stopPropagation();
        });
      });

      if (state.pendingScrollToSelected && state.selectedId) {
        var selectedCard = $all('[data-tm-card]', listEl).find(function (element) {
          return element.getAttribute('data-tm-card') === state.selectedId;
        });

        if (selectedCard) {
          var scrollIntoViewCard = function () {
            selectedCard.scrollIntoView({
              block: 'nearest',
              inline: 'nearest',
              behavior: 'smooth'
            });
          };

          if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(scrollIntoViewCard);
          } else {
            scrollIntoViewCard();
          }
        }

        state.pendingScrollToSelected = false;
      }

      renderPagination(paged.totalPages, filteredItems.length);
    }

    function renderMap() {
      if (!mapCanvas || !mapPlaceholder) return;

      if (state.status === 'loading') {
        setSearchAreaVisible(false);
        setMapPlaceholder(messages.mapLoading, true);
        return;
      }

      if (state.status === 'error') {
        setSearchAreaVisible(false);
        setMapPlaceholder(state.error || messages.mapError, true);
        clearMapMarkers();
        return;
      }

      if (!state.listId) {
        setSearchAreaVisible(false);
        setMapPlaceholder(messages.missingListId, true);
        clearMapMarkers();
        return;
      }

      if (!state.naverClientId && !state.kakaoAppKey) {
        setSearchAreaVisible(false);
        setMapPlaceholder(messages.mapKeyMissing, true);
        clearMapMarkers();
        return;
      }

      if (!state.location.initialResolved) {
        setSearchAreaVisible(false);
        setMapPlaceholder(messages.mapLoading, true);
        clearMapMarkers();
        return;
      }

      var renderToken = ++state.map.renderToken;
      if (!state.map.instance) {
        setMapPlaceholder(messages.mapLoading, true);
      }

      (state.naverClientId
        ? window.KPSNaverMaps.load(state.naverClientId)
        : ensureKakaoLoaded(state.kakaoAppKey))
        .then(function (kakao) {
          if (renderToken !== state.map.renderToken) return;
          state.map.api = kakao;
          state.map.loadFailed = false;

          if (!state.map.instance) {
            var initialCenter = state.location.center || SEOUL_JUNG_GU_CENTER;
            state.map.instance = new kakao.maps.Map(mapCanvas, {
              center: new kakao.maps.LatLng(initialCenter.lat, initialCenter.lng),
              level: DEFAULT_MAP_LEVEL
            });
            state.map.infoWindow = new kakao.maps.InfoWindow({ zIndex: 1000 });
            state.map.hoverInfoWindow = new kakao.maps.InfoWindow({ zIndex: 1001, disableAutoPan: true });
            kakao.maps.event.addListener(state.map.instance, 'idle', function () {
              closeHoverPlace(true);
              updateSearchAreaButton();
            });
            kakao.maps.event.addListener(state.map.instance, 'click', function () {
              closeSelectedPlace();
            });
          }

          setMapPlaceholder('', false);
          state.map.instance.relayout();

          if (!state.map.searchBounds) {
            captureSearchBoundsFromMap();
            renderList();
          }

          var filteredItems = currentFilteredItems();
          ensureSelectedItemVisible(filteredItems);
          clearMapMarkers();

          var selectedItem = null;
          var selectedMarker = null;
          var clusterableMarkers = [];

          filteredItems.forEach(function (item) {
            if (!isFiniteNumber(item.lat) || !isFiniteNumber(item.lng)) return;

            var isSelected = item.id === state.selectedId;
            var markerOptions = {
              position: new kakao.maps.LatLng(item.lat, item.lng),
              title: item.name,
              image: getMapMarkerImage(kakao, root, item.category, isSelected)
            };

            if (isSelected) {
              markerOptions.map = state.map.instance;
              markerOptions.zIndex = 999;
            }

            var marker = new kakao.maps.Marker(markerOptions);
            marker.tmRestaurantId = item.id;

            state.map.markers.push(marker);

            kakao.maps.event.addListener(marker, 'click', function () {
              selectRestaurant(item.id, { scrollList: true, source: 'map' });
            });
            kakao.maps.event.addListener(marker, 'mouseover', function () {
              showHoverPlace(item, marker);
            });
            kakao.maps.event.addListener(marker, 'mouseout', function () {
              scheduleHoverClose(item.id);
            });

            if (item.id === state.selectedId) {
              selectedItem = item;
              selectedMarker = marker;
            } else {
              clusterableMarkers.push(marker);
            }
          });

          if (clusterableMarkers.length && kakao.maps.MarkerClusterer) {
            state.map.clusterer = new kakao.maps.MarkerClusterer({
              map: state.map.instance,
              averageCenter: true,
              minLevel: 6,
              disableClickZoom: false,
              styles: [
                {
                  width: '38px',
                  height: '38px',
                  background: '#5B2BD8',
                  border: '3px solid #ffffff',
                  borderRadius: '50%',
                  color: '#ffffff',
                  fontSize: '13px',
                  fontWeight: '800',
                  lineHeight: '32px',
                  textAlign: 'center',
                  boxShadow: '0 4px 12px rgba(76, 29, 149, .35)'
                }
              ]
            });
            state.map.clusterer.addMarkers(clusterableMarkers);
          } else {
            clusterableMarkers.forEach(function (marker) {
              marker.setMap(state.map.instance);
            });
          }

          if (selectedMarker && selectedItem) {
            state.map.infoWindow.setContent(buildMapInfoContent(selectedItem));
            state.map.infoWindow.open(state.map.instance, selectedMarker);
            return;
          }

          if (state.map.infoWindow) {
            state.map.infoWindow.close();
          }

          updateSearchAreaButton();
        })
        .catch(function () {
          if (renderToken !== state.map.renderToken) return;
          state.map.loadFailed = true;
          setSearchAreaVisible(false);
          clearMapMarkers();
          setMapPlaceholder(messages.mapError, true);
          renderList();
        });
    }

    function renderAll() {
      updateFavoriteFilterToggle();
      renderList();
      renderMap();
    }

    function jumpToList() {
      if (!listEl) return;
      var selectedCard = state.selectedId ? $('[data-tm-card="' + state.selectedId + '"]', listEl) : null;
      var target = selectedCard || listEl.querySelector('[data-tm-card]') || listEl;

      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }

    function resetMapView() {
      state.category = '';
      state.pendingCategory = '';
      state.favoriteOnly = false;
      state.selectedId = null;
      state.page = 1;
      state.map.searchBounds = null;

      if (categorySelect) {
        categorySelect.value = '';
      }

      if (state.map.instance && state.map.api) {
        state.map.instance.setCenter(new state.map.api.maps.LatLng(SEOUL_JUNG_GU_CENTER.lat, SEOUL_JUNG_GU_CENTER.lng));
        state.map.instance.setLevel(DEFAULT_MAP_LEVEL);
        state.map.instance.relayout();
      }

      renderAll();
    }

    function selectRestaurant(id, options) {
      var config = options || {};
      state.selectedId = id || null;
      if (config.scrollList) {
        state.pendingScrollToSelected = true;
      }

      var filteredItems = currentFilteredItems();
      var selectedIndex = filteredItems.findIndex(function (item) {
        return item.id === state.selectedId;
      });

      if (selectedIndex >= 0) {
        state.page = Math.floor(selectedIndex / PAGE_SIZE) + 1;
      }

      renderAll();
    }

    function restorePlaceCardFocus(itemId) {
      var selectedCard = $all('[data-tm-card]', listEl).find(function (element) {
        return element.getAttribute('data-tm-card') === itemId;
      });

      if (selectedCard && selectedCard.offsetParent !== null) {
        focusWithoutScroll(selectedCard);
        return;
      }

      if (mapCanvas) {
        mapCanvas.setAttribute('tabindex', '-1');
        focusWithoutScroll(mapCanvas);
      }
    }

    function closeSelectedPlace(options) {
      var config = options || {};
      var hadHover = closeHoverPlace(false);
      var selectedId = state.selectedId;
      if (!selectedId) return hadHover;

      state.selectedId = null;
      state.pendingScrollToSelected = false;

      if (state.map.infoWindow) {
        state.map.infoWindow.close();
      }

      renderList();

      if (config.restoreFocus) {
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(function () {
            restorePlaceCardFocus(selectedId);
          });
        } else {
          restorePlaceCardFocus(selectedId);
        }
      }

      return true;
    }

    async function fetchRestaurants(noCache) {
      if (!state.listId) {
        state.status = 'idle';
        state.error = null;
        renderAll();
        return;
      }

      state.status = 'loading';
      state.error = null;
      renderAll();

      try {
        var itemsUrl = buildScopedEndpoint(
          root,
          state.listId,
          'data-tm-list-endpoint-template',
          '/restaurant-lists/{id}/items'
        );
        var filtersUrl = buildScopedEndpoint(
          root,
          state.listId,
          'data-tm-filter-endpoint-template',
          '/restaurant-lists/{id}/filters'
        );

        if (noCache) {
          var cacheBust = '_ts=' + Date.now();
          itemsUrl += (itemsUrl.indexOf('?') === -1 ? '?' : '&') + cacheBust;
          filtersUrl += (filtersUrl.indexOf('?') === -1 ? '?' : '&') + cacheBust;
        }

        var results = await Promise.allSettled([fetchEnvelope(itemsUrl), fetchEnvelope(filtersUrl)]);
        var accessDeniedResult =
          results.find(function (result) {
            return result.status === 'rejected' && isAccessDeniedError(result.reason);
          }) || null;

        if (accessDeniedResult) {
          throw accessDeniedResult.reason;
        }

        if (results[0].status !== 'fulfilled') {
          throw results[0].reason;
        }

        state.items = extractRestaurants(results[0].value.data)
          .map(normalizeRestaurant)
          .filter(Boolean)
          .sort(compareRestaurants);

        if (results[1].status === 'fulfilled') {
          state.options = normalizeFilterOptions(results[1].value.data);
        } else {
          state.options = buildFallbackFilterOptions(state.items);
        }

        migrateLegacyPurpleMapFavorites();
        state.status = 'ready';
        syncFilterControls();
      } catch (error) {
        if (isAccessDeniedError(error)) {
          resetProtectedRestaurantState();
          state.status = 'error';
          state.error = messages.error;
        } else {
          state.status = 'error';
          state.error = error && error.message && error.message !== 'PARSE_ERROR' ? error.message : messages.error;
        }
      }

      renderAll();
    }

    function onSelectChange() {
      state.category = categorySelect ? categorySelect.value : '';
      state.page = 1;
      state.selectedId = null;
      renderAll();
    }

    if (filtersEl) {
      filtersEl.innerHTML = '';
    }
    if (filtersWrap) {
      filtersWrap.setAttribute('hidden', '');
    }
    if (mapPlaceholderTitle) {
      mapPlaceholderTitle.hidden = true;
    }
    $all('.tm-map__tabs', root).forEach(function (element) {
      element.remove();
    });

    if (state.favoritesClient && state.customerId) {
      state.favoritesClient.subscribe(function () {
        renderAll();
      });
      state.favoritesClient.hydrate({ type: 'PURPLEMAP_PLACE' });
    }

    if (categorySelect) {
      categorySelect.addEventListener('change', onSelectChange);
    }

    if (favoriteFilterButton) {
      favoriteFilterButton.addEventListener('click', function () {
        state.favoriteOnly = !state.favoriteOnly;
        state.page = 1;
        state.selectedId = null;
        renderAll();
      });
    }

    if (searchAreaButton) {
      searchAreaButton.addEventListener('click', function () {
        if (captureSearchBoundsFromMap()) {
          state.page = 1;
          state.selectedId = null;
          renderAll();
        }
      });
    }

    if (listJumpButton) {
      listJumpButton.addEventListener('click', jumpToList);
    }

    if (resetMapButton) {
      resetMapButton.addEventListener('click', resetMapView);
    }

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;

      if (photoModal && !photoModal.hidden) {
        closePhotoPreview();
        return;
      }

      if (closeHoverPlace(true)) {
        event.preventDefault();
        return;
      }

      if (closeSelectedPlace({ restoreFocus: true })) {
        event.preventDefault();
      }
    });

    window.addEventListener('resize', function () {
      if (state.map.instance) {
        state.map.instance.relayout();
      }
    });

    initSidebarToggle(root);
    requestInitialLocation();
    fetchRestaurants(false);
  }

  function initSidebarToggle(wrap) {
    var collapseLabel = wrap.getAttribute('data-tm-label-collapse') || 'Hide list';
    var expandLabel = wrap.getAttribute('data-tm-label-expand') || 'Show list';

    function applySidebarCollapsed(collapsed) {
      wrap.classList.toggle('tm-sidebar-collapsed', collapsed);

      var sidebar = wrap.querySelector('.tm-sidebar');
      if (sidebar) {
        if (collapsed) {
          sidebar.setAttribute('aria-hidden', 'true');
        } else {
          sidebar.removeAttribute('aria-hidden');
        }
      }

      $all('[data-tm-sidebar-toggle]', wrap).forEach(function (button) {
        button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        button.setAttribute('title', collapsed ? expandLabel : collapseLabel);
      });

      var mobileCollapse = wrap.querySelector('.tm-sidebar-toggle__text--collapse');
      var mobileExpand = wrap.querySelector('.tm-sidebar-toggle__text--expand');
      if (mobileCollapse && mobileExpand) {
        mobileCollapse.hidden = collapsed;
        mobileExpand.hidden = !collapsed;
      }

      try {
        localStorage.setItem(TM_SIDEBAR_STORAGE, collapsed ? '1' : '0');
      } catch (error) {}

      window.dispatchEvent(new Event('resize'));
    }

    var saved = null;
    try {
      saved = localStorage.getItem(TM_SIDEBAR_STORAGE);
    } catch (error) {}

    if (saved === '1') {
      applySidebarCollapsed(true);
    }

    $all('[data-tm-sidebar-toggle]', wrap).forEach(function (button) {
      button.addEventListener('click', function () {
        var collapsed = !wrap.classList.contains('tm-sidebar-collapsed');
        applySidebarCollapsed(collapsed);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
