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


  /* ---- Icono del saludo: sustituye al emoji por un icono vectorial ---- */
  var P = {
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
    notes:'<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/>',
    cloudsun:'<path d="M12 3v1.8M4.2 6.2l1.3 1.3M2 12.5h1.8M19.8 6.2l-1.3 1.3"/><path d="M7.5 12.2a4.5 4.5 0 0 1 8.4-1.7"/><path d="M7 20h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 7.8 13.2 3.4 3.4 0 0 0 7 20z"/>',
    cup:'<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3v2.5M12.5 3v2.5"/>',
    guitar:'<circle cx="9" cy="15" r="5"/><path d="M12.5 11.5l7-7M17 3.5l3.5 3.5"/><circle cx="9" cy="15" r="1.2"/>',
    hand:'<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    sparkle:'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 3v4M17 5h4"/>'
  };
  var MAP = {"☀":"sun","🎶":"notes","🌤":"cloudsun","☕":"cup","🌻":"sun","🎸":"guitar","👋":"hand","🌙":"moon","✨":"sparkle"};

  function gradDefs() {
    if (document.getElementById("lgGradDefs")) return;
    var d = document.createElement("div");
    d.id = "lgGradDefs"; d.setAttribute("aria-hidden", "true");
    d.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    d.innerHTML = '<svg width="0" height="0"><defs><linearGradient id="lgGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2fd8c4"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs></svg>';
    document.body.appendChild(d);
  }

  function fixGreeting() {
    var g = document.getElementById("greeting");
    if (!g || g.querySelector(".lg-gi")) return;
    var t = g.textContent || "";
    var m = /\s*([\u2600\u2615\u2728]|\uD83C[\uDFB6\uDFB8\uDF3B\uDF24\uDF19]|\uD83D\uDC4B)\uFE0F?\s*$/.exec(t);
    if (!m) return;
    var key = MAP[m[1]];
    if (!key) return;
    gradDefs();
    var span = document.createElement("span");
    span.className = "lg-gi"; span.setAttribute("aria-hidden", "true");
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="url(#lgGrad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + P[key] + "</svg>";
    g.textContent = t.slice(0, m.index);
    g.appendChild(span);
  }

  function init() {
    scan();
    fixGreeting();
    var gEl = document.getElementById("greeting");
    if (gEl) new MutationObserver(fixGreeting).observe(gEl, { childList: true, characterData: true, subtree: true });
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
