/* Sonarium · Liquid Glass — deslizador de cristal para pestañas y controles segmentados.
   No depende de app.js: observa los cambios de la clase "on" y mueve el indicador con resorte. */
(function () {
  "use strict";
  var GROUPS = ".tabs, .tools-tabs, .lib-tabs, .a11y-seg";
  var ITEMS = ".tab, .tt, .lt, button";
  var obs = null;

  function active(g) { return g.querySelector(".on"); }

  function place(g, instant) {
    var thumb = g.querySelector(":scope > .lg-thumb");
    var el = active(g);
    if (!thumb) return;
    if (!el || !el.offsetWidth) { thumb.style.opacity = "0"; return; }
    if (instant) thumb.classList.add("no-anim");
    thumb.style.opacity = "1";
    thumb.style.width = el.offsetWidth + "px";
    thumb.style.transform = "translateX(" + el.offsetLeft + "px)";
    if (instant) { void thumb.offsetWidth; thumb.classList.remove("no-anim"); }
  }

  function setup(g) {
    if (g.__lg && g.querySelector(":scope > .lg-thumb")) { place(g); return; }
    g.__lg = true;
    var thumb = document.createElement("span");
    thumb.className = "lg-thumb";
    thumb.setAttribute("aria-hidden", "true");
    g.insertBefore(thumb, g.firstChild);
    g.classList.add("lg-ready");
    place(g, true);
    var mo = new MutationObserver(function () { place(g); });
    mo.observe(g, { attributes: true, attributeFilter: ["class"], subtree: true, childList: true });
    if (window.ResizeObserver) new ResizeObserver(function () { place(g, true); }).observe(g);
  }

  function scan(root) {
    (root || document).querySelectorAll(GROUPS).forEach(function (g) {
      if (g.querySelector(ITEMS)) setup(g);
    });
  }

  function init() {
    scan();
    // pestañas que se crean después (p. ej. el modal de cuenta vuelve a dibujar su HTML)
    var pending = false;
    obs = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; scan(); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // los modales ocultos miden 0: se recolocan al abrir
    document.addEventListener("transitionend", function (e) {
      if (e.target.classList && e.target.classList.contains("modal-veil")) scan();
    });
    window.addEventListener("resize", function () {
      document.querySelectorAll(GROUPS).forEach(function (g) { place(g, true); });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () {
      document.querySelectorAll(GROUPS).forEach(function (g) { place(g, true); });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
