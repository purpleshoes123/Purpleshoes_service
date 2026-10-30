(function () {
  'use strict';
  document.querySelectorAll('[data-kit-detail]').forEach(function (root) {
    var video = root.querySelector('[data-kit-demo]');
    var play = root.querySelector('[data-kit-play]');
    var error = root.querySelector('[data-kit-video-error]');
    if (!video || !play) return;
    play.addEventListener('click', function () {
      error.hidden = true;
      video.play().catch(function () { error.hidden = false; });
    });
    video.addEventListener('play', function () { play.hidden = true; });
    video.addEventListener('error', function () { play.hidden = true; error.hidden = false; });
  });
})();
