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


  /* ---- Iconos de controles (estilo SF Symbols: trazo fino, un solo color) ----
     Sustituyen emojis al inicio del texto de botones y rótulos de la interfaz.
     Solo actúan sobre controles (SEL), nunca sobre títulos de canciones, carpetas ni letras. */
  var I = {
    trash:'<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/>',
    down:'<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
    up:'<path d="M12 20V9M7.5 13.5L12 9l4.5 4.5M5 4h14"/>',
    doc:'<path d="M7 3h7l4 4v14H7zM14 3v4h4M9.5 12h5M9.5 16h5"/>',
    clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    history:'<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4.5l3 1.5"/>',
    text:'<path d="M3.5 18L8.5 6l5 12M5.3 14h6.4M15.5 18v-5a2.5 2.5 0 0 1 5 0v5M15.5 15.5h5"/>',
    mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>',
    metro:'<path d="M7.5 21L10 4h4l2.5 17zM12 16.5l4-9M14.8 7.5h2.2M6 21h12"/>',
    globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
    folder:'<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
    timer:'<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M9.5 3h5M12 3v3M18.5 7l1.3-1.3"/>',
    left:'<path d="M19 12H5M11 6l-6 6 6 6"/>',
    guitar:P.guitar,
    projector:'<rect x="3" y="8" width="18" height="9" rx="2"/><circle cx="15" cy="12.5" r="2.2"/><path d="M6.5 12.5h3M7 17v2M17 17v2"/>',
    star:'<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
    starF:'<path class="f" d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
    pencil:'<path d="M4 20l1-4.5L16.5 4a2 2 0 0 1 3 3L8 18.5zM14.5 6l3.5 3.5"/>',
    undo:'<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    home:'<path d="M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5.5h4V20"/>',
    x:'<path d="M6 6l12 12M18 6L6 18"/>',
    sun:P.sun, moon:P.moon, sparkle:P.sparkle,
    contrast:'<circle cx="12" cy="12" r="9"/><path class="f" d="M12 3a9 9 0 0 1 0 18z"/>',
    note:'<path d="M9 18V4.5l8 2.5"/><circle cx="6.8" cy="18" r="2.2"/>',
    tap:'<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11M12 10.5V9.5a1.5 1.5 0 0 1 3 0v1.5M15 11a1.5 1.5 0 0 1 3 0v3.5a6 6 0 0 1-6 6h-.5a5 5 0 0 1-4-2L5.5 14a1.5 1.5 0 0 1 2.3-1.8L9 13.5"/>',
    save:'<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>',
    link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 10 18.7l1-1"/>',
    notepen:'<path d="M5 4h10l4 4v12H5zM8.5 15.5l1-2.5 5-5 1.5 1.5-5 5z"/>',
    print:'<path d="M7 9V4h10v5M7 17H4.5v-7h15v7H17M7 14h10v6H7z"/>',
    play:'<path class="f" d="M8 5.5v13l11-6.5z"/>',
    pause:'<path class="f" d="M8 5h3v14H8zM13 5h3v14h-3z"/>',
    stop:'<path class="f" d="M6.5 6.5h11v11h-11z"/>',
    blackout:'<rect class="f" x="5" y="5" width="14" height="14" rx="3.5"/>',
    win:'<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.5h17"/>'
  };
  var CTRL = {"🗑":"trash","⬇":"down","⬆":"up","📄":"doc","🕒":"clock","🕘":"history","🔤":"text","🎤":"mic","🎙":"mic","🎼":"metro",
    "🌐":"globe","📁":"folder","⏱":"timer","←":"left","🎸":"guitar","📽":"projector","☆":"star","★":"starF","✎":"pencil","↩":"undo",
    "🏠":"home","✕":"x","☀":"sun","🌙":"moon","🔆":"sun","✨":"sparkle","🌓":"contrast","♩":"note","👆":"tap","💾":"save","🔗":"link",
    "📝":"notepen","🖨":"print","▶":"play","❚❚":"pause","■":"stop","🪟":"win","⬛":"blackout"};
  var SEL = ".glass-btn, .ic, .tt, .metro-pill, .sp-back, #homeBtn, #playBtn, #stPlay, .icon-btn-wrap, .cp-x, .crumb, " +
            ".pick-item[id^='mobile'], .fchip[data-ffav], .modal-head h3, #stageBar button, .pj-ctl button, .tab, .lt, .mobile-dock button, .card-actions button";
  var KEYS = Object.keys(CTRL).sort(function (a, b) { return b.length - a.length; });
  var RE = new RegExp("^\\s*(" + KEYS.join("|") + ")\\uFE0F?[\\s\\u00a0]*", "u");

  function iconize(el) {
    var n = el.firstChild;
    if (!n || n.nodeType !== 3) return;
    var m = RE.exec(n.nodeValue);
    if (!m) return;
    var name = CTRL[m[1]];
    if (!name || !I[name]) return;
    var rest = n.nodeValue.slice(m[0].length);
    var span = document.createElement("span");
    span.className = "lg-ic" + (rest.trim() ? " gap" : "");
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = '<svg viewBox="0 0 24 24">' + I[name] + "</svg>";
    el.insertBefore(span, n);
    if (rest) n.nodeValue = rest; else el.removeChild(n);
  }

  function iconizeIn(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.closest && root.closest(".lyrics-area, .lg-ic")) return;
    var c = root.closest ? root.closest(SEL) : null;
    if (c) iconize(c);
    if (root.matches && root.matches(SEL)) iconize(root);
    var list = root.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) iconize(list[i]);
  }

  function watchIcons() {
    iconizeIn(document.body);
    var queue = new Set(), raf = 0;
    new MutationObserver(function (recs) {
      recs.forEach(function (r) {
        if (r.type === "characterData") { if (r.target.parentElement) queue.add(r.target.parentElement); }
        else { queue.add(r.target); }
      });
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var items = Array.from(queue); queue.clear();
        items.forEach(iconizeIn);
      });
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  }


  /* ---- Ampliar como al abrir una app en iOS ----
     La canción (o el contenido de la carpeta) crece desde la tarjeta que tocaste y, al volver, se encoge hacia ella.
     Solo observa y anima: no cambia la lógica de app.js. Se omite con animaciones reducidas o modo ligero. */
  function zoomNav() {
    var home = document.getElementById("homeScreen"), song = document.getElementById("songScreen"), grid = document.getElementById("songGrid");
    if (!home || !song || !grid || !song.animate) return;
    var last = null, origin = null, songRect = null, wasOpen = false;

    function motionOK() {
      var m = document.documentElement.getAttribute("data-motion");
      if (m === "reduced") return false;
      if (m !== "full" && window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      return !document.body.classList.contains("lite");
    }
    function ease() {
      var v = getComputedStyle(document.documentElement).getPropertyValue("--spring-soft").trim();
      try { if (v && CSS.supports("transition-timing-function", v)) return v; } catch (e) {}
      return "cubic-bezier(.3,1.15,.5,1)";
    }
    function light() { return document.documentElement.getAttribute("data-theme") === "light"; }
    function fresh() { return last && performance.now() - last.t < 700; }

    // recordar la tarjeta tocada (antes de que app.js cambie de pantalla)
    document.addEventListener("click", function (e) {
      var c = e.target.closest && e.target.closest(".song-card, .folder-card");
      if (!c || e.target.closest(".card-actions")) return;
      last = {
        rect: c.getBoundingClientRect(), t: performance.now(),
        kind: c.classList.contains("folder-card") ? "folder" : "song",
        radius: parseFloat(getComputedStyle(c).borderTopLeftRadius) || 24
      };
    }, true);

    function fromTo(elm, rect, radius, finalRadius) {
      var b = elm.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      var s = Math.max(rect.width / b.width, 0.1);
      var dx = rect.left + rect.width / 2 - (b.left + b.width / 2);
      var dy = rect.top + rect.height / 2 - (b.top + b.height / 2);
      return { s: s, dx: dx, dy: dy, r0: radius / s, rf: finalRadius, b: b };
    }

    // ---- abrir canción: crece desde su tarjeta ----
    function openZoom() {
      if (!motionOK() || !fresh() || last.kind !== "song") return;
      var m = fromTo(song, last.rect, last.radius, 0);
      if (!m) return;
      origin = last.rect; last = null;
      var bg0 = light() ? "rgba(250,251,255,.97)" : "rgba(26,30,66,.96)", bg1 = light() ? "rgba(250,251,255,0)" : "rgba(26,30,66,0)";
      var prev = song.style.overflow; song.style.overflow = "hidden";
      var a = song.animate([
        { transform: "translate(" + m.dx + "px," + m.dy + "px) scale(" + m.s + ")", opacity: 0, borderRadius: m.r0 + "px", backgroundColor: bg0 },
        { opacity: 1, offset: 0.2 },
        { transform: "none", opacity: 1, borderRadius: "0px", backgroundColor: bg1 }
      ], { duration: 640, easing: ease() });
      a.onfinish = a.oncancel = function () { song.style.overflow = prev; };
    }

    // ---- abrir carpeta: su contenido crece desde la carpeta ----
    function folderZoom() {
      if (!motionOK() || !fresh() || last.kind !== "folder" || home.style.display === "none") return;
      var m = fromTo(grid, last.rect, 0, 0);
      if (!m) return;
      last = null;
      grid.classList.add("lg-zoom");
      var a = grid.animate([
        { transform: "translate(" + m.dx + "px," + m.dy + "px) scale(" + Math.max(m.s, 0.45) + ")", opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: "none", opacity: 1 }
      ], { duration: 560, easing: ease() });
      a.onfinish = a.oncancel = function () { grid.classList.remove("lg-zoom"); };
    }

    // ---- volver: lámina de cristal que se encoge hacia la tarjeta + inicio que se acomoda ----
    function closeZoom() {
      if (!motionOK() || !songRect) return;
      var g = document.createElement("div");
      g.className = "lg-ghost";
      g.style.cssText = "left:" + songRect.left + "px;top:" + songRect.top + "px;width:" + songRect.width + "px;height:" + songRect.height + "px";
      document.body.appendChild(g);
      var tx, ty, s;
      if (origin) {
        s = Math.max(origin.width / songRect.width, 0.1);
        tx = origin.left + origin.width / 2 - (songRect.left + songRect.width / 2);
        ty = origin.top + origin.height / 2 - (songRect.top + songRect.height / 2);
      } else { s = 0.3; tx = 0; ty = 0; }
      var a = g.animate([
        { transform: "none", opacity: 0.9, borderRadius: "0px" },
        { opacity: 0.9, offset: 0.55 },
        { transform: "translate(" + tx + "px," + ty + "px) scale(" + s + ")", opacity: 0, borderRadius: (24 / s) + "px" }
      ], { duration: 460, easing: "cubic-bezier(.32,.72,0,1)" });
      a.onfinish = a.oncancel = function () { g.remove(); };
      home.animate([{ transform: "scale(1.045)", opacity: 0.55 }, { transform: "none", opacity: 1 }], { duration: 560, easing: ease() });
      origin = null; songRect = null;
    }

    new MutationObserver(function () {
      var open = song.style.display === "flex";
      if (open && !wasOpen) { songRect = song.getBoundingClientRect(); openZoom(); }
      else if (!open && wasOpen) closeZoom();
      wasOpen = open;
    }).observe(song, { attributes: true, attributeFilter: ["style"] });

    new MutationObserver(function () { if (home.style.display !== "none") folderZoom(); })
      .observe(grid, { childList: true });
  }


  /* ---- Fondo decorativo (estilo RoboKids) ----
     Degradados y puntos estáticos + iconos de contorno que solo suben y bajan unos píxeles con transform.
     Nada de desenfoques animados ni cambios de forma: la GPU lo mueve sin esfuerzo. */
  var CLEF_D = "M434 2Q464 -103 464 -170Q464 -223 427.0 -257.0Q390 -291 337 -291Q287 -291 250.0 -261.5Q213 -232 213 -190Q213 -160 233.5 -133.5Q254 -107 283.5 -107.0Q313 -107 331.5 -128.5Q350 -150 350 -178Q350 -240 280 -240Q298 -268 338 -268Q353 -268 368.5 -263.5Q384 -259 401.0 -248.0Q418 -237 428.5 -213.5Q439 -190 439 -157Q439 -136 411 -6Q389 -12 356 -12Q259 -12 189.5 60.0Q120 132 120 232Q120 267 131.5 303.0Q143 339 157.5 366.5Q172 394 200.5 428.5Q229 463 248.5 483.5Q268 504 303 539Q280 621 280 689Q280 779 313.0 839.5Q346 900 379 900Q389 900 401.5 887.0Q414 874 426.0 851.0Q438 828 446.5 790.5Q455 753 455 710Q455 551 342 447L368 329Q384 332 397 332Q458 332 500.0 282.5Q542 233 542 162Q542 44 434 2ZM426 746Q426 801 394 801Q358 801 333.0 748.0Q308 695 308 630Q308 588 321 557Q359 580 392.5 639.5Q426 699 426 746ZM498 128Q498 183 466.0 216.0Q434 249 383 249L428 23Q498 52 498 128ZM407 17 361 247Q334 241 311.5 214.0Q289 187 289 158Q289 143 295.0 128.5Q301 114 309.5 104.0Q318 94 327.0 86.0Q336 78 342.0 74.5Q348 71 348 71L340 66Q307 75 277.5 106.0Q248 137 248 184Q248 231 277.5 270.5Q307 310 343 323L325 430Q168 299 168 177Q168 104 223.0 55.0Q278 6 348 6Q365 6 407 17Z";
  var BGI = {
    clef:'<g transform="scale(1 -1)"><path fill="currentColor" stroke="none" d="'+CLEF_D+'"/></g>',
    notes:P.notes, note:I.note, guitar:P.guitar, mic:I.mic, metro:I.metro, sparkle:P.sparkle,
    headphones:'<path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5.5A1.5 1.5 0 0 1 4 18.5zM20 15h-3v5h1.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
    piano:'<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7.5 6v12M12 6v12M16.5 6v12M6 6v6.5M9 6v6.5M15 6v6.5M18 6v6.5"/>',
    book:'<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/>'
  };
  // [icono, izquierda %, arriba %, tamaño px, giro °, retraso s]
  var BGP = [["clef",6,9,104,-10,0],["notes",86,7,86,10,1.2],["guitar",4,60,104,-18,2.4],["headphones",90,56,92,8,.6],
             ["mic",24,84,74,12,3.1],["metro",72,82,82,-8,1.8],["piano",46,5,92,6,2.9],["note",78,30,58,14,2.2],
             ["sparkle",17,38,46,0,1.4],["book",58,46,70,-10,.9],["sparkle",93,82,44,0,3.6],["note",36,64,54,-14,.3]];

  function buildBg() {
    if (document.getElementById("lgBg")) return;
    var bg = document.createElement("div");
    bg.id = "lgBg"; bg.className = "lg-bg"; bg.setAttribute("aria-hidden", "true");
    var h = "";
    BGP.forEach(function (p) {
      var filled = p[0] === "clef";
      h += '<span class="lg-deco" style="left:' + p[1] + '%;top:' + p[2] + '%;width:' + p[3] + 'px;height:' + p[3] + 'px;--rot:' + p[4] + 'deg;animation-delay:' + p[5] + 's">' +
           '<svg viewBox="' + (filled ? "90 -930 482 1251" : "0 0 24 24") + '"' + (filled ? ' preserveAspectRatio="xMidYMid meet"' : "") + ">" + BGI[p[0]] + "</svg></span>";
    });
    bg.innerHTML = h;
    document.body.insertBefore(bg, document.body.firstChild);
  }

  function init() {
    scan();
    fixGreeting();
    watchIcons();
    zoomNav();
    buildBg();
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
