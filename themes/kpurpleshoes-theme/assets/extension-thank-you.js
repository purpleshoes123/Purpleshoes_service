(function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  var KST_OFFSET_MS = 9 * 60 * 60 * 1000;

  function kstDateStartMs(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return null;
    var kstDate = new Date(date.getTime() + KST_OFFSET_MS);
    return Date.UTC(
      kstDate.getUTCFullYear(),
      kstDate.getUTCMonth(),
      kstDate.getUTCDate()
    );
  }

  // The entitlement is stored at the end of its KST calendar day. Count
  // calendar-day boundaries in KST, rather than rounding the remaining hours
  // up, so a 60-day extension adds exactly 60 days (never 61).
  function remainingDays(expiresAtKst, now) {
    var expiryDay = kstDateStartMs(expiresAtKst);
    var today = kstDateStartMs(now || new Date());
    if (expiryDay === null || today === null) return null;
    return Math.max(0, Math.floor((expiryDay - today) / DAY));
  }

  function formatEnd(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Seoul'
    }).format(date);
  }

  function selectActiveEntitlement(items) {
    return (items || [])
      .filter(function (item) { return item && item.status === 'ACTIVE' && item.expiresAtKst; })
      .sort(function (a, b) { return new Date(b.expiresAtKst) - new Date(a.expiresAtKst); })[0] || null;
  }

  function render(root, item) {
    var status = root.querySelector('[data-extension-status]');
    var days = root.querySelector('[data-extension-days]');
    var ends = root.querySelector('[data-extension-ends]');
    var copy = root.querySelector('[data-extension-copy]');
    if (!item) {
      if (status) status.textContent = 'Check My Page';
      if (days) days.textContent = '—';
      if (ends) ends.textContent = '—';
      if (copy) copy.textContent = 'Your guide access details are available in My Page.';
      return;
    }
    var remaining = remainingDays(item.expiresAtKst);
    var extensionDays = Number(item.extensionDays);
    if (status) status.textContent = 'Active';
    if (days) days.textContent = remaining === null
      ? '—'
      : remaining + (remaining === 1 ? ' day' : ' days');
    if (ends) ends.textContent = formatEnd(item.expiresAtKst);
    if (copy) {
      copy.textContent = Number.isFinite(extensionDays) && extensionDays > 0
        ? 'Your ' + extensionDays + '-day extension is now active.'
        : 'Your guide access extension is now active.';
    }
  }

  function load(root) {
    var customerId = root.getAttribute('data-customer-id');
    var endpoint = root.getAttribute('data-entitlements-endpoint');
    if (!customerId || !endpoint) return render(root, null);
    var joiner = endpoint.indexOf('?') === -1 ? '?' : '&';
    fetch(endpoint + joiner + 'logged_in_customer_id=' + encodeURIComponent(customerId) + '&_ts=' + Date.now(), {
      credentials: 'same-origin', headers: { Accept: 'application/json' }
    })
      .then(function (response) { if (!response.ok) throw new Error('Unavailable'); return response.json(); })
      .then(function (payload) {
        var data = payload && payload.data ? payload.data : payload;
        render(root, selectActiveEntitlement(data && data.items));
      })
      .catch(function () { render(root, null); });
  }

  document.querySelectorAll('[data-section="extension-thank-you"]').forEach(load);
})();
