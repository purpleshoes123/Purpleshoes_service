(function () {
  'use strict';

  function preserveAttribution(root) {
    var current = new URL(window.location.href);
    if (current.protocol !== 'https:' && current.protocol !== 'http:') return;
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'fbclid', 'msclkid'];
    root.querySelectorAll('[data-skv-cta]').forEach(function (link) {
      var destination = new URL(link.getAttribute('href'), window.location.origin);
      if (destination.origin !== window.location.origin) return;
      keys.forEach(function (key) {
        if (current.searchParams.has(key)) destination.searchParams.set(key, current.searchParams.get(key));
      });
      link.href = destination.pathname + destination.search + destination.hash;
    });
  }

  function initGuidebook(root) {
    var viewer = root.querySelector('[data-skv-pdf-mobile]');
    if (!viewer || viewer.dataset.initialized) return;
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
      viewer.querySelector('.skv__pdf-page').scrollTop = 0;
      image.alt = (viewer.getAttribute('data-page-description') || 'Starter Guidebook page __NUMBER__').replace('__NUMBER__', number);
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
      var trigger = root.querySelector('[data-skv-pdf-fullscreen]');
      if (trigger) trigger.focus();
    });
    showPage(1);
  }

  function initMapVideo(root) {
    var video = root.querySelector('[data-skv-map-video]');
    var button = root.querySelector('[data-skv-map-play]');
    var status = root.querySelector('[data-skv-map-status]');
    if (!video || !button || video.dataset.initialized) return;
    video.dataset.initialized = 'true';
    button.hidden = false;
    button.addEventListener('click', function () {
      button.hidden = true;
      if (status) status.hidden = true;
      var attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(function () {
          button.hidden = false;
          if (status) status.hidden = false;
        });
      }
    });
    video.addEventListener('play', function () {
      button.hidden = true;
      if (status) status.hidden = true;
    });
    video.addEventListener('error', function () {
      button.hidden = true;
      if (status) status.hidden = false;
    });
  }

  function openPdfFullscreen(button) {
    var targetId = button.getAttribute('data-skv-pdf-target');
    var frame = targetId ? document.getElementById(targetId) : null;
    if (!frame) return;

    frame.classList.add('is-expanded');
    var closeButton = frame.querySelector('[data-skv-pdf-close]');
    if (closeButton) closeButton.focus();
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-skv-pdf-fullscreen]');
    if (!button) return;
    event.preventDefault();
    openPdfFullscreen(button);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('[data-skv-pdf-mobile].is-expanded [data-skv-pdf-close]').forEach(function (button) {
      button.click();
    });
  });

  function initViewer(root) {
    if (root.dataset.skvInitialized) return;
    root.dataset.skvInitialized = 'true';
    preserveAttribution(root);
    initMapVideo(root);
    initGuidebook(root);
  }

  document.querySelectorAll('[data-section="starter-kit-viewer"]').forEach(initViewer);
  document.addEventListener('shopify:section:load', function (event) {
    event.target.querySelectorAll('[data-section="starter-kit-viewer"]').forEach(initViewer);
  });
})();
