// Mobile viewport fix for the relay web app (browser / Telegram Mini App only).
// style.css pins body to 100vh, which on iOS ignores the on-screen keyboard and
// pushes the composer off-screen; drive the real height from VisualViewport so
// the composer always sits above the keyboard. A separate file (not inline) so
// app.html's CSP can forbid inline scripts.
(function () {
  var vv = window.visualViewport;
  function apply() {
    var h = vv ? vv.height : window.innerHeight;
    document.body.style.height = h + "px";
    window.scrollTo(0, 0);
    var l = document.getElementById("log");
    // When the keyboard opens the user is about to type — keep the tail visible.
    if (l) l.scrollTop = l.scrollHeight;
  }
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", function () { setTimeout(apply, 250); });
  try {
    if (window.Telegram && Telegram.WebApp) {
      Telegram.WebApp.ready();
      Telegram.WebApp.expand();
    }
  } catch (e) {}
  apply();
})();
