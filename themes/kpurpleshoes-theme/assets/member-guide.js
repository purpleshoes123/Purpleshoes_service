(function () {
  'use strict';
  document.querySelectorAll('[data-member-guide]').forEach(function (root) {
    var copy = JSON.parse(root.querySelector('[data-member-copy]').textContent);
    var status = root.querySelector('[data-member-status]');
    var grid = root.querySelector('[data-member-plans]');
    var retry = root.querySelector('[data-member-retry]');
    var dialog = root.querySelector('[data-member-upgrade]');
    var upgradePrice = root.querySelector('[data-upgrade-price]');
    var upgradeButton = root.querySelector('[data-upgrade-accept]');
    var keepButton = root.querySelector('[data-upgrade-keep]');
    var upgradeSavings = root.querySelector('[data-upgrade-savings]');
    var onlyCoupon = root.querySelector('[data-only-coupon]');
    var onlyExtra = root.querySelector('[data-only-extra]');
    var onlyTotal = root.querySelector('[data-only-total]');
    var extensionDialog = root.querySelector('[data-member-extension]');
    var pendingChoice;
    var busy = false;
    var countdownInterval = null;
    async function request(path, body) {
      if (new URLSearchParams(window.location.search).get('private_checkout_preview') === '1') {
        path += (path.includes('?') ? '&' : '?') + 'private_checkout_preview=1';
      }
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 12000);
      try {
      var response = await fetch('/apps/bta-booking' + path, {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      var envelope = await response.json();
      if (!response.ok || !envelope.data) throw new Error('Member request failed');
      return envelope.data;
      } finally { clearTimeout(timeout); }
    }
    function element(tag, text) {
      var node = document.createElement(tag);
      if (text) node.textContent = text;
      return node;
    }
    async function load() {
      clearInterval(countdownInterval);
      countdownInterval = null;
      grid.querySelectorAll('[data-plan-purchase]').forEach(function (slot) { slot.replaceChildren(); }); retry.hidden = true; status.textContent = copy.loading;
      try {
        if (window.psWelcomeOfferReady) await window.psWelcomeOfferReady;
        var data = await request('/member/catalog?key=guide-plans');
        if (data.kind !== 'guide') throw new Error('Invalid member catalog');
        if (!Array.isArray(data.plans) || !data.plans.length) throw new Error('Empty member catalog');
        var eligibility = await request('/guide-purchase/eligibility?variantId=' + encodeURIComponent(data.plans[0].variantId));
        if (typeof eligibility.canPurchaseBase !== 'boolean') throw new Error('Invalid access status');
        var canPurchase = eligibility.canPurchaseBase;
        var extensionTypes = eligibility.nextAction && eligibility.nextAction.extensionEligibleTypes;
        if (!canPurchase && (!Array.isArray(extensionTypes) || !extensionTypes.length)) throw new Error('Missing extension options');
        var format = new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency: data.currency });
        var bundle = data.plans.find(function (plan) { return plan.kind === 'BUNDLE'; });
        var welcome = null;
        var serverOffset = 0;
        if (canPurchase && bundle && bundle.memberPriceCents < bundle.priceCents) {
          try {
            var summary = await request('/coupons/summary');
            serverOffset = summary.serverTime && Number.isFinite(summary.serverTime.nowMs) ? summary.serverTime.nowMs - Date.now() : 0;
            var offer = summary.coupons && summary.coupons.guide50;
            if (offer && offer.available) {
              var deadline = typeof offer.expiresAt === 'number' ? offer.expiresAt : Date.parse(offer.expiresAt);
              if (!Number.isFinite(deadline) && offer.ttlSeconds > 0) deadline = Date.now() + serverOffset + offer.ttlSeconds * 1000;
              if (Number.isFinite(deadline) && deadline > Date.now() + serverOffset) welcome = { deadline: deadline, percent: Math.round(offer.percentRate * 100) };
            }
          } catch (_error) {}
        }
        function money(cents) { return format.format(cents / 100) + ' ' + data.currency; }
        function kitPrice(plan) { return plan.extraAvailable ? plan.extraPriceCents : plan.memberPriceCents; }
        function kitSavings(plan) {
          var percent = plan.priceCents > 0 ? Math.round((1 - plan.memberPriceCents / plan.priceCents) * 100) : 0;
          var extra = plan.extraAvailable ? plan.memberPriceCents - plan.extraPriceCents : 0;
          var text = percent > 0 && extra > 0 ? copy.kit_percent_extra : percent > 0 ? copy.kit_percent : extra > 0 ? copy.kit_extra : copy.estimate;
          return text.replace('[percent]', String(percent)).replace('[amount]', format.format(extra / 100));
        }
        async function checkout(plan, useExtra, requestId) {
          if (busy) return;
          busy = true; status.textContent = copy.working;
          root.querySelectorAll('button, input').forEach(function (node) { node.disabled = true; });
          try {
            var prepared = await request('/guide/prepare-checkout?checkoutMode=private_draft', { variantId: plan.variantId, quantity: 1, useExtra10: useExtra, clientRequestId: requestId });
            if (!prepared.checkoutUrl || prepared.checkoutMode !== 'private_draft') throw new Error('Private checkout not ready');
            var url = new URL(prepared.checkoutUrl);
            if (url.protocol !== 'https:' || !['kpurpleshoes.com', 'eafxf4-t9.myshopify.com', 'checkout.shopify.com'].includes(url.hostname)) throw new Error('Invalid checkout host');
            window.location.assign(url.href);
          } catch (_error) {
            status.textContent = copy.error; busy = false;
            root.querySelectorAll('button, input').forEach(function (node) { node.disabled = false; });
          }
        }
        data.plans.forEach(function (plan) {
          var card = Array.from(grid.querySelectorAll('[data-plan-kind]')).find(function (item) { return item.dataset.planKind === plan.kind; });
          if (!card) throw new Error('Missing plan card');
          var purchase = card.querySelector('[data-plan-purchase]');
          var price = element('strong'); price.className = 'tg-pricing-card__amount';
          var extensionType = extensionTypes && (extensionTypes.includes(plan.kind) ? plan.kind : extensionTypes.includes('BUNDLE') ? 'BUNDLE' : extensionTypes[0]);
          var button = element('button', canPurchase ? card.dataset.planCta || copy.checkout : copy.extend_access); button.type = 'button'; button.className = 'tg-pricing-card__btn';
          var requestId = crypto.randomUUID();
          var priceWrap = element('div'); priceWrap.className = 'tg-pricing-card__price';
          var discountedKit = canPurchase && plan.kind === 'BUNDLE' && kitPrice(plan) < plan.priceCents;
          if (discountedKit) {
            var regular = element('s', money(plan.priceCents)); regular.className = 'ps-member-guide__regular-price';
            priceWrap.append(regular); price.className += ' tg-pricing-card__discount';
          }
          price.textContent = canPurchase ? money(plan.kind === 'BUNDLE' ? kitPrice(plan) : plan.priceCents) : copy.extend_price;
          priceWrap.append(price);
          var payOnce = element('p', copy.pay_once); payOnce.className = 'tg-pricing-card__pay-once';
          purchase.append(priceWrap, payOnce);
          if (canPurchase && plan.kind === 'BUNDLE') {
            var estimate = element('p', kitSavings(plan)); estimate.className = 'tg-pricing-card__discount-note';
            purchase.append(estimate);
            if (welcome) {
              var countdown = element('div'); countdown.className = 'tg-pricing-card__countdown-wrap';
              var timerLabel = element('span', copy.welcome_timer.replace('[percent]', String(welcome.percent))); timerLabel.className = 'tg-pricing-card__countdown-label';
              var timerText = element('span'); timerText.className = 'tg-pricing-card__countdown-num';
              countdown.append(timerLabel, timerText); purchase.append(countdown);
              function tick() {
                if (!root.isConnected) { clearInterval(countdownInterval); return; }
                var remaining = Math.max(0, Math.ceil((welcome.deadline - Date.now() - serverOffset) / 1000));
                timerText.textContent = [Math.floor(remaining / 3600), Math.floor(remaining / 60) % 60, remaining % 60].map(function (value) { return String(value).padStart(2, '0'); }).join(':');
                if (!remaining) {
                  clearInterval(countdownInterval); countdown.hidden = true;
                  if (!busy) { dialog.close(); pendingChoice = null; load(); }
                }
              }
              tick(); countdownInterval = setInterval(tick, 1000);
            }
          }
          purchase.append(button);
          button.addEventListener('click', async function () {
            if (busy) return;
            if (!canPurchase) {
              extensionDialog.showModal();
              document.dispatchEvent(new CustomEvent('guide-extension:select-type', { detail: { type: extensionType } }));
              return;
            }
            if (bundle && plan.kind !== 'BUNDLE') {
              pendingChoice = { plan: plan, useExtra: plan.extraAvailable, requestId: requestId, bundle: bundle, bundleRequestId: crypto.randomUUID(), checkout: checkout, money: money };
              upgradePrice.textContent = money(kitPrice(bundle));
              upgradeSavings.textContent = kitSavings(bundle);
              onlyExtra.checked = plan.extraAvailable;
              onlyCoupon.hidden = !plan.extraAvailable;
              onlyTotal.textContent = copy.only_total.replace('[amount]', money(plan.extraAvailable ? plan.extraPriceCents : plan.memberPriceCents));
              dialog.showModal();
            } else { await checkout(plan, plan.extraAvailable, requestId); }
          });
        });
        status.textContent = canPurchase ? '' : copy.extend_hint;
      } catch (_error) { status.textContent = copy.error; retry.hidden = false; }
    }
    retry.addEventListener('click', load);
    root.querySelector('[data-extension-close]').addEventListener('click', function () { extensionDialog.close(); });
    root.querySelector('[data-upgrade-close]').addEventListener('click', function () { dialog.close(); });
    onlyExtra.addEventListener('change', function () {
      if (!pendingChoice || busy) return;
      pendingChoice.useExtra = onlyExtra.checked && pendingChoice.plan.extraAvailable;
      pendingChoice.requestId = crypto.randomUUID();
      onlyTotal.textContent = copy.only_total.replace('[amount]', pendingChoice.money(pendingChoice.useExtra ? pendingChoice.plan.extraPriceCents : pendingChoice.plan.memberPriceCents));
    });
    upgradeButton.addEventListener('click', function () {
      if (!pendingChoice || busy) return;
      dialog.close(); pendingChoice.checkout(pendingChoice.bundle, pendingChoice.bundle.extraAvailable, pendingChoice.bundleRequestId);
    });
    keepButton.addEventListener('click', function () {
      if (!pendingChoice || busy) return;
      dialog.close(); pendingChoice.checkout(pendingChoice.plan, pendingChoice.useExtra, pendingChoice.requestId);
    });
    load();
  });
})();
