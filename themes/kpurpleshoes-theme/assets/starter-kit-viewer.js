(function () {
  'use strict';

  function initMobilePdf(root) {
    var viewer = root.querySelector('[data-skv-pdf-mobile]');
    if (!viewer || viewer.dataset.initialized || !window.matchMedia('(max-width: 760px)').matches) return;
    viewer.dataset.initialized = 'true';

    var image = viewer.querySelector('[data-skv-pdf-image]');
    var pages = Array.prototype.map.call(viewer.querySelectorAll('[data-skv-pdf-page-url]'), function (page) {
      return page.getAttribute('data-skv-pdf-page-url');
    });
    var count = viewer.querySelector('[data-skv-pdf-count]');
    var previous = viewer.querySelector('[data-skv-pdf-prev]');
    var next = viewer.querySelector('[data-skv-pdf-next]');
    var close = viewer.querySelector('[data-skv-pdf-close]');
    var currentPage = 1;

    function showPage(number) {
      if (number < 1 || number > pages.length) return;
      currentPage = number;
      image.src = pages[number - 1];
      image.alt = 'Starter Guidebook page ' + number + ' of ' + pages.length;
      count.textContent = number + ' / ' + pages.length;
      previous.disabled = number === 1;
      next.disabled = number === pages.length;
      if (number < pages.length) {
        var preload = new Image();
        preload.src = pages[number];
      }
    }

    previous.addEventListener('click', function () {
      showPage(currentPage - 1);
    });
    next.addEventListener('click', function () {
      showPage(currentPage + 1);
    });
    close.addEventListener('click', function () {
      viewer.classList.remove('is-expanded');
    });
    showPage(1);
  }

  function syncDesktopPdf(root) {
    var frame = root.querySelector('.skv__pdf');
    if (!frame) return;
    if (window.matchMedia('(max-width: 760px)').matches) {
      if (frame.hasAttribute('src')) frame.removeAttribute('src');
      return;
    }
    if (!frame.hasAttribute('src')) frame.src = frame.getAttribute('data-pdf-url') + '#toolbar=0';
  }

  function updateConversionCta(root, state) {
    var title = root.querySelector('[data-skv-cta-title]');
    var copy = root.querySelector('[data-skv-cta-copy]');
    var cta = root.querySelector('[data-skv-cta]');
    if (!title || !copy || !cta) return;

    var guideKitUrl = root.getAttribute('data-guide-kit-url') || '/products/korea-guide-kit';
    if (state === 'guide50') {
      copy.textContent = 'Your 50% Welcome Offer is ready.';
      cta.textContent = 'View My 50% Welcome Offer';
      cta.href = guideKitUrl;
      return;
    }

    if (state === 'customer') {
      copy.textContent = 'Explore the complete Korea Guide Kit and see everything included.';
      cta.textContent = 'Explore the Korea Guide Kit';
      cta.href = guideKitUrl;
      return;
    }

    copy.textContent = 'Create your account to unlock your 50% Welcome Offer for 24 hours.';
    cta.textContent = 'Create My Account';
    cta.href = '/';
  }

  function loadCouponState(root) {
    var customerId = root.getAttribute('data-customer-id');
    if (!customerId) {
      updateConversionCta(root, 'guest');
      return;
    }

    var endpoint = root.getAttribute('data-coupon-summary-endpoint');
    if (!endpoint) {
      updateConversionCta(root, 'customer');
      return;
    }

    var separator = endpoint.indexOf('?') === -1 ? '?' : '&';
    var url = endpoint + separator + 'logged_in_customer_id=' + encodeURIComponent(customerId) + '&_ts=' + Date.now();
    Promise.resolve(window.psWelcomeOfferReady).then(function () {
      return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    })
      .then(function (response) {
        if (!response.ok) throw new Error('Coupon summary unavailable');
        return response.json();
      })
      .then(function (payload) {
        var summary = payload && payload.data ? payload.data : payload;
        var guide50 = summary && summary.coupons && summary.coupons.guide50;
        updateConversionCta(root, guide50 && guide50.available === true ? 'guide50' : 'customer');
      })
      .catch(function () {
        updateConversionCta(root, 'customer');
      });
  }

  function openPdfFullscreen(button) {
    var targetId = button.getAttribute('data-skv-pdf-target');
    var frame = targetId ? document.getElementById(targetId) : null;
    if (!frame) return;

    if (window.matchMedia('(max-width: 760px)').matches) {
      var mobileViewer = frame.parentElement.querySelector('[data-skv-pdf-mobile]');
      if (mobileViewer) {
        mobileViewer.classList.add('is-expanded');
        return;
      }
    }

    var requestFullscreen = frame.requestFullscreen || frame.webkitRequestFullscreen || frame.msRequestFullscreen;
    if (requestFullscreen) {
      Promise.resolve(requestFullscreen.call(frame)).catch(function () {
        window.open(frame.getAttribute('data-pdf-url') || frame.src, '_blank', 'noopener');
      });
      return;
    }

    window.open(frame.getAttribute('data-pdf-url') || frame.src, '_blank', 'noopener');
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-skv-pdf-fullscreen]');
    if (!button) return;
    event.preventDefault();
    openPdfFullscreen(button);
  });

  document.querySelectorAll('[data-section="starter-kit-viewer"]').forEach(function (root) {
    loadCouponState(root);
    syncDesktopPdf(root);
    initMobilePdf(root);
    window.addEventListener('resize', function () {
      syncDesktopPdf(root);
      initMobilePdf(root);
    });
  });
})();
