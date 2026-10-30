(function () {
  function positionHighlights() {
    var slot = document.querySelector("[data-travel-highlights-slot]");
    if (!slot || slot.querySelector(".wyd")) {
      return;
    }
    var highlights = document.querySelector("main .shopify-section .wyd");
    var section = highlights && highlights.closest(".shopify-section");
    if (section && !section.contains(slot)) {
      slot.appendChild(section);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", positionHighlights);
  } else {
    positionHighlights();
  }
  document.addEventListener("shopify:section:load", positionHighlights);
})();
