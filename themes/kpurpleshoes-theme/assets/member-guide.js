(function () {
  "use strict";
  document.querySelectorAll("[data-member-guide]").forEach(function (root) {
    var copy = JSON.parse(root.querySelector("[data-kit-copy]").textContent);
    var status = root.querySelector("[data-member-status]");
    var retry = root.querySelector("[data-member-retry]");
    var dialog = root.querySelector("[data-member-upgrade]");
    var extensionDialog = root.querySelector("[data-member-extension]");
    var onlyExtra = root.querySelector("[data-only-extra]");
    var bottom = document.querySelector("[data-kit-bottom]");
    var shareDialog = root.querySelector("[data-kit-share-dialog]");
    var catalog,
      access,
      summary,
      pendingChoice,
      selectedExtension = null;
    var busy = false,
      sharing = false,
      loading = false,
      countdownInterval = null;
    var ids = {};
    async function request(path, body) {
      if (new URLSearchParams(window.location.search).get("private_checkout_preview") === "1") {
        path += (path.includes("?") ? "&" : "?") + "private_checkout_preview=1";
      }
      var controller = new AbortController();
      var timeout = setTimeout(function () {
        controller.abort();
      }, 12000);
      try {
        var response = await fetch("/apps/bta-booking" + path, {
          method: body ? "POST" : "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        var envelope = await response.json();
        if (!response.ok || !envelope.data) {
          throw new Error("Member request failed");
        }
        return envelope.data;
      } finally {
        clearTimeout(timeout);
      }
    }
    function element(tag, text, className) {
      var node = document.createElement(tag);
      if (text) {
        node.textContent = text;
      }
      if (className) {
        node.className = className;
      }
      return node;
    }
    function find(selector) {
      return root.querySelector(selector);
    }
    function set(selector, value) {
      find(selector).textContent = value;
    }
    function planFor(kind) {
      return catalog.plans.find(function (plan) {
        return plan.kind === kind;
      });
    }
    function kitPrice(plan) {
      return plan.extraAvailable ? plan.extraPriceCents : plan.memberPriceCents;
    }
    function money(cents) {
      return (
        catalog.currency +
        " " +
        new Intl.NumberFormat(document.documentElement.lang || "en", {
          maximumFractionDigits: 2,
        }).format(cents / 100)
      );
    }
    function eligibleTypes() {
      return (access.nextAction && access.nextAction.extensionEligibleTypes) || [];
    }
    function button(label, action, disabled) {
      var node = element("button", label, "kgd__button");
      node.type = "button";
      node.disabled = !!disabled;
      node.addEventListener("click", action);
      return node;
    }
    function syncDisabled() {
      root.querySelectorAll("[data-plan-purchase] button").forEach(function (node) {
        node.disabled = busy || sharing || loading || node.dataset.ineligible === "true";
      });
      [find("[data-upgrade-accept]"), find("[data-upgrade-keep]"), onlyExtra].forEach(
        function (node) {
          node.disabled = busy || sharing || loading;
        },
      );
      if (bottom) {
        bottom.disabled = busy || sharing || loading || !catalog;
      }
    }
    async function checkout(plan, useExtra, requestId) {
      if (busy || sharing || loading) {
        return;
      }
      busy = true;
      status.textContent = copy.working;
      root.querySelectorAll("button, input").forEach(function (node) {
        node.disabled = true;
      });
      if (bottom) {
        bottom.disabled = true;
      }
      try {
        var prepared = await request("/guide/prepare-checkout?checkoutMode=private_draft", {
          variantId: plan.variantId,
          quantity: 1,
          useExtra10: useExtra,
          clientRequestId: requestId,
        });
        if (!prepared.checkoutUrl || prepared.checkoutMode !== "private_draft") {
          throw new Error("Private checkout not ready");
        }
        var url = new URL(prepared.checkoutUrl);
        if (
          url.protocol !== "https:" ||
          !["kpurpleshoes.com", "eafxf4-t9.myshopify.com", "checkout.shopify.com"].includes(
            url.hostname,
          )
        ) {
          throw new Error("Invalid checkout host");
        }
        window.location.assign(url.href);
      } catch (_error) {
        status.textContent = copy.error;
        busy = false;
        root.querySelectorAll("button, input").forEach(function (node) {
          node.disabled = false;
        });
        syncDisabled();
      }
    }
    function extend(kind) {
      if (busy || loading || sharing || !eligibleTypes().includes(kind)) {
        return;
      }
      selectedExtension = kind;
      extensionDialog.showModal();
      document.dispatchEvent(
        new CustomEvent("guide-extension:select-type", { detail: { type: kind } }),
      );
    }
    function popup() {
      var p = pendingChoice.plan,
        bundle = planFor("BUNDLE");
      var amount = pendingChoice.useExtra ? p.extraPriceCents : p.memberPriceCents;
      var kitAmount = kitPrice(bundle),
        delta = kitAmount - amount;
      set("[data-upgrade-title]", copy[p.kind === "PDF" ? "pdf_upgrade" : "video_upgrade"]);
      set("[data-upgrade-benefit]", copy[p.kind === "PDF" ? "pdf_benefit" : "video_benefit"]);
      set("[data-only-name]", copy[p.kind]);
      set("[data-only-total]", money(amount));
      set(
        "[data-only-summary]",
        copy.regular_popup.replace("[amount]", money(p.priceCents)) +
          (pendingChoice.useExtra ? " · " + copy.popup_extra : ""),
      );
      set("[data-upgrade-price]", money(kitAmount));
      var savings = copy.regular_popup.replace("[amount]", money(bundle.priceCents));
      if (bundle.memberPriceCents < bundle.priceCents) {
        savings += " · " + copy.popup_welcome;
      }
      if (bundle.extraAvailable) {
        savings += " · " + copy.popup_extra;
      }
      set("[data-upgrade-savings]", savings);
      var difference =
        delta > 0
          ? copy[p.kind === "PDF" ? "more_pdf" : "more_video"]
          : delta < 0
            ? copy.less
            : copy.same;
      set("[data-upgrade-difference]", difference.replace("[amount]", money(Math.abs(delta))));
      find("[data-only-coupon]").hidden = !p.extraAvailable;
      onlyExtra.checked = pendingChoice.useExtra;
      set("[data-only-extra-label]", copy.only_coupon.replace("[plan]", copy[p.kind]));
      set("[data-upgrade-keep]", copy.upgrade_keep.replace("[plan]", copy[p.kind]));
    }
    function choose(kind) {
      if (busy || sharing || loading) {
        return;
      }
      if (!access.canPurchaseBase) {
        extend(kind);
        return;
      }
      var p = planFor(kind);
      if (kind === "BUNDLE") {
        checkout(p, p.extraAvailable, ids[kind]);
        return;
      }
      pendingChoice = {
        plan: p,
        useExtra: p.extraAvailable,
        requestId: ids[kind],
        bundleRequestId: ids.BUNDLE,
      };
      popup();
      dialog.showModal();
    }
    function row(container, label, value, total) {
      var line = element("div", "", total ? "kgd__total" : "");
      line.append(element("span", label), element(total ? "strong" : "span", value));
      container.append(line);
    }
    function deadline() {
      var offer = summary && summary.coupons && summary.coupons.guide50;
      var offset =
        summary && summary.serverTime && Number.isFinite(summary.serverTime.nowMs)
          ? summary.serverTime.nowMs - Date.now()
          : 0;
      if (!offer || !offer.available) {
        return null;
      }
      var end = typeof offer.expiresAt === "number" ? offer.expiresAt : Date.parse(offer.expiresAt);
      if (!Number.isFinite(end) && offer.ttlSeconds > 0) {
        end = Date.now() + offset + offer.ttlSeconds * 1000;
      }
      return Number.isFinite(end) && end > Date.now() + offset
        ? { end: end, offset: offset }
        : null;
    }
    function render() {
      clearInterval(countdownInterval);
      countdownInterval = null;
      var owned = !access.canPurchaseBase,
        bundle = planFor("BUNDLE");
      root.dataset.kitState = owned ? "owned" : "member";
      root.querySelectorAll("[data-plan-purchase]").forEach(function (slot) {
        slot.replaceChildren();
      });
      var card = find('[data-plan-kind="BUNDLE"] [data-plan-purchase]');
      if (owned) {
        var block = element("div", "", "kgd__extension-card");
        block.append(
          element("span", copy.extend_badge, "kgd__pill"),
          element("p", copy.extend_copy, "kgd__muted"),
          element("strong", copy.extension_price, "kgd__amount"),
          element("p", copy.pay_once, "kgd__muted"),
        );
        var extendButton = button(
          copy.extend,
          function () {
            extend("BUNDLE");
          },
          !eligibleTypes().includes("BUNDLE"),
        );
        extendButton.dataset.ineligible = String(!eligibleTypes().includes("BUNDLE"));
        block.append(
          extendButton,
          element(
            "p",
            eligibleTypes().includes("BUNDLE") ? copy.extend_contents : copy.not_owned,
            "kgd__muted",
          ),
        );
        card.append(block);
      } else {
        var active = deadline();
        card.append(
          element("p", copy.eyebrow, "kgd__eyebrow"),
          element("h3", active ? copy.welcome_offer : copy.current_offer),
          element("strong", money(kitPrice(bundle)), "kgd__amount"),
        );
        if (kitPrice(bundle) < bundle.priceCents) {
          card.append(element("p", copy.regular + " " + money(bundle.priceCents), "kgd__muted"));
        }
        if (active) {
          var countdown = element("div", "", "kgd__timer"),
            timerText = element("strong");
          countdown.append(element("span", copy.timer), timerText);
          card.append(countdown);
          function tick() {
            if (!root.isConnected) {
              clearInterval(countdownInterval);
              return;
            }
            var remaining = Math.max(
              0,
              Math.ceil((active.end - Date.now() - active.offset) / 1000),
            );
            timerText.textContent = [
              Math.floor(remaining / 3600),
              Math.floor(remaining / 60) % 60,
              remaining % 60,
            ]
              .map(function (value) {
                return String(value).padStart(2, "0");
              })
              .join(":");
            if (!remaining) {
              clearInterval(countdownInterval);
              countdown.hidden = true;
              if (!busy) {
                dialog.close();
                pendingChoice = null;
                load().catch(function () {});
              }
            }
          }
          countdownInterval = setInterval(tick, 1000);
          tick();
        } else if (
          summary &&
          summary.coupons &&
          summary.coupons.guide50 &&
          !summary.coupons.guide50.available
        ) {
          card.append(element("p", copy.expired, "kgd__expired"));
        }
        var lines = element("div", "", "kgd__breakdown");
        row(lines, copy.regular_line, money(bundle.priceCents));
        if (bundle.memberPriceCents < bundle.priceCents) {
          row(lines, copy.welcome_line, "− " + money(bundle.priceCents - bundle.memberPriceCents));
        }
        if (bundle.extraAvailable) {
          row(
            lines,
            copy.extra_line,
            "− " + money(bundle.memberPriceCents - bundle.extraPriceCents),
          );
        }
        row(lines, copy.total, money(kitPrice(bundle)), true);
        card.append(lines);
        var referral = element("div", "", "kgd__referral");
        referral.append(
          element("strong", bundle.extraAvailable ? copy.applied : copy.referral_title),
          element("p", copy.referral_copy),
        );
        var share = button(
          bundle.extraAvailable ? copy.referral_share : copy.referral_get,
          shareOffer,
        );
        share.classList.add("kgd__button--outline");
        share.dataset.kitShare = "";
        referral.append(share);
        card.append(referral);
        card.append(
          button(copy.get_kit, function () {
            choose("BUNDLE");
          }),
          element("p", copy.confirm, "kgd__checkout-note"),
        );
      }
      ["PDF", "VIDEO"].forEach(function (kind) {
        var p = planFor(kind),
          item = find('[data-plan-kind="' + kind + '"]');
        item.querySelector("[data-only-price]").textContent = owned
          ? copy.extension_price
          : money(p.priceCents);
        item.querySelector("[data-kit-only-regular]").hidden = owned;
        item.querySelector("[data-only-access]").textContent = owned
          ? copy.only_devices
          : copy.only_access;
        var disabled = owned && !eligibleTypes().includes(kind);
        var action = button(
          owned ? copy.extend : copy[kind === "PDF" ? "pdf_cta" : "video_cta"],
          function () {
            choose(kind);
          },
          disabled,
        );
        action.dataset.ineligible = String(disabled);
        if (disabled) {
          action.title = copy.not_owned;
        }
        item.querySelector("[data-plan-purchase]").append(action);
      });
      find("[data-kit-new-only]").hidden = owned;
      set("[data-kit-steps-heading]", copy[owned ? "extend_steps_title" : "steps_title"]);
      var steps = owned
        ? ["extend_step1", "extend_step2", "extend_step3"]
        : ["member_step", "purchase_step", "open_step"];
      steps.forEach(function (key, i) {
        set("[data-kit-step" + (i + 1) + "]", copy[key]);
        set("[data-kit-step" + (i + 1) + "-copy]", copy[key + "_copy"]);
      });
      document.querySelector("[data-kit-closing-title]").textContent =
        copy[owned ? "extend_closing_title" : "closing_title"];
      document.querySelector("[data-kit-closing-copy]").textContent =
        copy[owned ? "extend_closing_copy" : "closing_copy"];
      if (bottom) {
        bottom.textContent = copy[owned ? "extend" : "get_kit"];
      }
    }
    async function load() {
      if (loading || busy) {
        return;
      }
      loading = true;
      retry.hidden = true;
      status.textContent = copy.loading;
      syncDisabled();
      try {
        if (window.psWelcomeOfferReady) {
          await window.psWelcomeOfferReady;
        }
        var data = await request("/member/catalog?key=guide-plans");
        if (
          data.kind !== "guide" ||
          !Array.isArray(data.plans) ||
          !/^[A-Z]{3}$/.test(data.currency || "")
        ) {
          throw new Error("Invalid member catalog");
        }
        ["PDF", "BUNDLE", "VIDEO"].forEach(function (kind) {
          var p = data.plans.find(function (item) {
            return item.kind === kind;
          });
          if (
            !p ||
            !p.variantId ||
            ![p.priceCents, p.memberPriceCents, p.extraPriceCents].every(function (value) {
              return Number.isSafeInteger(value) && value >= 0;
            })
          ) {
            throw new Error("Invalid plan");
          }
        });
        var eligibility = await request(
          "/guide-purchase/eligibility?variantId=" + encodeURIComponent(data.plans[0].variantId),
        );
        if (typeof eligibility.canPurchaseBase !== "boolean") {
          throw new Error("Invalid access status");
        }
        if (
          !eligibility.canPurchaseBase &&
          (!eligibility.nextAction ||
            !Array.isArray(eligibility.nextAction.extensionEligibleTypes) ||
            !eligibility.nextAction.extensionEligibleTypes.length)
        ) {
          throw new Error("Missing extension options");
        }
        var coupons = null;
        if (eligibility.canPurchaseBase) {
          try {
            coupons = await request("/coupons/summary");
          } catch (_summaryError) {}
        }
        catalog = data;
        access = eligibility;
        summary = coupons;
        ["PDF", "BUNDLE", "VIDEO"].forEach(function (kind) {
          ids[kind] = crypto.randomUUID();
        });
        if (dialog.open) {
          dialog.close();
        }
        pendingChoice = null;
        render();
        status.textContent = "";
      } catch (_error) {
        status.textContent = copy.error;
        retry.hidden = false;
        throw _error;
      } finally {
        loading = false;
        syncDisabled();
      }
    }
    async function shareOffer() {
      if (busy || sharing || loading) {
        return;
      }
      sharing = true;
      syncDisabled();
      status.textContent = copy.referral_busy;
      try {
        if (!planFor("BUNDLE").extraAvailable) {
          await request("/coupons/extra10/activate-share", {
            shareUrl: "https://kpurpleshoes.com/pages/freeguideoptin",
            source: "thank-you-offer",
            clientRequestId: crypto.randomUUID(),
          });
          await load();
          if (!planFor("BUNDLE").extraAvailable) {
            throw new Error("Coupon not active");
          }
        }
        status.textContent = copy.applied;
        if (navigator.share && typeof navigator.share === "function") {
          try {
            await navigator.share({
              title: copy.referral_share,
              text: copy.referral_copy,
              url: "https://kpurpleshoes.com/pages/freeguideoptin",
            });
            return;
          } catch (shareError) {
            if (shareError && shareError.name === "AbortError") {
              return;
            }
          }
        }
        shareDialog.showModal();
      } catch (_error) {
        status.textContent = copy.referral_error;
      } finally {
        sharing = false;
        syncDisabled();
      }
    }
    extensionDialog.addEventListener("change", function (event) {
      if (
        event.target.matches("[data-type-radio]") &&
        eligibleTypes().includes(event.target.value)
      ) {
        selectedExtension = event.target.value;
      }
    });
    retry.addEventListener("click", function () {
      load().catch(function () {});
    });
    find("[data-upgrade-close]").addEventListener("click", function () {
      dialog.close();
    });
    find("[data-extension-close]").addEventListener("click", function () {
      extensionDialog.close();
    });
    find("[data-kit-share-close]").addEventListener("click", function () {
      shareDialog.close();
    });
    find("[data-kit-copy-link]").addEventListener("click", async function () {
      try {
        await navigator.clipboard.writeText("https://kpurpleshoes.com/pages/freeguideoptin");
        set("[data-kit-copy-status]", copy.share_copied);
      } catch (_error) {
        set("[data-kit-copy-status]", copy.share_ready);
      }
    });
    onlyExtra.addEventListener("change", function () {
      if (!pendingChoice || busy || loading) {
        return;
      }
      pendingChoice.useExtra = onlyExtra.checked && pendingChoice.plan.extraAvailable;
      pendingChoice.requestId = crypto.randomUUID();
      popup();
    });
    find("[data-upgrade-accept]").addEventListener("click", function () {
      if (!pendingChoice || busy || sharing || loading) {
        return;
      }
      dialog.close();
      checkout(planFor("BUNDLE"), planFor("BUNDLE").extraAvailable, pendingChoice.bundleRequestId);
    });
    find("[data-upgrade-keep]").addEventListener("click", function () {
      if (!pendingChoice || busy || sharing || loading) {
        return;
      }
      dialog.close();
      checkout(pendingChoice.plan, pendingChoice.useExtra, pendingChoice.requestId);
    });
    if (bottom) {
      bottom.addEventListener("click", function () {
        if (!catalog || busy || sharing || loading) {
          return;
        }
        if (access.canPurchaseBase) {
          choose("BUNDLE");
        } else if (selectedExtension && eligibleTypes().includes(selectedExtension)) {
          extend(selectedExtension);
        } else {
          find(
            eligibleTypes().some(function (type) {
              return type === "PDF" || type === "VIDEO";
            })
              ? ".kgd__only"
              : "#member-purchase",
          ).scrollIntoView({ behavior: "smooth", block: "center" });
          status.textContent = copy.choose_extension;
        }
      });
    }
    document.addEventListener("visibilitychange", function () {
      if (
        document.visibilityState === "visible" &&
        !busy &&
        !sharing &&
        !dialog.open &&
        !extensionDialog.open
      ) {
        load().catch(function () {});
      }
    });
    window.addEventListener("pageshow", function (event) {
      if (event.persisted) {
        busy = false;
        sharing = false;
        load().catch(function () {});
      }
    });
    load().catch(function () {});
  });
})();
