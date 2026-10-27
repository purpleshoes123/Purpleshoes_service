(function() {
  'use strict';

  var ROOT_SELECTOR = '[data-pv-root]';
  var REQUEST_TIMEOUT_MS = 15000;
  var JEJU_HIDDEN_CATEGORIES = ['Neighborhood Highlights & Markets', 'Neighborhood Highlights'];
  var PDF_ZOOM_DEFAULT = 100;
  var PDF_ZOOM_MIN = 50;
  var PDF_ZOOM_MAX = 200;
  var PDF_ZOOM_STEP = 25;
  var PREFETCH_START_DELAY_MS = 1500;
  var PREFETCH_INTERVAL_MS = 2500;
  var RATE_LIMIT_COOLDOWN_MS = 65000;
  var MAX_FOREGROUND_RATE_LIMIT_RETRY = 1;

  document.querySelectorAll(ROOT_SELECTOR).forEach(function(root) {
    initViewer(root);
  });

  function initTmSidebarToggle(root) {
    if (!root.classList || !root.classList.contains('tm-wrap')) return;
    var collapseLabel = root.getAttribute('data-tm-label-collapse') || 'Hide list';
    var expandLabel = root.getAttribute('data-tm-label-expand') || 'Show list';
    var STORAGE = 'pv-guide-viewer-sidebar-collapsed';

    function qsa(sel, ctx) {
      return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
    }

    function applySidebarCollapsed(collapsed) {
      root.classList.toggle('tm-sidebar-collapsed', collapsed);
      var sidebar = root.querySelector('.tm-sidebar');
      if (sidebar) {
        if (collapsed) {
          sidebar.setAttribute('aria-hidden', 'true');
        } else {
          sidebar.removeAttribute('aria-hidden');
        }
      }
      qsa('[data-tm-sidebar-toggle]', root).forEach(function (btn) {
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.setAttribute('title', collapsed ? expandLabel : collapseLabel);
      });
      var mobileCollapse = root.querySelector('.tm-sidebar-toggle__text--collapse');
      var mobileExpand = root.querySelector('.tm-sidebar-toggle__text--expand');
      if (mobileCollapse && mobileExpand) {
        mobileCollapse.hidden = collapsed;
        mobileExpand.hidden = !collapsed;
      }
      try {
        localStorage.setItem(STORAGE, collapsed ? '1' : '0');
      } catch (e) {}
      window.dispatchEvent(new Event('resize'));
    }

    var saved = null;
    try {
      saved = localStorage.getItem(STORAGE);
    } catch (e) {}
    if (saved === '1') {
      applySidebarCollapsed(true);
    }

    qsa('[data-tm-sidebar-toggle]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var collapsed = !root.classList.contains('tm-sidebar-collapsed');
        applySidebarCollapsed(collapsed);
      });
    });
  }

  function initViewer(root) {
    initTmSidebarToggle(root);

    var apiBase = trimTrailingSlash(root.getAttribute('data-api-base') || '/apps/bta-booking/mypage');
    var appBase = apiBase.replace(/\/mypage$/, '');

    var state = {
      root: root,
      apiBase: apiBase,
      appBase: appBase || apiBase,
      categoriesEndpoint: root.getAttribute('data-categories-endpoint') || '/categories',
      categoryViewerTemplate:
        root.getAttribute('data-category-viewer-template') || '/categories/{id}/viewer',
      customerId: (root.getAttribute('data-customer-id') || '').trim(),
      customerKey: (root.getAttribute('data-customer-gid') || root.getAttribute('data-customer-id') || '').trim(),
      loadingText: root.getAttribute('data-loading-text') || 'Loading your guide...',
      emptyGuidesText:
        root.getAttribute('data-empty-guides-text') ||
        'No active guide categories are available for this customer yet.',
      emptyStateText:
        root.getAttribute('data-empty-state-text') || 'Select a category from the left panel.',
      protectionNoticeText:
        root.getAttribute('data-protection-notice-text') ||
        'Protected guide. Download and print are intentionally limited on this page.',
      printBlockedText:
        root.getAttribute('data-print-blocked-text') ||
        'Printing is disabled on this guide viewer.',
      shortcutBlockedText:
        root.getAttribute('data-shortcut-blocked-text') ||
        'Download, save, print, and right-click are intentionally limited on this page.',
      legacyFavoritesKey: 'pv-fav-' + (root.id || 'default'),
      favoritesClient: window.KPSAccountFavorites
        ? window.KPSAccountFavorites.createClient({
          customerId: (root.getAttribute('data-customer-id') || '').trim(),
          customerKey: (root.getAttribute('data-customer-gid') || root.getAttribute('data-customer-id') || '').trim(),
          apiBase: apiBase,
          namespace: 'guidebook'
        })
        : null,
      nodes: [],
      itemsById: {},
      selectableItemIds: [],
      categoryAvailabilityCache: {},
      categoryAvailabilityState: {},
      categoryAvailabilityInFlight: {},
      categoryAvailabilityPrefetchStarted: false,
      prefetchQueue: [],
      prefetchQueuedIds: {},
      prefetchTimer: null,
      prefetchPausedUntil: 0,
      prefetchActive: false,
      prefetchLastStartedAt: 0,
      prefetchVisibilityObserver: null,
      foregroundActiveCount: 0,
      guideAccess: {
        loaded: false,
        pdf: false,
        video: false,
        bundle: false,
      },
      signedUrlCache: {},
      signedUrlInFlight: {},
      assetOpenCounts: {},
      currentItemId: null,
      currentFormat: null,
      selectionToken: 0,
      assetOpenToken: 0,
      manualRetryAction: null,
      pdfZoom: PDF_ZOOM_DEFAULT,
      renderedAsset: null,
      printRestore: null,
      warningTimer: null,
      elements: {
        sidebar: root.querySelector('.pv-sidebar'),
        sidebarScroller: root.querySelector('.pv-sidebar__inner'),
        toc: root.querySelector('[data-pv-toc]'),
        sidebarEmpty: root.querySelector('[data-pv-sidebar-empty]'),
        favoritesPanel: root.querySelector('[data-pv-favorites-panel]'),
        favoritesList: root.querySelector('[data-pv-favorites-list]'),
        favoritesEmpty: root.querySelector('[data-pv-favorites-empty]'),
        showFavorites: root.querySelector('[data-pv-show-favorites]'),
        showAll: root.querySelector('[data-pv-show-all]'),
        currentLabel: root.querySelector('[data-pv-current-label]'),
        headerFormatActions: root.querySelector('[data-pv-header-format-actions]'),
        headerButtonWrap: root.querySelector('[data-pv-header-format-actions] [data-pv-item-buttons]'),
        openFull: root.querySelector('[data-pv-open-full]'),
        zoomControls: root.querySelector('[data-pv-zoom-controls]'),
        zoomValue: root.querySelector('[data-pv-zoom-value]'),
        zoomOut: root.querySelector('[data-pv-zoom-action="out"]'),
        zoomIn: root.querySelector('[data-pv-zoom-action="in"]'),
        requestStatus: root.querySelector('[data-pv-request-status]'),
        requestStatusText: root.querySelector('[data-pv-request-status-text]'),
        retryAction: root.querySelector('[data-pv-retry-action]'),
        warning: root.querySelector('[data-pv-protection-warning]'),
        viewer: root.querySelector('[data-pv-viewer]'),
        empty: root.querySelector('[data-pv-empty]'),
        emptyText: root.querySelector('[data-pv-empty-text]'),
        loading: root.querySelector('[data-pv-loading]'),
        frameWrap: root.querySelector('[data-pv-frame-wrap]'),
        frameStage: root.querySelector('[data-pv-frame-stage]'),
        frame: root.querySelector('[data-pv-frame]'),
        pdfShield: root.querySelector('[data-pv-pdf-shield]'),
        videoWrap: root.querySelector('[data-pv-video-wrap]'),
        video: root.querySelector('[data-pv-video]'),
      },
    };

    if (state.favoritesClient && state.customerId) {
      state.favoritesClient.subscribe(function() {
        syncGuideFavoriteUi(state);
      });
      state.favoritesClient.hydrate({ type: 'GUIDEBOOK_NODE' }).then(function() {
        syncGuideFavoriteUi(state);
      }).catch(function() {
        syncGuideFavoriteUi(state);
      });
    }

    bindEvents(state);
    updateProtectionUi(state);
    showViewerEmpty(state, state.emptyStateText);

    if (!state.customerId) {
      showSidebarEmpty(state, state.emptyGuidesText);
      return;
    }

    loadGuideAccess(state);
    loadCategories(state);
  }

  function trimTrailingSlash(value) {
    return value.slice(-1) === '/' ? value.slice(0, -1) : value;
  }

  function bindEvents(state) {
    state.root.addEventListener('click', function(event) {
      var groupFavoriteToggle = event.target.closest('[data-pv-fav-group]');
      if (groupFavoriteToggle) {
        event.preventDefault();
        event.stopPropagation();
        toggleGroupFavorites(state, groupFavoriteToggle.getAttribute('data-pv-fav-group'));
        return;
      }

      var favoriteToggle = event.target.closest('[data-pv-fav]');
      if (favoriteToggle) {
        event.preventDefault();
        event.stopPropagation();
        toggleFavorite(state, favoriteToggle.getAttribute('data-pv-fav'));
        return;
      }

      var favoriteLink = event.target.closest('[data-pv-favorite-link]');
      if (favoriteLink) {
        event.preventDefault();
        var favoriteItemId = favoriteLink.getAttribute('data-pv-favorite-link');
        setFavoritesView(state, false);
        openDefaultAsset(state, favoriteItemId);
        return;
      }

      var favoriteFormatButton = event.target.closest('[data-pv-favorite-open-format]');
      if (favoriteFormatButton) {
        event.preventDefault();
        var formatItemId = favoriteFormatButton.getAttribute('data-pv-item-id');
        var formatType = favoriteFormatButton.getAttribute('data-pv-favorite-open-format');
        if (!formatItemId || !formatType) return;
        openAsset(state, formatItemId, formatType);
        return;
      }

      var retryAction = event.target.closest('[data-pv-retry-action]');
      if (retryAction) {
        event.preventDefault();
        if (typeof state.manualRetryAction === 'function') {
          var retry = state.manualRetryAction;
          clearViewerStatus(state);
          retry();
        }
        return;
      }

      var fullVersionButton = event.target.closest('[data-pv-open-full]');
      if (fullVersionButton) {
        event.preventDefault();
        if (!state.renderedAsset || !state.renderedAsset.signedUrl) return;
        window.open(state.renderedAsset.signedUrl, '_blank', 'noopener');
        return;
      }

      var zoomButton = event.target.closest('[data-pv-zoom-action]');
      if (zoomButton) {
        event.preventDefault();
        handlePdfZoomAction(state, zoomButton.getAttribute('data-pv-zoom-action'));
        return;
      }

      var formatButton = event.target.closest('[data-pv-open-format]');
      if (formatButton) {
        event.preventDefault();
        openAsset(
          state,
          formatButton.getAttribute('data-pv-item-id'),
          formatButton.getAttribute('data-pv-open-format')
        );
        return;
      }

      var categorySelect = event.target.closest('[data-pv-category-select]');
      if (categorySelect) {
        event.preventDefault();
        selectCategory(state, categorySelect.getAttribute('data-pv-item-id'));
        return;
      }

      var groupToggle = event.target.closest('[data-pv-toggle]');
      if (groupToggle) {
        event.preventDefault();
        var branchEl = groupToggle.closest('[data-pv-branch]');
        var opened = toggleBranch(branchEl);
        if (opened) {
          promoteBranchPrefetchItems(state, branchEl);
        }
        if (branchEl && branchEl.hasAttribute('data-pv-leaf-item-id')) {
          var leafItemId = branchEl.getAttribute('data-pv-leaf-item-id');
          if (leafItemId && branchEl.getAttribute('data-pv-open') === 'true') {
            selectCategory(state, leafItemId, { keepViewer: true });
          }
        }
      }
    });

    state.root.addEventListener('contextmenu', function(event) {
      if (!isProtectedSurface(state, event.target)) return;
      event.preventDefault();
      showProtectionWarning(state, state.shortcutBlockedText);
    });

    state.root.addEventListener('dragstart', function(event) {
      if (!isProtectedSurface(state, event.target)) return;
      event.preventDefault();
    });

    document.addEventListener('keydown', function(event) {
      if (!shouldBlockShortcut(event) || isEditableElement(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      showProtectionWarning(state, shortcutBlockedMessage(state, event));
    });

    window.addEventListener('beforeprint', function() {
      handleBeforePrint(state);
    });

    window.addEventListener('afterprint', function() {
      handleAfterPrint(state);
    });

    if (state.elements.showFavorites) {
      state.elements.showFavorites.addEventListener('click', function() {
        var isFavoriteView =
          state.elements.sidebar &&
          state.elements.sidebar.getAttribute('data-pv-view') === 'favorites';
        setFavoritesView(state, !isFavoriteView);
      });
    }

    if (state.elements.showAll) {
      state.elements.showAll.addEventListener('click', function() {
        setFavoritesView(state, false);
      });
    }

    if (state.elements.sidebarScroller) {
      var visiblePrefetchTimer = null;
      state.elements.sidebarScroller.addEventListener('scroll', function() {
        if (visiblePrefetchTimer) return;
        visiblePrefetchTimer = window.setTimeout(function() {
          visiblePrefetchTimer = null;
          promoteVisiblePrefetchItems(state);
        }, 120);
      });
    }

    if (state.elements.frame) {
      state.elements.frame.addEventListener('load', function() {
        setViewerLoading(state, false);
        updateProtectionUi(state);
      });
      state.elements.frame.addEventListener('error', function() {
        showViewerEmpty(state, 'The PDF could not be loaded.');
        if (state.currentItemId) {
          syncCategoryButtons(state, state.currentItemId);
        }
      });
    }

    if (state.elements.video) {
      state.elements.video.addEventListener('loadedmetadata', function() {
        setViewerLoading(state, false);
        updateProtectionUi(state);
      });
      state.elements.video.addEventListener('error', function() {
        showViewerEmpty(state, 'The video could not be loaded.');
        if (state.currentItemId) {
          syncCategoryButtons(state, state.currentItemId);
        }
      });
    }
  }

  async function loadCategories(state) {
    setViewerLoading(state, true);

    try {
      var payload = await requestJson(state, state.categoriesEndpoint);
      resetCategoryRequestCoordinator(state);
      state.itemsById = {};
      state.selectableItemIds = [];
      state.categoryAvailabilityCache = {};
      state.nodes = normalizeCategoryNodes(state, Array.isArray(payload.items) ? payload.items : [], []);

      renderTree(state);
      setupPrefetchVisibilityPromotion(state);
      migrateLegacyGuideFavorites(state);
      syncGuideFavoriteUi(state);
      prefetchCategoryAvailabilities(state);

      if (!state.nodes.length) {
        showSidebarEmpty(state, state.emptyGuidesText);
        showViewerEmpty(state, state.emptyGuidesText);
        return;
      }

      hideSidebarEmpty(state);
      showViewerEmpty(state, state.emptyStateText);
    } catch (error) {
      var message =
        error && typeof error.message === 'string'
          ? error.message
          : 'Failed to load your guide categories.';
      showSidebarEmpty(state, message);
      showViewerEmpty(state, message);
    } finally {
      setViewerLoading(state, false);
    }
  }

  async function loadGuideAccess(state) {
    if (!state.customerId) return;

    try {
      var data = await requestJson(state, buildGuideAccessPath(state), {
        absolute: true,
        cache: 'no-store',
      });
      state.guideAccess = normalizeGuideAccess(data);
      syncAllCategoryButtons(state);
    } catch (error) {
      if (
        error &&
        (error.code === 'GUIDE_EXTENSION_NOT_ELIGIBLE' || error.code === 'AUTH_LOGIN_REQUIRED')
      ) {
        state.guideAccess = normalizeGuideAccess(null);
        syncAllCategoryButtons(state);
      }
    }
  }

  function buildGuideAccessPath(state) {
    return (
      state.appBase +
      '/guide-extension/entitlements?logged_in_customer_id=' +
      encodeURIComponent(state.customerId)
    );
  }

  function normalizeGuideAccess(data) {
    var activeTypes = {};
    if (data && Array.isArray(data.items)) {
      data.items.forEach(function(item) {
        if (item && item.type && item.status === 'ACTIVE') {
          activeTypes[String(item.type)] = true;
        }
      });
    }

    var hints = data && data.uiHints ? data.uiHints : {};
    var bundle = Boolean(activeTypes.BUNDLE);

    return {
      loaded: true,
      pdf: Boolean(activeTypes.PDF || bundle || hints.pdfAccessViaBundle),
      video: Boolean(activeTypes.VIDEO || bundle || hints.videoAccessViaBundle),
      bundle: bundle,
    };
  }

  function addUniqueString(list, value) {
    var normalized = String(value || '').trim();
    if (!normalized || list.indexOf(normalized) !== -1) return;
    list.push(normalized);
  }

  function collectGuideNodeAliases(node) {
    var aliases = [];
    addUniqueString(aliases, node && node.id);
    addUniqueString(aliases, node && node.nodeId);
    addUniqueString(aliases, node && node.categoryId);
    addUniqueString(aliases, node && node.targetId);
    if (node && node.contentRef && typeof node.contentRef === 'object') {
      addUniqueString(aliases, node.contentRef.nodeId);
    }
    return aliases;
  }

  function normalizeCategoryNodes(state, nodes, parentSegments) {
    var parentName = parentSegments.length > 0 ? parentSegments[parentSegments.length - 1] : '';
    var filteredNodes = parentName === 'Jeju'
      ? nodes.filter(function(node) {
          return JEJU_HIDDEN_CATEGORIES.indexOf(String(node.name || '')) === -1;
        })
      : nodes;
    return filteredNodes.map(function(node) {
      var segments = parentSegments.concat(String(node.name || 'Untitled'));
      var children = normalizeCategoryNodes(state, Array.isArray(node.children) ? node.children : [], segments);
      var item = {
        id: String(node.id),
        kind: String(node.kind || 'SHARED'),
        slug: String(node.slug || ''),
        title: String(node.name || 'Untitled'),
        path: segments.join(' / '),
        pathSegments: segments,
        depth: Number(node.depth || segments.length || 1),
        sortOrder: Number(node.sortOrder || 0),
        children: children,
        selectable: children.length === 0,
        favoriteAliases: collectGuideNodeAliases(node),
        pdfAsset: null,
        videoAsset: null,
      };

      state.itemsById[item.id] = item;
      if (item.selectable) {
        state.selectableItemIds.push(item.id);
      }

      return item;
    });
  }

  function isEditableElement(target) {
    if (!target || target === window || target === document) return false;

    var tagName = target.tagName ? target.tagName.toLowerCase() : '';
    return Boolean(
      target.isContentEditable ||
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select'
    );
  }

  function shouldBlockShortcut(event) {
    if (!event || !(event.metaKey || event.ctrlKey)) return false;

    var key = String(event.key || '').toLowerCase();
    return key === 'p' || key === 's';
  }

  function shortcutBlockedMessage(state, event) {
    var key = String((event && event.key) || '').toLowerCase();
    return key === 'p' ? state.printBlockedText : state.shortcutBlockedText;
  }

  function isProtectedSurface(state, target) {
    if (!target || !state.root.contains(target)) return false;
    return Boolean(state.elements.viewer && state.elements.viewer.contains(target));
  }

  function showProtectionWarning(state, message) {
    if (!state.elements.warning || !message) return;

    state.elements.warning.hidden = false;
    state.elements.warning.textContent = message;
    state.root.setAttribute('data-pv-protection-warning', 'true');

    if (state.warningTimer) {
      window.clearTimeout(state.warningTimer);
    }

    state.warningTimer = window.setTimeout(function() {
      state.root.removeAttribute('data-pv-protection-warning');
      state.elements.warning.hidden = true;
    }, 2600);
  }

  function handleBeforePrint(state) {
    state.root.setAttribute('data-pv-print-lock', 'true');
    showProtectionWarning(state, state.printBlockedText);

    if (state.printRestore || !state.renderedAsset) return;

    state.printRestore = {
      itemId: state.currentItemId,
      format: state.currentFormat,
      pdfZoom: state.pdfZoom,
      currentLabel: state.elements.currentLabel ? state.elements.currentLabel.textContent : '',
      renderedAsset: state.renderedAsset,
    };

    showViewerEmpty(state, state.printBlockedText);
    updateCurrentLabel(state, state.printBlockedText);
  }

  function handleAfterPrint(state) {
    state.root.removeAttribute('data-pv-print-lock');

    if (!state.printRestore) {
      updateProtectionUi(state);
      return;
    }

    var restore = state.printRestore;
    state.printRestore = null;
    state.currentItemId = restore.itemId;
    state.currentFormat = restore.format;
    state.pdfZoom = restore.pdfZoom || PDF_ZOOM_DEFAULT;

    renderAsset(
      state,
      restore.renderedAsset.itemId,
      restore.renderedAsset.format,
      restore.renderedAsset.signedUrl
    );
    updateCurrentLabel(state, restore.currentLabel || '');
    setViewerLoading(state, false);
    updateActiveFormatButtons(state);
  }

  function updateProtectionUi(state) {
    var format = state.renderedAsset ? state.renderedAsset.format : '';

    if (format) {
      state.root.setAttribute('data-pv-current-format', format);
    } else {
      state.root.removeAttribute('data-pv-current-format');
    }

    if (state.elements.pdfShield) {
      var showShield = false;
      state.elements.pdfShield.hidden = !showShield;
      state.elements.pdfShield.setAttribute('aria-hidden', showShield ? 'false' : 'true');
    }
  }

  function buildViewerSourceUrl(format, signedUrl) {
    if (format !== 'pdf' || !signedUrl) return signedUrl;

    
    buildViewerSourceUrl.navigationId = (buildViewerSourceUrl.navigationId || 0) + 1;
    return 'https://bta-proxy.kpurpleshoes.com/guide-pdf?view=' +
      buildViewerSourceUrl.navigationId + '#file=' + encodeURIComponent(signedUrl);
  }

  function clampPdfZoom(value) {
    var zoom = Number(value);
    if (!isFinite(zoom)) zoom = PDF_ZOOM_DEFAULT;
    return Math.max(PDF_ZOOM_MIN, Math.min(PDF_ZOOM_MAX, Math.round(zoom)));
  }

  function updatePdfZoomControls(state, visible) {
    var show = Boolean(
      visible && state.renderedAsset && state.renderedAsset.format === 'pdf' && state.renderedAsset.signedUrl
    );

    if (state.elements.zoomControls) {
      state.elements.zoomControls.hidden = !show;
      state.elements.zoomControls.setAttribute('aria-hidden', show ? 'false' : 'true');
    }
    if (state.elements.zoomValue) {
      state.elements.zoomValue.textContent = clampPdfZoom(state.pdfZoom) + '%';
    }
    if (state.elements.zoomOut) {
      state.elements.zoomOut.disabled = !show || clampPdfZoom(state.pdfZoom) <= PDF_ZOOM_MIN;
    }
    if (state.elements.zoomIn) {
      state.elements.zoomIn.disabled = !show || clampPdfZoom(state.pdfZoom) >= PDF_ZOOM_MAX;
    }
  }

  function handlePdfZoomAction(state, action) {
    if (!state.renderedAsset || state.renderedAsset.format !== 'pdf') return;

    if (action === 'out') {
      setPdfZoom(state, state.pdfZoom - PDF_ZOOM_STEP);
    } else if (action === 'in') {
      setPdfZoom(state, state.pdfZoom + PDF_ZOOM_STEP);
    } else if (action === 'reset') {
      setPdfZoom(state, PDF_ZOOM_DEFAULT);
    }
  }

  function setPdfZoom(state, zoom) {
    if (!state.renderedAsset || state.renderedAsset.format !== 'pdf') return;

    state.pdfZoom = clampPdfZoom(zoom);
    applyPdfZoom(state);
    updatePdfZoomControls(state, true);
  }

  function applyPdfZoom(state) {
    var zoom = clampPdfZoom(state.pdfZoom);
    var scale = zoom / 100;

    if (state.elements.frameStage) {
      state.elements.frameStage.style.width = zoom + '%';
      state.elements.frameStage.style.height = '100%';
      state.elements.frameStage.style.minHeight = '500px';
    }

    if (state.elements.frame) {
      state.elements.frame.style.width = 100 / scale + '%';
      state.elements.frame.style.height = 100 / scale + '%';
      state.elements.frame.style.minHeight = Math.round(500 / scale) + 'px';
      state.elements.frame.style.transform = 'translateX(-50%) scale(' + scale + ')';
      state.elements.frame.style.transformOrigin = 'top center';
    }

    if (state.elements.frameWrap && scale <= 1) {
      state.elements.frameWrap.scrollLeft = 0;
    }
  }

  function resetPdfZoomFrame(state) {
    if (state.elements.frameStage) {
      state.elements.frameStage.removeAttribute('style');
    }
    if (state.elements.frame) {
      state.elements.frame.style.removeProperty('width');
      state.elements.frame.style.removeProperty('height');
      state.elements.frame.style.removeProperty('min-height');
      state.elements.frame.style.removeProperty('transform');
      state.elements.frame.style.removeProperty('transform-origin');
    }
  }

  function requestJson(state, path, options) {
    options = options || {};
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeoutId = null;

    if (controller) {
      timeoutId = window.setTimeout(function() {
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
    }

    var url = options.absolute ? path : state.apiBase + path;
    var fetchOptions = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
      },
      signal: controller ? controller.signal : undefined,
    };
    if (options.cache) {
      fetchOptions.cache = options.cache;
    }

    return fetch(url, fetchOptions)
      .then(function(response) {
        return response
          .json()
          .catch(function() {
            return null;
          })
          .then(function(body) {
            if (!response.ok || !body || body.ok === false) {
              var errorCode = body && body.error ? body.error.code : '';
              var errorMessage = body && body.error ? body.error.message : '';
              if (errorCode === 'AUTH_LOGIN_REQUIRED') {
                var authError = new Error('Please sign in again to access your guide viewer.');
                authError.code = errorCode;
                throw authError;
              }
              var requestError = new Error(errorMessage || 'Request failed.');
              requestError.code = errorCode || 'REQUEST_FAILED';
              requestError.status = response.status;
              requestError.correlationId =
                (body && body.error && (body.error.correlationId || body.error.requestId)) ||
                response.headers.get('x-correlation-id') ||
                response.headers.get('x-request-id') ||
                '';
              requestError.retryAfterMs = getRetryAfterMs(response);
              throw requestError;
            }
            return body.data;
          });
      })
      .finally(function() {
        if (timeoutId) window.clearTimeout(timeoutId);
      });
  }

  function renderTree(state) {
    var toc = state.elements.toc;
    if (!toc) return;

    toc.innerHTML = '';
    if (!state.nodes.length) return;

    state.nodes.forEach(function(node) {
      renderNode(state, node, toc);
    });
  }

  function renderNode(state, node, parent) {
    parent.appendChild(
      node.children.length > 0 ? createGroupBranch(state, node) : createLeafBranch(state, node)
    );
  }

  function isChapterHeaderTitle(title) {
    var t = String(title || '');
    if (/^\[/.test(t)) return true;
    if (/^Seoul \[/i.test(t)) return true;
    return ['Incheon', 'Busan', 'Jeju', 'Gyeongju', 'Gangwon-do'].indexOf(t) !== -1;
  }

  function collectSelectableDescendantIds(node) {
    var ids = [];
    if (!node || !node.children || !node.children.length) return ids;
    node.children.forEach(function(child) {
      if (child.selectable) ids.push(child.id);
      ids = ids.concat(collectSelectableDescendantIds(child));
    });
    return ids;
  }

  function createGroupBranch(state, node) {
    var depth = Math.min(node.depth, 3);
    var branch = createElement('div', {
      className: 'pv-toc__branch pv-toc__branch--' + depth,
      attrs: {
        'data-pv-branch': '',
        'data-pv-open': 'false',
        role: 'group',
      },
    });
    var itemClass = 'pv-toc__item pv-toc__item--l' + depth;
    if (depth >= 2 && isChapterHeaderTitle(node.title)) {
      itemClass += ' pv-toc__item--section-header';
    }
    var item = createElement('div', {
      className: itemClass,
      attrs: {
        'data-level': String(depth),
        'data-pv-item': '',
        'data-pv-node-type': 'group',
        'data-pv-node-id': node.id,
      },
    });
    var row = createElement('div', { className: 'pv-toc__row' });

    if (depth === 1) {
      row.appendChild(createInitial(node.title));
      var cell = createElement('div', { className: 'pv-toc__cell' });
      var triggerLevelOne = createElement('button', {
        className: 'pv-toc__trigger pv-toc__trigger--l1',
        attrs: {
          type: 'button',
          'data-pv-toggle': '',
          'aria-expanded': 'false',
        },
      });
      triggerLevelOne.appendChild(
        createElement('span', { className: 'pv-toc__link-text', text: node.title })
      );
      cell.appendChild(triggerLevelOne);
      row.appendChild(cell);
      row.appendChild(
        createElement('span', {
          className: 'pv-toc__chevron pv-toc__chevron--right',
          attrs: { 'aria-hidden': 'true', 'data-pv-toggle': '' },
        })
      );
    } else {
      if (
        depth === 2 &&
        node.children.length > 0 &&
        !isChapterHeaderTitle(node.title)
      ) {
        var bulkIds = collectSelectableDescendantIds(node);
        if (bulkIds.length > 0) {
          row.appendChild(createFavoriteGroupButton(node.id));
        }
      }
      var trigger = createElement('button', {
        className: 'pv-toc__trigger',
        attrs: {
          type: 'button',
          'data-pv-toggle': '',
          'aria-expanded': 'false',
        },
      });
      trigger.appendChild(
        createElement('span', { className: 'pv-toc__link-text', text: node.title })
      );
      trigger.appendChild(
        createElement('span', {
          className: 'pv-toc__chevron',
          attrs: { 'aria-hidden': 'true' },
        })
      );
      row.appendChild(trigger);
    }

    item.appendChild(row);
    branch.appendChild(item);

    var childWrap = createElement('div', {
      className: 'pv-toc__children',
      attrs: { 'data-pv-children': '' },
    });
    childWrap.hidden = true;
    node.children.forEach(function(child) {
      renderNode(state, child, childWrap);
    });
    branch.appendChild(childWrap);
    return branch;
  }

  function createLeafBranch(state, itemData) {
    var depth = Math.min(itemData.depth, 3);

    if (depth === 1) {
      var branchD1 = createElement('div', {
        className: 'pv-toc__branch pv-toc__branch--1 pv-toc__branch--leaf-depth1',
        attrs: {
          'data-pv-branch': '',
          'data-pv-open': 'false',
          'data-pv-leaf-item-id': itemData.id,
          role: 'group',
        },
      });
      var itemSummary = createElement('div', {
        className: 'pv-toc__item pv-toc__item--l1 pv-toc__item--leaf-summary',
        attrs: {
          'data-level': '1',
          'data-pv-item': '',
          'data-pv-node-type': 'leaf-summary',
          'data-pv-node-id': itemData.id,
        },
      });
      var summaryRow = createElement('div', { className: 'pv-toc__row' });
      summaryRow.appendChild(createInitial(itemData.title));
      var summaryCell = createElement('div', { className: 'pv-toc__cell' });
      var summaryTrigger = createElement('button', {
        className: 'pv-toc__trigger pv-toc__trigger--l1',
        attrs: {
          type: 'button',
          'data-pv-toggle': '',
          'aria-expanded': 'false',
        },
      });
      summaryTrigger.appendChild(
        createElement('span', { className: 'pv-toc__link-text', text: itemData.title })
      );
      summaryCell.appendChild(summaryTrigger);
      summaryRow.appendChild(summaryCell);
      summaryRow.appendChild(
        createElement('span', {
          className: 'pv-toc__chevron pv-toc__chevron--right',
          attrs: { 'aria-hidden': 'true', 'data-pv-toggle': '' },
        })
      );
      itemSummary.appendChild(summaryRow);
      branchD1.appendChild(itemSummary);

      var childWrapD1 = createElement('div', {
        className: 'pv-toc__children pv-toc__children--leaf-detail',
        attrs: { 'data-pv-children': '' },
      });
      childWrapD1.hidden = true;

      var detailItem = createElement('div', {
        className:
          'pv-toc__item pv-toc__item--l1 pv-toc__item--link pv-toc__item--leaf-row pv-toc__item--leaf-detail-card',
        attrs: {
          'data-level': '1',
          'data-pv-item': '',
          'data-block-id': itemData.id,
          'data-pv-title': itemData.path || itemData.title,
          'data-pv-item-id': itemData.id,
        },
      });
      var detailRow = createElement('div', {
        className: 'pv-toc__row pv-toc__row--leaf pv-toc__row--leaf-detail',
      });
      detailRow.appendChild(createFavoriteButton(itemData.id));
      var detailTitle = createElement('div', {
        className: 'pv-toc__cell pv-toc__cell--leaf-detail',
      });
      detailTitle.appendChild(
        createElement('span', {
          className: 'pv-toc__leaf-detail-title',
          text: itemData.title,
        })
      );
      detailRow.appendChild(detailTitle);
      var actionsWrapD1 = createElement('div', {
        className: 'pv-toc__row-actions',
        attrs: {
          'data-pv-item-buttons': '',
          'data-pv-item-buttons-for': itemData.id,
        },
      });
      syncButtonWrap(state, actionsWrapD1, itemData);
      detailRow.appendChild(actionsWrapD1);
      detailItem.appendChild(detailRow);
      childWrapD1.appendChild(detailItem);
      branchD1.appendChild(childWrapD1);
      applyFavoriteState(state, itemData.id);
      return branchD1;
    }

    var branch = createElement('div', {
      className: 'pv-toc__branch pv-toc__branch--' + depth,
      attrs: {
        'data-pv-branch': '',
        role: 'group',
      },
    });
    var item = createElement('div', {
      className:
        'pv-toc__item pv-toc__item--l' +
        depth +
        ' pv-toc__item--link pv-toc__item--leaf-row pv-toc__item--leaf-last-depth',
      attrs: {
        'data-level': String(depth),
        'data-pv-item': '',
        'data-block-id': itemData.id,
        'data-pv-title': itemData.path || itemData.title,
        'data-pv-item-id': itemData.id,
      },
    });
    var row = createElement('div', { className: 'pv-toc__row pv-toc__row--leaf pv-toc__row--leaf-detail' });

    var actionsWrap = createElement('div', {
      className: 'pv-toc__row-actions',
      attrs: {
        'data-pv-item-buttons': '',
        'data-pv-item-buttons-for': itemData.id,
      },
    });
    syncButtonWrap(state, actionsWrap, itemData);

    row.appendChild(createFavoriteButton(itemData.id));
    var leafButton = createElement('button', {
      className: 'pv-toc__link pv-toc__link--leaf-title',
      attrs: {
        type: 'button',
        'data-pv-category-select': '',
        'data-pv-item-id': itemData.id,
      },
    });
    leafButton.appendChild(
      createElement('span', { className: 'pv-toc__link-text', text: itemData.title })
    );
    row.appendChild(leafButton);
    row.appendChild(actionsWrap);
    item.appendChild(row);
    branch.appendChild(item);
    applyFavoriteState(state, itemData.id);
    return branch;
  }

  function syncButtonWrap(state, wrap, item) {
    if (!wrap || !item) return;
    wrap.innerHTML = '';

    function appendFormatBtn(format, label) {
      var btn = createFormatButton(item.id, format, label);
      var viewingThisFormat =
        state.renderedAsset &&
        state.renderedAsset.itemId === item.id &&
        state.renderedAsset.format === format;
      applyFormatButtonAvailability(state, btn, item, format, viewingThisFormat);
      wrap.appendChild(btn);
    }

    appendFormatBtn('pdf', 'PDF');
    appendFormatBtn('video', 'MOV');
  }

  function applyFormatButtonAvailability(state, button, item, format, viewingThisFormat) {
    if (!button || !item) return;

    var label = format === 'video' ? 'MOV' : 'PDF';
    var availabilityState = getCategoryAvailabilityState(state, item.id);
    var asset = format === 'video' ? item.videoAsset : item.pdfAsset;

    button.disabled = false;
    button.removeAttribute('aria-disabled');
    button.removeAttribute('aria-busy');
    button.classList.remove(
      'pv-toc__format-btn--pending',
      'pv-toc__format-btn--restricted',
      'pv-toc__format-btn--unavailable'
    );
    button.setAttribute('data-pv-availability-state', availabilityState);

    if (isFormatBlockedByGuideAccess(state, format)) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.classList.add('pv-toc__format-btn--restricted');
      button.setAttribute('title', 'Your current guide access does not include ' + label + '.');
      return;
    }

    if (availabilityState !== 'ready') {
      button.classList.add('pv-toc__format-btn--pending');
      button.setAttribute('aria-busy', 'true');
      button.setAttribute(
        'title',
        availabilityState === 'rate_limited'
          ? 'Preparing ' + label + '. Please try again shortly.'
          : 'Checking ' + label + ' availability...'
      );
      return;
    }

    if (asset || viewingThisFormat) {
      if (asset && isAssetOpenInFlight(state, asset.id)) {
        button.classList.add('pv-toc__format-btn--pending');
        button.setAttribute('aria-busy', 'true');
        button.setAttribute('title', 'Opening ' + label + '...');
      } else {
        button.setAttribute('title', 'Open ' + label + '.');
      }
      return;
    }

    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.classList.add('pv-toc__format-btn--unavailable');
    button.setAttribute('title', label + ' is not available for this category.');
  }

  function getCategoryAvailabilityState(state, itemId) {
    return state.categoryAvailabilityState[itemId] || 'unknown';
  }

  function setCategoryAvailabilityState(state, itemId, value) {
    if (!itemId) return;
    state.categoryAvailabilityState[itemId] = value;
  }

  function isAssetOpenInFlight(state, assetId) {
    return Boolean(assetId && state.assetOpenCounts[assetId]);
  }

  function isFormatBlockedByGuideAccess(state, format) {
    if (!state || !state.guideAccess || !state.guideAccess.loaded) return false;

    return format === 'video' ? !state.guideAccess.video : !state.guideAccess.pdf;
  }

  function createFormatButton(itemId, format, label) {
    return createElement('button', {
      className: 'pv-toc__format-btn',
      attrs: {
        type: 'button',
        'data-pv-open-format': format,
        'data-pv-item-id': itemId,
        'data-pv-format': format,
      },
      text: label,
    });
  }

  function createFavoriteButton(itemId) {
    var button = createElement('button', {
      className: 'pv-toc__fav',
      attrs: {
        type: 'button',
        'data-pv-fav': itemId,
        'aria-label': 'Add to favorites',
        title: 'Add to favorites',
      },
    });

    button.innerHTML =
      '<span class="pv-toc__fav-icon" aria-hidden="true">' +
      '<svg class="pv-toc__heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>' +
      '</svg>' +
      '</span>';

    return button;
  }

  function createFavoriteGroupButton(groupNodeId) {
    var button = createElement('button', {
      className: 'pv-toc__fav pv-toc__fav--group',
      attrs: {
        type: 'button',
        'data-pv-fav-group': groupNodeId,
        'aria-label': 'Add all sub-items to favorites',
        title: 'Add all sub-items to favorites',
      },
    });

    button.innerHTML =
      '<span class="pv-toc__fav-icon" aria-hidden="true">' +
      '<svg class="pv-toc__heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>' +
      '</svg>' +
      '</span>';

    return button;
  }

  function syncCategoryButtons(state, itemId, options) {
    options = options || {};
    var item = state.itemsById[itemId];
    if (!item) return;
    var updateHeader = options.updateHeader !== false;
    var refreshFavorites = options.refreshFavorites !== false;

    if (updateHeader && state.elements.headerButtonWrap) {
      state.elements.headerButtonWrap.setAttribute('data-pv-item-buttons-for', itemId);
    }
    if (updateHeader && state.elements.headerFormatActions) {
      state.elements.headerFormatActions.hidden = false;
    }

    state.root
      .querySelectorAll('[data-pv-item-buttons-for="' + cssEscape(itemId) + '"]')
      .forEach(function(wrap) {
        syncButtonWrap(state, wrap, item);
      });

    updateActiveFormatButtons(state);
    if (
      refreshFavorites &&
      state.elements.sidebar &&
      state.elements.sidebar.getAttribute('data-pv-view') === 'favorites'
    ) {
      buildFavoritesList(state);
    }
  }

  function syncAllCategoryButtons(state) {
    state.selectableItemIds.forEach(function(itemId) {
      syncCategoryButtons(state, itemId, {
        updateHeader: false,
        refreshFavorites: false,
      });
    });

    if (state.currentItemId) {
      syncCategoryButtons(state, state.currentItemId);
    } else if (
      state.elements.sidebar &&
      state.elements.sidebar.getAttribute('data-pv-view') === 'favorites'
    ) {
      buildFavoritesList(state);
    }
  }

  function syncAllFavoriteButtons(state) {
    var seen = Object.create(null);
    state.root.querySelectorAll('[data-pv-fav]').forEach(function(button) {
      var itemId = button.getAttribute('data-pv-fav');
      if (!itemId || seen[itemId]) return;
      seen[itemId] = true;
      applyFavoriteState(state, itemId);
    });
  }

  function syncGuideFavoriteUi(state) {
    syncAllFavoriteButtons(state);
    updateGroupFavoriteButtons(state);
    buildFavoritesList(state);
    promoteFavoritePrefetchItems(state);
  }

  function createInitial(text) {
    var initial = (text || '?').charAt(0).toUpperCase() || '?';
    return createElement('span', {
      className: 'pv-toc__initial',
      attrs: { 'aria-hidden': 'true' },
      text: initial,
    });
  }

  async function selectCategory(state, itemId, options) {
    options = options || {};
    var item = state.itemsById[itemId];
    if (!item) return;
    var selectionToken = state.selectionToken + 1;
    state.selectionToken = selectionToken;
    state.assetOpenToken += 1;

    state.currentItemId = itemId;
    state.root.querySelectorAll('.pv-toc__item[data-pv-item-id]').forEach(function(node) {
      var isCurrent = node.getAttribute('data-pv-item-id') === itemId;
      node.classList.toggle('pv-toc__item--active', isCurrent);
      node.classList.toggle('pv-toc__item--expanded', isCurrent);
    });

    openAncestorBranches(state, itemId);
    updateCurrentLabel(state, item.path || item.title || '');
    updateFullVersionButton(state);
    syncCategoryButtons(state, itemId);
    clearViewerStatus(state);
    showCategoryAvailabilityPending(state, item);

    var retryAction =
      options.retryAction ||
      function() {
        return selectCategory(state, itemId, { keepViewer: options.keepViewer });
      };

    try {
      item = await ensureForegroundCategoryAvailability(state, itemId, {
        isCurrent: function() {
          return state.selectionToken === selectionToken && state.currentItemId === itemId;
        },
        retryAction: retryAction,
      });

      if (!item || state.selectionToken !== selectionToken || state.currentItemId !== itemId) {
        return null;
      }

      syncCategoryButtons(state, itemId);
      clearViewerStatus(state);

      if (!item.pdfAsset && !item.videoAsset) {
        showViewerEmpty(state, 'No accessible PDF or MOV is available for "' + item.title + '".');
      } else if (!options.keepViewer && !state.renderedAsset) {
        showViewerEmpty(state, 'Choose PDF or MOV for "' + item.title + '".', {
          keepHeaderFormatButtons: true,
        });
      }

      return item;
    } catch (error) {
      if (state.selectionToken !== selectionToken || state.currentItemId !== itemId) {
        return null;
      }

      syncCategoryButtons(state, itemId);
      if (!isRateLimitError(error) || !state.manualRetryAction) {
        var message =
          error && typeof error.message === 'string'
            ? error.message
            : 'Failed to load the selected category.';
        if (state.renderedAsset) {
          showViewerStatus(state, message);
        } else {
          showViewerEmpty(state, message, { keepHeaderFormatButtons: true });
        }
      }
      return null;
    }
  }

  function buildCategoryViewerPath(state, categoryId) {
    return state.categoryViewerTemplate.replace('{id}', encodeURIComponent(categoryId));
  }

  function showCategoryAvailabilityPending(state, item) {
    if (!item) return;
    showViewerStatus(state, 'Checking available formats for "' + item.title + '".');
    if (!state.renderedAsset) {
      showViewerEmpty(state, 'Checking available formats for "' + item.title + '".', {
        keepHeaderFormatButtons: true,
      });
    }
  }

  function ensureCategoryAvailability(state, itemId) {
    if (state.categoryAvailabilityCache[itemId]) {
      setCategoryAvailabilityState(state, itemId, 'ready');
      return Promise.resolve(state.itemsById[itemId]);
    }

    if (state.categoryAvailabilityInFlight[itemId]) {
      return state.categoryAvailabilityInFlight[itemId];
    }

    var item = state.itemsById[itemId];
    if (!item) return Promise.resolve(null);

    setCategoryAvailabilityState(state, itemId, 'checking');
    var request = requestJson(state, buildCategoryViewerPath(state, itemId))
      .then(function(data) {
        item.pdfAsset = data && data.pdfAsset ? data.pdfAsset : null;
        item.videoAsset = data && data.videoAsset ? data.videoAsset : null;
        state.categoryAvailabilityCache[itemId] = true;
        setCategoryAvailabilityState(state, itemId, 'ready');
        syncAvailabilityResult(state, itemId);
        return item;
      })
      .catch(function(error) {
        setCategoryAvailabilityState(state, itemId, isRateLimitError(error) ? 'rate_limited' : 'unknown');
        syncAvailabilityResult(state, itemId);
        throw error;
      });

    var sharedRequest = request.finally(function() {
      if (state.categoryAvailabilityInFlight[itemId] === sharedRequest) {
        delete state.categoryAvailabilityInFlight[itemId];
      }
    });
    state.categoryAvailabilityInFlight[itemId] = sharedRequest;
    return sharedRequest;
  }

  function syncAvailabilityResult(state, itemId) {
    syncCategoryButtons(state, itemId, {
      updateHeader: state.currentItemId === itemId,
    });
  }

  async function ensureForegroundCategoryAvailability(state, itemId, options) {
    options = options || {};
    removeItemFromPrefetchQueue(state, itemId);
    state.foregroundActiveCount += 1;
    deferBackgroundPrefetch(state);

    if (!state.categoryAvailabilityCache[itemId]) {
      setCategoryAvailabilityState(state, itemId, 'checking');
      syncCategoryButtons(state, itemId);
    }

    try {
      return await runForegroundRequestWithRateLimitRetry(state, function() {
        return ensureCategoryAvailability(state, itemId);
      }, {
        isCurrent: options.isCurrent,
        retryAction: options.retryAction,
        pendingMessage: 'Preparing your guide. Retrying shortly.',
        retryFailedMessage: 'We could not prepare this guide yet. Try again.',
        onRateLimited: function() {
          setCategoryAvailabilityState(state, itemId, 'rate_limited');
          syncCategoryButtons(state, itemId);
        },
        onBeforeRetry: function() {
          setCategoryAvailabilityState(state, itemId, 'checking');
          syncCategoryButtons(state, itemId);
        },
      });
    } finally {
      state.foregroundActiveCount = Math.max(0, state.foregroundActiveCount - 1);
      scheduleBackgroundPrefetch(state, PREFETCH_INTERVAL_MS);
    }
  }

  function prefetchCategoryAvailabilities(state) {
    if (state.categoryAvailabilityPrefetchStarted) return;
    state.categoryAvailabilityPrefetchStarted = true;

    state.selectableItemIds.forEach(function(itemId) {
      enqueuePrefetchItem(state, itemId);
    });
    if (!state.prefetchQueue.length) return;

    promoteVisiblePrefetchItems(state);
    promoteFavoritePrefetchItems(state);
    scheduleBackgroundPrefetch(state, PREFETCH_START_DELAY_MS);
  }

  function enqueuePrefetchItem(state, itemId, options) {
    options = options || {};
    if (
      !itemId ||
      state.categoryAvailabilityCache[itemId] ||
      state.categoryAvailabilityInFlight[itemId] ||
      state.prefetchQueuedIds[itemId]
    ) {
      return;
    }

    state.prefetchQueuedIds[itemId] = true;
    setCategoryAvailabilityState(state, itemId, 'queued');
    if (options.front) {
      state.prefetchQueue.unshift(itemId);
    } else {
      state.prefetchQueue.push(itemId);
    }
  }

  function removeItemFromPrefetchQueue(state, itemId) {
    if (!itemId || !state.prefetchQueuedIds[itemId]) return;
    delete state.prefetchQueuedIds[itemId];
    state.prefetchQueue = state.prefetchQueue.filter(function(queuedId) {
      return queuedId !== itemId;
    });
  }

  function promotePrefetchItems(state, itemIds) {
    if (!itemIds || !itemIds.length || !state.prefetchQueue.length) return;

    var promoteLookup = {};
    var promoted = [];
    itemIds.forEach(function(itemId) {
      if (
        itemId &&
        state.prefetchQueuedIds[itemId] &&
        !promoteLookup[itemId] &&
        !state.categoryAvailabilityCache[itemId] &&
        !state.categoryAvailabilityInFlight[itemId]
      ) {
        promoteLookup[itemId] = true;
        promoted.push(itemId);
      }
    });
    if (!promoted.length) return;

    state.prefetchQueue = promoted.concat(
      state.prefetchQueue.filter(function(itemId) {
        return !promoteLookup[itemId];
      })
    );
  }

  function promoteVisiblePrefetchItems(state) {
    var scroller = state.elements.sidebarScroller || state.elements.sidebar;
    var bounds = scroller && scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : null;
    var itemIds = [];

    state.root.querySelectorAll('.pv-toc__item[data-pv-item-id]').forEach(function(item) {
      var itemId = item.getAttribute('data-pv-item-id');
      if (!itemId || !state.prefetchQueuedIds[itemId] || !item.getBoundingClientRect) return;
      var rect = item.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      if (
        !bounds ||
        (rect.bottom >= bounds.top && rect.top <= bounds.bottom)
      ) {
        itemIds.push(itemId);
      }
    });

    promotePrefetchItems(state, itemIds);
  }

  function promoteBranchPrefetchItems(state, branch) {
    if (!branch) return;
    var itemIds = [];
    branch.querySelectorAll('.pv-toc__item[data-pv-item-id]').forEach(function(item) {
      var itemId = item.getAttribute('data-pv-item-id');
      if (itemId) itemIds.push(itemId);
    });
    promotePrefetchItems(state, itemIds);
  }

  function promoteFavoritePrefetchItems(state) {
    var favorites = getFavorites(state);
    var itemIds = state.selectableItemIds.filter(function(itemId) {
      return isGuideItemFavorite(state, itemId, favorites);
    });
    promotePrefetchItems(state, itemIds);
  }

  function setupPrefetchVisibilityPromotion(state) {
    if (state.prefetchVisibilityObserver) {
      state.prefetchVisibilityObserver.disconnect();
      state.prefetchVisibilityObserver = null;
    }

    if (typeof IntersectionObserver !== 'function') return;

    var observerRoot = state.elements.sidebarScroller || null;
    state.prefetchVisibilityObserver = new IntersectionObserver(function(entries) {
      var itemIds = [];
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var itemId = entry.target.getAttribute('data-pv-item-id');
        if (itemId) itemIds.push(itemId);
      });
      promotePrefetchItems(state, itemIds);
    }, {
      root: observerRoot,
      rootMargin: '120px 0px',
      threshold: 0.01,
    });

    state.root.querySelectorAll('.pv-toc__item[data-pv-item-id]').forEach(function(item) {
      state.prefetchVisibilityObserver.observe(item);
    });
  }

  function scheduleBackgroundPrefetch(state, minimumDelay) {
    if (
      !state.categoryAvailabilityPrefetchStarted ||
      state.prefetchActive ||
      !state.prefetchQueue.length ||
      state.prefetchTimer
    ) {
      return;
    }

    var now = Date.now();
    var delay = Math.max(0, Number(minimumDelay) || 0);
    delay = Math.max(delay, state.prefetchPausedUntil - now);
    if (state.foregroundActiveCount > 0) {
      delay = Math.max(delay, PREFETCH_INTERVAL_MS);
    }
    if (state.prefetchLastStartedAt) {
      delay = Math.max(delay, PREFETCH_INTERVAL_MS - (now - state.prefetchLastStartedAt));
    }

    state.prefetchTimer = window.setTimeout(function() {
      state.prefetchTimer = null;
      runNextBackgroundPrefetch(state);
    }, delay);
  }

  function deferBackgroundPrefetch(state) {
    if (!state.prefetchTimer) return;
    window.clearTimeout(state.prefetchTimer);
    state.prefetchTimer = null;
  }

  function runNextBackgroundPrefetch(state) {
    if (state.prefetchActive || state.foregroundActiveCount > 0) {
      scheduleBackgroundPrefetch(state, PREFETCH_INTERVAL_MS);
      return;
    }

    var now = Date.now();
    if (state.prefetchPausedUntil > now) {
      scheduleBackgroundPrefetch(state, state.prefetchPausedUntil - now);
      return;
    }

    var itemId = state.prefetchQueue.shift();
    if (!itemId) return;
    delete state.prefetchQueuedIds[itemId];

    if (state.categoryAvailabilityCache[itemId]) {
      setCategoryAvailabilityState(state, itemId, 'ready');
      scheduleBackgroundPrefetch(state, 0);
      return;
    }

    state.prefetchActive = true;
    state.prefetchLastStartedAt = Date.now();
    ensureCategoryAvailability(state, itemId)
      .then(function() {
        syncCategoryButtons(state, itemId, { updateHeader: false });
        updateGroupFavoriteButtons(state);
      })
      .catch(function(error) {
        if (isRateLimitError(error)) {
          pauseBackgroundPrefetch(state, error);
          enqueuePrefetchItem(state, itemId, { front: true });
        }
        syncCategoryButtons(state, itemId, { updateHeader: false });
      })
      .finally(function() {
        state.prefetchActive = false;
        scheduleBackgroundPrefetch(state, PREFETCH_INTERVAL_MS);
      });
  }

  function countSelectableChildren(node) {
    if (!node.children || node.children.length === 0) return 1;

    var count = 0;
    node.children.forEach(function(child) {
      count += countSelectableChildren(child);
    });
    return count;
  }

  function tocBranchHeadItem(branch) {
    var groupItem = branch.querySelector(':scope > .pv-toc__item[data-pv-node-type="group"]');
    if (groupItem) return groupItem;
    return branch.querySelector(':scope > .pv-toc__item[data-pv-node-type="leaf-summary"]');
  }

  function openAncestorBranches(state, itemId) {
    var item = state.root.querySelector(
      '.pv-toc__item[data-pv-item-id="' + cssEscape(itemId) + '"]'
    );
    if (!item) return;

    var parent = item.parentElement;
    while (parent && parent !== state.root) {
      if (parent.hasAttribute('data-pv-branch')) {
        var headItem = tocBranchHeadItem(parent);
        var childWrap = getChildWrap(parent);
        if (childWrap) childWrap.hidden = false;
        parent.setAttribute('data-pv-open', 'true');
        if (headItem) headItem.classList.add('pv-toc__item--open');
        var toggle = headItem ? headItem.querySelector('[data-pv-toggle]') : null;
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
      }
      parent = parent.parentElement;
    }
  }

  function toggleBranch(branch) {
    if (!branch) return false;
    var childWrap = getChildWrap(branch);
    if (!childWrap) return false;

    var nextOpen = branch.getAttribute('data-pv-open') !== 'true';
    branch.setAttribute('data-pv-open', nextOpen ? 'true' : 'false');
    childWrap.hidden = !nextOpen;

    var item = tocBranchHeadItem(branch);
    if (item) item.classList.toggle('pv-toc__item--open', nextOpen);
    var toggle = item ? item.querySelector('[data-pv-toggle]') : null;
    if (toggle) toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    return nextOpen;
  }

  function getChildWrap(branch) {
    if (!branch) return null;
    for (var index = 0; index < branch.children.length; index += 1) {
      if (branch.children[index].hasAttribute('data-pv-children')) {
        return branch.children[index];
      }
    }
    return null;
  }

  function updateCurrentLabel(state, text) {
    if (state.elements.currentLabel) {
      state.elements.currentLabel.textContent = text || '';
    }
  }

  async function openDefaultAsset(state, itemId) {
    var item = await selectCategory(state, itemId, {
      keepViewer: true,
      retryAction: function() {
        return openDefaultAsset(state, itemId);
      },
    });
    if (!item || state.currentItemId !== itemId) return;

    if (item.pdfAsset) {
      await openAsset(state, itemId, 'pdf', { categorySelected: true });
      return;
    }
    if (item.videoAsset) {
      await openAsset(state, itemId, 'video', { categorySelected: true });
    }
  }

  function viewAllMatchScore(item, format) {
    var text = [item.title, item.slug, item.path]
      .map(function(value) {
        return String(value || '').toLowerCase();
      })
      .join(' ');
    var normalized = text.replace(/[\s_-]+/g, ' ');
    var baseScore = 0;
    var formatScore = 0;

    if (normalized.indexOf('view all') !== -1) baseScore += 8;
    if (normalized.indexOf('full version') !== -1) baseScore += 8;
    if (normalized.indexOf('full guide') !== -1) baseScore += 8;
    if (normalized.indexOf('complete guide') !== -1) baseScore += 8;
    if (normalized.indexOf('all guide') !== -1) baseScore += 6;
    if (normalized.indexOf('entire guide') !== -1) baseScore += 6;
    if (normalized.indexOf('전체보기') !== -1) baseScore += 8;
    if (normalized.indexOf('전체 보기') !== -1) baseScore += 8;
    if (normalized.indexOf('전체') !== -1) baseScore += 4;

    if (!baseScore) return 0;

    if (format === 'video') {
      if (normalized.indexOf('mov') !== -1) formatScore += 5;
      if (normalized.indexOf('video') !== -1) formatScore += 5;
      if (normalized.indexOf('영상') !== -1) formatScore += 5;
    } else {
      if (normalized.indexOf('pdf') !== -1) formatScore += 5;
      if (normalized.indexOf('guidebook') !== -1) formatScore += 2;
    }

    return baseScore + formatScore;
  }

  async function openAsset(state, itemId, format, options) {
    options = options || {};
    var item = options.categorySelected
      ? state.itemsById[itemId]
      : await selectCategory(state, itemId, {
        keepViewer: true,
        retryAction: function() {
          return openAsset(state, itemId, format);
        },
      });
    if (!item || state.currentItemId !== itemId) return;

    var asset = format === 'video' ? item.videoAsset : item.pdfAsset;
    if (!asset) {
      var unavailableMessage =
        'No ' +
        (format === 'video' ? 'MOV' : 'PDF') +
        ' is available for "' +
        item.title +
        '".';
      if (state.renderedAsset) {
        showViewerStatus(state, unavailableMessage);
      } else {
        showViewerEmpty(state, unavailableMessage, { keepHeaderFormatButtons: true });
      }
      syncCategoryButtons(state, itemId);
      return;
    }

    var assetOpenToken = state.assetOpenToken + 1;
    state.assetOpenToken = assetOpenToken;
    incrementAssetOpenCount(state, asset.id);
    syncCategoryButtons(state, itemId);
    setViewerLoading(state, true);

    try {
      var signedUrl = await getForegroundSignedUrl(state, asset.id, {
        isCurrent: function() {
          return state.assetOpenToken === assetOpenToken && state.currentItemId === itemId;
        },
        retryAction: function() {
          return openAsset(state, itemId, format);
        },
      });
      if (
        !signedUrl ||
        state.assetOpenToken !== assetOpenToken ||
        state.currentItemId !== itemId
      ) {
        return;
      }
      state.currentFormat = format;
      if (format === 'pdf') {
        state.pdfZoom = PDF_ZOOM_DEFAULT;
      }
      updateCurrentLabel(
        state,
        (item.path || item.title || '') + ' · ' + (format === 'video' ? 'MOV' : 'PDF')
      );
      renderAsset(state, itemId, format, signedUrl);
      updateActiveFormatButtons(state);
      clearViewerStatus(state);
    } catch (error) {
      if (state.assetOpenToken !== assetOpenToken || state.currentItemId !== itemId) {
        return;
      }
      var message =
        error && typeof error.message === 'string'
          ? error.message
          : 'The selected asset could not be opened.';
      if (!isRateLimitError(error) || !state.manualRetryAction) {
        if (state.renderedAsset) {
          showViewerStatus(state, message);
        } else {
          showViewerEmpty(state, message, { keepHeaderFormatButtons: true });
        }
      }
    } finally {
      decrementAssetOpenCount(state, asset.id);
      syncCategoryButtons(state, itemId);
      if (state.assetOpenToken === assetOpenToken) {
        setViewerLoading(state, false);
      }
    }
  }

  function renderAsset(state, itemId, format, signedUrl) {
    var frameWrap = state.elements.frameWrap;
    var frame = state.elements.frame;
    var videoWrap = state.elements.videoWrap;
    var video = state.elements.video;
    var empty = state.elements.empty;

    state.renderedAsset = {
      itemId: itemId,
      format: format,
      signedUrl: signedUrl,
    };
    updateProtectionUi(state);
    updateFullVersionButton(state);

    if (empty) empty.style.display = 'none';

    if (format === 'video') {
      if (frameWrap) frameWrap.style.display = 'none';
      if (frame) frame.src = 'about:blank';
      resetPdfZoomFrame(state);
      updatePdfZoomControls(state, false);
      if (videoWrap) videoWrap.style.display = 'flex';
      if (video) {
        video.pause();
        video.src = signedUrl;
        video.load();
      }
      setViewerLoading(state, false);
      return;
    }

    if (videoWrap) videoWrap.style.display = 'none';
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (frameWrap) frameWrap.style.display = 'flex';
    if (frame) frame.src = buildViewerSourceUrl(format, signedUrl);
    applyPdfZoom(state);
    updatePdfZoomControls(state, true);
    if (state.warningTimer) window.clearTimeout(state.warningTimer);
    state.root.removeAttribute('data-pv-protection-warning');
    if (state.elements.warning) state.elements.warning.hidden = true;
    setViewerLoading(state, false);
  }

  function getSignedUrl(state, assetId) {
    var cached = state.signedUrlCache[assetId];
    if (cached && cached.expiresAt && Date.parse(cached.expiresAt) - Date.now() > 15000) {
      return Promise.resolve(cached.url);
    }

    if (state.signedUrlInFlight[assetId]) {
      return state.signedUrlInFlight[assetId];
    }

    var request = requestJson(state, '/assets/' + encodeURIComponent(assetId) + '/signed-url', {
      method: 'POST',
    }).then(function(data) {
      state.signedUrlCache[assetId] = {
        url: data.signedUrl,
        expiresAt: data.expiresAt,
      };
      return data.signedUrl;
    });

    var sharedRequest = request.finally(function() {
      if (state.signedUrlInFlight[assetId] === sharedRequest) {
        delete state.signedUrlInFlight[assetId];
      }
    });
    state.signedUrlInFlight[assetId] = sharedRequest;
    return sharedRequest;
  }

  async function getForegroundSignedUrl(state, assetId, options) {
    options = options || {};
    state.foregroundActiveCount += 1;
    deferBackgroundPrefetch(state);

    try {
      return await runForegroundRequestWithRateLimitRetry(state, function() {
        return getSignedUrl(state, assetId);
      }, {
        isCurrent: options.isCurrent,
        retryAction: options.retryAction,
        pendingMessage: 'Preparing your guide. Retrying shortly.',
        retryFailedMessage: 'We could not prepare this guide yet. Try again.',
      });
    } finally {
      state.foregroundActiveCount = Math.max(0, state.foregroundActiveCount - 1);
      scheduleBackgroundPrefetch(state, PREFETCH_INTERVAL_MS);
    }
  }

  async function runForegroundRequestWithRateLimitRetry(state, request, options) {
    options = options || {};
    var isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : function() { return true; };

    try {
      return await request();
    } catch (error) {
      if (!isRateLimitError(error)) throw error;

      pauseBackgroundPrefetch(state, error);
      if (!isCurrent()) throw error;
      if (typeof options.onRateLimited === 'function') {
        options.onRateLimited();
      }
      var retryDelayMs = getRateLimitCooldownMs(error);
      showViewerStatus(
        state,
        (options.pendingMessage || 'Preparing your guide. Retrying shortly.') +
          ' Retrying in about ' +
          Math.max(1, Math.ceil(retryDelayMs / 1000)) +
          ' seconds.'
      );

      var retryError = error;
      for (var attempt = 0; attempt < MAX_FOREGROUND_RATE_LIMIT_RETRY; attempt += 1) {
        await waitForDocumentVisible(retryDelayMs);
        if (!isCurrent()) return null;
        if (typeof options.onBeforeRetry === 'function') {
          options.onBeforeRetry();
        }

        try {
          return await request();
        } catch (nextError) {
          retryError = nextError;
          if (!isRateLimitError(nextError)) throw nextError;
          pauseBackgroundPrefetch(state, nextError);
          if (!isCurrent()) throw nextError;
          if (typeof options.onRateLimited === 'function') {
            options.onRateLimited();
          }
        }
      }

      if (isCurrent()) {
        showViewerStatus(
          state,
          options.retryFailedMessage || 'We could not prepare this guide yet. Try again.',
          options.retryAction
        );
      }
      throw retryError;
    }
  }

  function isRateLimitError(error) {
    return Boolean(error && (error.status === 429 || error.code === 'RATE_LIMITED'));
  }

  function getRetryAfterMs(response) {
    if (!response || !response.headers) return 0;
    var value = String(response.headers.get('retry-after') || '').trim();
    if (!value) return 0;

    var seconds = Number(value);
    if (isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }

    var dateValue = Date.parse(value);
    return isNaN(dateValue) ? 0 : Math.max(0, dateValue - Date.now());
  }

  function getRateLimitCooldownMs(error) {
    var retryAfterMs = Number(error && error.retryAfterMs);
    return isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : RATE_LIMIT_COOLDOWN_MS;
  }

  function pauseBackgroundPrefetch(state, error) {
    var pausedUntil = Date.now() + getRateLimitCooldownMs(error);
    state.prefetchPausedUntil = Math.max(state.prefetchPausedUntil, pausedUntil);

    if (state.prefetchTimer) {
      window.clearTimeout(state.prefetchTimer);
      state.prefetchTimer = null;
    }
    if (!state.prefetchActive) {
      scheduleBackgroundPrefetch(state, state.prefetchPausedUntil - Date.now());
    }
  }

  function waitForDocumentVisible(delayMs) {
    return new Promise(function(resolve) {
      var timerId = null;

      function finish() {
        if (timerId) window.clearTimeout(timerId);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        resolve();
      }

      function afterDelay() {
        if (document.visibilityState !== 'hidden') {
          finish();
          return;
        }
        document.addEventListener('visibilitychange', onVisibilityChange);
      }

      function onVisibilityChange() {
        if (document.visibilityState !== 'hidden') finish();
      }

      timerId = window.setTimeout(afterDelay, Math.max(0, Number(delayMs) || 0));
    });
  }

  function incrementAssetOpenCount(state, assetId) {
    if (!assetId) return;
    state.assetOpenCounts[assetId] = (state.assetOpenCounts[assetId] || 0) + 1;
  }

  function decrementAssetOpenCount(state, assetId) {
    if (!assetId || !state.assetOpenCounts[assetId]) return;
    state.assetOpenCounts[assetId] -= 1;
    if (state.assetOpenCounts[assetId] <= 0) {
      delete state.assetOpenCounts[assetId];
    }
  }

  function resetCategoryRequestCoordinator(state) {
    if (state.prefetchTimer) {
      window.clearTimeout(state.prefetchTimer);
    }
    if (state.prefetchVisibilityObserver) {
      state.prefetchVisibilityObserver.disconnect();
    }

    state.categoryAvailabilityState = {};
    state.categoryAvailabilityInFlight = {};
    state.categoryAvailabilityPrefetchStarted = false;
    state.prefetchQueue = [];
    state.prefetchQueuedIds = {};
    state.prefetchTimer = null;
    state.prefetchPausedUntil = 0;
    state.prefetchActive = false;
    state.prefetchLastStartedAt = 0;
    state.prefetchVisibilityObserver = null;
    state.foregroundActiveCount = 0;
  }

  function showViewerStatus(state, message, retryAction) {
    state.manualRetryAction = typeof retryAction === 'function' ? retryAction : null;
    if (state.elements.requestStatusText) {
      state.elements.requestStatusText.textContent = message || '';
    }
    if (state.elements.requestStatus) {
      state.elements.requestStatus.hidden = !message;
    }
    if (state.elements.retryAction) {
      state.elements.retryAction.hidden = typeof retryAction !== 'function';
    }
  }

  function clearViewerStatus(state) {
    state.manualRetryAction = null;
    if (state.elements.requestStatusText) {
      state.elements.requestStatusText.textContent = '';
    }
    if (state.elements.requestStatus) {
      state.elements.requestStatus.hidden = true;
    }
    if (state.elements.retryAction) {
      state.elements.retryAction.hidden = true;
    }
  }

  function setViewerLoading(state, isLoading) {
    if (state.elements.loading) {
      state.elements.loading.style.display = isLoading ? 'flex' : 'none';
    }
  }

  function showViewerEmpty(state, message, options) {
    options = options || {};
    if (!options.keepHeaderFormatButtons) {
      if (state.elements.headerFormatActions) {
        state.elements.headerFormatActions.hidden = true;
      }
      if (state.elements.headerButtonWrap) {
        state.elements.headerButtonWrap.removeAttribute('data-pv-item-buttons-for');
        state.elements.headerButtonWrap.innerHTML = '';
      }
    }
    if (state.elements.emptyText) {
      state.elements.emptyText.textContent = message || state.emptyStateText;
    }
    if (state.elements.empty) {
      state.elements.empty.style.display = '';
    }
    if (state.elements.frameWrap) {
      state.elements.frameWrap.style.display = 'none';
    }
    if (state.elements.frame) {
      state.elements.frame.src = 'about:blank';
    }
    resetPdfZoomFrame(state);
    updatePdfZoomControls(state, false);
    if (state.elements.videoWrap) {
      state.elements.videoWrap.style.display = 'none';
    }
    if (state.elements.video) {
      state.elements.video.pause();
      state.elements.video.removeAttribute('src');
      state.elements.video.load();
    }
    setViewerLoading(state, false);
    state.renderedAsset = null;
    updateProtectionUi(state);
    updateFullVersionButton(state);
    state.currentFormat = null;
    updateActiveFormatButtons(state);
  }

  function showSidebarEmpty(state, message) {
    if (state.elements.toc) {
      state.elements.toc.innerHTML = '';
    }
    if (state.elements.sidebarEmpty) {
      state.elements.sidebarEmpty.hidden = false;
      state.elements.sidebarEmpty.textContent = message || state.emptyGuidesText;
    }
  }

  function hideSidebarEmpty(state) {
    if (state.elements.sidebarEmpty) {
      state.elements.sidebarEmpty.hidden = true;
    }
  }

  function getFavorites(state) {
    if (state.favoritesClient && state.customerId) {
      var accountFavorites = {};
      state.favoritesClient.getActiveItems('GUIDEBOOK_NODE').forEach(function(item) {
        getGuideFavoriteNodeIds(item).forEach(function(nodeId) {
          accountFavorites[nodeId] = true;
        });
      });
      return accountFavorites;
    }

    try {
      return JSON.parse(window.localStorage.getItem(state.legacyFavoritesKey) || '{}');
    } catch (error) {
      return {};
    }
  }

  function setFavorites(state, favorites) {
    window.localStorage.setItem(state.legacyFavoritesKey, JSON.stringify(favorites));
  }

  function getGuideFavoriteNodeIds(favorite) {
    var nodeIds = [];
    if (!favorite || favorite.type !== 'GUIDEBOOK_NODE') return nodeIds;
    addUniqueString(nodeIds, favorite.targetId);
    if (favorite.contentRef && typeof favorite.contentRef === 'object') {
      addUniqueString(nodeIds, favorite.contentRef.nodeId);
    }
    return nodeIds;
  }

  function getGuideItemAliases(state, itemOrId) {
    var item = typeof itemOrId === 'string' ? state.itemsById[itemOrId] : itemOrId;
    var aliases = [];
    if (item && Array.isArray(item.favoriteAliases)) {
      item.favoriteAliases.forEach(function(alias) {
        addUniqueString(aliases, alias);
      });
    }
    if (item && item.id) {
      addUniqueString(aliases, item.id);
    }
    if (!item && typeof itemOrId === 'string') {
      addUniqueString(aliases, itemOrId);
    }
    return aliases;
  }

  function isGuideItemFavorite(state, itemOrId, favorites) {
    favorites = favorites || getFavorites(state);
    var aliases = getGuideItemAliases(state, itemOrId);
    return aliases.some(function(alias) {
      return Boolean(favorites[alias]);
    });
  }

  function findAccountFavoriteForItem(state, itemId) {
    if (!state.favoritesClient || !state.customerId) return null;
    var aliases = getGuideItemAliases(state, itemId);
    if (!aliases.length) return null;

    var aliasLookup = {};
    aliases.forEach(function(alias) {
      aliasLookup[alias] = true;
    });

    var activeItems = state.favoritesClient.getActiveItems('GUIDEBOOK_NODE');
    for (var index = 0; index < activeItems.length; index += 1) {
      var favoriteNodeIds = getGuideFavoriteNodeIds(activeItems[index]);
      for (var nodeIndex = 0; nodeIndex < favoriteNodeIds.length; nodeIndex += 1) {
        if (aliasLookup[favoriteNodeIds[nodeIndex]]) {
          return activeItems[index];
        }
      }
    }
    return null;
  }

  function resolveGuideFavoriteNodeId(state, itemId) {
    var activeFavorite = findAccountFavoriteForItem(state, itemId);
    var activeNodeIds = getGuideFavoriteNodeIds(activeFavorite);
    if (activeNodeIds.length) return activeNodeIds[0];

    var aliases = getGuideItemAliases(state, itemId);
    return aliases[0] || itemId;
  }

  function buildGuideFavoriteChange(state, itemId, action) {
    var item = state.itemsById[itemId];
    var nodeId = resolveGuideFavoriteNodeId(state, itemId);
    return {
      type: 'GUIDEBOOK_NODE',
      targetId: nodeId,
      action: action,
      display: {
        title: item && item.title ? item.title : nodeId,
        pathLabel: item && item.path ? item.path : (item && item.title ? item.title : nodeId)
      },
      contentRef: {
        nodeId: nodeId
      }
    };
  }

  function migrateLegacyGuideFavorites(state) {
    if (!state.favoritesClient || !state.customerId) return;

    var migration = state.favoritesClient.getMigrationState();
    if (migration.guidebookLegacyPvFavMigratedAt) return;

    var seenTargets = {};
    var changes = [];

    try {
      for (var index = 0; index < window.localStorage.length; index += 1) {
        var key = window.localStorage.key(index);
        if (!key || key.indexOf('pv-fav-') !== 0) continue;

        var favorites = JSON.parse(window.localStorage.getItem(key) || '{}');
        if (!favorites || typeof favorites !== 'object' || Array.isArray(favorites)) continue;

        Object.keys(favorites).forEach(function(itemId) {
          if (!favorites[itemId] || seenTargets[itemId]) return;
          var item = state.itemsById[itemId];
          if (!item || !item.selectable) return;
          seenTargets[itemId] = true;
          changes.push(buildGuideFavoriteChange(state, itemId, 'ADD'));
        });
      }
    } catch (error) {}

    if (changes.length) {
      state.favoritesClient.queueChanges(changes);
    }

    migration.guidebookLegacyPvFavMigratedAt = new Date().toISOString();
    state.favoritesClient.setMigrationState(migration);
  }

  function toggleGroupFavorites(state, groupNodeId) {
    var group = state.itemsById[groupNodeId];
    if (!group || !group.children) return;
    var ids = collectSelectableDescendantIds(group);
    if (!ids.length) return;

    var favorites = getFavorites(state);
    var allFavorite = ids.every(function(id) {
      return isGuideItemFavorite(state, id, favorites);
    });

    if (state.favoritesClient && state.customerId) {
      state.favoritesClient.queueChanges(ids.map(function(id) {
        return buildGuideFavoriteChange(state, id, allFavorite ? 'REMOVE' : 'ADD');
      }));
    } else {
      ids.forEach(function(id) {
        if (allFavorite) {
          delete favorites[id];
        } else {
          favorites[id] = true;
        }
      });
      setFavorites(state, favorites);
    }

    ids.forEach(function(id) {
      applyFavoriteState(state, id);
    });
    buildFavoritesList(state);
    updateGroupFavoriteButtons(state);
  }

  function updateGroupFavoriteButtons(state) {
    var seen = Object.create(null);
    state.root.querySelectorAll('[data-pv-fav-group]').forEach(function(el) {
      var gid = el.getAttribute('data-pv-fav-group');
      if (!gid || seen[gid]) return;
      seen[gid] = true;
      applyGroupFavoriteState(state, gid);
    });
  }

  function applyGroupFavoriteState(state, groupNodeId) {
    var group = state.itemsById[groupNodeId];
    if (!group || !group.children) return;
    var ids = collectSelectableDescendantIds(group);
    if (!ids.length) return;

    var favorites = getFavorites(state);
    var allFavorite = ids.every(function(id) {
      return isGuideItemFavorite(state, id, favorites);
    });

    state.root
      .querySelectorAll('[data-pv-fav-group="' + cssEscape(groupNodeId) + '"]')
      .forEach(function(button) {
        var item = button.closest('.pv-toc__item');
        if (item) item.classList.toggle('is-fav', allFavorite);
        button.setAttribute(
          'aria-label',
          allFavorite ? 'Remove all sub-items from favorites' : 'Add all sub-items to favorites'
        );
        button.setAttribute(
          'title',
          allFavorite ? 'Remove all sub-items from favorites' : 'Add all sub-items to favorites'
        );
      });
  }

  function toggleFavorite(state, itemId) {
    if (!itemId) return;

    if (state.favoritesClient && state.customerId) {
      state.favoritesClient.toggle(buildGuideFavoriteChange(state, itemId));
    } else {
      var favorites = getFavorites(state);
      if (favorites[itemId]) {
        delete favorites[itemId];
      } else {
        favorites[itemId] = true;
      }
      setFavorites(state, favorites);
    }
    applyFavoriteState(state, itemId);
    buildFavoritesList(state);
    updateGroupFavoriteButtons(state);
  }

  function applyFavoriteState(state, itemId) {
    var favorites = getFavorites(state);
    state.root
      .querySelectorAll('[data-pv-fav="' + cssEscape(itemId) + '"]')
      .forEach(function(button) {
        var item = button.closest('.pv-toc__item');
        var active = isGuideItemFavorite(state, itemId, favorites);
        if (item) item.classList.toggle('is-fav', active);
        button.setAttribute('aria-label', active ? 'Remove from favorites' : 'Add to favorites');
        button.setAttribute('title', active ? 'Remove from favorites' : 'Add to favorites');
      });
  }

  function buildFavoritesList(state) {
    var list = state.elements.favoritesList;
    var empty = state.elements.favoritesEmpty;
    if (!list || !empty) return;

    var favorites = getFavorites(state);
    list.innerHTML = '';

    var favoriteItems = state.selectableItemIds
      .map(function(itemId) {
        return state.itemsById[itemId];
      })
      .filter(function(item) {
        return item && isGuideItemFavorite(state, item, favorites);
      });

    favoriteItems.forEach(function(item) {
      var row = createElement('div', {
        className: 'pv-sidebar__favorite-item',
      });
      var button = createElement('button', {
        className: 'pv-sidebar__favorite-link',
        attrs: {
          type: 'button',
          'data-pv-favorite-link': item.id,
        },
        text: item.path || item.title || item.id,
      });

      var actions = createElement('div', {
        className: 'pv-sidebar__favorite-actions',
      });
      var pdfButton = createElement('button', {
        className: 'pv-toc__format-btn pv-toc__format-btn--favorite',
        attrs: {
          type: 'button',
          'data-pv-favorite-open-format': 'pdf',
          'data-pv-item-id': item.id,
        },
        text: 'PDF',
      });
      var movButton = createElement('button', {
        className: 'pv-toc__format-btn pv-toc__format-btn--favorite',
        attrs: {
          type: 'button',
          'data-pv-favorite-open-format': 'video',
          'data-pv-item-id': item.id,
        },
        text: 'MOV',
      });
      applyFormatButtonAvailability(state, pdfButton, item, 'pdf', false);
      applyFormatButtonAvailability(state, movButton, item, 'video', false);
      actions.appendChild(pdfButton);
      actions.appendChild(movButton);
      row.appendChild(button);
      row.appendChild(actions);
      list.appendChild(row);
    });

    empty.style.display = favoriteItems.length > 0 ? 'none' : 'block';
  }

  function setFavoritesView(state, on) {
    if (state.elements.sidebar) {
      state.elements.sidebar.setAttribute('data-pv-view', on ? 'favorites' : 'toc');
    }
    if (state.elements.favoritesPanel) {
      state.elements.favoritesPanel.hidden = !on;
      state.elements.favoritesPanel.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    if (state.elements.showFavorites) {
      state.elements.showFavorites.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (on) {
      buildFavoritesList(state);
    }
  }

  function updateActiveFormatButtons(state) {
    state.root
      .querySelectorAll('[data-pv-open-format]')
      .forEach(function(button) {
        var buttonFormat = button.getAttribute('data-pv-open-format');
        var buttonItemId = button.getAttribute('data-pv-item-id') || state.currentItemId;
        var active = Boolean(
          state.currentItemId &&
            state.currentFormat &&
            buttonItemId === state.currentItemId &&
            buttonFormat === state.currentFormat
        );
        button.classList.toggle('is-active', active);
      });
  }

  function updateFullVersionButton(state) {
    if (!state.elements.openFull) return;
    var enabled = Boolean(
      state.renderedAsset &&
        state.renderedAsset.signedUrl &&
        state.renderedAsset.itemId === state.currentItemId &&
        state.renderedAsset.format !== 'pdf'
    );
    state.elements.openFull.hidden = !enabled;
    state.elements.openFull.disabled = !enabled;
  }

  function createElement(tagName, options) {
    options = options || {};
    var element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text) element.textContent = options.text;
    if (options.html) element.innerHTML = options.html;
    if (options.attrs) {
      Object.keys(options.attrs).forEach(function(name) {
        element.setAttribute(name, options.attrs[name]);
      });
    }
    return element;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }
})();
