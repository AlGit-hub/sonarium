(function(){
  "use strict";

  const DAY_MS = 24*60*60*1000;
  const TRASH_DAYS = 12;
  const STORAGE_KEY = "cancionero.repertorio.v2";

  const PALETTE = [
    { name:"Turquesa", hex:"#2fd8c4" },
    { name:"Violeta",  hex:"#a78bfa" },
    { name:"Ámbar",    hex:"#f3b451" },
    { name:"Rosa",     hex:"#fb7185" },
    { name:"Cielo",    hex:"#60a5fa" },
    { name:"Lima",     hex:"#a3e635" },
    { name:"Magenta",  hex:"#e879f9" },
    { name:"Coral",    hex:"#fb923c" }
  ];

  const SAMPLE_SONGS = [
    {
      id: "demo-2",
      title: "Canción de práctica",
      artist: "Ejemplo — bórrala cuando quieras",
      key: "Am",
      color: PALETTE[1].hex,
      body:
`[Am]Esta es una canción de [F]ejemplo,
para que [C]veas cómo se ven los [G]acordes.

[F]Edítala o bórrala [C]cuando quieras,
y agrega las [G]tuyas [Am]aquí.`
    }
  ];

  /* Canciones incluidas con la página. Se agregan UNA sola vez a tu repertorio;
     después puedes editarlas o borrarlas y no vuelven a aparecer.
     Para sumar más desde el código, agrega un objeto con un id nuevo y único. */
  const BUILTIN_SONGS = [];   // ya no se agregan canciones extra a usuarios nuevos
  const SEEDED_KEY = "cancionero.seeded.v1";
  function mergeBuiltins(list){
    let seeded = [];
    try{ seeded = JSON.parse(localStorage.getItem(SEEDED_KEY)) || []; }catch(e){}
    BUILTIN_SONGS.forEach(b => {
      if(!seeded.includes(b.id)){
        list.push(Object.assign({}, b, { updatedAt: 1 }));
        seeded.push(b.id);
      }
    });
    try{ localStorage.setItem(SEEDED_KEY, JSON.stringify(seeded)); }catch(e){}
    return list;
  }

  /* ---------------- visitas (cuántas veces se abrió en este dispositivo) ---------------- */
  const VISITS_KEY = "sonarium.visitas";
  const visits = (function(){
    let n = 0;
    try{
      n = parseInt(localStorage.getItem(VISITS_KEY), 10) || 0;
      if(!sessionStorage.getItem("sonarium.visitaContada")){
        n++; localStorage.setItem(VISITS_KEY, String(n)); sessionStorage.setItem("sonarium.visitaContada", "1");
      }
    }catch(e){}
    return n;
  })();

  /* ---------------- estado ---------------- */
  let songs = [], folders = [], spaces = [], tombs = [], meta = {};
  let loc = { type:"folder", id:null };       // dónde estás en el explorador
  let activeId = null;
  let songCtx = null;   // si la canción se abrió desde un espacio: { spaceId }
  let semitoneShift = 0;
  let editingId = null;
  let pendingDeleteId = null;
  let selectedColor = PALETTE[0].hex;
  let autoScroll = { playing:false, raf:null, lastTs:0, speed:4 };
  const lastSig = new Map();

  const STATE_KEY = "cancionero.estado.v3";
  const SPACE_OPTIONS = [
    { h:12,  label:"12 horas" },
    { h:24,  label:"1 día" },
    { h:48,  label:"2 días" },
    { h:168, label:"1 semana" },
    { h:336, label:"2 semanas" },
    { h:720, label:"1 mes" }
  ];

  /* Carpetas iniciales (se crean una sola vez; puedes renombrarlas, moverlas o borrarlas) */
  const LITURGY_TREE = [
    { id:"f-eucaristia", name:"Celebración Eucarística", children:[
      "Entrada","Acto Penitencial","Gloria","Aclamación al Evangelio","Profesión de Fe",
      "Santo","Padre Nuestro","Paz","Comunión","María" ] },
    { id:"f-liturgicos", name:"Tiempos litúrgicos", children:[
      "Adviento","Navidad","Cuaresma","Semana Santa","Pascua" ] },
    { id:"f-espiritu-santo", name:"Espíritu Santo" },
    { id:"f-vocacion", name:"Vocación" },
    { id:"f-mision", name:"Misión" },
    { id:"f-difuntos", name:"Difuntos" }
  ];
  function slug(s){
    return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  }
  const SEED_FOLDER_IDS = ["f-mis-canciones"], SEED_SONG_IDS = ["demo-2"];
  function seedFolders(){
    folders.push({ id:"f-mis-canciones", name:"Mis canciones", parentId:null, ord:0, color:PALETTE[0].hex, updatedAt:1 });
    meta.seedFolders = true;
  }
  // Plantilla opcional: Eucaristía, tiempos litúrgicos, etc. (se agrega desde «📁 Carpeta»)
  function addLiturgyTemplate(){
    let ord = nextOrd(null), added = 0;
    LITURGY_TREE.forEach((g, gi) => {
      const color = PALETTE[(gi + 1) % PALETTE.length].hex;
      if(!folderById(g.id)){ folders.push({ id:g.id, name:g.name, parentId:null, ord:ord++, color }); added++; }
      (g.children || []).forEach((n, i) => {
        const id = g.id + "-" + slug(n);
        if(!folderById(id)){ folders.push({ id, name:n, parentId:g.id, ord:i, color }); added++; }
      });
    });
    persist();
    openFolder(null);
    toast(added ? "Carpetas de la liturgia agregadas" : "Esas carpetas ya existen");
  }
  // ¿Este dispositivo solo tiene lo que trae la app de fábrica (nada propio)?
  function isPristine(st){
    return !(st.spaces || []).length && !(st.tombs || []).length &&
      (st.songs || []).every(x => SEED_SONG_IDS.includes(x.id) && (x.updatedAt || 0) <= 1) &&
      (st.folders || []).every(f => SEED_FOLDER_IDS.includes(f.id) && (f.updatedAt || 0) <= 1);
  }
  function uid(p){ return p + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

  /* ---------------- almacenamiento local ---------------- */
  function loadState(){
    let st = null;
    try{ const raw = localStorage.getItem(STATE_KEY); if(raw) st = JSON.parse(raw); }catch(e){ console.warn("Estado ilegible", e); }
    if(!st){
      let old = null;
      try{
        const raw = localStorage.getItem(STORAGE_KEY);
        if(raw){ const p = JSON.parse(raw); if(Array.isArray(p)) old = p; }
      }catch(e){}
      st = { songs: old || SAMPLE_SONGS.slice(), folders:[], spaces:[], tombs:[], meta:{} };
    }
    songs = st.songs || []; folders = st.folders || []; spaces = st.spaces || [];
    tombs = st.tombs || []; meta = st.meta || {};
    [songs, folders, spaces].forEach(arr => arr.forEach(o => { if(!o.updatedAt) o.updatedAt = 1; }));
    if(!meta.seedFolders) seedFolders();
    mergeBuiltins(songs);
    snapshotSigs();
    writeLocal();
  }
  function currentState(){ return { v:3, songs, folders, spaces, tombs, meta }; }
  function writeLocal(){
    try{ localStorage.setItem(STATE_KEY, JSON.stringify(currentState())); }catch(e){ console.warn("No se pudo guardar", e); }
  }
  function sigOf(o){ const c = Object.assign({}, o); delete c.updatedAt; return JSON.stringify(c); }
  function snapshotSigs(){
    lastSig.clear();
    [["s",songs],["f",folders],["e",spaces]].forEach(([k, arr]) => arr.forEach(o => lastSig.set(k + ":" + o.id, sigOf(o))));
  }
  // Marca como "modificado ahora" lo que cambió y deja una lápida de lo que se borró,
  // para que al sincronizar entre dispositivos los cambios no se pisen.
  function stamp(){
    const now = Date.now();
    const cur = new Map();
    [["s",songs],["f",folders],["e",spaces]].forEach(([k, arr]) => arr.forEach(o => {
      const key = k + ":" + o.id, sig = sigOf(o);
      cur.set(key, sig);
      if(lastSig.get(key) !== sig) o.updatedAt = now;
    }));
    lastSig.forEach((_, key) => {
      if(!cur.has(key)){
        const k = key[0], id = key.slice(2);
        const t = tombs.find(x => x.k === k && x.id === id);
        if(t) t.at = now; else tombs.push({ k, id, at: now });
      }
    });
    const limit = now - 90*DAY_MS;
    tombs = tombs.filter(t => t.at > limit);
    lastSig.clear(); cur.forEach((v, k) => lastSig.set(k, v));
  }
  function persist(opts){
    stamp();
    writeLocal();
    if(!(opts && opts.noSync)) cloudPushSoon();
  }
  function applyState(st){
    songs = st.songs; folders = st.folders; spaces = st.spaces; tombs = st.tombs; meta = st.meta;
    snapshotSigs();
    writeLocal();
  }

  function pickPrefs(x, y){
    if(!x) return y || undefined;
    if(!y) return x;
    return (y.at || 0) > (x.at || 0) ? y : x;
  }
  function mergeStates(a, b){
    const tm = new Map();
    [...(a.tombs || []), ...(b.tombs || [])].forEach(t => {
      const key = t.k + ":" + t.id, p = tm.get(key);
      if(!p || t.at > p.at) tm.set(key, t);
    });
    function pick(k, la, lb){
      const m = new Map();
      [...la, ...lb].forEach(o => {
        const p = m.get(o.id);
        if(!p || (o.updatedAt || 0) > (p.updatedAt || 0)) m.set(o.id, o);
      });
      return [...m.values()].filter(o => { const t = tm.get(k + ":" + o.id); return !t || (o.updatedAt || 0) > t.at; });
    }
    const limit = Date.now() - 90*DAY_MS;
    return {
      v:3,
      songs: pick("s", a.songs || [], b.songs || []),
      folders: pick("f", a.folders || [], b.folders || []),
      spaces: pick("e", a.spaces || [], b.spaces || []),
      tombs: [...tm.values()].filter(t => t.at > limit),
      meta: { seedFolders: !!((a.meta && a.meta.seedFolders) || (b.meta && b.meta.seedFolders)), prefs: pickPrefs(a.meta && a.meta.prefs, b.meta && b.meta.prefs) }
    };
  }
  function canon(st){
    const byId = (x, y) => (x.id < y.id ? -1 : 1);
    return JSON.stringify({
      s: [...st.songs].sort(byId), f: [...st.folders].sort(byId), e: [...st.spaces].sort(byId),
      t: [...st.tombs].sort((x, y) => (x.k + x.id < y.k + y.id ? -1 : 1)), m: st.meta
    });
  }

  function cleanupTrash(){
    const now = Date.now();
    const before = songs.length;
    songs = songs.filter(s => !s.trashedAt || (now - s.trashedAt) < TRASH_DAYS*DAY_MS);
    if(songs.length !== before) persist();
  }
  function purgeExpiredSpaces(){
    const now = Date.now(), n = spaces.length;
    spaces = spaces.filter(s => !s.expiresAt || s.expiresAt > now);
    if(spaces.length !== n){
      if(loc.type === "space" && !spaces.find(s => s.id === loc.id)) loc = { type:"folder", id:null };
      persist();
      return true;
    }
    return false;
  }

  /* ---------------- carpetas: utilidades ---------------- */
  const folderById = id => folders.find(f => f.id === id);
  function effParent(f){ return f.parentId && folderById(f.parentId) ? f.parentId : null; }
  function effFolder(s){ return s.folderId && folderById(s.folderId) ? s.folderId : null; }
  function childFolders(pid){
    return folders.filter(f => effParent(f) === (pid || null))
      .sort((a, b) => ((a.ord || 0) - (b.ord || 0)) || a.name.localeCompare(b.name, "es"));
  }
  function folderPath(id){
    const out = []; let cur = folderById(id), guard = 0;
    while(cur && guard++ < 30){ out.unshift(cur); cur = cur.parentId ? folderById(cur.parentId) : null; }
    return out;
  }
  function isDescendant(id, ancestorId){
    let cur = folderById(id), guard = 0;
    while(cur && guard++ < 30){ if(cur.id === ancestorId) return true; cur = cur.parentId ? folderById(cur.parentId) : null; }
    return false;
  }
  function countSongsRec(fid){
    let n = songs.filter(s => !s.trashedAt && effFolder(s) === fid).length;
    childFolders(fid).forEach(c => { n += countSongsRec(c.id); });
    return n;
  }
  function nextOrd(pid){
    const sib = childFolders(pid);
    return sib.length ? Math.max(...sib.map(f => f.ord || 0)) + 1 : 0;
  }
  function pathLabel(fid){
    return fid ? folderPath(fid).map(f => f.name).join(" › ") : "";
  }

  /* ---------------- favoritas y etiquetas ---------------- */
  const filt = { fav:false, tag:null };
  const tagsOf = s => Array.isArray(s.tags) ? s.tags : [];
  const tagKey = t => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function parseTags(str){
    const seen = new Set(), out = [];
    String(str || "").split(/[,;\n]/).forEach(t => {
      t = t.replace(/^#+/, "").trim().slice(0, 24); if(!t) return;
      const k = tagKey(t); if(seen.has(k)) return; seen.add(k); out.push(t);
    });
    return out.slice(0, 8);
  }
  function filterActive(){ return !!(filt.fav || filt.tag); }
  /* búsqueda: ignora tildes y mayúsculas, acepta varias palabras y mira también la letra */
  const nrm = s => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const searchCache = new Map();
  function searchIndex(s){
    const stamp = (s.updatedAt || 0) + ":" + (s.body || "").length + ":" + s.title + "|" + (s.artist || "") + "|" + tagsOf(s).join(",");
    let c = searchCache.get(s.id);
    if(c && c.stamp === stamp) return c;
    const parts = [];
    (s.body || "").split("\n").forEach(l => {
      if(/^\s*\{[^}]*\}\s*$/.test(l)) return;
      const t = parseLine(l).lyric.trim(); if(t) parts.push(t);
    });
    const lyr = parts.join(" · ");
    c = { stamp, head: nrm(s.title + " " + (s.artist || "") + " " + tagsOf(s).join(" ")), lyr, lyrN: lyr.split("").map(nrm).join("") };
    searchCache.set(s.id, c);
    return c;
  }
  const searchWords = q => nrm(q).split(/\s+/).filter(Boolean);
  function songMatches(s, words){ if(!words.length) return true; const c = searchIndex(s); return words.every(w => c.head.includes(w) || c.lyrN.includes(w)); }
  // fragmento de la letra donde aparece lo buscado (solo si no coincidió en título/artista/etiquetas)
  function snippetFor(s, q){
    const words = searchWords(q); if(!words.length) return "";
    const c = searchIndex(s);
    if(words.every(w => c.head.includes(w)) || c.lyrN.length !== c.lyr.length) return "";
    let pos = -1;
    words.forEach(w => { const i = c.lyrN.indexOf(w); if(i >= 0 && (pos < 0 || i < pos)) pos = i; });
    if(pos < 0) return "";
    const a = Math.max(0, pos - 30), b = Math.min(c.lyr.length, pos + 70), marks = [];
    words.forEach(w => { let i = a; while((i = c.lyrN.indexOf(w, i)) >= 0 && i < b){ marks.push([i, i + w.length]); i += w.length; } });
    marks.sort((x, y) => x[0] - y[0]);
    let out = "", cur = a;
    marks.forEach(([m0, m1]) => { if(m0 < cur) return; out += escapeHtml(c.lyr.slice(cur, m0)) + "<mark>" + escapeHtml(c.lyr.slice(m0, m1)) + "</mark>"; cur = m1; });
    out += escapeHtml(c.lyr.slice(cur, b));
    return (a > 0 ? "…" : "") + out + (b < c.lyr.length ? "…" : "");
  }
  function activeSongs(filterText){
    const words = searchWords(filterText);
    return songs.filter(s => !s.trashedAt
      && (!filt.fav || s.fav)
      && (!filt.tag || tagsOf(s).some(t => tagKey(t) === filt.tag))
      && songMatches(s, words));
  }
  function toggleFav(id){
    const s = songs.find(x => x.id === id); if(!s) return;
    s.fav = !s.fav; if(!s.fav) delete s.fav;
    persist();
    toast(s.fav ? "★ Agregada a favoritas" : "Quitada de favoritas");
    updateFavBtn();
    if(activeId === null) renderHome(false);
  }
  function updateFavBtn(){
    const b = document.getElementById("favBtn"); if(!b) return;
    const s = songs.find(x => x.id === activeId), on = !!(s && s.fav);
    b.textContent = on ? "★" : "☆"; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
    b.title = on ? "Quitar de favoritas" : "Marcar como favorita";
  }
  function renderSongTags(song){
    const box = document.getElementById("songTags"); if(!box) return;
    box.innerHTML = tagsOf(song).map(t => '<span class="a-chip tg">#' + escapeHtml(t) + '</span>').join("");
  }
  function renderFilterRow(){
    const box = document.getElementById("filterRow"); if(!box) return;
    const live = songs.filter(s => !s.trashedAt);
    const nFav = live.filter(s => s.fav).length;
    const counts = new Map();
    live.forEach(s => tagsOf(s).forEach(t => { const k = tagKey(t), c = counts.get(k) || { name:t, n:0 }; c.n++; counts.set(k, c); }));
    if(!nFav && !counts.size && !filterActive()){ box.innerHTML = ""; box.style.display = "none"; return; }
    box.style.display = "";
    const tags = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name, "es")).slice(0, 14);
    box.innerHTML = '<button class="fchip' + (filt.fav ? " on" : "") + '" data-ffav="1">★ Favoritas' + (nFav ? ' <i>' + nFav + '</i>' : '') + '</button>' +
      tags.map(([k, c]) => '<button class="fchip' + (filt.tag === k ? " on" : "") + '" data-ftag="' + attr(k) + '">#' + escapeHtml(c.name) + ' <i>' + c.n + '</i></button>').join("") +
      (filterActive() ? '<button class="fchip clear" data-fclear="1">✕ Quitar filtro</button>' : "");
  }
  document.getElementById("filterRow").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if(!b) return;
    if(b.dataset.ffav) filt.fav = !filt.fav;
    else if(b.dataset.ftag) filt.tag = (filt.tag === b.dataset.ftag) ? null : b.dataset.ftag;
    else if(b.dataset.fclear){ filt.fav = false; filt.tag = null; }
    renderHome(true);
  });
  function trashedSongs(){
    return songs.filter(s => s.trashedAt).sort((a,b)=>b.trashedAt-a.trashedAt);
  }

  /* ---------------- nube (Firebase / Firestore, como RoboKids) ----------------
     Sin Firebase Auth: usuario + clave. La clave nunca se guarda; con ella se
     derivan (PBKDF2) un verificador y una llave AES. En Firestore solo queda el
     cuaderno CIFRADO, así que aunque alguien lea el documento no ve tus canciones. */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCG3DMy4FzaHwRctJdKEi4pGZCXZpRZKjw",
    authDomain: "sonarium9608.firebaseapp.com",
    projectId: "sonarium9608",
    storageBucket: "sonarium9608.firebasestorage.app",
    messagingSenderId: "764212974164",
    appId: "1:764212974164:web:2fbbac363a7479b02393c1",
    measurementId: "G-JTDSL6N8JP"
  };
  const FB_COLLECTION = "cuadernos";
  // App Check (reCAPTCHA Enterprise / Fraud Defense): la «clave del sitio» (pública). Vacía = desactivado.
  const APPCHECK_SITE_KEY = "6LcfsCsuAAAAAOK3PWIpAKEaUnSEft1GZJ381bbi";
  const FB_VERSION = "10.12.2";
  const RULES_TEXT =
`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Sonarium: un documento por cuaderno. Lo que no aparece aquí queda bloqueado.
    match /cuadernos/{usuario} {
      allow get: if true;
      allow list: if false;
      allow delete: if false;

      allow create: if usuario.matches('^[a-z0-9._-]{3,24}$')
        && request.resource.data.keys().hasOnly(['usuario','sal','verificador','datos','comp','version','actualizado'])
        && request.resource.data.usuario == usuario
        && request.resource.data.sal is string && request.resource.data.sal.size() < 64
        && request.resource.data.verificador is string && request.resource.data.verificador.size() < 64
        && request.resource.data.datos is string && request.resource.data.datos.size() < 900000;

      allow update: if request.resource.data.keys().hasOnly(['usuario','sal','verificador','datos','comp','version','actualizado'])
        && request.resource.data.usuario == resource.data.usuario
        && request.resource.data.sal == resource.data.sal
        && request.resource.data.verificador == resource.data.verificador
        && request.resource.data.datos is string && request.resource.data.datos.size() < 900000;
    }

    // Biblioteca compartida: cualquiera lee y puede publicar canciones nuevas (una por título+artista).
    // Nadie puede editar ni borrar desde la app; los retiros se hacen desde la consola de Firebase.
    match /biblioteca/{id} {
      allow get: if true;
      allow list: if request.query.limit <= 50;
      allow update, delete: if false;
      allow create: if id.matches('^[a-f0-9]{20}$')
        && request.resource.data.keys().hasOnly(['titulo','artista','tono','cuerpo','etiquetas','tokens','autor','creado','derechos'])
        && request.resource.data.titulo is string && request.resource.data.titulo.size() > 0 && request.resource.data.titulo.size() <= 120
        && request.resource.data.artista is string && request.resource.data.artista.size() <= 160
        && request.resource.data.tono is string && request.resource.data.tono.size() <= 12
        && request.resource.data.cuerpo is string && request.resource.data.cuerpo.size() > 0 && request.resource.data.cuerpo.size() <= 20000
        && request.resource.data.etiquetas is list && request.resource.data.etiquetas.size() <= 8
        && request.resource.data.tokens is list && request.resource.data.tokens.size() <= 16
        && request.resource.data.autor is string && request.resource.data.autor.size() <= 30
        && request.resource.data.derechos == true
        && request.resource.data.creado == request.time;
    }

    // Enlaces cortos para compartir un Espacio: un código al azar apunta al contenido.
    match /compartidos/{code} {
      allow get: if true;
      allow list, update, delete: if false;
      allow create: if code.matches('^[a-z0-9]{8}$')
        && request.resource.data.keys().hasOnly(['datos','creado'])
        && request.resource.data.datos is string && request.resource.data.datos.size() < 200000
        && request.resource.data.creado == request.time;
    }

    // Reportes de la biblioteca: solo se pueden crear (los lees tú en la consola).
    match /reportes/{rid} {
      allow read, update, delete: if false;
      allow create: if request.resource.data.keys().hasOnly(['cancion','motivo','creado'])
        && request.resource.data.cancion is string && request.resource.data.cancion.size() <= 40
        && request.resource.data.motivo is string && request.resource.data.motivo.size() <= 300
        && request.resource.data.creado == request.time;
    }
  }
}`;

  const cloud = { user:null, aesKey:null, keyB64:null, sal:null, verifier:null,
                  db:null, fs:null, status:"off", msg:"", timer:null, busy:false, again:false, lastSync:0 };
  const SESSION_KEY = "sonarium.sesion";
  const LOCK_KEY = "sonarium.intentos";
  const MAX_FAILS = 5, LOCK_MS = 5*60*1000;
  const te = new TextEncoder(), td = new TextDecoder();

  function cfgOk(){ return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId); }
  async function fbLoad(){
    if(cloud.db) return;
    if(!cfgOk()) throw new Error("Falta pegar el firebaseConfig en el código (ver «Configurar Firebase»).");
    const base = "https://www.gstatic.com/firebasejs/" + FB_VERSION + "/";
    const appMod = await import(base + "firebase-app.js");
    const fs = await import(base + "firebase-firestore.js");
    cloud.fs = fs;
    const app = appMod.initializeApp(FIREBASE_CONFIG);
    // App Check: comprueba que las peticiones vienen de Sonarium y no de un programa ajeno
    if(APPCHECK_SITE_KEY){
      try{
        if(/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
        const ac = await import(base + "firebase-app-check.js");
        ac.initializeAppCheck(app, { provider: new ac.ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
      }catch(e){ console.warn("App Check no se pudo iniciar", e); }
    }
    // si la conexión continua está bloqueada (extensiones, antivirus, algunas redes), Firestore cambia solo a un método más compatible
    try{ cloud.db = fs.initializeFirestore(app, { experimentalAutoDetectLongPolling: true }); }
    catch(e){ cloud.db = fs.getFirestore(app); }
  }
  function b64e(u8){
    let s = ""; const CH = 0x8000;
    for(let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64d(str){
    const s = atob(str), u = new Uint8Array(s.length);
    for(let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  async function kdf(clave, salU8){
    const km = await crypto.subtle.importKey("raw", te.encode(clave), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name:"PBKDF2", salt:salU8, iterations:150000, hash:"SHA-256" }, km, 512));
  }
  function aesFrom(u8){ return crypto.subtle.importKey("raw", u8, "AES-GCM", false, ["encrypt","decrypt"]); }
  async function viaStream(u8, Ctor){
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new Ctor("gzip"))).arrayBuffer());
  }
  async function packState(st){
    let raw = te.encode(JSON.stringify(st)), comp = 0;
    if(window.CompressionStream){ raw = await viaStream(raw, CompressionStream); comp = 1; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM", iv }, cloud.aesKey, raw));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return { datos: b64e(out), comp };
  }
  async function unpackState(datos, comp){
    const u = b64d(datos);
    let raw = new Uint8Array(await crypto.subtle.decrypt({ name:"AES-GCM", iv:u.subarray(0,12) }, cloud.aesKey, u.subarray(12)));
    if(comp) raw = await viaStream(raw, DecompressionStream);
    return JSON.parse(td.decode(raw));
  }

  function setStatus(s, msg){
    cloud.status = s; cloud.msg = msg || "";
    if(typeof updateAccountChip === "function") updateAccountChip();
  }
  function cloudPushSoon(delay){
    if(!cloud.user) return;
    clearTimeout(cloud.timer);
    cloud.timer = setTimeout(() => cloudSync(), delay === undefined ? 1500 : delay);
  }
  async function cloudSync(opts){
    if(!cloud.user) return;
    if(cloud.busy){ cloud.again = true; return; }
    cloud.busy = true; setStatus("sync");
    const replace = !!(opts && opts.replace);
    try{
      if(!navigator.onLine) throw new Error("Sin conexión");
      await fbLoad();
      const { doc, getDoc, setDoc } = cloud.fs;
      const ref = doc(cloud.db, FB_COLLECTION, cloud.user);
      const snap = await getDoc(ref);
      const local = currentState();
      let merged = local, remote = null;
      if(snap.exists()){
        const d = snap.data();
        if(d.verificador !== cloud.verifier) throw new Error("La clave cambió; vuelve a iniciar sesión.");
        if(!replace){
          try{ remote = await unpackState(d.datos, d.comp); }
          catch(e){ throw new Error("No pude leer el cuaderno de la nube (datos dañados). Puedes reemplazarlo con lo de este dispositivo desde tu cuenta."); }
          merged = isPristine(local) ? remote : mergeStates(local, remote);
        }
      }
      const localChanged = canon(merged) !== canon(local);
      if(localChanged){ applyState(merged); refreshAfterSync(); }
      if(replace || !remote || canon(merged) !== canon(remote)){
        const pk = await packState(merged);
        if(pk.datos.length > 880000) throw new Error("El cuaderno es demasiado grande para la nube (límite ~1 MB).");
        await setDoc(ref, { usuario:cloud.user, sal:cloud.sal, verificador:cloud.verifier,
                            datos:pk.datos, comp:pk.comp, version:3, actualizado:Date.now() });
      }
      cloud.lastSync = Date.now();
      setStatus("ok");
    }catch(e){
      console.warn("Sync", e);
      const off = !navigator.onLine || /offline|network|unavailable|Failed to fetch/i.test(String(e && e.message));
      setStatus(off ? "offline" : "error", off ? "Sin conexión; se sincronizará al volver." : (e && e.message) || String(e));
    }finally{
      cloud.busy = false;
      if(cloud.again){ cloud.again = false; cloudPushSoon(300); }
    }
  }
  function refreshAfterSync(){
    applyChordsPref();
    if(loc.type === "space" && !spaces.find(s => s.id === loc.id)) loc = { type:"folder", id:null };
    if(loc.type === "folder" && loc.id && !folderById(loc.id)) loc = { type:"folder", id:null };
    if(activeId === null && typeof renderHome === "function") renderHome(false);
  }

  function normUser(u){ return (u || "").trim().toLowerCase(); }
  function lockInfo(u){
    try{ const o = JSON.parse(localStorage.getItem(LOCK_KEY)) || {}; return o[u] || { n:0, until:0 }; }catch(e){ return { n:0, until:0 }; }
  }
  function setLock(u, v){
    try{
      const o = JSON.parse(localStorage.getItem(LOCK_KEY)) || {};
      if(v) o[u] = v; else delete o[u];
      localStorage.setItem(LOCK_KEY, JSON.stringify(o));
    }catch(e){}
  }
  async function startSession(user, salB64, verifier, keyBytes, remember){
    cloud.user = user; cloud.sal = salB64; cloud.verifier = verifier;
    cloud.keyB64 = b64e(keyBytes);
    cloud.aesKey = await aesFrom(keyBytes);
    const payload = JSON.stringify({ u:user, s:salB64, v:verifier, k:cloud.keyB64 });
    try{
      localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY);
      (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, payload);
    }catch(e){}
  }
  async function restoreSession(){
    let raw = null;
    try{ raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY); }catch(e){}
    if(!raw) return;
    try{
      const o = JSON.parse(raw);
      cloud.user = o.u; cloud.sal = o.s; cloud.verifier = o.v; cloud.keyB64 = o.k;
      cloud.aesKey = await aesFrom(b64d(o.k));
      setStatus("sync");
      cloudSync();
    }catch(e){ endSession(false); }
  }
  function endSession(wipe){
    clearTimeout(cloud.timer);
    cloud.user = null; cloud.aesKey = null; cloud.keyB64 = null; cloud.sal = null; cloud.verifier = null;
    try{ localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); }catch(e){}
    if(wipe){
      try{ localStorage.removeItem(STATE_KEY); localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(SEEDED_KEY); }catch(e){}
      songs = []; folders = []; spaces = []; tombs = []; meta = {};
      loadState();
      applyChordsPref();
      loc = { type:"folder", id:null };
    }
    setStatus("off");
  }
  async function authSubmit(mode, usuarioRaw, clave, remember, chords, avatar){
    const usuario = normUser(usuarioRaw);
    if(!/^[a-z0-9._-]{3,24}$/.test(usuario)) throw new Error("El usuario debe tener 3 a 24 caracteres: letras, números, punto, guion o guion bajo.");
    if((clave || "").length < 6) throw new Error("La clave debe tener al menos 6 caracteres.");
    if(mode === "create" && chords !== true && chords !== false) throw new Error("Elige si quieres ver los acordes o solo la letra.");
    if(mode === "create" && !avById(avatar)) throw new Error("Elige tu avatar.");
    const li = lockInfo(usuario);
    if(li.until > Date.now()) throw new Error("Demasiados intentos. Espera " + Math.ceil((li.until - Date.now())/60000) + " min.");
    if(!window.crypto || !crypto.subtle) throw new Error("Este navegador/contexto no permite cifrado. Abre la página con Live Server o desde https.");
    await fbLoad();
    const { doc, getDoc } = cloud.fs;
    const snap = await getDoc(doc(cloud.db, FB_COLLECTION, usuario));
    if(mode === "login"){
      if(!snap.exists()) throw new Error("Esa cuenta no existe. Usa «Crear cuenta».");
      const d = snap.data();
      const bits = await kdf(clave, b64d(d.sal));
      const ver = b64e(bits.slice(0, 32));
      if(ver !== d.verificador){
        const n = li.n + 1;
        setLock(usuario, n >= MAX_FAILS ? { n:0, until: Date.now() + LOCK_MS } : { n, until:0 });
        throw new Error("Usuario o clave incorrectos.");
      }
      setLock(usuario, null);
      await startSession(usuario, d.sal, ver, bits.slice(32), remember);
    } else {
      if(snap.exists()) throw new Error("Ese usuario ya existe. Elige otro o inicia sesión.");
      const salU8 = crypto.getRandomValues(new Uint8Array(16));
      const bits = await kdf(clave, salU8);
      await startSession(usuario, b64e(salU8), b64e(bits.slice(0, 32)), bits.slice(32), remember);
      meta.prefs = { chords, avatar, at: Date.now() };
      persist({ noSync:true });
      applyChordsPref();
    }
    await cloudSync();
    if(cloud.status === "error") throw new Error(cloud.msg || "No se pudo sincronizar.");
  }

  /* ---------------- transposición de acordes ---------------- */
  const SHARPS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const FLATS  = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
  const NOTE_RE = /^([A-G])(#|b)?/;

  function noteIndex(note){
    let n = SHARPS.indexOf(note);
    if(n === -1) n = FLATS.indexOf(note);
    return n;
  }
  function transposeChord(chord, shift){
    if(!shift) return chord;
    return chord.split("/").map(part => transposeSingle(part, shift)).join("/");
  }
  function transposeSingle(part, shift){
    const m = part.match(NOTE_RE);
    if(!m) return part;
    const root = m[0];
    const rest = part.slice(root.length);
    const usesFlat = root.includes("b");
    const idx = noteIndex(root);
    if(idx === -1) return part;
    let newIdx = (idx + shift) % 12;
    if(newIdx < 0) newIdx += 12;
    const table = usesFlat ? FLATS : SHARPS;
    let out = table[newIdx];
    // nombres de uso común: Bb y Eb siempre; Ab en acordes mayores (G#m se queda como G#m)
    if(!usesFlat && (newIdx === 10 || newIdx === 3 || (newIdx === 8 && !/^m(?!aj)/.test(rest)))) out = FLATS[newIdx];
    return out + rest;
  }
  const NOTE_ES = { C:"Do", D:"Re", E:"Mi", F:"Fa", G:"Sol", A:"La", B:"Si" };
  function useLatin(){ try{ return localStorage.getItem("sonarium.notacion") === "latin"; }catch(e){ return false; } }
  function toNotation(ch){
    if(!useLatin() || !ch) return ch;
    return String(ch).replace(/(^|\/)([A-G])/g, (m, p, n) => p + NOTE_ES[n]);
  }
  function shiftKeyLabel(key, shift){
    if(!key) return "";
    return toNotation(transposeChord(key.trim(), shift));
  }

  /* ---------------- parseo de letra con acordes ---------------- */
  function parseLine(line){
    const chords = [];
    let lyric = "";
    let i = 0;
    while(i < line.length){
      if(line[i] === "["){
        const end = line.indexOf("]", i);
        if(end !== -1){
          chords.push({ pos: lyric.length, text: line.slice(i+1, end) });
          i = end + 1;
          continue;
        }
      }
      lyric += line[i];
      i++;
    }
    return { chords, lyric };
  }
  function splitInlineDirectives(lines){
    const out = [], DIR = "\\{\\s*(?:soc|eoc|start_of_chorus|end_of_chorus)\\s*(?::[^}]*)?\\}";
    const reHead = new RegExp("^\\s*(" + DIR + ")\\s*", "i"), reTail = new RegExp("\\s*(" + DIR + ")\\s*$", "i");
    lines.forEach(l => {
      if(/^\s*\{[^}]*\}\s*$/.test(l)){ out.push(l); return; }
      let rest = l, m; const head = [], tail = [];
      while((m = reHead.exec(rest))){ head.push(m[1]); rest = rest.slice(m[0].length); }
      while((m = reTail.exec(rest))){ tail.unshift(m[1]); rest = rest.slice(0, m.index); }
      head.forEach(x => out.push(x));
      if(rest.trim() !== "" || !(head.length || tail.length)) out.push(rest);
      tail.forEach(x => out.push(x));
    });
    return out;
  }
  function renderSongBody(body, shift){
    const lines = splitInlineDirectives(body.split("\n"));
    let html = "", inChorus = false;
    const closeChorus = () => { if(inChorus){ html += "</div>"; inChorus = false; } };
    lines.forEach(rawLine => {
      /* directivas ChordPro: {soc}…{eoc} = coro, {c: texto} = etiqueta; las demás se ocultan */
      const dm = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i.exec(rawLine);
      if(dm){
        const d = dm[1].toLowerCase(), arg = (dm[2] || "").trim();
        if(d === "soc" || d === "start_of_chorus"){
          closeChorus(); inChorus = true;
          html += '<div class="chorus">' + '<div class="sec-label">' + escapeHtml(arg || "Coro") + '</div>';
        } else if(d === "eoc" || d === "end_of_chorus"){
          closeChorus();
        } else if(d === "sov" || d === "start_of_verse" || d === "sob" || d === "start_of_bridge" || d === "c" || d === "comment" || d === "ci" || d === "comment_italic" || d === "cb" || d === "comment_box"){
          const lbl = arg || (/verse/.test(d) || d === "sov" ? "Estrofa" : (/bridge/.test(d) || d === "sob" ? "Puente" : ""));
          if(lbl) html += '<div class="sec-label solo">' + escapeHtml(lbl) + '</div>';
        }
        return;
      }
      if(rawLine.trim() === ""){
        html += `<div class="song-line blank"></div>`;
        return;
      }
      const { chords, lyric } = parseLine(rawLine);
      let chordHtml = "";
      chords.forEach(c => {
        const shown = toNotation(transposeChord(normChord(c.text), shift));
        chordHtml += `<span class="chord-tag" data-ch="${escapeHtml(transposeChord(normChord(c.text), shift)).replace(/"/g, "&quot;")}" style="left:calc(${c.pos}ch / 0.875);">${escapeHtml(shown)}</span>`;
      });
      const lyricClass = lyric.trim() === "" ? "lyric-text faded" : "lyric-text";
      html += `<div class="song-line${chords.length ? "" : " nc"}">${chordHtml}<span class="${lyricClass}">${escapeHtml(lyric) || "&nbsp;"}</span></div>`;
    });
    closeChorus();
    return html;
  }
  function escapeHtml(str){
    return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  function hexToRgba(hex, alpha){
    const h = hex.replace('#','');
    const r = parseInt(h.substring(0,2),16);
    const g = parseInt(h.substring(2,4),16);
    const b = parseInt(h.substring(4,6),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function daysLeft(trashedAt){
    const remainMs = TRASH_DAYS*DAY_MS - (Date.now() - trashedAt);
    return Math.max(0, Math.ceil(remainMs / DAY_MS));
  }

  /* ---------------- refs DOM ---------------- */
  const el = {
    homeScreen: document.getElementById("homeScreen"),
    songScreen: document.getElementById("songScreen"),
    songGrid: document.getElementById("songGrid"),
    searchInput: document.getElementById("searchInput"),
    songTitle: document.getElementById("songTitle"),
    songArtist: document.getElementById("songArtist"),
    keyLabel: document.getElementById("keyLabel"),
    songRender: document.getElementById("songRender"),
    lyricsArea: document.getElementById("lyricsArea"),
    scrollDock: document.getElementById("scrollDock"),
    playBtn: document.getElementById("playBtn"),
    speedRange: document.getElementById("speedRange"),
    modalVeil: document.getElementById("modalVeil"),
    modalTitle: document.getElementById("modalTitle"),
    fieldTitle: document.getElementById("fieldTitle"),
    fieldArtist: document.getElementById("fieldArtist"),
    fieldKey: document.getElementById("fieldKey"),
    fieldBody: document.getElementById("fieldBody"),
    swatches: document.getElementById("swatches"),
    confirmVeil: document.getElementById("confirmVeil"),
    confirmText: document.getElementById("confirmText"),
    trashVeil: document.getElementById("trashVeil"),
    trashList: document.getElementById("trashList"),
    trashBadge: document.getElementById("trashBadge"),
    accentBlob: document.getElementById("accentBlob"),
    crumbs: document.getElementById("crumbs"),
    spacesStrip: document.getElementById("spacesStrip"),
  };

  /* ---------------- swatches del modal ---------------- */
  function buildSwatches(){
    el.swatches.innerHTML = "";
    PALETTE.forEach(c => {
      const s = document.createElement("div");
      s.className = "swatch" + (c.hex === selectedColor ? " selected" : "");
      s.style.background = c.hex;
      s.title = c.name;
      s.addEventListener("click", () => { selectedColor = c.hex; buildSwatches(); });
      el.swatches.appendChild(s);
    });
    const customWrap = document.createElement("label");
    customWrap.className = "swatch custom-swatch";
    const isCustom = !PALETTE.some(c => c.hex === selectedColor);
    if(isCustom){ customWrap.style.background = selectedColor; customWrap.classList.add("selected"); customWrap.textContent = ""; }
    else customWrap.textContent = "+";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = selectedColor;
    colorInput.style.opacity = 0;
    colorInput.style.position = "absolute";
    colorInput.style.width = "1px";
    colorInput.style.height = "1px";
    colorInput.addEventListener("input", (e) => { selectedColor = e.target.value; buildSwatches(); });
    customWrap.appendChild(colorInput);
    el.swatches.appendChild(customWrap);
  }

  /* ---------------- util de tiempo ---------------- */
  function fmtLeft(ms){
    if(ms <= 0) return "vencido";
    const m = Math.floor(ms/60000), h = Math.floor(m/60), d = Math.floor(h/24);
    if(h >= 48) return d + " días";
    if(h >= 1) return h + " h " + String(m % 60).padStart(2,"0") + " min";
    return Math.max(1, m) + " min";
  }
  function fmtDate(ts){
    return new Date(ts).toLocaleString("es-CO", { weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit" });
  }
  function attr(s){ return escapeHtml(String(s)).replace(/"/g, "&quot;"); }
  function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* ---------------- render HOME (explorador) ---------------- */
  const FOLDER_SVG = '<svg viewBox="0 0 34 28" aria-hidden="true"><path d="M2 5a3 3 0 0 1 3-3h9l4 4h11a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function renderCrumbs(){
    const q = el.searchInput.value.trim();
    const sep = '<span class="sep">›</span>';
    const parts = [];
    const atRoot = loc.type === "folder" && !loc.id && !q && !filterActive();
    parts.push(atRoot ? '<span class="crumb current">🏠 Cuaderno</span>'
                      : '<button class="crumb" data-crumb="">🏠 Cuaderno</button>');
    if(q || filterActive()){
      const lbl = q ? 'Resultados de «' + escapeHtml(q) + '»' : (filt.fav ? "★ Favoritas" : "Etiqueta") + (filt.tag ? ' #' + escapeHtml((songs.map(tagsOf).flat().find(t => tagKey(t) === filt.tag)) || filt.tag) : "");
      parts.push(sep, '<span class="crumb current">' + lbl + '</span>');
    } else if(loc.type === "space"){
      const sp = spaces.find(s => s.id === loc.id);
      parts.push(sep, '<span class="crumb current">⏱ ' + escapeHtml(sp ? sp.name : "Espacio") + '</span>');
    } else if(loc.id){
      const path = folderPath(loc.id);
      path.forEach((f, i) => {
        parts.push(sep, i === path.length - 1
          ? '<span class="crumb current">' + escapeHtml(f.name) + '</span>'
          : '<button class="crumb" data-crumb="' + attr(f.id) + '">' + escapeHtml(f.name) + '</button>');
      });
    }
    el.crumbs.innerHTML = parts.join("");
  }

  // Subtítulo: bienvenida las primeras 2 visitas; después, contadores (los que valen 0 no se muestran).
  function renderSub(){
    const p = document.getElementById("homeSub");
    if(!p) return;
    if(visits <= 2){
      p.innerHTML = '<span>Bienvenido a <strong>Sonarium</strong>. Elige una canción o crea una nueva.</span>';
      return;
    }
    const nS = songs.filter(s => !s.trashedAt).length, nF = folders.length, nE = spaces.length;
    const pl = (n, a, b) => n + " " + (n === 1 ? a : b);
    const parts = [];
    if(nS) parts.push(["var(--accent)", pl(nS, "canción", "canciones")]);
    if(nF) parts.push([PALETTE[1].hex, pl(nF, "carpeta", "carpetas")]);
    if(nE) parts.push([PALETTE[2].hex, pl(nE, "espacio", "espacios")]);
    p.innerHTML = parts.map(x => '<span class="stat" style="--c:' + x[0] + '"><i></i>' + x[1] + '</span>').join("");
  }

  function renderSpacesStrip(){
    const q = el.searchInput.value.trim();
    if(!spaces.length || q){ el.spacesStrip.innerHTML = ""; el.spacesStrip.style.display = "none"; return; }
    const now = Date.now();
    el.spacesStrip.style.display = "flex";
    el.spacesStrip.innerHTML = '<span class="strip-label">Espacios temporales</span>' +
      [...spaces].sort((a, b) => a.expiresAt - b.expiresAt).map(sp => {
        const n = (sp.songIds || []).filter(id => songs.some(s => s.id === id && !s.trashedAt)).length;
        const left = sp.expiresAt - now;
        return '<button class="space-chip' + (loc.type === "space" && loc.id === sp.id ? " active" : "") +
          (left < 3600000 ? " soon" : "") + '" data-space="' + attr(sp.id) + '">' +
          '<span class="sn">' + escapeHtml(sp.name) + '</span>' +
          '<span class="sl">' + n + ' · ' + fmtLeft(left) + '</span></button>';
      }).join("");
  }

  const HANDLE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h14"/></svg>';
  function songCardHtml(s, i, o){
    o = o || {};
    const color = s.color || PALETTE[0].hex;
    const acts = o.inSpace
      ? '<button data-act="unspace" class="d" title="Quitar del espacio">✕</button><button class="drag-handle" type="button" title="Arrastra para cambiar el orden" aria-label="Cambiar el orden">' + HANDLE_SVG + '</button>'
      : '<button data-act="fav" class="fav' + (s.fav ? ' on' : '') + '" title="' + (s.fav ? 'Quitar de favoritas' : 'Marcar como favorita') + '">' + (s.fav ? '★' : '☆') + '</button><button data-act="space" title="Agregar a un espacio temporal">⏱</button><button data-act="move" title="Mover a otra carpeta">📁</button><button data-act="del" class="d" title="Eliminar">✕</button>';
    const sub = (o.snippet ? '<div class="snip">' + o.snippet + '</div>' : "") + (o.path ? '<div class="path">' + escapeHtml(o.path) + '</div>' : "");
    return '<div class="card song-card"' + (o.inSpace ? '' : ' draggable="true"') + ' data-id="' + attr(s.id) + '" style="--i:' + Math.min(i, 14) +
      ';--c:' + color + ';color:' + color + ';border-color:' + hexToRgba(color, 0.35) + ';">' +
      '<span class="dot" style="background:' + color + ';"></span><div class="glow" style="background:' + color + ';"></div>' +
      '<div class="txt"><div class="t">' + (o.num ? '<span class="ord">' + o.num + '</span>' : "") + (s.fav ? '<span class="star" aria-label="Favorita">★</span>' : "") + escapeHtml(s.title) + '</div>' +
      '<div class="a">' + escapeHtml(artistLabel(s.artist)) + '</div>' + sub + '</div>' +
      '<div class="card-actions">' + acts + '</div></div>';
  }
  function folderCardHtml(f, i){
    const color = f.color || PALETTE[0].hex;
    const nSub = childFolders(f.id).length, nSongs = countSongsRec(f.id);
    const meta = (nSub ? nSub + (nSub === 1 ? " carpeta · " : " carpetas · ") : "") + nSongs + (nSongs === 1 ? " canción" : " canciones");
    return '<div class="card folder-card" draggable="true" data-folder="' + attr(f.id) + '" style="--i:' + Math.min(i, 14) +
      ';--c:' + color + ';color:' + color + ';border-color:' + hexToRgba(color, 0.32) + ';">' +
      '<span class="fico">' + FOLDER_SVG + '</span><div class="glow" style="background:' + color + ';"></div>' +
      '<div class="txt"><div class="t">' + escapeHtml(f.name) + '</div><div class="a">' + meta + '</div></div>' +
      '<div class="card-actions"><button data-act="rename" title="Cambiar nombre">✎</button>' +
      '<button data-act="move" title="Mover a otra carpeta">📁</button>' +
      '<button data-act="del" class="d" title="Eliminar carpeta">✕</button></div></div>';
  }

  function spaceHeadHtml(sp){
    const left = sp.expiresAt - Date.now();
    const chips = SPACE_OPTIONS.filter(o => o.h <= 336).map(o =>
      '<button class="mini" data-ext="' + o.h + '">+ ' + o.label + '</button>').join("");
    return '<div class="space-head">' +
      '<div class="sh-top"><div><div class="sh-title">⏱ ' + escapeHtml(sp.name) + '</div>' +
      '<div class="sh-sub">Vence en <strong>' + fmtLeft(left) + '</strong> · ' + fmtDate(sp.expiresAt).replace(/\.$/, "") +
      '. Al vencer solo se quita el espacio; las canciones se quedan en tu cuaderno.<br>Se tocan en este orden: arrastra <b>≡</b> para cambiarlo.</div></div>' +
      '<div class="sh-actions"><button class="glass-btn primary" data-sact="share">⇪ Compartir</button><button class="glass-btn" data-sact="add">+ Agregar canciones</button>' +
      '<button class="glass-btn" data-sact="edit">✎ Editar</button>' +
      '<button class="glass-btn danger" data-sact="del">Eliminar espacio</button></div></div>' +
      '<div class="sh-ext"><span>Extender el uso:</span>' + chips + '</div></div>';
  }

  const ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  const ICON_GRID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>';
  function isListView(){
    let v = null;
    try{ v = localStorage.getItem("sonarium.vista"); }catch(e){}
    if(v === "list") return true;
    if(v === "grid") return false;
    return window.matchMedia && window.matchMedia("(max-width:640px)").matches;
  }
  function applyViewMode(){
    const list = isListView();
    el.songGrid.classList.toggle("list", list || (loc.type === "space" && !el.searchInput.value.trim()));
    ["viewBtn", "mobileView"].forEach(id => {
      const b = document.getElementById(id);
      if(b){ b.innerHTML = list ? ICON_GRID : ICON_LIST; b.title = list ? "Ver en cuadrícula" : "Ver en lista"; }
    });
  }
  /* ---------------- varios artistas en una canción ---------------- */
  // Se separan con coma, punto y coma, "y", "&", "/" o "feat.". Ej.: "Hermana Glenda y Jésed, Ana Gabriel"
  function splitArtists(str){
    const seen = new Set(), out = [];
    String(str || "").split(/\s*(?:[,;&\/]|\s+y\s+|\s+(?:feat|ft)\.?\s+)\s*/i).forEach(n => {
      n = n.trim(); if(!n) return;
      const k = n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      if(!seen.has(k)){ seen.add(k); out.push(n); }
    });
    return out;
  }
  const artistKey = n => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function artistLabel(str){ const a = splitArtists(str); return a.length > 1 ? a.join(" · ") : (str || ""); }
  // Orden por artista: la canción aparece bajo cada uno de sus artistas, con un rótulo por grupo.
  function songsHtml(list, i0, optsFn){
    const sorted = sortSongs(list);
    let i = i0, html = "";
    if(getSort() !== "artista"){
      sorted.forEach(s => { html += songCardHtml(s, i++, optsFn ? optsFn(s) : undefined); });
      return html;
    }
    const groups = new Map(), none = [];
    sorted.forEach(s => {
      const names = splitArtists(s.artist);
      if(!names.length){ none.push(s); return; }
      names.forEach(n => {
        const k = artistKey(n);
        if(!groups.has(k)) groups.set(k, { name:n, songs:[] });
        groups.get(k).songs.push(s);
      });
    });
    const col = (a, b) => a.localeCompare(b, "es", { sensitivity:"base" });
    const ordered = [...groups.values()].sort((a, b) => col(a.name, b.name));
    if(none.length) ordered.push({ name:"Sin artista", songs:none, none:true });
    ordered.forEach(g => {
      html += '<div class="artist-head' + (g.none ? ' none' : '') + '"><span>' + escapeHtml(g.name) + '</span><i>' + g.songs.length + '</i></div>';
      g.songs.forEach(s => { html += songCardHtml(s, i++, optsFn ? optsFn(s) : undefined); });
    });
    return html;
  }
  const SORT_KEY = "sonarium.orden";
  function getSort(){ try{ const v = localStorage.getItem(SORT_KEY); return (v === "alfa" || v === "artista") ? v : "recientes"; }catch(e){ return "recientes"; } }
  function sortSongs(list){
    const mode = getSort(), out = [...list];
    const col = (a, b) => (a || "").localeCompare(b || "", "es", { sensitivity:"base" });
    if(mode === "alfa") out.sort((a, b) => col(a.title, b.title));
    else if(mode === "artista") out.sort((a, b) => {
      const ea = !(a.artist || "").trim(), eb = !(b.artist || "").trim();
      if(ea !== eb) return ea ? 1 : -1;
      return col(a.artist, b.artist) || col(a.title, b.title);
    });
    else out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }
  function renderHome(animate){
    purgeExpiredSpaces();
    document.getElementById("sortSel").value = getSort();
    applyViewMode();
    const q = el.searchInput.value.trim().toLowerCase();
    renderCrumbs();
    renderFilterRow();
    renderSub();
    renderSpacesStrip();
    let html = "", i = 0;

    if(q || filterActive()){
      const fl = filterActive() ? [] : folders.filter(f => searchWords(q).every(w => nrm(f.name).includes(w)));
      const sl = activeSongs(q);
      fl.forEach(f => { html += folderCardHtml(f, i++); });
      html += songsHtml(activeSongs(q), i, s => ({ path: pathLabel(effFolder(s)), snippet: snippetFor(s, q) }));
      if(!fl.length && !sl.length) html = '<div class="empty-hint">' + (filterActive() ? 'Ninguna canción coincide con ese filtro todavía.' : 'No hay carpetas ni canciones que coincidan con tu búsqueda.') + '</div>';
    } else if(loc.type === "space"){
      const sp = spaces.find(s => s.id === loc.id);
      if(!sp){ loc = { type:"folder", id:null }; return renderHome(animate); }
      html += spaceHeadHtml(sp);
      const list = (sp.songIds || []).map(id => songs.find(s => s.id === id && !s.trashedAt)).filter(Boolean);
      list.forEach((s, k) => { html += songCardHtml(s, i++, { inSpace:true, num:k + 1, path: pathLabel(effFolder(s)) }); });
      if(!list.length) html += '<div class="empty-hint">Este espacio está vacío. Usa «Agregar canciones», o toca ⏱ en cualquier canción, o arrástrala hasta el espacio.</div>';
    } else {
      if(!loc.id && !songs.some(s => !s.trashedAt && !SEED_SONG_IDS.includes(s.id))) html += startCardHtml();
      html += '<div class="card add-card" id="addCard"><div class="plus">+</div><div>Nueva canción</div></div>';
      childFolders(loc.id).forEach(f => { html += folderCardHtml(f, i++); });
      html += songsHtml(songs.filter(s => !s.trashedAt && effFolder(s) === (loc.id || null)), i);
      if(loc.id && !childFolders(loc.id).length && !songs.some(s => !s.trashedAt && effFolder(s) === loc.id)){
        html += '<div class="empty-hint">Esta carpeta está vacía. Crea una canción aquí o arrastra canciones desde otra carpeta.</div>';
      }
    }
    if(!q && loc.type !== "space") html += quoteHtml();
    el.songGrid.innerHTML = html;
    if(animate){
      el.songGrid.classList.remove("enter"); void el.songGrid.offsetWidth; el.songGrid.classList.add("enter");
    } else {
      el.songGrid.classList.remove("enter");
    }
    updateTrashBadge();
  }

  function updateTrashBadge(){
    const n = trashedSongs().length;
    if(n > 0){
      el.trashBadge.style.display = "flex";
      el.trashBadge.textContent = n;
    } else {
      el.trashBadge.style.display = "none";
    }
  }

  /* ---------------- navegación ---------------- */
  function goHome(){
    stopAutoScroll();
    activeId = null;
    songCtx = null;
    el.songScreen.style.display = "none";
    el.homeScreen.style.display = "flex";
    document.body.classList.remove("song-open");
    setReading(false);
    setAccent(null);
    renderHome(true);
  }
  function openFolder(id){
    loc = { type:"folder", id: id || null };
    el.searchInput.value = "";
    renderHome(true);
  }
  function openSpace(id){
    loc = { type:"space", id };
    el.searchInput.value = "";
    renderHome(true);
  }

  function openSong(id, ctx){
    if(ctx !== undefined) songCtx = ctx;
    activeId = id;
    const song = songs.find(s => s.id === id);
    if(!song) return goHome();
    semitoneShift = song.semi || 0;      // cada canción recuerda su tono
    el.homeScreen.style.display = "none";
    el.songScreen.style.display = "flex";
    document.body.classList.add("song-open");
    setReading(window.matchMedia && window.matchMedia("(orientation:landscape) and (max-height:620px)").matches);
    el.songTitle.textContent = song.title;
    (function(){
      const a = splitArtists(song.artist);
      if(a.length > 1) el.songArtist.innerHTML = a.map(n => '<span class="a-chip">' + escapeHtml(n) + '</span>').join("");
      else el.songArtist.textContent = song.artist || "";
    })();
    paintSongBody(song);
    el.lyricsArea.scrollTop = 0;
    el.songRender.classList.remove("song-in"); void el.songRender.offsetWidth; el.songRender.classList.add("song-in");
    setAccent(song.color);
    updateSpaceNav();
    updateFavBtn();
    renderSongTags(song);
    stageSync();
  }
  function setAccent(hex){
    if(hex){
      document.documentElement.style.setProperty('--accent', hex);
      document.documentElement.style.setProperty('--accent-soft', hexToRgba(hex,0.35));
      el.accentBlob.style.background = hex;
      el.accentBlob.style.opacity = 0.4;
    } else {
      el.accentBlob.style.opacity = 0;
    }
  }

  function applyNotaBtn(){
    const b = document.getElementById("notaBtn");
    if(b){ b.textContent = useLatin() ? "DO" : "ABC"; b.title = useLatin() ? "Mostrar en cifrado americano (A B C)" : "Mostrar en Do Re Mi"; }
  }
  function refreshSongView(){
    const song = songs.find(s => s.id === activeId);
    if(!song) return;
    paintSongBody(song);
  }
  // Con capo, las formas de los acordes bajan tantos semitonos como trastes; el tono real (keyLabel) no cambia.
  const capoOf = s => Math.max(0, Math.min(11, (s && s.capo) || 0));
  function paintSongBody(song){
    const capo = capoOf(song);
    el.keyLabel.textContent = shiftKeyLabel(song.key, semitoneShift) || "—";
    el.songRender.innerHTML = renderSongBody(song.body, semitoneShift - capo);
    const lab = document.getElementById("capoLabel");
    if(lab){
      const shape = song.key ? shiftKeyLabel(song.key, semitoneShift - capo) : "";
      lab.textContent = capo ? "Capo " + capo + (shape ? " · " + shape : "") : "Sin capo";
      document.getElementById("capoPill").title = capo ? "Capo en el traste " + capo + (shape ? ": tocas las formas de " + shape + " y suena en " + (shiftKeyLabel(song.key, semitoneShift)) : "") : "Capo (cejilla)";
      document.getElementById("capoPill").classList.toggle("on", capo > 0);
    }
    stageSync();
  }
  function updateTranspose(delta){
    const song = songs.find(s => s.id === activeId);
    if(!song) return;
    semitoneShift += delta;
    if(semitoneShift) song.semi = semitoneShift; else delete song.semi;
    persist();
    paintSongBody(song);
  }
  function setCapo(delta){
    const song = songs.find(s => s.id === activeId);
    if(!song) return;
    const n = Math.max(0, Math.min(11, capoOf(song) + delta));
    if(n === capoOf(song)) return;
    if(n) song.capo = n; else delete song.capo;
    persist();
    paintSongBody(song);
  }
  document.getElementById("capoDown").addEventListener("click", () => setCapo(-1));
  document.getElementById("capoUp").addEventListener("click", () => setCapo(1));

  /* ---------------- auto-scroll ---------------- */
  function startAutoScroll(){
    autoScroll.playing = true;
    autoScroll.lastTs = performance.now();
    autoScroll.pos = el.lyricsArea.scrollTop;
    el.playBtn.textContent = "❚❚";
    el.playBtn.classList.add("playing");
    requestAnimationFrame(step);
  }
  function stopAutoScroll(){
    autoScroll.playing = false;
    if(autoScroll.raf) cancelAnimationFrame(autoScroll.raf);
    el.playBtn.textContent = "▶";
    el.playBtn.classList.remove("playing");
  }
  function step(ts){
    if(!autoScroll.playing) return;
    const dt = Math.min(0.1, (ts - autoScroll.lastTs) / 1000);
    autoScroll.lastTs = ts;
    const pxPerSec = autoScroll.speed * 8;
    // si la persona movió la letra con el dedo/rueda, seguimos desde ahí; si no, acumulamos decimales
    if(Math.abs(el.lyricsArea.scrollTop - (autoScroll.pos || 0)) > 2) autoScroll.pos = el.lyricsArea.scrollTop;
    autoScroll.pos = (autoScroll.pos || 0) + pxPerSec * dt;
    el.lyricsArea.scrollTo({ top: autoScroll.pos, behavior: "instant" });
    if(el.lyricsArea.scrollTop + el.lyricsArea.clientHeight >= el.lyricsArea.scrollHeight - 2){
      stopAutoScroll();
      return;
    }
    autoScroll.raf = requestAnimationFrame(step);
  }

  /* ---------------- diálogos genéricos ---------------- */
  const dlg = { veil: null, resolve: null, hasInput: false };
  function askDialog(o){
    return new Promise(resolve => {
      dlg.resolve = resolve; dlg.hasInput = !!o.input;
      document.getElementById("dlgTitle").textContent = o.title || "";
      document.getElementById("dlgText").textContent = o.text || "";
      document.getElementById("dlgText").style.display = o.text ? "" : "none";
      const f = document.getElementById("dlgField"), inp = document.getElementById("dlgInput");
      f.style.display = o.input ? "" : "none";
      inp.value = o.input ? (o.input.value || "") : "";
      inp.placeholder = o.input ? (o.input.placeholder || "") : "";
      const ex = document.getElementById("dlgExtra");
      ex.style.display = o.extra ? "" : "none"; ex.textContent = o.extra || "";
      const ok = document.getElementById("dlgOk");
      ok.textContent = o.ok || "Aceptar";
      ok.className = "glass-btn " + (o.danger ? "danger" : "primary");
      document.getElementById("dlgVeil").classList.add("open");
      if(o.input) setTimeout(() => { inp.focus(); inp.select(); }, 30);
    });
  }
  function closeDialog(val){
    document.getElementById("dlgVeil").classList.remove("open");
    const r = dlg.resolve; dlg.resolve = null;
    if(r) r(val);
  }
  function dlgAccept(){
    if(dlg.hasInput){
      const v = document.getElementById("dlgInput").value.trim();
      if(!v){ document.getElementById("dlgInput").focus(); return; }
      closeDialog(v);
    } else closeDialog(true);
  }

  /* ---------------- selector de carpeta ("Mover a…") ---------------- */
  const pick = { resolve:null };
  function pickFolder(o){
    return new Promise(resolve => {
      pick.resolve = resolve;
      document.getElementById("pickTitle").textContent = o.title || "Mover a…";
      const exclude = o.exclude || [];
      const cur = o.current || null;
      let html = '<button class="pick-item' + (!cur ? " cur" : "") + '" data-pick="">🏠 Cuaderno (inicio)</button>';
      (function walk(pid, depth){
        childFolders(pid).forEach(f => {
          const dis = exclude.includes(f.id);
          html += '<button class="pick-item' + (cur === f.id ? " cur" : "") + '"' + (dis ? " disabled" : "") +
            ' data-pick="' + attr(f.id) + '" style="padding-left:' + (14 + depth*20) + 'px"><span style="color:' + (f.color || "#fff") + '">▸</span> ' +
            escapeHtml(f.name) + '</button>';
          if(!dis) walk(f.id, depth + 1);
        });
      })(null, 0);
      document.getElementById("pickList").innerHTML = html;
      document.getElementById("pickVeil").classList.add("open");
    });
  }
  function closePick(val){
    document.getElementById("pickVeil").classList.remove("open");
    const r = pick.resolve; pick.resolve = null;
    if(r) r(val);
  }

  /* ---------------- carpetas: acciones ---------------- */
  async function newFolder(){
    const parent = loc.type === "folder" ? loc.id : null;
    const name = await askDialog({ title:"Nueva carpeta", input:{ placeholder:"Ej: Misa de domingo" }, ok:"Crear",
      extra:"📚 O cargar las carpetas de la liturgia" });
    if(!name) return;
    if(typeof name === "object"){ addLiturgyTemplate(); return; }
    const base = parent ? folderById(parent) : null;
    folders.push({ id: uid("f-"), name, parentId: parent, ord: nextOrd(parent),
      color: base ? base.color : PALETTE[childFolders(null).length % PALETTE.length].hex });
    persist();
    if(loc.type !== "folder"){ loc = { type:"folder", id:null }; }
    renderHome(false);
    toast("Carpeta «" + name + "» creada");
  }
  async function renameFolder(id){
    const f = folderById(id); if(!f) return;
    const name = await askDialog({ title:"Cambiar nombre", input:{ value:f.name }, ok:"Guardar" });
    if(!name) return;
    f.name = name; persist(); renderHome(false);
  }
  async function moveFolder(id){
    const f = folderById(id); if(!f) return;
    const dest = await pickFolder({ title:"Mover «" + f.name + "» a…", exclude:[id], current:f.parentId || null });
    if(dest === undefined) return;
    if(dest && (dest === id || isDescendant(dest, id))) return;
    if((f.parentId || null) === dest) return;
    f.parentId = dest; f.ord = nextOrd(dest);
    persist(); renderHome(false);
    toast("Carpeta movida a " + (dest ? folderById(dest).name : "Cuaderno"));
  }
  async function deleteFolder(id){
    const f = folderById(id); if(!f) return;
    const nSub = childFolders(id).length, nS = songs.filter(s => !s.trashedAt && effFolder(s) === id).length;
    const ok = await askDialog({
      title:"Eliminar carpeta", danger:true, ok:"Eliminar carpeta",
      text:"¿Eliminar «" + f.name + "»? " + ((nSub || nS)
        ? "Lo que contiene (" + (nSub ? nSub + " carpeta(s)" : "") + (nSub && nS ? " y " : "") + (nS ? nS + " canción(es)" : "") +
          ") no se borra: pasa a la carpeta de arriba."
        : "Está vacía.")
    });
    if(!ok) return;
    const up = f.parentId && folderById(f.parentId) ? f.parentId : null;
    songs.forEach(s => { if(s.folderId === id) s.folderId = up; });
    folders.forEach(c => { if(c.parentId === id) c.parentId = up; });
    folders = folders.filter(c => c.id !== id);
    if(loc.type === "folder" && loc.id === id) loc = { type:"folder", id: up };
    persist(); renderHome(false);
    toast("Carpeta eliminada");
  }
  async function moveSong(id){
    const s = songs.find(x => x.id === id); if(!s) return;
    const dest = await pickFolder({ title:"Mover «" + s.title + "» a…", current: effFolder(s) });
    if(dest === undefined) return;
    setSongFolder(id, dest);
  }
  function setSongFolder(id, dest){
    const s = songs.find(x => x.id === id); if(!s) return;
    if(effFolder(s) === (dest || null)) return;
    s.folderId = dest || null;
    persist();
    if(activeId === null) renderHome(false);
    toast("«" + s.title + "» ahora está en " + (dest ? folderById(dest).name : "Cuaderno"));
  }
  function setFolderParent(id, dest){
    const f = folderById(id); if(!f) return;
    if(dest === id || (dest && isDescendant(dest, id)) || (f.parentId || null) === (dest || null)) return;
    f.parentId = dest || null; f.ord = nextOrd(dest || null);
    persist(); renderHome(false);
    toast("Carpeta movida a " + (dest ? folderById(dest).name : "Cuaderno"));
  }

  /* ---------------- espacios temporales ---------------- */
  let spaceDraft = { songIds:[], openAfter:true, editId:null };
  const $id = x => document.getElementById(x);
  const MAX_SPACE_MIN = 90*1440;
  function durMin(){
    return (parseInt($id("durD").value, 10) || 0)*1440 + (parseInt($id("durH").value, 10) || 0)*60 + (parseInt($id("durM").value, 10) || 0);
  }
  function setDurMin(min){
    min = Math.max(0, Math.min(MAX_SPACE_MIN, Math.round(min)));
    $id("durD").value = Math.floor(min/1440); $id("durH").value = Math.floor((min % 1440)/60); $id("durM").value = min % 60;
  }
  function localInputValue(ts){
    const d = new Date(ts), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function refreshWhen(){
    const min = durMin(), w = $id("spaceWhen");
    if(min < 1){ w.textContent = "Pon al menos 1 minuto."; return; }
    const ts = Date.now() + Math.min(min, MAX_SPACE_MIN)*60000;
    w.innerHTML = "Vence el <strong>" + escapeHtml(fmtDate(ts).replace(/\.$/, "")) + "</strong>" + (min > MAX_SPACE_MIN ? " (máximo 90 días)" : "");
    $id("spaceUntil").value = localInputValue(ts);
  }
  function openSpaceModal(pre, editId){
    const sp = editId ? spaces.find(s => s.id === editId) : null;
    spaceDraft = { songIds: pre || [], openAfter: !sp && !(pre && pre.length), editId: sp ? sp.id : null };
    $id("spaceModalTitle").textContent = sp ? "Editar espacio" : "Nuevo espacio temporal";
    $id("spaceCreate").textContent = sp ? "Guardar cambios" : "Crear espacio";
    $id("spaceName").value = sp ? sp.name : "";
    setDurMin(sp ? Math.max(1, Math.ceil((sp.expiresAt - Date.now())/60000)) : 12*60);
    $id("spaceUntil").min = localInputValue(Date.now());
    refreshWhen();
    $id("spaceVeil").classList.add("open");
    setTimeout(() => $id("spaceName").focus(), 30);
  }
  ["durD", "durH", "durM"].forEach(id => {
    $id(id).addEventListener("input", refreshWhen);
    $id(id).addEventListener("change", () => { setDurMin(durMin()); refreshWhen(); });
  });
  $id("spaceUntil").addEventListener("change", (e) => {
    const min = Math.round((new Date(e.target.value).getTime() - Date.now())/60000);
    if(!isFinite(min) || min < 1){ toast("Elige un momento que todavía no haya pasado"); refreshWhen(); return; }
    setDurMin(min); refreshWhen();
  });
  $id("spaceVeil").addEventListener("click", (e) => {
    const st = e.target.closest("[data-dstep]");
    if(st){
      const [f, d] = st.dataset.dstep.split(":");
      setDurMin(durMin() + (parseInt(d, 10) || 0) * ({ D:1440, H:60, M:1 }[f]));
      refreshWhen(); return;
    }
    const pr = e.target.closest("[data-dpre]");
    if(pr){ setDurMin(parseInt(pr.dataset.dpre, 10)); refreshWhen(); }
  });
  function closeSpaceModal(){ document.getElementById("spaceVeil").classList.remove("open"); }
  function createSpace(){
    const name = $id("spaceName").value.trim() || "Espacio temporal";
    const min = durMin();
    if(min < 1){ toast("Pon al menos 1 minuto de duración"); return; }
    const now = Date.now(), exp = now + Math.min(min, MAX_SPACE_MIN)*60000;
    if(spaceDraft.editId){
      const sp0 = spaces.find(s => s.id === spaceDraft.editId);
      if(sp0){ sp0.name = name; sp0.expiresAt = exp; persist(); }
      closeSpaceModal(); renderHome(false); toast("Espacio actualizado");
      return;
    }
    const sp = { id: uid("e-"), name, songIds: spaceDraft.songIds.slice(), createdAt: now, expiresAt: exp };
    spaces.push(sp);
    persist();
    closeSpaceModal();
    if(spaceDraft.openAfter && activeId === null) openSpace(sp.id);
    else { renderHome(false); toast("Espacio «" + name + "» creado"); }
    refreshSongSpacesModal();
  }
  function extendSpace(id, hours){
    const sp = spaces.find(s => s.id === id); if(!sp) return;
    sp.expiresAt = Math.max(sp.expiresAt, Date.now()) + hours*3600000;
    persist(); renderHome(false);
    toast("Espacio extendido: vence en " + fmtLeft(sp.expiresAt - Date.now()));
  }
  function addToSpace(spaceId, songId){
    const sp = spaces.find(s => s.id === spaceId); if(!sp) return false;
    sp.songIds = sp.songIds || [];
    if(sp.songIds.includes(songId)) return false;
    sp.songIds.push(songId); persist(); return true;
  }
  function moveInSpace(songId, dir){
    const sp = spaces.find(s => s.id === loc.id); if(!sp) return;
    const arr = sp.songIds, i = arr.indexOf(songId), j = i + dir;
    if(i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    persist(); renderHome(false);
  }
  async function renameSpace(id){
    const sp = spaces.find(s => s.id === id); if(!sp) return;
    const name = await askDialog({ title:"Nombre del espacio", input:{ value:sp.name }, ok:"Guardar" });
    if(!name) return;
    sp.name = name; persist(); renderHome(false);
  }
  async function deleteSpace(id){
    const sp = spaces.find(s => s.id === id); if(!sp) return;
    const ok = await askDialog({ title:"Eliminar espacio", danger:true, ok:"Eliminar espacio",
      text:"¿Eliminar el espacio «" + sp.name + "»? Las canciones no se borran, siguen en sus carpetas." });
    if(!ok) return;
    spaces = spaces.filter(s => s.id !== id);
    if(loc.type === "space" && loc.id === id) loc = { type:"folder", id:null };
    persist(); renderHome(true);
  }

  /* agregar canciones a un espacio */
  let spPick = { spaceId:null, selected:new Set() };
  function openSpaceSongs(spaceId){
    const sp = spaces.find(s => s.id === spaceId); if(!sp) return;
    spPick = { spaceId, selected: new Set(sp.songIds || []) };
    document.getElementById("spSongsSearch").value = "";
    renderSpaceSongs();
    document.getElementById("spaceSongsVeil").classList.add("open");
  }
  function renderSpaceSongs(){
    const q = document.getElementById("spSongsSearch").value.trim().toLowerCase();
    const list = songs.filter(s => !s.trashedAt && songMatches(s, searchWords(q)))
      .sort((a, b) => a.title.localeCompare(b.title, "es"));
    document.getElementById("spSongsList").innerHTML = list.length ? list.map(s =>
      '<label class="check-row"><input type="checkbox" data-sp="' + attr(s.id) + '"' + (spPick.selected.has(s.id) ? " checked" : "") + '>' +
      '<span class="cr-t">' + escapeHtml(s.title) + '</span><span class="cr-s">' + escapeHtml(pathLabel(effFolder(s))) + '</span></label>').join("")
      : '<div class="trash-empty">No hay canciones que coincidan.</div>';
  }
  function saveSpaceSongs(){
    const sp = spaces.find(s => s.id === spPick.spaceId);
    if(sp){
      const keep = (sp.songIds || []).filter(id => spPick.selected.has(id));
      spPick.selected.forEach(id => { if(!keep.includes(id)) keep.push(id); });
      sp.songIds = keep; persist();
    }
    document.getElementById("spaceSongsVeil").classList.remove("open");
    renderHome(false);
  }

  /* elegir espacios para una canción */
  let spSong = { id:null };
  function openSongSpaces(songId){
    spSong.id = songId;
    refreshSongSpacesModal();
    document.getElementById("songSpacesVeil").classList.add("open");
  }
  function refreshSongSpacesModal(){
    if(!spSong.id) return;
    const list = [...spaces].sort((a, b) => a.expiresAt - b.expiresAt);
    document.getElementById("songSpacesList").innerHTML = list.length ? list.map(sp =>
      '<label class="check-row"><input type="checkbox" data-ss="' + attr(sp.id) + '"' + ((sp.songIds || []).includes(spSong.id) ? " checked" : "") + '>' +
      '<span class="cr-t">⏱ ' + escapeHtml(sp.name) + '</span><span class="cr-s">vence en ' + fmtLeft(sp.expiresAt - Date.now()) + '</span></label>').join("")
      : '<div class="trash-empty">Todavía no tienes espacios temporales.</div>';
  }

  /* ---------------- cuenta (UI) ---------------- */
  const acc = { mode:"login", busy:false, err:"", chords:null, avatar:null };
  function agoText(ts){
    const s = Math.round((Date.now() - ts)/1000);
    if(s < 10) return "ahora mismo";
    if(s < 60) return "hace " + s + " s";
    if(s < 3600) return "hace " + Math.round(s/60) + " min";
    return "hace " + Math.round(s/3600) + " h";
  }
  function statusText(){
    switch(cloud.status){
      case "ok": return "Sincronizado" + (cloud.lastSync ? " · " + agoText(cloud.lastSync) : "");
      case "sync": return "Sincronizando…";
      case "offline": return cloud.msg || "Sin conexión";
      case "error": return cloud.msg || "Error al sincronizar";
      default: return "Solo en este dispositivo";
    }
  }
  // Saludo con nombre solo para quien aparezca aquí; los demás ven "Hola 👋".
  const GREETING_NAMES = { "alvaroguzm": "Al" };
  // Saludos variados según la hora; se elige uno al abrir la página y se mantiene durante la sesión.
  const GREET_POOL = {
    m:[["Buenos días","☀️"],["Qué bonito día para cantar","🎶"],["Buen día","🌤️"],["Bienvenido de vuelta","☕"]],
    t:[["Buenas tardes","🌻"],["Qué gusto verte","🎸"],["Hola de nuevo","👋"],["Bienvenido de vuelta","🎶"]],
    n:[["Buenas noches","🌙"],["Qué bueno verte por aquí","✨"],["Hola de nuevo","👋"],["Una canción antes de dormir","🎶"]]
  };
  const greetPick = (function(){
    const h = new Date().getHours();
    const pool = GREET_POOL[h >= 5 && h < 12 ? "m" : (h >= 12 && h < 19 ? "t" : "n")];
    let i = -1;
    try{ i = parseInt(sessionStorage.getItem("sonarium.saludo"), 10); }catch(e){}
    if(!(i >= 0 && i < pool.length)){
      i = Math.floor(Math.random() * pool.length);
      try{ sessionStorage.setItem("sonarium.saludo", String(i)); }catch(e){}
    }
    return pool[i];
  })();
  function makeGreeting(name){ return greetPick[0] + (name ? ", " + name : "") + " " + greetPick[1]; }

  // Frase del día (cambia cada día, igual para todos).
  const QUOTES = [
    ["Quien canta bien, ora dos veces.", "San Agustín (atribuida)"],
    ["Sin música, la vida sería un error.", "Friedrich Nietzsche"],
    ["Donde las palabras fallan, la música habla.", "Hans Christian Andersen"],
    ["La música es el lenguaje universal de la humanidad.", "Henry Wadsworth Longfellow"],
    ["La música expresa lo que no puede decirse y sobre lo cual es imposible permanecer callado.", "Victor Hugo"],
    ["Lo bueno de la música es que cuando te golpea no sientes dolor.", "Bob Marley"],
    ["Canten al Señor un canto nuevo.", "Salmo 98"],
    ["La música es una revelación más alta que toda sabiduría y filosofía.", "Ludwig van Beethoven (atribuida)"],
    ["La música lava del alma el polvo de la vida cotidiana.", "Berthold Auerbach (atribuida)"]
  ];
  function todayQuote(){
    const d = new Date(), n = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
    return QUOTES[n % QUOTES.length];
  }
  function quoteHtml(){
    const q = todayQuote();
    return '<figure class="quote-card"><blockquote>“' + escapeHtml(q[0]) + '”</blockquote><figcaption>— ' + escapeHtml(q[1]) + '</figcaption></figure>';
  }
  // Preferencia: ver acordes (músicos) o solo la letra (cantantes). Se guarda en el cuaderno y se sincroniza.
  function showChords(){ return !(meta.prefs && meta.prefs.chords === false); }
  function applyChordsPref(){
    const on = showChords();
    document.body.classList.toggle("no-chords", !on);
    const b = document.getElementById("chordsBtn");
    if(b){ b.classList.toggle("off", !on); b.setAttribute("aria-pressed", String(on)); b.title = on ? "Ocultar acordes" : "Mostrar acordes"; }
    const c = document.getElementById("accShowChords"); if(c) c.checked = on;
  }
  function setPref(patch){ meta.prefs = Object.assign({}, meta.prefs, patch, { at: Date.now() }); persist(); }
  /* ---------------- avatar (también es el favicon de la pestaña) ---------------- */
  const AVATARS = [
    { id:"guitarra", e:"🎸", a:"#ff7eb3", b:"#8b5cf6" }, { id:"piano",   e:"🎹", a:"#5eead4", b:"#3b82f6" },
    { id:"micro",    e:"🎤", a:"#fbbf24", b:"#f43f5e" }, { id:"bateria", e:"🥁", a:"#fb923c", b:"#ef4444" },
    { id:"violin",   e:"🎻", a:"#a78bfa", b:"#ec4899" }, { id:"trompeta",e:"🎺", a:"#facc15", b:"#f97316" },
    { id:"sax",      e:"🎷", a:"#34d399", b:"#0ea5e9" }, { id:"banjo",   e:"🪕", a:"#a3e635", b:"#14b8a6" },
    { id:"audifonos",e:"🎧", a:"#60a5fa", b:"#a855f7" }, { id:"notas",   e:"🎶", a:"#f472b6", b:"#6366f1" },
    { id:"paloma",   e:"🕊️", a:"#bae6fd", b:"#818cf8" }, { id:"estrella",e:"⭐", a:"#fde047", b:"#fb7185" }
  ];
  const avById = id => AVATARS.find(x => x.id === id) || null;
  const avGrad = a => "linear-gradient(135deg," + a.a + "," + a.b + ")";
  function avatarsHtml(sel){
    return '<div class="av-grid">' + AVATARS.map(a =>
      '<button type="button" class="av-opt' + (a.id === sel ? " on" : "") + '" data-av="' + a.id + '" style="background:' + avGrad(a) + '" aria-label="Avatar ' + a.id + '">' + a.e + '</button>').join("") + '</div>';
  }
  /* ícono de la app (pantalla de inicio / app instalada): cuadrado completo con el avatar */
  function avatarSquare(a, size, round){
    const c = document.createElement("canvas"); c.width = c.height = size;
    const x = c.getContext("2d");
    if(round){ x.beginPath(); x.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); x.clip(); }   // ícono circular, sin esquinas
    const g = x.createLinearGradient(0, 0, size, size); g.addColorStop(0, a.a); g.addColorStop(1, a.b);
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    x.font = Math.round(size * 0.5) + "px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
    x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(a.e, size / 2, size * 0.54);
    return c.toDataURL("image/png");
  }
  const appIcon = { touch:null, manifestHref:null, baseManifest:null, blob:null, key:"" };
  async function applyAppIcons(a){
    const key = a ? a.id : "";
    if(key === appIcon.key) return;
    appIcon.key = key;
    const touch = document.querySelector('link[rel="apple-touch-icon"]:not(#dynApple)');
    const man = document.querySelector('link[rel="manifest"]');
    if(!appIcon.touch && touch) appIcon.touch = touch.getAttribute("href");
    if(!appIcon.manifestHref && man) appIcon.manifestHref = man.getAttribute("href");
    const dyn = document.getElementById("dynApple");
    if(!a){   // sin avatar: vuelven los íconos de Sonarium
      if(dyn) dyn.remove();
      if(touch && appIcon.touch) touch.setAttribute("href", appIcon.touch);
      if(man && appIcon.manifestHref) man.setAttribute("href", appIcon.manifestHref);
      if(appIcon.blob){ URL.revokeObjectURL(appIcon.blob); appIcon.blob = null; }
      return;
    }
    try{
      const i180 = avatarSquare(a, 180), i192 = avatarSquare(a, 192), i512 = avatarSquare(a, 512);
      const r192 = avatarSquare(a, 192, true), r512 = avatarSquare(a, 512, true);   // circulares para "any"
      if(touch) touch.setAttribute("href", i180);
      else if(!dyn){ const l = document.createElement("link"); l.rel = "apple-touch-icon"; l.id = "dynApple"; l.href = i180; document.head.appendChild(l); }
      if(!man) return;
      if(!appIcon.baseManifest){
        try{ const r = await fetch(appIcon.manifestHref, { cache:"no-cache" }); appIcon.baseManifest = r.ok ? await r.json() : {}; }
        catch(e){ appIcon.baseManifest = {}; }
      }
      if(appIcon.key !== key) return;   // cambió el avatar mientras tanto
      const base = appIcon.baseManifest || {}, here = location.href.split("#")[0];
      const abs = (u, d) => { try{ return new URL(u || d, new URL(appIcon.manifestHref, location.href)).href; }catch(e){ return here; } };
      const m = Object.assign({ name:"Sonarium", short_name:"Sonarium", display:"standalone", background_color:"#0c1024", theme_color:"#0c1024" }, base, {
        start_url: abs(base.start_url, here), scope: abs(base.scope, "./"), id: abs(base.id, base.start_url || here),
        icons: [
          { src:r192, sizes:"192x192", type:"image/png", purpose:"any" }, { src:r512, sizes:"512x512", type:"image/png", purpose:"any" },
          { src:i192, sizes:"192x192", type:"image/png", purpose:"maskable" }, { src:i512, sizes:"512x512", type:"image/png", purpose:"maskable" }
        ]
      });
      const url = URL.createObjectURL(new Blob([JSON.stringify(m)], { type:"application/manifest+json" }));
      man.setAttribute("href", url);
      if(appIcon.blob) URL.revokeObjectURL(appIcon.blob);
      appIcon.blob = url;
    }catch(e){}
  }
  let iconStash = null, iconKey = "";
  function applyFavicon(a){
    applyAppIcons(a);
    const key = a ? a.id : "";
    if(key === iconKey) return;
    iconKey = key;
    const old = document.getElementById("dynIcon"); if(old) old.remove();
    if(!a){
      if(iconStash){ iconStash.forEach(l => document.head.appendChild(l)); iconStash = null; }
      return;
    }
    try{
      const c = document.createElement("canvas"); c.width = c.height = 64;
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, 64, 64); g.addColorStop(0, a.a); g.addColorStop(1, a.b);
      x.fillStyle = g; x.beginPath(); x.arc(32, 32, 32, 0, Math.PI * 2); x.fill();
      x.font = "36px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
      x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(a.e, 32, 35);
      if(!iconStash){ iconStash = [...document.querySelectorAll('link[rel="icon"]')]; iconStash.forEach(l => l.remove()); }
      const ln = document.createElement("link"); ln.rel = "icon"; ln.type = "image/png"; ln.id = "dynIcon"; ln.href = c.toDataURL("image/png");
      document.head.appendChild(ln);
    }catch(e){}
  }
  function myAvatar(){ return cloud.user && meta.prefs ? avById(meta.prefs.avatar) : null; }
  function setChordsPref(on){
    setPref({ chords: !!on });
    applyChordsPref();
    toast(on ? "Acordes visibles" : "Solo la letra");
  }
  function updateAccountChip(){
    const b = document.getElementById("accountBtn");
    if(!b) return;
    b.className = "glass-btn acct" + (cloud.user ? " on st-" + cloud.status : "");
    const av = myAvatar();
    b.innerHTML = (av ? '<span class="av-mini" style="background:' + avGrad(av) + '">' + av.e + '<span class="adot"></span></span>' : '<span class="adot"></span>') +
      '<span class="al">' + (cloud.user ? escapeHtml(cloud.user) : "Iniciar sesión") + '</span>';
    applyFavicon(av);
    b.title = cloud.user ? statusText() : "Guarda tu cuaderno en la nube para verlo en otros dispositivos";
    const g = document.getElementById("greeting");
    if(g) g.textContent = makeGreeting(cloud.user && GREETING_NAMES[cloud.user]);
    const s = document.getElementById("accStatus");
    if(s){ s.textContent = statusText(); s.className = "acc-status st-" + cloud.status; }
  }
  function renderAccount(){
    const body = document.getElementById("accBody");
    if(cloud.user){
      body.innerHTML =
        '<div class="acc-user"><div class="acc-av"' + (myAvatar() ? ' style="background:' + avGrad(myAvatar()) + ';font-size:24px"' : "") + '>' + (myAvatar() ? myAvatar().e : escapeHtml(cloud.user.slice(0,1).toUpperCase())) + '</div>' +
        '<div><div class="acc-name">' + escapeHtml(cloud.user) + '</div><div class="acc-status" id="accStatus"></div></div></div>' +
        '<p class="confirm-text">Tu cuaderno (canciones, carpetas y espacios temporales) se guarda cifrado en la nube y se sincroniza solo cuando haces cambios.</p>' +
        '<div class="field"><label>Tu avatar <span class="hint-inline">(también es el ícono de la pestaña)</span></label>' + avatarsHtml(meta.prefs && meta.prefs.avatar) + '</div>' +
        '<label class="check-inline"><input type="checkbox" id="accShowChords"' + (showChords() ? " checked" : "") + '> Mostrar acordes en las canciones</label>' + themeRow() + liteRow() + installRow() +
        '<div class="acc-btns"><button class="glass-btn primary" data-acc="sync">⟳ Sincronizar ahora</button>' +
        '<button class="glass-btn" data-acc="tour">❔ Ver el recorrido otra vez</button>' +
        '<button class="glass-btn" data-acc="replace">Reemplazar la nube con este dispositivo</button>' +
        '<button class="glass-btn" data-acc="logout">Cerrar sesión</button>' +
        '<button class="glass-btn danger" data-acc="logoutwipe">Cerrar sesión y borrar lo de este dispositivo</button></div>';
    } else {
      body.innerHTML =
        '<div class="tabs"><button class="tab' + (acc.mode === "login" ? " on" : "") + '" data-accmode="login">Entrar</button>' +
        '<button class="tab' + (acc.mode === "create" ? " on" : "") + '" data-accmode="create">Crear cuenta</button></div>' +
        '<div class="field"><label>Usuario</label><input type="text" id="accUser" autocomplete="username" autocapitalize="off" placeholder="ej: al.guitarra"></div>' +
        '<div class="field"><label>Clave</label><input type="password" id="accPass" autocomplete="' + (acc.mode === "login" ? "current-password" : "new-password") + '" placeholder="mínimo 6 caracteres"></div>' +
        (acc.mode === "create" ? '<div class="field"><label>¿Quieres ver los acordes?</label><div class="choice">' +
          '<button type="button" class="choice-opt' + (acc.chords === true ? " on" : "") + '" data-chords="1"><b>🎸 Sí, toco un instrumento</b><span>Mostrar los acordes sobre la letra</span></button>' +
          '<button type="button" class="choice-opt' + (acc.chords === false ? " on" : "") + '" data-chords="0"><b>🎤 No, solo canto</b><span>Solo la letra, más limpia y cómoda</span></button></div>' +
          '<div class="hint">Lo puedes cambiar cuando quieras con el botón 🎸 dentro de cada canción.</div></div>' : "") +
        (acc.mode === "create" ? '<div class="field"><label>Elige tu avatar</label>' + avatarsHtml(acc.avatar) +
          '<div class="hint">Será tu foto en Sonarium y el ícono de la pestaña del navegador.</div></div>' : "") +
        '<label class="check-inline"><input type="checkbox" id="accRemember" checked> Recordar en este dispositivo</label>' + themeRow() + liteRow() + installRow() +
        '<div class="acc-err" id="accErr"></div>' +
        '<button class="glass-btn primary" id="accSubmit" style="align-self:flex-start;">' + (acc.mode === "login" ? "Entrar" : "Crear mi cuenta") + '</button>' +
        '<p class="hint">Con tu clave se cifra el cuaderno antes de subirlo. <strong>Si la olvidas no se puede recuperar</strong>; por eso conviene exportar una copia de vez en cuando.</p>' +
        (cfgOk() ? "" : '<div class="acc-warn">Aún falta pegar el <code>firebaseConfig</code> en el código. Abre «Configurar Firebase» aquí abajo.</div>') +
        (cfgOk() ? "" : '<details class="setup" open><summary>Configurar Firebase (una sola vez)</summary>' +
        '<ol><li>Entra a <code>console.firebase.google.com</code> → <em>Agregar proyecto</em>. Ponle su propio nombre (ej. «sonarium») y desactiva Analytics. Es un proyecto aparte, sin relación con RoboKids.</li>' +
        '<li><em>Compilación → Firestore Database → Crear base de datos</em> → modo <em>producción</em> → elige una ubicación cercana (ej. <code>southamerica-east1</code>).</li>' +
        '<li><em>Configuración del proyecto</em> (engranaje) → <em>Tus apps</em> → ícono web <code>&lt;/&gt;</code> → registra la app «Sonarium» (sin Hosting) y copia el <code>firebaseConfig</code> en <code>FIREBASE_CONFIG</code>, al inicio del script de <code>index.html</code>.</li>' +
        '<li>En Firestore → <em>Reglas</em>: borra todo, pega estas reglas completas y pulsa <em>Publicar</em>.</li>' +
        '<li>Abre Sonarium con Live Server o desde tu URL publicada, no con doble clic (<code>file:///</code>).</li></ol>' +
        '<pre id="accRules"></pre><button class="glass-btn" id="accCopy" type="button">Copiar reglas</button></details>');
      const pre = document.getElementById("accRules"); if(pre) pre.textContent = RULES_TEXT;
    }
    updateAccountChip();
  }
  function openAccount(){ renderAccount(); document.getElementById("accountVeil").classList.add("open"); }
  function closeAccount(){
    const v = document.getElementById("accountVeil");
    const wasOpen = v.classList.contains("open");
    v.classList.remove("open");
    // recorrido guiado: solo cuando acaba de ingresar y cierra la ventana
    if(wasOpen && acc.fresh && cloud.user){
      acc.fresh = false;
      if(!(meta.prefs && meta.prefs.tour)) setTimeout(startTour, 450);
    }
  }
  /* ---------------- tema claro / oscuro ---------------- */
  const THEME_KEY = "sonarium.tema";
  function themePref(){ try{ return localStorage.getItem(THEME_KEY) || "dark"; }catch(e){ return "dark"; } }
  function isLight(){ return document.documentElement.getAttribute("data-theme") === "light"; }
  function applyTheme(){
    const p = themePref();
    const light = p === "light" || (p === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    const m = document.querySelector('meta[name="theme-color"]'); if(m) m.content = light ? "#eef1fa" : "#0c1024";
    const b = document.getElementById("themeBtn");
    if(b){ b.textContent = light ? "🌙" : "☀️"; b.title = light ? "Cambiar a tema oscuro" : "Cambiar a tema claro"; }
  }
  function setThemePref(v){ try{ localStorage.setItem(THEME_KEY, v); }catch(e){} applyTheme(); }
  function toggleTheme(){ setThemePref(isLight() ? "dark" : "light"); }
  function themeRow(){
    const p = themePref(), o = (v, t) => '<button type="button" class="tpill' + (p === v ? " on" : "") + '" data-acc="th-' + v + '">' + t + '</button>';
    return '<div class="theme-row"><span>Apariencia</span>' + o("auto", "Auto") + o("dark", "🌙 Oscuro") + o("light", "☀️ Claro") + '</div>';
  }
  if(window.matchMedia) matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if(themePref() === "auto") applyTheme(); });
  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  document.getElementById("mobileTheme").addEventListener("click", toggleTheme);
  applyTheme();

  /* instalar como app + uso sin internet */
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; });
  window.addEventListener("appinstalled", () => { installEvt = null; toast("Sonarium instalado"); });
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  function installRow(){
    if(isStandalone()) return "";
    if(installEvt) return '<button class="glass-btn" data-acc="install" style="margin-top:6px;">📲 Instalar Sonarium en este dispositivo</button>';
    if(/iphone|ipad|ipod/i.test(navigator.userAgent)) return '<div class="hint" style="margin-top:6px;">📲 Para instalar: toca Compartir y luego «Agregar a pantalla de inicio».</div>';
    return "";
  }
  function liteRow(){
    return '<label class="check-inline"><input type="checkbox" id="accLite"' + (document.body.classList.contains("lite") ? " checked" : "") + '> Modo ligero (menos efectos, más fluido)</label>';
  }

  async function onAccSubmit(){
    if(acc.busy) return;
    const btn = document.getElementById("accSubmit"), err = document.getElementById("accErr");
    acc.busy = true; btn.disabled = true; btn.textContent = "Un momento…"; err.textContent = "";
    try{
      await authSubmit(acc.mode, document.getElementById("accUser").value,
                       document.getElementById("accPass").value, document.getElementById("accRemember").checked,
                       acc.mode === "create" ? acc.chords : undefined,
                       acc.mode === "create" ? acc.avatar : undefined);
      acc.busy = false;
      acc.fresh = true;
      renderAccount();
      toast(acc.mode === "login" ? "Sesión iniciada" : "Cuenta creada");
      if(activeId === null) renderHome(false);
    }catch(e){
      acc.busy = false;
      if(!cloud.user){
        const b = document.getElementById("accSubmit");
        if(b){ b.disabled = false; b.textContent = acc.mode === "login" ? "Entrar" : "Crear mi cuenta"; }
        const er = document.getElementById("accErr"); if(er) er.textContent = (e && e.message) || String(e);
      } else { renderAccount(); }
    }
  }
  async function onAccAction(act){
    if(act.indexOf("th-") === 0){ setThemePref(act.slice(3)); renderAccount(); }
    else if(act === "install"){ if(installEvt){ installEvt.prompt(); installEvt.userChoice.finally(() => { installEvt = null; renderAccount(); }); } }
    else if(act === "tour"){ closeAccount(); setTimeout(startTour, 450); }
    else if(act === "sync"){ cloudSync(); toast("Sincronizando…"); }
    else if(act === "replace"){
      const ok = await askDialog({ title:"Reemplazar la nube", danger:true, ok:"Reemplazar",
        text:"La nube quedará exactamente como lo que tienes en este dispositivo. Úsalo solo si el cuaderno de la nube se dañó o si lo que ves aquí es lo correcto." });
      if(ok){ await cloudSync({ replace:true }); renderAccount(); }
    }
    else if(act === "logout"){ endSession(false); renderAccount(); toast("Sesión cerrada"); }
    else if(act === "logoutwipe"){
      const ok = await askDialog({ title:"Cerrar sesión y borrar", danger:true, ok:"Cerrar y borrar",
        text:"Se cierra la sesión y se borran las canciones guardadas en este dispositivo. Siguen en la nube, y las recuperas al volver a entrar." });
      if(ok){ endSession(true); renderAccount(); renderHome(true); toast("Dispositivo limpio"); }
    }
  }

  /* ---------------- modal crear/editar ---------------- */
  function openModal(song){
    editingId = song ? song.id : null;
    document.getElementById("modalTitle").textContent = song ? "Editar canción" : "Nueva canción";
    el.fieldTitle.value = song ? song.title : "";
    el.fieldArtist.value = song ? (song.artist || "") : "";
    el.fieldKey.value = song ? (song.key || "") : "";
    document.getElementById("fieldTags").value = song ? tagsOf(song).join(", ") : "";
    el.fieldBody.value = song ? song.body : "";
    selectedColor = song ? (song.color || PALETTE[0].hex) : PALETTE[songs.filter(s=>!s.trashedAt).length % PALETTE.length].hex;
    buildSwatches();
    dupAck = false; updateDupHint();
    el.modalVeil.classList.add("open");
    el.fieldTitle.focus();
  }
  function closeModal(){ el.modalVeil.classList.remove("open"); }
  const normTitle = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  let dupAck = false;
  function findDuplicate(){
    const t = normTitle(el.fieldTitle.value);
    if(!t) return null;
    return songs.find(s => !s.trashedAt && s.id !== editingId && normTitle(s.title) === t) || null;
  }
  function updateDupHint(){
    const hint = document.getElementById("titleHint"), btn = document.getElementById("saveModal");
    const d = findDuplicate();
    if(!d){ hint.hidden = true; dupAck = false; btn.textContent = "Guardar canción"; return; }
    const where = pathLabel(effFolder(d));
    hint.hidden = false;
    hint.textContent = "⚠ Ya tienes «" + d.title + "»" + (d.artist ? " de " + d.artist : "") + (where ? " en " + where : "") + ".";
  }
  function saveModal(){
    const title = el.fieldTitle.value.trim();
    if(!title){ el.fieldTitle.focus(); return; }
    if(findDuplicate() && !dupAck){
      dupAck = true;
      document.getElementById("saveModal").textContent = "Guardar de todos modos";
      const h = document.getElementById("titleHint"); h.classList.remove("shake"); void h.offsetWidth; h.classList.add("shake");
      el.fieldTitle.focus();
      return;
    }
    dupAck = false;
    document.getElementById("saveModal").textContent = "Guardar canción";
    const data = {
      title,
      artist: el.fieldArtist.value.trim(),
      key: el.fieldKey.value.trim(),
      body: el.fieldBody.value,
      color: selectedColor
    };
    const tg = parseTags(document.getElementById("fieldTags").value);
    if(tg.length) data.tags = tg;
    if(editingId){
      const idx = songs.findIndex(s => s.id === editingId);
      if(!data.tags) delete songs[idx].tags;
      histPush(songs[idx], data);
      songs[idx] = Object.assign(songs[idx], data);
      persist();
      closeModal();
      if(activeId === editingId) openSong(editingId);
      renderHome();
    } else {
      const id = uid("s-");
      const folderId = (loc.type === "folder" && !el.searchInput.value.trim()) ? loc.id : null;
      songs.unshift(Object.assign({ id, folderId }, data));
      if(loc.type === "space"){ const sp = spaces.find(x => x.id === loc.id); if(sp){ sp.songIds = sp.songIds || []; sp.songIds.push(id); } }
      persist();
      closeModal();
      goHome();
    }
  }

  /* ---------------- eliminar / papelera ---------------- */
  function askDelete(id){
    pendingDeleteId = id;
    const song = songs.find(s => s.id === id);
    el.confirmText.textContent = song
      ? `¿Seguro que quieres eliminar "${song.title}"? Se guardará en la papelera 12 días antes de borrarse para siempre.`
      : "¿Seguro que quieres eliminar esta canción?";
    el.confirmVeil.classList.add("open");
  }
  function closeConfirm(){ el.confirmVeil.classList.remove("open"); pendingDeleteId = null; }
  function confirmDelete(){
    if(!pendingDeleteId) return closeConfirm();
    const song = songs.find(s => s.id === pendingDeleteId);
    if(song) song.trashedAt = Date.now();
    persist();
    if(activeId === pendingDeleteId) goHome(); else renderHome();
    closeConfirm();
  }

  function renderTrash(){
    cleanupTrash();
    const list = trashedSongs();
    if(list.length === 0){
      el.trashList.innerHTML = `<div class="trash-empty">La papelera está vacía.</div>`;
    } else {
      el.trashList.innerHTML = list.map(s => `
        <div class="trash-item">
          <div class="info">
            <div class="t">${escapeHtml(s.title)}</div>
            <div class="d">${daysLeft(s.trashedAt)} día(s) antes de borrarse para siempre</div>
          </div>
          <div class="btns">
            <button data-restore="${s.id}">Restaurar</button>
            <button class="del" data-purge="${s.id}">Eliminar ya</button>
          </div>
        </div>
      `).join("");
    }
    updateTrashBadge();
  }
  function openTrash(){ renderTrash(); el.trashVeil.classList.add("open"); }
  function closeTrash(){ el.trashVeil.classList.remove("open"); }

  /* ---------------- exportar / importar ---------------- */
  function exportSongs(){
    const blob = new Blob([JSON.stringify(currentState(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mi-cancionero.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  function importSongs(file){
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const parsed = JSON.parse(reader.result);
        const inc = Array.isArray(parsed) ? { songs: parsed } : parsed;
        if(!inc || !Array.isArray(inc.songs)) throw new Error("formato inválido");
        const put = (arr, o) => { const i = arr.findIndex(x => x.id === o.id); if(i >= 0) arr[i] = o; else arr.push(o); };
        let n = 0;
        (inc.folders || []).forEach(f => { if(f && f.id && f.name) put(folders, f); });
        inc.songs.forEach(x => { if(x && x.id && x.title){ put(songs, x); n++; } });
        (inc.spaces || []).forEach(sp => { if(sp && sp.id && sp.expiresAt) put(spaces, sp); });
        persist();
        goHome();
        toast("Se importaron " + n + " canciones");
      }catch(e){
        alert("No se pudo importar el archivo. Verifica que sea un JSON exportado desde el cancionero.");
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- convertir "acordes sobre letra" a [acordes] ---------------- */
  const ES_ROOTS = { do:"C", re:"D", mi:"E", fa:"F", sol:"G", la:"A", si:"B" };
  function parseChordToken(tok){
    const m = tok.match(/^(Do|Re|Mi|Fa|Sol|La|Si|do|re|mi|fa|sol|la|si|[A-G])(#|b)?(.*)$/);
    if(!m) return null;
    let root = m[1], acc = m[2] || "", rest = m[3] || "";
    let letter, minorByCase = false;
    if(ES_ROOTS[root.toLowerCase()] && root.length > 1 || ES_ROOTS[root]){
      letter = ES_ROOTS[root.toLowerCase()];
      if(root === root.toLowerCase()) minorByCase = true;
    } else if(/^[A-G]$/.test(root)){
      letter = root;
    } else return null;
    rest = rest.replace(/^-/, "m").replace(/min/, "m").replace(/-/g, "");
    if(!/^(m|maj|M|sus|dim|aug|add|\+|\d|\/[A-G][#b]?)*$/.test(rest)) return null;
    if(minorByCase && !rest.startsWith("m")) rest = "m" + rest;
    return letter + acc + rest;
  }
  /* marcas que suelen acompañar a los acordes y que no son acordes: barras de compás, repeticiones, N.C. */
  const CH_NOISE = /^(\|{1,2}|:\|{1,2}|\|{1,2}:|\(?x\d+\)?|\(?\d+x\)?|\(?bis\)?|n\.?c\.?|[-–—/.]+|[()]+)$/i;
  const SEC_WORDS = "intro|introducci[oó]n|verso|estrofa|coro|puente|final|solo|pre-?coro|estribillo|interludio|instrumental|outro|verse|chorus|bridge";
  const SEC_ONLY = new RegExp("^\\s*\\[?\\s*((?:" + SEC_WORDS + ")\\s*\\d*)\\s*\\]?\\s*:?\\s*$", "i");
  const SEC_PREFIX = new RegExp("^(\\s*)((?:" + SEC_WORDS + ")\\s*\\d*)\\s*:\\s+(?=\\S)", "i");
  const cleanTok = t => t.replace(/^[(\[]+/, "").replace(/[)\],;.]+$/, "");
  const LOW_ES = /^(do|re|mi|fa|sol|la|si)$/;
  // devuelve los acordes de una línea (con su posición) o null si la línea no es de acordes
  function chordsOfLine(line){
    const work = line.replace(/\t/g, "    ");
    const found = []; let sawUpper = false, sawLowEs = false; const re = /\S+/g; let m;
    while((m = re.exec(work))){
      const raw = m[0];
      if(CH_NOISE.test(raw)) continue;
      const tok = cleanTok(raw), c = tok ? parseChordToken(tok) : null;
      if(c === null) return null;
      if(LOW_ES.test(tok)) sawLowEs = true; else sawUpper = true;
      found.push({ idx: m.index + (raw.length - raw.replace(/^[(\[]+/, "").length), chord: c });
    }
    if(!found.length) return null;
    // "la si mi" en minúsculas casi siempre es letra, no acordes
    if(sawLowEs && !sawUpper) return null;
    return found;
  }
  function isChordLine(line){ return chordsOfLine(line) !== null; }
  function sectionLabel(line){ const m = SEC_ONLY.exec(line); return m ? m[1].trim().replace(/^./, c => c.toUpperCase()) : null; }
  function convertChordSheet(text){
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    for(let i = 0; i < lines.length; i++){
      let line = lines[i];
      const lab = sectionLabel(line);
      if(lab && !chordsOfLine(line)){ out.push("{c: " + lab + "}"); continue; }
      const pre = SEC_PREFIX.exec(line);
      if(pre && chordsOfLine(line.slice(pre[0].length))){ out.push("{c: " + pre[2].trim().replace(/^./, c => c.toUpperCase()) + "}"); line = line.slice(pre[0].length); }
      const found = chordsOfLine(line);
      if(found){
        const next = lines[i+1];
        if(!pre && next !== undefined && next.trim() !== "" && !isChordLine(next) && !sectionLabel(next)){
          let lyric = next.replace(/\t/g, "    ");
          for(let k = found.length - 1; k >= 0; k--){
            const f = found[k];
            if(lyric.length < f.idx) lyric = lyric.padEnd(f.idx, " ");
            lyric = lyric.slice(0, f.idx) + "[" + f.chord + "]" + lyric.slice(f.idx);
          }
          out.push(lyric);
          i++;
        } else {
          out.push(found.map(f => "[" + f.chord + "]").join(" "));
        }
      } else {
        out.push(line);
      }
    }
    return out.join("\n");
  }
  // ¿el texto parece "acordes sobre la letra"? (para ofrecer convertirlo al pegar)
  function chordSheetScore(text){
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n"); let n = 0;
    for(let i = 0; i < lines.length - 1; i++) if(isChordLine(lines[i]) && lines[i+1].trim() && !isChordLine(lines[i+1]) && !/\[[A-G]/.test(lines[i+1])) n++;
    return n;
  }
  // Normaliza los acordes que ya están entre corchetes: [D-] -> [Dm], [Do] -> [C], etc.
  function normChord(c){
    const n = parseChordToken(String(c).trim());
    return n === null ? c : n;
  }
  function normalizeBracketChords(text){
    return text.replace(/\[([^\]\n]*)\]/g, (m, c) => "[" + normChord(c) + "]");
  }
  el.fieldBody.addEventListener("paste", e => {
    const t = ((e.clipboardData || window.clipboardData).getData("text")) || "";
    if(chordSheetScore(t) < 2) return;
    setTimeout(async () => {
      const ok = await askDialog({ title:"Parece una canción con los acordes sobre la letra", text:"¿La convierto al formato de Sonarium, con cada acorde dentro de la letra, justo donde se toca?", ok:"Convertir" });
      if(!ok) return;
      el.fieldBody.value = normalizeBracketChords(convertChordSheet(el.fieldBody.value));
      toast("Acordes convertidos");
    }, 60);
  });
  document.getElementById("convertBtn").addEventListener("click", () => {
    const before = el.fieldBody.value;
    const after = normalizeBracketChords(convertChordSheet(before));
    el.fieldBody.value = after;
    toast(after !== before ? "Acordes convertidos" : "No encontré acordes por convertir");
  });


  /* ---------------- diagramas de acordes (guitarra, ukulele, piano) ---------------- */
  const CD = (function(){
    const PCS = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
    const pcOf = n => { const m = /^([A-G])(#|b)?$/.exec(n); return m ? (PCS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12 : null; };
    function parse(name){
      const parts = String(name).trim().split("/");
      const m = /^([A-G](?:#|b)?)(.*)$/.exec(parts[0]); if(!m) return null;
      const root = pcOf(m[1]); if(root == null) return null;
      let bass = root;
      if(parts[1] !== undefined){ const b = pcOf(parts[1].trim()); if(b == null) return null; bass = b; }
      let r = m[2].replace(/[()\s]/g, "");
      let iv = null, min = false, dim = false, aug = false, half = false, sus = null, seventh = null;
      const add = [], flats = {};
      if(r === "5") iv = [0, 7];
      else {
        let mm = /^(m(?!aj)|min|-)/.exec(r); if(mm){ min = true; r = r.slice(mm[0].length); }
        if(/^(dim|°|o)/.test(r)){ dim = true; r = r.replace(/^(dim|°|o)/, ""); }
        else if(/^(aug|\+)/.test(r)){ aug = true; r = r.replace(/^(aug|\+)/, ""); }
        else if(/^ø/.test(r)){ half = true; r = r.slice(1); }
        let mj = /^(maj|M|Δ)(7|9|11|13)?/.exec(r);
        if(mj){ r = r.slice(mj[0].length); seventh = 11; const e = mj[2]; if(e >= 9) add.push(2); if(e >= 11) add.push(5); if(e >= 13) add.push(9); }
        else { const nm = /^(7|9|11|13)/.exec(r); if(nm){ r = r.slice(nm[0].length); seventh = (dim && !half && nm[1] === "7") ? 9 : 10; const e = +nm[1]; if(e >= 9) add.push(2); if(e >= 11) add.push(5); if(e >= 13) add.push(9); } }
        let guard = 0;
        while(r && guard++ < 8){
          let t;
          if((t = /^sus2/.exec(r))) sus = 2;
          else if((t = /^sus4?/.exec(r))) sus = 5;
          else if((t = /^add(9|2)/.exec(r))) add.push(2);
          else if((t = /^add(11|4)/.exec(r))) add.push(5);
          else if((t = /^6/.exec(r))) add.push(9);
          else if((t = /^b5/.exec(r))) flats.five = 6;
          else if((t = /^#5/.exec(r))) flats.five = 8;
          else if((t = /^b9/.exec(r))) add.push(1);
          else if((t = /^#9/.exec(r))) add.push(3);
          else if((t = /^#11/.exec(r))) add.push(6);
          else if((t = /^b13/.exec(r))) add.push(8);
          else if((t = /^(7|9)/.exec(r)) && seventh == null) { seventh = 10; if(t[1] === "9") add.push(2); }
          else return null;
          r = r.slice(t[0].length);
        }
        if(r) return null;
        const third = sus != null ? sus : (min || dim || half ? 3 : 4);
        const five = flats.five != null ? flats.five : (dim || half ? 6 : aug ? 8 : 7);
        iv = [0, third, five];
        if(seventh != null) iv.push(seventh);
        add.forEach(x => iv.push(x));
        iv = iv.filter((x, i) => iv.indexOf(x) === i);
        // la quinta es opcional cuando el acorde ya tiene 4 o más notas
        var fifthOpt = iv.length >= 4 ? five : null;
      }
      const pcs = new Set(iv.map(x => (root + x) % 12));
      const must = new Set(pcs);
      if(typeof fifthOpt !== "undefined" && fifthOpt != null) must.delete((root + fifthOpt) % 12);
      if(iv.length === 2){ /* power chord: quinta incluida */ }
      pcs.add(bass); must.add(root);
      return { root, bass, pcs, must, iv: iv.map(x => (root + x) % 12), slash: bass !== root };
    }
    const TUN = { guitar: [4, 9, 2, 7, 11, 4], ukulele: [7, 0, 4, 9] };
    function evaluate(f, tun, info, instr){
      const n = tun.length, snd = [];
      for(let i = 0; i < n; i++) if(f[i] >= 0) snd.push(i);
      if(snd.length < (instr === "guitar" ? 4 : 3)) return null;
      for(let k = 1; k < snd.length; k++) if(snd[k] !== snd[k-1] + 1) return null;
      const notes = new Set(); let lowPc = null;
      for(const i of snd){ const pc = (tun[i] + f[i]) % 12; if(!info.pcs.has(pc)) return null; notes.add(pc); if(lowPc === null) lowPc = pc; }
      for(const x of info.must) if(!notes.has(x)) return null;
      if(instr === "guitar" && lowPc !== info.bass) return null;
      const fr = snd.map(i => f[i]).filter(x => x > 0);
      const minF = fr.length ? Math.min(...fr) : 0, maxF = fr.length ? Math.max(...fr) : 0;
      let fingers = fr.length, barre = null;
      if(minF > 0){
        const at = snd.filter(i => f[i] === minF);
        if(at.length >= 3 || (at.length === 2 && at[0] === snd[0])){
          const a = at[0], b = at[at.length - 1];
          for(let i = a; i <= b; i++) if(f[i] === 0) return null;
          // la cejilla cubre desde la primera cuerda con ese traste; las cuerdas bajas silenciadas a su izquierda no cuentan
          barre = { a, b, f: minF };
          fingers = 1 + fr.filter(x => x > minF).length;
        }
      }
      if(fingers > 4) return null;
      const opens = snd.filter(i => f[i] === 0).length, mutes = n - snd.length;
      const score = snd.length * 1.6 - mutes * 0.4 + opens * 0.9 - minF * 0.9 - fingers * 0.4 - (maxF - minF) * 0.3 + (barre ? -0.8 : 0);
      return { frets: f.slice(), score, minF, maxF, barre };
    }
    function voicings(info, instr, limit){
      const tun = TUN[instr], n = tun.length, found = new Map();
      for(let w = 1; w <= 11; w++){
        const f = new Array(n);
        (function go(i){
          if(i === n){ const r = evaluate(f, tun, info, instr); if(r){ const k = r.frets.join(","); if(!found.has(k)) found.set(k, r); } return; }
          f[i] = -1; go(i + 1);
          if(w === 1){ f[i] = 0; go(i + 1); }
          for(let x = w; x <= w + 3; x++){ f[i] = x; go(i + 1); }
        })(0);
      }
      return [...found.values()].sort((a, b) => b.score - a.score).slice(0, limit || 6);
    }
    const cache = new Map();
    function forChord(name, instr){
      const k = instr + "|" + name;
      if(cache.has(k)) return cache.get(k);
      const info = parse(name); const v = info ? voicings(info, instr, 6) : [];
      cache.set(k, v); return v;
    }
    /* ---- dibujo ---- */
    function fretSvg(v, instr){
      const n = TUN[instr].length, gap = instr === "guitar" ? 20 : 26, L = 26, T = 30, RH = 22, rows = 5;
      const base = v.maxF <= 5 ? 1 : v.minF;
      const W = L + (n - 1) * gap + 18, H = T + rows * RH + 8;
      let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" fill="none" stroke="currentColor" stroke-width="1.2">`;
      for(let r = 0; r <= rows; r++) s += `<line x1="${L}" y1="${T + r * RH}" x2="${L + (n - 1) * gap}" y2="${T + r * RH}" opacity="${r === 0 && base === 1 ? 1 : .45}" stroke-width="${r === 0 && base === 1 ? 3.4 : 1.2}"/>`;
      for(let i = 0; i < n; i++) s += `<line x1="${L + i * gap}" y1="${T}" x2="${L + i * gap}" y2="${T + rows * RH}" opacity=".65"/>`;
      if(base > 1) s += `<text x="${L - 8}" y="${T + RH / 2 + 4}" text-anchor="end" fill="currentColor" stroke="none" font-size="12" font-weight="700">${base}</text>`;
      if(v.barre){ const b = v.barre, y = T + (b.f - base) * RH + RH / 2; s += `<rect x="${L + b.a * gap - 7}" y="${y - 7}" width="${(b.b - b.a) * gap + 14}" height="14" rx="7" class="cd-dot"/>`; }
      v.frets.forEach((f, i) => {
        const x = L + i * gap;
        if(f < 0) s += `<path d="M${x - 4} ${T - 16}l8 8m0 -8l-8 8" opacity=".8"/>`;
        else if(f === 0) s += `<circle cx="${x}" cy="${T - 12}" r="4.2" opacity=".85"/>`;
        else s += `<circle cx="${x}" cy="${T + (f - base) * RH + RH / 2}" r="7" class="cd-dot"/>`;
      });
      return s + "</svg>";
    }
    function pianoSvg(info){
      const WH = [0, 2, 4, 5, 7, 9, 11], kw = 17, N = 14, H = 78;
      const on = new Set(); info.iv.forEach(pc => { let a = ((pc - info.root) + 12) % 12 + info.root % 12; if(a >= 24) a -= 12; on.add(a); });
      // posición absoluta de la raíz dentro del primer octavo; las demás notas ascienden desde ella
      on.clear(); const r0 = info.root;
      info.iv.forEach(pc => { on.add(r0 + ((pc - r0 + 12) % 12)); });
      const bassAbs = info.bass;
      let s = `<svg viewBox="0 0 ${kw * N + 2} ${H + 2}" width="${kw * N + 2}" height="${H + 2}" role="img" stroke="currentColor" stroke-width="1">`;
      let wi = 0; const blacks = [];
      for(let a = 0; a < 24; a++){
        const pc = a % 12;
        if(WH.includes(pc)){
          const x = 1 + wi * kw, isRoot = a === r0, isOn = on.has(a) || (info.slash && a === bassAbs && false);
          s += `<rect x="${x}" y="1" width="${kw}" height="${H}" rx="2.5" class="cd-wk${isOn ? (isRoot ? " root" : " on") : ""}"/>`;
          wi++;
        } else blacks.push({ a, x: 1 + wi * kw - 5.5 });
      }
      blacks.forEach(b => { const isRoot = b.a === r0; s += `<rect x="${b.x}" y="1" width="11" height="${H * 0.6}" rx="2" class="cd-bk${on.has(b.a) ? (isRoot ? " root" : " on") : ""}"/>`; });
      return s + "</svg>";
    }
    return { parse, forChord, fretSvg, pianoSvg, TUN };
  })();

  const chordPop = document.createElement("div");
  chordPop.id = "chordPop"; chordPop.className = "chord-pop glass"; chordPop.hidden = true;
  chordPop.setAttribute("role", "dialog"); chordPop.setAttribute("aria-label", "Diagrama de acorde");
  document.body.appendChild(chordPop);
  const cpState = { name: "", idx: 0 };
  const cpInstr = () => { try{ const v = localStorage.getItem("sonarium.instr"); return v === "ukulele" || v === "piano" ? v : "guitar"; }catch(e){ return "guitar"; } };
  function closeChordPop(){ chordPop.hidden = true; document.querySelectorAll(".chord-tag.sel").forEach(n => n.classList.remove("sel")); }
  function paintChordPop(){
    const instr = cpInstr(), name = cpState.name, info = CD.parse(name);
    const tabs = [["guitar", "Guitarra"], ["ukulele", "Ukulele"], ["piano", "Piano"]].map(([k, l]) => `<button type="button" class="cp-tab${k === instr ? " on" : ""}" data-i="${k}">${l}</button>`).join("");
    let body = "", nav = "";
    if(!info) body = '<p class="cp-none">No tengo un diagrama para este acorde.</p>';
    else if(instr === "piano") body = '<div class="cp-fig">' + CD.pianoSvg(info) + "</div>";
    else {
      const list = CD.forChord(name, instr);
      if(!list.length) body = '<p class="cp-none">No encontré una digitación cómoda para este acorde.</p>';
      else {
        cpState.idx = ((cpState.idx % list.length) + list.length) % list.length;
        body = '<div class="cp-fig">' + CD.fretSvg(list[cpState.idx], instr) + "</div>";
        if(list.length > 1) nav = `<div class="cp-nav"><button type="button" data-n="-1" aria-label="Posición anterior">‹</button><span>Posición ${cpState.idx + 1} de ${list.length}</span><button type="button" data-n="1" aria-label="Posición siguiente">›</button></div>`;
      }
    }
    const NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const notes = info ? info.iv.map(pc => toNotation(NAMES[pc])).join(" · ") : "";
    chordPop.innerHTML = `<div class="cp-head"><b>${escapeHtml(toNotation(name))}</b><button type="button" class="cp-x" aria-label="Cerrar">✕</button></div><div class="cp-tabs">${tabs}</div>${body}${nav}${notes ? `<div class="cp-notes">Notas: ${escapeHtml(notes)}</div>` : ""}`;
  }
  function placeChordPop(anchor){
    chordPop.hidden = false;
    if(window.innerWidth <= 640){ chordPop.style.left = ""; chordPop.style.top = ""; return; }
    const r = anchor.getBoundingClientRect(), w = chordPop.offsetWidth, h = chordPop.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let y = r.bottom + 8; if(y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 8);
    chordPop.style.left = x + "px"; chordPop.style.top = y + "px";
  }
  el.songRender.addEventListener("click", e => {
    const t = e.target.closest(".chord-tag");
    if(!t || !t.dataset.ch || document.body.classList.contains("stage")) return;
    if(!chordPop.hidden && cpState.name === t.dataset.ch && t.classList.contains("sel")){ closeChordPop(); return; }
    document.querySelectorAll(".chord-tag.sel").forEach(n => n.classList.remove("sel"));
    t.classList.add("sel"); cpState.name = t.dataset.ch; cpState.idx = 0;
    paintChordPop(); placeChordPop(t);
  });
  chordPop.addEventListener("click", e => {
    const b = e.target.closest("button"); if(!b) return;
    if(b.classList.contains("cp-x")) return closeChordPop();
    if(b.dataset.i){ try{ localStorage.setItem("sonarium.instr", b.dataset.i); }catch(_){} cpState.idx = 0; const a = document.querySelector(".chord-tag.sel"); paintChordPop(); if(a) placeChordPop(a); }
    else if(b.dataset.n){ cpState.idx += +b.dataset.n; paintChordPop(); }
  });
  document.addEventListener("click", e => { if(!chordPop.hidden && !e.composedPath().includes(chordPop) && !e.target.closest(".chord-tag")) closeChordPop(); });
  document.addEventListener("keydown", e => { if(e.key === "Escape" && !chordPop.hidden) closeChordPop(); });
  window.addEventListener("scroll", () => { if(!chordPop.hidden && window.innerWidth > 640) closeChordPop(); }, { passive: true, capture: true });

  /* ---------------- modo proyección (letra sin acordes, para proyector o TV) ---------------- */
  const PROJ_RECV = /[?&]proyeccion\b/.test(location.search);
  let projBC = null; try{ if("BroadcastChannel" in window) projBC = new BroadcastChannel("sonarium-proj"); }catch(e){}
  const proj = { on:false, slides:[], i:0, black:false, scale:1, remote:false, hideT:0 };
  const projEl = document.createElement("div");
  projEl.id = "projVeil"; projEl.hidden = true; if(PROJ_RECV) projEl.classList.add("recv");
  projEl.innerHTML = '<div class="pj-stage"><div class="pj-label"></div><div class="pj-text"></div></div><div class="pj-foot"></div>'
    + '<div class="pj-ctl glass"><button data-a="prev" title="Anterior (←)" aria-label="Anterior">‹</button><button data-a="next" title="Siguiente (→ o espacio)" aria-label="Siguiente">›</button>'
    + '<button data-a="chorus" class="pj-chorus" title="Ir al coro y volver (C)" aria-label="Ir al coro" hidden>Coro</button><button data-a="black" title="Pantalla en negro (B)" aria-label="Pantalla en negro">⬛</button><button data-a="smaller" title="Letra más pequeña (−)" aria-label="Letra más pequeña">A−</button><button data-a="bigger" title="Letra más grande (+)" aria-label="Letra más grande">A+</button>'
    + '<button data-a="win" title="Abrir en otra ventana (para el proyector)" aria-label="Abrir en otra ventana">🪟</button><button data-a="close" title="Cerrar (Esc)" aria-label="Cerrar">✕</button></div>';
  document.body.appendChild(projEl);
  function projSlides(song){
    const out = [{ label:"", title:true, lines:[song.title].concat(song.artist ? [artistLabel(song.artist)] : []) }];
    let cur = [], inCh = false, label = "";
    const flush = () => { for(let k = 0; k < cur.length; k += 4) out.push({ label: k === 0 && inCh ? label : "", chorus: inCh, lines: cur.slice(k, k + 4) }); cur = []; };
    splitInlineDirectives((song.body || "").split("\n")).forEach(l => {
      const dm = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i.exec(l);
      if(dm){
        const d = dm[1].toLowerCase();
        if(d === "soc" || d === "start_of_chorus"){ flush(); inCh = true; label = (dm[2] || "Coro").trim(); }
        else if(d === "eoc" || d === "end_of_chorus"){ flush(); inCh = false; label = ""; }
        return;
      }
      const t = parseLine(l).lyric.trim();
      if(!t){ if(!inCh) flush(); return; }
      cur.push(t);
    });
    flush();
    return out;
  }
  function projFit(){
    const tx = projEl.querySelector(".pj-text"), box = projEl.querySelector(".pj-stage");
    let px = Math.min(innerWidth * .062, innerHeight * .13) * proj.scale;
    tx.style.fontSize = px + "px";
    let n = 0;
    while(n++ < 45 && px > 14 && (tx.getBoundingClientRect().height > box.clientHeight * .8 || tx.scrollWidth > box.clientWidth)){ px *= .94; tx.style.fontSize = px + "px"; }
  }
  function projPaint(s, foot){
    projEl.querySelector(".pj-label").textContent = s.label || "";
    const tx = projEl.querySelector(".pj-text");
    tx.className = "pj-text" + (s.title ? " title" : "");
    tx.innerHTML = s.lines.map((l, k) => `<div${s.title && k ? ' class="sub"' : ""}>${escapeHtml(l)}</div>`).join("");
    projEl.querySelector(".pj-foot").textContent = foot || "";
    projEl.classList.toggle("black", proj.black);
    projFit();
  }
  function projSend(extra){
    if(!projBC || !proj.remote) return;
    const s = proj.slides[proj.i]; if(!s) return;
    try{ projBC.postMessage(Object.assign({ t:"state", label:s.label, lines:s.lines, title:!!s.title, black:proj.black, scale:proj.scale }, extra || {})); }catch(e){}
  }
  function projRender(){
    const s = proj.slides[proj.i]; if(!s) return;
    projPaint(s, (proj.i + 1) + " / " + proj.slides.length);
    projChorusBtn();
    projSend();
  }
  // Coro: salta al coro (que a veces está escrito una sola vez) y vuelve a la diapositiva donde estabas
  function projChorus(){
    const cur = proj.slides[proj.i];
    if(proj.ret != null && cur && cur.chorus){ proj.i = proj.ret; proj.ret = null; proj.black = false; projRender(); return; }
    const k = proj.slides.findIndex(s => s.chorus);
    if(k < 0 || k === proj.i) return;
    proj.ret = proj.i; proj.i = k; proj.black = false; projRender();
  }
  function projChorusBtn(){
    const btn = projEl.querySelector(".pj-chorus"), has = proj.slides.some(s => s.chorus), cur = proj.slides[proj.i];
    if(proj.ret != null && !(cur && cur.chorus)) proj.ret = null;
    btn.hidden = !has || PROJ_RECV;
    const back = proj.ret != null;
    btn.textContent = back ? "↩ Volver" : "Coro"; btn.setAttribute("aria-label", back ? "Volver a donde estabas" : "Ir al coro");
  }
  function projGo(d){ const n = Math.max(0, Math.min(proj.slides.length - 1, proj.i + d)); if(n !== proj.i){ proj.i = n; proj.black = false; projRender(); } }
  function projCtl(){ projEl.classList.add("ctl"); clearTimeout(proj.hideT); proj.hideT = setTimeout(() => projEl.classList.remove("ctl"), 2600); }
  function projFull(){ try{ if(document.fullscreenElement) document.exitFullscreen(); else projEl.requestFullscreen && projEl.requestFullscreen(); }catch(e){} }
  function openProj(){
    const song = songs.find(s => s.id === activeId); if(!song) return;
    proj.slides = projSlides(song); proj.i = 0; proj.ret = null; proj.black = false; proj.on = true;
    projEl.hidden = false; projEl.classList.remove("recv"); document.body.classList.add("projecting");
    try{ projEl.requestFullscreen && projEl.requestFullscreen(); }catch(e){}
    projRender(); projCtl();
  }
  function closeProj(){
    if(!proj.on) return;
    proj.on = false; projEl.hidden = true; document.body.classList.remove("projecting");
    try{ if(document.fullscreenElement) document.exitFullscreen(); }catch(e){}
    if(projBC && proj.remote){ try{ projBC.postMessage({ t:"end" }); }catch(e){} }
  }
  function openProjWindow(){
    const w = window.open(location.pathname + "?proyeccion=1", "sonariumProj", "popup,width=1024,height=640");
    if(!w){ toast("El navegador bloqueó la ventana. Permite ventanas emergentes para este sitio."); return; }
    proj.remote = true;
    toast("Ventana abierta: arrástrala al proyector y pulsa F para pantalla completa");
    setTimeout(projSend, 900);
  }
  projEl.addEventListener("click", e => {
    const b = e.target.closest("button[data-a]");
    if(b){
      const a = b.dataset.a;
      if(a === "prev") projGo(-1); else if(a === "next") projGo(1);
      else if(a === "chorus") projChorus();
      else if(a === "black"){ proj.black = !proj.black; projRender(); }
      else if(a === "smaller" || a === "bigger"){ proj.scale = Math.max(.5, Math.min(1.6, proj.scale + (a === "bigger" ? .1 : -.1))); projRender(); }
      else if(a === "win") openProjWindow(); else if(a === "close") closeProj();
      projCtl(); return;
    }
    if(PROJ_RECV) return;
    if(e.target.closest(".pj-ctl")) return;
    projGo(e.clientX > innerWidth * .4 ? 1 : -1); projCtl();
  });
  projEl.addEventListener("mousemove", projCtl);
  projEl.addEventListener("touchstart", projCtl, { passive:true });
  window.addEventListener("resize", () => { if(!projEl.hidden) projFit(); });
  document.addEventListener("keydown", e => {
    if(projEl.hidden) return;
    const k = e.key; let used = true;
    if(k === "Escape"){ PROJ_RECV ? projFull() : closeProj(); }
    else if(PROJ_RECV){ if(k === "f" || k === "F") projFull(); else used = false; }
    else if(k === "ArrowRight" || k === " " || k === "PageDown" || k === "Enter" || k === "ArrowDown") projGo(1);
    else if(k === "ArrowLeft" || k === "PageUp" || k === "Backspace" || k === "ArrowUp") projGo(-1);
    else if(k === "Home"){ proj.i = 0; projRender(); } else if(k === "End"){ proj.i = proj.slides.length - 1; projRender(); }
    else if(k === "c" || k === "C") projChorus();
    else if(k === "b" || k === "B" || k === "."){ proj.black = !proj.black; projRender(); }
    else if(k === "f" || k === "F") projFull();
    else if(k === "+" || k === "=" || k === "-"){ proj.scale = Math.max(.5, Math.min(1.6, proj.scale + (k === "-" ? -.1 : .1))); projRender(); }
    else used = false;
    if(used){ e.preventDefault(); e.stopImmediatePropagation(); projCtl(); }
  }, true);
  if(PROJ_RECV){
    document.body.classList.add("projwin"); projEl.hidden = false; proj.on = true;
    projPaint({ label:"", title:true, lines:["Sonarium", "Esperando la letra…"] }, "");
    projEl.addEventListener("dblclick", projFull);
    if(projBC){
      projBC.onmessage = ev => {
        const d = ev.data || {};
        if(d.t === "state"){ proj.black = !!d.black; proj.scale = d.scale || 1; projPaint({ label:d.label, title:d.title, lines:d.lines }, ""); }
        else if(d.t === "end") projPaint({ label:"", title:true, lines:["Sonarium"] }, "");
      };
      projBC.postMessage({ t:"hello" });
    }
  } else if(projBC){
    projBC.onmessage = ev => { if(ev.data && ev.data.t === "hello" && proj.on){ proj.remote = true; projSend(); } };
  }
  const projBtn = document.getElementById("projBtn");
  if(projBtn) projBtn.addEventListener("click", openProj);

  /* ---------------- respaldo automático e historial de versiones (solo en este dispositivo) ---------------- */
  const BK = { db:null, last:0, lastData:"", timer:0 };
  function bkOpen(){
    if(BK.db) return Promise.resolve(BK.db);
    return new Promise(res => {
      if(!window.indexedDB) return res(null);
      let rq; try{ rq = indexedDB.open("sonarium-respaldo", 1); }catch(e){ return res(null); }
      rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore("snaps", { keyPath:"at" }); d.createObjectStore("hist", { keyPath:"id" }); };
      rq.onsuccess = () => { BK.db = rq.result; res(BK.db); };
      rq.onerror = rq.onblocked = () => res(null);
    });
  }
  function bkTx(store, mode, fn){
    return bkOpen().then(db => !db ? null : new Promise(res => {
      let out; try{
        const tx = db.transaction(store, mode), st = tx.objectStore(store);
        out = fn(st);
        tx.oncomplete = () => res(out && "result" in out ? out.result : out);
        tx.onerror = tx.onabort = () => res(null);
      }catch(e){ res(null); }
    }));
  }
  const bkAll = () => bkTx("snaps", "readonly", st => st.getAll()).then(r => (r || []).sort((a, b) => b.at - a.at));
  function bkPayload(){ return JSON.stringify({ songs, folders, spaces }); }
  function bkPrune(){
    return bkAll().then(list => {
      const keep = new Set(), day = {}, now = Date.now();
      let recent = 0, manual = 0;
      list.forEach(s => {
        const d = new Date(s.at).toDateString();
        if(s.kind !== "auto"){ if(manual++ < 12) keep.add(s.at); return; }
        if(now - s.at < DAY_MS){ if(recent++ < 12) keep.add(s.at); }
        else if(now - s.at < 14 * DAY_MS && !day[d]){ day[d] = 1; keep.add(s.at); }
      });
      return bkTx("snaps", "readwrite", st => { list.forEach(s => { if(!keep.has(s.at)) st.delete(s.at); }); });
    });
  }
  function bkSnap(kind, label){
    const data = bkPayload();
    if(kind === "auto" && data === BK.lastData) return Promise.resolve(false);
    if(!songs.length && kind === "auto") return Promise.resolve(false);
    const rec = { at: Date.now(), kind, label: label || "", ns: songs.filter(s => !s.trashedAt).length, nf: folders.length, ne: spaces.length, data };
    BK.last = rec.at; BK.lastData = data;
    return bkTx("snaps", "readwrite", st => st.put(rec)).then(() => bkPrune()).then(() => true);
  }
  function bkSoon(){
    clearTimeout(BK.timer);
    BK.timer = setTimeout(() => { if(Date.now() - BK.last >= 15 * 60000) bkSnap("auto"); }, 25000);
  }
  document.addEventListener("visibilitychange", () => { if(document.hidden && Date.now() - BK.last >= 2 * 60000) bkSnap("auto"); });
  const _persist0 = persist; persist = function(){ const r = _persist0.apply(this, arguments); bkSoon(); return r; };
  setTimeout(() => { bkAll().then(l => { BK.last = l.length ? l[0].at : 0; if(!l.length || Date.now() - BK.last > 6 * 3600e3) bkSnap("auto", "al abrir"); else BK.lastData = l[0].data; }); }, 6000);

  const fmtWhen = at => { const d = new Date(at); return d.toLocaleDateString("es", { day:"numeric", month:"short" }) + " · " + d.toLocaleTimeString("es", { hour:"2-digit", minute:"2-digit" }); };
  const bkVeil = document.getElementById("backupVeil"), bkList = document.getElementById("backupList");
  function bkRender(){
    bkAll().then(list => {
      bkList.innerHTML = list.length ? list.map(s => `<div class="bk-row"><div class="bk-info"><b>${escapeHtml(fmtWhen(s.at))}</b><small>${s.ns} canciones · ${s.nf} carpetas · ${s.ne} espacios${s.kind === "auto" ? (s.label ? " · " + escapeHtml(s.label) : "") : " · " + escapeHtml(s.label || "copia manual")}</small></div><button class="glass-btn" data-bk="dl" data-at="${s.at}" title="Descargar esta copia">⬇</button><button class="glass-btn" data-bk="rs" data-at="${s.at}">Restaurar</button></div>`).join("")
        : '<p class="bk-empty">Todavía no hay copias. Se crean solas mientras usas Sonarium.</p>';
    });
  }
  function openBackups(){ bkVeil.classList.add("open"); bkRender(); }
  document.getElementById("backupClose").addEventListener("click", () => bkVeil.classList.remove("open"));
  bkVeil.addEventListener("click", e => { if(e.target === bkVeil) bkVeil.classList.remove("open"); });
  document.getElementById("backupNow").addEventListener("click", () => { BK.lastData = ""; bkSnap("manual", "copia manual").then(() => { bkRender(); toast("Copia guardada"); }); });
  bkList.addEventListener("click", async e => {
    const b = e.target.closest("button[data-bk]"); if(!b) return;
    const at = +b.dataset.at, snap = (await bkAll()).find(s => s.at === at); if(!snap) return;
    if(b.dataset.bk === "dl"){
      const blob = new Blob([snap.data], { type:"application/json" }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "sonarium-copia-" + new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".json";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); return;
    }
    const ok = await askDialog({ title:"¿Restaurar esta copia?", text:"Tu repertorio volverá a como estaba el " + fmtWhen(at) + " (" + snap.ns + " canciones).", extra:"Antes de restaurar guardo una copia de cómo está ahora, por si cambias de opinión.", ok:"Restaurar" });
    if(!ok) return;
    await bkSnap("manual", "antes de restaurar");
    let st; try{ st = JSON.parse(snap.data); }catch(err){ toast("Esa copia está dañada"); return; }
    const now = Date.now(), ids = { s:new Set((st.songs || []).map(x => x.id)), f:new Set((st.folders || []).map(x => x.id)), e:new Set((st.spaces || []).map(x => x.id)) };
    const gone = [];
    [["s", songs], ["f", folders], ["e", spaces]].forEach(([k, arr]) => arr.forEach(o => { if(!ids[k].has(o.id)) gone.push({ k, id:o.id, at:now }); }));
    const T = [["s", st.songs || []], ["f", st.folders || []], ["e", st.spaces || []]];
    T.forEach(([, arr]) => arr.forEach(o => { o.updatedAt = now; }));
    const keepTombs = tombs.filter(t => !(ids[t.k] && ids[t.k].has(t.id)));
    applyState({ songs: st.songs || [], folders: st.folders || [], spaces: st.spaces || [], tombs: keepTombs.concat(gone), meta });
    persist();
    bkVeil.classList.remove("open");
    goHome(); toast("Copia restaurada");
  });
  document.getElementById("backupBtn").addEventListener("click", openBackups);
  document.getElementById("mobileBackup").addEventListener("click", openBackups);

  /* historial de versiones de una canción */
  function histPush(old, next){
    if(!old || !old.id) return;
    const same = ["title", "artist", "key", "body"].every(k => (old[k] || "") === (next[k] || ""));
    if(same) return;
    const ver = { at: Date.now(), title: old.title, artist: old.artist || "", key: old.key || "", body: old.body || "" };
    bkTx("hist", "readwrite", st => {
      const rq = st.get(old.id);
      rq.onsuccess = () => {
        const rec = rq.result || { id: old.id, list: [] };
        if(rec.list[0] && ver.at - rec.list[0].at < 2 * 60000) rec.list[0] = ver; else rec.list.unshift(ver);
        rec.list = rec.list.slice(0, 25);
        st.put(rec);
      };
    });
  }
  const histVeil = document.getElementById("histVeil"), histList = document.getElementById("histList");
  document.getElementById("histBtn").addEventListener("click", () => {
    if(!editingId) return;
    histVeil.classList.add("open"); histList.innerHTML = "";
    bkTx("hist", "readonly", st => st.get(editingId)).then(rec => {
      const l = (rec && rec.list) || [];
      histList.innerHTML = l.length ? l.map((v, i) => `<div class="bk-row"><div class="bk-info"><b>${escapeHtml(fmtWhen(v.at))}</b><small>${escapeHtml((v.body || "").replace(/\[[^\]]*\]/g, "").split("\n").filter(x => x.trim() && !/^\s*\{/.test(x)).slice(0, 2).join(" · ").slice(0, 110))}</small></div><button class="glass-btn" data-h="${i}">Cargar</button></div>`).join("")
        : '<p class="bk-empty">Aún no hay versiones anteriores. Se guardan cada vez que cambias y guardas esta canción.</p>';
      histList._l = l;
    });
  });
  document.getElementById("histClose").addEventListener("click", () => histVeil.classList.remove("open"));
  histVeil.addEventListener("click", e => { if(e.target === histVeil) histVeil.classList.remove("open"); });
  histList.addEventListener("click", e => {
    const b = e.target.closest("button[data-h]"); if(!b) return;
    const v = (histList._l || [])[+b.dataset.h]; if(!v) return;
    el.fieldTitle.value = v.title; el.fieldArtist.value = v.artist; el.fieldKey.value = v.key; el.fieldBody.value = v.body;
    histVeil.classList.remove("open");
    toast("Versión cargada en el editor. Pulsa Guardar para quedarte con ella.");
  });

  /* ---------------- biblioteca compartida (pública, sin cuenta) ---------------- */
  const LIB = { items:[], last:null, more:false, loading:false, q:"", tab:"ex", timer:0, seq:0 };
  const libVeil = document.getElementById("libVeil"), libRes = document.getElementById("libRes"), libMsg = document.getElementById("libMsg");
  const libReported = () => { try{ return new Set(JSON.parse(localStorage.getItem("sonarium.reportadas") || "[]")); }catch(e){ return new Set(); } };
  async function libHash(title, artist){
    const d = await crypto.subtle.digest("SHA-256", te.encode(nrm(title.trim()) + "|" + nrm((artist || "").trim())));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
  }
  const libTokens = (t, a) => [...new Set(nrm(t + " " + (a || "")).split(/[^a-z0-9]+/).filter(w => w.length >= 2))].slice(0, 16);
  function libError(e){
    const c = String((e && e.code) || ""), m = String((e && e.message) || e);
    if(!navigator.onLine) return "Sin conexión. La biblioteca necesita internet.";
    if(/permission|denied/i.test(c + m)) return "La biblioteca todavía no está activada (faltan publicar las reglas en Firebase).";
    if(/index/i.test(m)) return "Firebase pide crear un índice para esta búsqueda.";
    return "No pude conectar con la biblioteca. Intenta de nuevo en un momento.";
  }
  function libSetTab(t){
    LIB.tab = t;
    libVeil.querySelectorAll(".lt").forEach(b => b.classList.toggle("on", b.dataset.lt === t));
    document.getElementById("libEx").hidden = t !== "ex"; document.getElementById("libSh").hidden = t !== "sh";
    if(t === "ex" && !LIB.items.length) libLoad(true); else if(t === "sh") libFillMine();
  }
  async function libLoad(reset){
    if(LIB.loading && !reset) return;
    const my = ++LIB.seq; LIB.loading = true;
    if(reset){ LIB.items = []; LIB.last = null; libRes.innerHTML = ""; }
    libMsg.textContent = "Cargando…";
    try{
      await fbLoad();
      const { collection, query, orderBy, limit, startAfter, where, getDocs } = cloud.fs;
      const col = collection(cloud.db, "biblioteca"), words = searchWords(LIB.q);
      let q;
      if(words.length) q = query(col, where("tokens", "array-contains", words.slice().sort((a, b) => b.length - a.length)[0]), limit(50));
      else q = query(col, orderBy("creado", "desc"), ...(LIB.last ? [startAfter(LIB.last)] : []), limit(30));
      const snap = await getDocs(q);
      if(my !== LIB.seq) return;
      const rep = libReported(), got = [];
      snap.forEach(d => { const v = d.data(); if(!rep.has(d.id)) got.push(Object.assign({ id:d.id }, v)); });
      if(words.length) LIB.items = got.filter(x => { const h = nrm(x.titulo + " " + (x.artista || "") + " " + (x.etiquetas || []).join(" ")); return words.every(w => h.includes(w)); });
      else { LIB.items = LIB.items.concat(got); LIB.last = snap.docs.length ? snap.docs[snap.docs.length - 1] : LIB.last; LIB.more = snap.docs.length >= 30; }
      if(words.length) LIB.more = false;
      libMsg.textContent = LIB.items.length ? "" : (words.length ? "No encontré nada con «" + LIB.q.trim() + "». Prueba con una palabra completa del título o del artista." : "Todavía no hay canciones compartidas. ¡Sé la primera persona en compartir una!");
      libPaint();
    }catch(e){ console.warn(e); libMsg.textContent = libError(e); }
    finally{ if(my === LIB.seq) LIB.loading = false; }
  }
  function libPaint(){
    libRes.innerHTML = LIB.items.map(x => {
      const lines = String(x.cuerpo || "").split("\n").filter(l => !/^\s*\{/.test(l)).slice(0, 12).join("\n");
      return `<div class="lib-row" data-id="${attr(x.id)}"><div class="lib-top"><div class="lib-main"><b>${escapeHtml(x.titulo)}</b><small>${escapeHtml([x.artista, x.tono ? "Tono " + x.tono : "", x.autor && x.autor !== "anónimo" ? "por " + x.autor : ""].filter(Boolean).join(" · "))}</small></div><button class="glass-btn" data-lib="prev">Ver</button><button class="glass-btn primary" data-lib="add">Añadir</button></div><div class="lib-prev" hidden><pre>${escapeHtml(lines)}</pre><button class="lib-rep" data-lib="rep" type="button">⚑ Reportar esta canción</button></div></div>`;
    }).join("") + (LIB.more ? '<button class="glass-btn lib-more" data-lib="more" type="button">Cargar más</button>' : "");
  }
  function libFillMine(){
    const sel = document.getElementById("libPick");
    const mine = songs.filter(s => !s.trashedAt).sort((a, b) => a.title.localeCompare(b.title, "es"));
    sel.innerHTML = mine.map(s => `<option value="${attr(s.id)}">${escapeHtml(s.title)}${s.artist ? " — " + escapeHtml(artistLabel(s.artist)) : ""}</option>`).join("");
    if(activeId && mine.some(s => s.id === activeId)) sel.value = activeId;
    try{ document.getElementById("libName").value = localStorage.getItem("sonarium.nombreBib") || ""; }catch(e){}
    document.getElementById("libOk").checked = false; document.getElementById("libShMsg").textContent = "";
  }
  async function libPublish(){
    const msg = document.getElementById("libShMsg"), s = songs.find(x => x.id === document.getElementById("libPick").value);
    if(!s){ msg.textContent = "Elige una canción."; return; }
    if(!document.getElementById("libOk").checked){ msg.textContent = "Marca la casilla para confirmar que puedes compartir esta letra."; return; }
    if((s.body || "").length > 20000){ msg.textContent = "Esta canción es demasiado larga para la biblioteca."; return; }
    const name = document.getElementById("libName").value.trim().slice(0, 30);
    try{ localStorage.setItem("sonarium.nombreBib", name); }catch(e){}
    const btn = document.getElementById("libPublish"); btn.disabled = true; msg.textContent = "Publicando…";
    try{
      await fbLoad();
      const { doc, getDoc, setDoc, serverTimestamp } = cloud.fs;
      const id = await libHash(s.title, s.artist), ref = doc(cloud.db, "biblioteca", id);
      if((await getDoc(ref)).exists()){ msg.textContent = "Esa canción ya está en la biblioteca. ¡Gracias de todos modos!"; return; }
      await setDoc(ref, { titulo: s.title.slice(0, 120), artista: (s.artist || "").slice(0, 160), tono: (s.key || "").slice(0, 12), cuerpo: s.body, etiquetas: (s.tags || []).slice(0, 8).map(t => String(t).slice(0, 24)), tokens: libTokens(s.title, s.artist), autor: name || "anónimo", creado: serverTimestamp(), derechos: true });
      msg.textContent = "¡Compartida! Ya la puede encontrar cualquier persona."; LIB.items = []; LIB.last = null;
    }catch(e){ console.warn(e); msg.textContent = libError(e); }
    finally{ btn.disabled = false; }
  }
  function openLibrary(tab){ libVeil.classList.add("open"); libSetTab(tab || "ex"); }
  document.getElementById("libClose").addEventListener("click", () => libVeil.classList.remove("open"));
  libVeil.addEventListener("click", e => { if(e.target === libVeil) libVeil.classList.remove("open"); });
  libVeil.querySelectorAll(".lt").forEach(b => b.addEventListener("click", () => libSetTab(b.dataset.lt)));
  document.getElementById("libSearch").addEventListener("input", e => { LIB.q = e.target.value; clearTimeout(LIB.timer); LIB.timer = setTimeout(() => libLoad(true), 450); });
  document.getElementById("libPublish").addEventListener("click", libPublish);
  libRes.addEventListener("click", async e => {
    const b = e.target.closest("[data-lib]"); if(!b) return;
    const row = b.closest(".lib-row"), a = b.dataset.lib;
    if(a === "more") return libLoad(false);
    const it = row && LIB.items.find(x => x.id === row.dataset.id);
    if(a === "prev"){ const p = row.querySelector(".lib-prev"); p.hidden = !p.hidden; b.textContent = p.hidden ? "Ver" : "Ocultar"; return; }
    if(!it) return;
    if(a === "add"){
      if(titleExists(it.titulo)){ const ok = await askDialog({ title:"Ya tienes una canción con ese título", text:"¿La añado de todos modos?", ok:"Añadir" }); if(!ok) return; }
      const song = { id: uid("s-"), folderId: null, title: it.titulo, artist: it.artista || "", key: it.tono || "", body: it.cuerpo, color: PALETTE[Math.floor(Math.random() * PALETTE.length)].hex };
      if((it.etiquetas || []).length) song.tags = it.etiquetas.slice(0, 8);
      songs.unshift(song); persist(); if(activeId === null) renderHome(false);
      b.textContent = "Añadida ✓"; b.disabled = true; toast("Añadida a tu cancionero");
    } else if(a === "rep"){
      const r = await askDialog({ title:"Reportar esta canción", text:"Cuéntame brevemente qué pasa (letra con derechos de autor, contenido ofensivo, spam…). Lo reviso y la retiro si corresponde.", input:{ placeholder:"Motivo" }, ok:"Enviar reporte" });
      if(r === false || r === null || r === undefined) return;
      try{
        await fbLoad(); const { collection, addDoc, serverTimestamp } = cloud.fs;
        await addDoc(collection(cloud.db, "reportes"), { cancion: it.id, motivo: String(r === true ? "" : r).slice(0, 300), creado: serverTimestamp() });
        const set = libReported(); set.add(it.id); try{ localStorage.setItem("sonarium.reportadas", JSON.stringify([...set])); }catch(_){}
        LIB.items = LIB.items.filter(x => x.id !== it.id); libPaint(); toast("Gracias, la revisaré");
      }catch(err){ toast(libError(err)); }
    }
  });
  document.getElementById("libBtn").addEventListener("click", () => openLibrary("ex"));
  document.getElementById("mobileLib").addEventListener("click", () => openLibrary("ex"));

  /* ---------------- accesibilidad: texto grande, alto contraste, animaciones, nombres para lectores de pantalla ---------------- */
  (function initA11y(){
    const labels = { importFile:"Archivo de copia para importar", speedRange:"Velocidad del desplazamiento automático", libPick:"Canción que quieres compartir", dlgInput:"Escribe aquí",
      durD:"Días", durH:"Horas", durM:"Minutos", spaceUntil:"Fecha y hora de fin del espacio", pdfFile:"Archivo PDF", pdfFrom:"Primera página", pdfTo:"Última página" };
    Object.keys(labels).forEach(id => { const n = document.getElementById(id); if(n && !n.getAttribute("aria-label")) n.setAttribute("aria-label", labels[id]); });
    const root = document.documentElement;
    const get = (k, d) => { try{ return localStorage.getItem(k) || d; }catch(e){ return d; } };
    const set = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){} };
    const veil = document.getElementById("a11yVeil");
    function applyAll(){
      root.setAttribute("data-text", get("sonarium.texto", "0"));
      root.setAttribute("data-contrast", get("sonarium.contraste", "normal"));
      const mo = get("sonarium.movimiento", "auto");
      root.setAttribute("data-motion", mo === "reduced" || (mo === "auto" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) ? "reduced" : "full");
    }
    function paint(){
      const cur = { texto:get("sonarium.texto", "0"), contraste:get("sonarium.contraste", "normal"), movimiento:get("sonarium.movimiento", "auto") };
      veil.querySelectorAll("[data-a11y]").forEach(b => { const on = cur[b.dataset.a11y] === b.dataset.v; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
    }
    veil.addEventListener("click", e => {
      if(e.target === veil) return veil.classList.remove("open");
      const b = e.target.closest("[data-a11y]"); if(!b) return;
      set("sonarium." + b.dataset.a11y, b.dataset.v); applyAll(); paint();
    });
    const open = () => { veil.classList.add("open"); paint(); };
    document.getElementById("a11yClose").addEventListener("click", () => veil.classList.remove("open"));
    document.getElementById("a11yBtn").addEventListener("click", open);
    const mb = document.getElementById("mobileA11y"); if(mb) mb.addEventListener("click", open);
    document.addEventListener("keydown", e => { if(e.key === "Escape" && veil.classList.contains("open")) veil.classList.remove("open"); });
    applyAll();
  })();

  /* ---------------- bienvenida para quien aún no tiene canciones ---------------- */
  function startCardHtml(){
    return '<div class="start-card"><h2>Empecemos 🎶</h2><p>Sonarium es tu cancionero con acordes. No necesitas cuenta para usarlo: todo queda guardado en tu dispositivo.</p>'
      + '<div class="start-acts"><button class="glass-btn primary" data-start="new" type="button">+ Crear mi primera canción</button>'
      + '<button class="glass-btn" data-start="lib" type="button">🌐 Explorar la biblioteca</button>'
      + '<button class="glass-btn" data-start="import" type="button">⬆ Importar un repertorio</button></div>'
      + '<a class="start-link" href="terminos.html" target="_blank" rel="noopener">Términos y privacidad</a></div>';
  }
  el.songGrid.addEventListener("click", e => {
    const b = e.target.closest("[data-start]"); if(!b) return;
    const a = b.dataset.start;
    if(a === "new") document.getElementById("newSongBtn").click();
    else if(a === "lib") openLibrary("ex");
    else if(a === "import") document.getElementById("importBtn").click();
  });

  /* ---------------- importar desde PDF (se procesa en el navegador) ---------------- */
  const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdfEl = {
    veil: document.getElementById("pdfVeil"), file: document.getElementById("pdfFile"),
    from: document.getElementById("pdfFrom"), to: document.getElementById("pdfTo"),
    status: document.getElementById("pdfStatus"), list: document.getElementById("pdfList"),
    save: document.getElementById("pdfSave"), read: document.getElementById("pdfRead")
  };
  let pdfCandidates = [];

  function loadPdfJs(){
    if(window.pdfjsLib) return Promise.resolve();
    return new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = PDFJS_URL;
      sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(); };
      sc.onerror = () => rej(new Error("No se pudo cargar el lector de PDF (revisa tu conexión)."));
      document.head.appendChild(sc);
    });
  }

  // Convierte una página en texto con [acordes], usando las posiciones X de cada fragmento.
  function pageToChordText(items){
    const rows = [];
    items.forEach(it => {
      if(!it.str || !it.str.trim()) return;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find(r => Math.abs(r.y - y) < 3);
      if(!row){ row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, w: it.width, str: it.str });
    });
    rows.sort((a,b) => b.y - a.y);
    rows.forEach(r => r.items.sort((a,b) => a.x - b.x));

    // tokens de cada fila (con su X estimada)
    rows.forEach(r => {
      r.tokens = [];
      r.items.forEach(it => {
        const re = /\S+/g; let m;
        while((m = re.exec(it.str))){
          const cw = it.w / Math.max(1, it.str.length);
          r.tokens.push({ x: it.x + m.index * cw, str: m[0] });
        }
      });
      r.isChord = r.tokens.length > 0 && r.tokens.every(t => parseChordToken(t.str) !== null);
    });

    // texto de una fila de letra + mapa X -> índice de carácter
    function lyricInfo(r){
      let text = "", map = [];
      r.items.forEach((it, k) => {
        if(k > 0 && text.length && !/\s$/.test(text) && !/^\s/.test(it.str)){
          const prev = r.items[k-1];
          if(it.x - (prev.x + prev.w) > 1.5) text += " ";
        }
        map.push({ x0: it.x, w: it.w, start: text.length, len: it.str.length });
        text += it.str;
      });
      return { text, map };
    }
    function xToIndex(info, x){
      const m = info.map;
      if(!m.length) return 0;
      if(x <= m[0].x0) return 0;
      for(const seg of m){
        if(x < seg.x0 + seg.w) return seg.start + Math.round((x - seg.x0) / (seg.w || 1) * seg.len);
      }
      const last = m[m.length-1];
      return last.start + last.len;
    }

    const out = [];
    for(let i = 0; i < rows.length; i++){
      const r = rows[i];
      if(r.isChord){
        const nxt = rows[i+1];
        if(nxt && !nxt.isChord){
          const info = lyricInfo(nxt);
          let lyric = info.text;
          const ins = r.tokens.map(t => ({ idx: xToIndex(info, t.x), chord: parseChordToken(t.str) }));
          for(let k = ins.length - 1; k >= 0; k--){
            const p = Math.min(ins[k].idx, lyric.length);
            lyric = lyric.slice(0, p) + "[" + ins[k].chord + "]" + lyric.slice(p);
          }
          out.push(lyric);
          i++;
        } else {
          out.push(r.tokens.map(t => "[" + parseChordToken(t.str) + "]").join(" "));
        }
      } else {
        out.push(lyricInfo(r).text);
      }
    }
    return out.join("\n");
  }

  function guessTitle(text){
    const lines = text.split("\n").map(l => l.replace(/\[[^\]]*\]/g, "").trim()).filter(Boolean);
    const cand = lines.find(l => l.length <= 70 && !/^\d+$/.test(l));
    return cand ? cand.replace(/^\d+[.\-)\s]+/, "").trim() : "";
  }
  function guessKey(text){
    const m = text.match(/\[([A-G][#b]?m?)\]/);
    return m ? m[1] : "";
  }
  function titleExists(t){
    const q = nrm(t.trim());
    return q && songs.some(s => !s.trashedAt && nrm(s.title.trim()) === q);
  }

  async function readPdfRange(){
    const f = pdfEl.file.files[0];
    if(!f){ pdfEl.status.textContent = "Primero elige un archivo PDF."; return; }
    pdfEl.read.disabled = true;
    pdfEl.list.innerHTML = ""; pdfCandidates = []; pdfEl.save.disabled = true;
    try{
      pdfEl.status.textContent = "Cargando lector de PDF…";
      await loadPdfJs();
      const buf = await f.arrayBuffer();
      const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const total = doc.numPages;
      let a = Math.max(1, parseInt(pdfEl.from.value, 10) || 1);
      let b = Math.min(total, parseInt(pdfEl.to.value, 10) || a);
      if(b - a > 60){ b = a + 60; }
      for(let p = a; p <= b; p++){
        pdfEl.status.textContent = "Leyendo página " + p + " de " + b + " (el PDF tiene " + total + ")…";
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        const text = pageToChordText(tc.items).trim();
        if(text.length < 20) continue;
        const title = guessTitle(text);
        pdfCandidates.push({ page: p, title, key: guessKey(text), body: text, checked: !titleExists(title) });
      }
      pdfEl.status.textContent = pdfCandidates.length
        ? "Encontré " + pdfCandidates.length + " página(s) con texto (páginas " + a + "–" + b + " de " + total + "). Revisa los títulos y marca las que quieras guardar. Si una canción ocupa dos páginas, pega el texto de la segunda en la primera. Máximo 60 páginas por lectura."
        : "No encontré texto en esas páginas. Si el PDF es de imágenes escaneadas, este lector no puede leerlo.";
      renderPdfList();
    }catch(e){
      pdfEl.status.textContent = "Error: " + (e && e.message ? e.message : e);
    }
    pdfEl.read.disabled = false;
  }

  function renderPdfList(){
    pdfEl.list.innerHTML = pdfCandidates.map((c, i) => `
      <div class="trash-item" style="flex-direction:column;align-items:stretch;gap:8px;">
        <div style="display:flex;gap:10px;align-items:center;">
          <input type="checkbox" data-pdfchk="${i}" ${c.checked ? "checked" : ""}>
          <span style="font-size:12px;color:var(--ink-faint);white-space:nowrap;">pág. ${c.page}</span>
          <input type="text" data-pdftitle="${i}" value="${escapeHtml(c.title).replace(/"/g,"&quot;")}" placeholder="Título"
            style="flex:1;background:rgba(255,255,255,.05);border:1px solid var(--glass-border);border-radius:10px;padding:8px 10px;color:var(--ink);font-size:14px;">
          <input type="text" data-pdfkey="${i}" value="${escapeHtml(c.key)}" placeholder="Tono"
            style="width:64px;background:rgba(255,255,255,.05);border:1px solid var(--glass-border);border-radius:10px;padding:8px 10px;color:var(--ink);font-size:14px;">
        </div>
        ${titleExists(c.title) ? '<div style="font-size:12px;color:var(--amber);">Ya tienes una canción con este título; si la guardas quedará repetida.</div>' : ""}
        <textarea data-pdfbody="${i}" rows="6" style="width:100%;font-family:'IBM Plex Mono',monospace;font-size:12.5px;line-height:1.5;background:rgba(255,255,255,.05);border:1px solid var(--glass-border);border-radius:10px;padding:10px;color:var(--ink);resize:vertical;">${escapeHtml(c.body)}</textarea>
      </div>`).join("");
    pdfEl.save.disabled = !pdfCandidates.length;
  }
  pdfEl.list.addEventListener("input", (e) => {
    const t = e.target;
    const g = a => t.getAttribute(a);
    if(g("data-pdftitle") !== null) pdfCandidates[+g("data-pdftitle")].title = t.value;
    if(g("data-pdfkey") !== null) pdfCandidates[+g("data-pdfkey")].key = t.value;
    if(g("data-pdfbody") !== null) pdfCandidates[+g("data-pdfbody")].body = t.value;
  });
  pdfEl.list.addEventListener("change", (e) => {
    const i = e.target.getAttribute("data-pdfchk");
    if(i !== null) pdfCandidates[+i].checked = e.target.checked;
  });

  function savePdfSelection(){
    const chosen = pdfCandidates.filter(c => c.checked && c.title.trim() && c.body.trim());
    if(!chosen.length){ pdfEl.status.textContent = "Marca al menos una canción con título."; return; }
    const base = songs.filter(s => !s.trashedAt).length;
    chosen.forEach((c, k) => {
      songs.unshift({
        id: "pdf-" + Date.now() + "-" + k,
        folderId: (loc.type === "folder" ? loc.id : null),
        title: c.title.trim(), artist: "", key: c.key.trim(), body: c.body,
        color: PALETTE[(base + k) % PALETTE.length].hex
      });
    });
    persist();
    pdfEl.veil.classList.remove("open");
    pdfCandidates = []; pdfEl.list.innerHTML = ""; pdfEl.status.textContent = "";
    goHome();
  }
  function openPdfModal(){ pdfEl.veil.classList.add("open"); }
  function closePdfModal(){ pdfEl.veil.classList.remove("open"); }
  document.getElementById("pdfBtn").addEventListener("click", openPdfModal);
  document.getElementById("mobilePdf").addEventListener("click", openPdfModal);
  document.getElementById("closePdf").addEventListener("click", closePdfModal);
  document.getElementById("cancelPdf").addEventListener("click", closePdfModal);
  pdfEl.read.addEventListener("click", readPdfRange);
  pdfEl.save.addEventListener("click", savePdfSelection);

  /* ---------------- eventos ---------------- */
  /* ---------------- eventos del explorador ---------------- */
  function cardKind(card){ return card.dataset.folder ? "folder" : "song"; }
  function handleCardAction(act, card){
    if(cardKind(card) === "folder"){
      const id = card.dataset.folder;
      if(act === "rename") renameFolder(id);
      else if(act === "move") moveFolder(id);
      else if(act === "del") deleteFolder(id);
      return;
    }
    const id = card.dataset.id;
    if(act === "del") askDelete(id);
    else if(act === "move") moveSong(id);
    else if(act === "fav") toggleFav(id);
    else if(act === "space") openSongSpaces(id);
    else if(act === "up") moveInSpace(id, -1);
    else if(act === "down") moveInSpace(id, 1);
    else if(act === "unspace"){
      const sp = spaces.find(s => s.id === loc.id);
      if(sp){ sp.songIds = (sp.songIds || []).filter(x => x !== id); persist(); renderHome(false); }
    }
  }
  el.songGrid.addEventListener("click", (e) => {
    if(e.target.closest(".drag-handle")) return;
    if(e.target.closest("#addCard")){ openModal(null); return; }
    const act = e.target.closest("[data-act]");
    if(act){ e.stopPropagation(); handleCardAction(act.dataset.act, act.closest(".card")); return; }
    const ext = e.target.closest("[data-ext]");
    if(ext){ extendSpace(loc.id, parseInt(ext.dataset.ext, 10)); return; }
    const sact = e.target.closest("[data-sact]");
    if(sact){
      const a = sact.dataset.sact;
      if(a === "share") openShare(loc.id);
      else if(a === "add") openSpaceSongs(loc.id);
      else if(a === "edit") openSpaceModal(null, loc.id);
      else if(a === "del") deleteSpace(loc.id);
      return;
    }
    const fc = e.target.closest(".folder-card");
    if(fc){ openFolder(fc.dataset.folder); return; }
    const card = e.target.closest(".card[data-id]");
    if(card) openSong(card.dataset.id, loc.type === "space" ? { spaceId: loc.id } : null);
  });
  el.crumbs.addEventListener("click", (e) => {
    const c = e.target.closest("[data-crumb]");
    if(c){ filt.fav = false; filt.tag = null; openFolder(c.dataset.crumb || null); }
  });
  el.spacesStrip.addEventListener("click", (e) => {
    const c = e.target.closest("[data-space]");
    if(c) openSpace(c.dataset.space);
  });

  /* arrastrar y soltar (mouse): canciones y carpetas hacia carpetas, migas de pan o espacios */
  let drag = null, dropEl = null;
  function clearDrop(){ if(dropEl){ dropEl.classList.remove("drop-ok"); dropEl = null; } }
  function dropTargetOf(e){
    const t = e.target.closest && e.target.closest(".folder-card, .crumb[data-crumb], .space-chip");
    if(!t || !drag) return null;
    if(t.classList.contains("space-chip")) return drag.t === "s" ? t : null;
    const dest = t.dataset.folder !== undefined ? t.dataset.folder : (t.dataset.crumb || null);
    if(drag.t === "f" && dest && (dest === drag.id || isDescendant(dest, drag.id))) return null;
    return t;
  }
  document.addEventListener("dragstart", (e) => {
    const c = e.target.closest && e.target.closest(".card[draggable]");
    if(!c) return;
    drag = c.dataset.folder ? { t:"f", id:c.dataset.folder } : { t:"s", id:c.dataset.id };
    e.dataTransfer.effectAllowed = "move";
    try{ e.dataTransfer.setData("text/plain", drag.t + ":" + drag.id); }catch(_){}
    c.classList.add("dragging");
    document.body.classList.add("dnd");
  });
  document.addEventListener("dragend", () => {
    drag = null; clearDrop();
    document.body.classList.remove("dnd");
    document.querySelectorAll(".dragging").forEach(n => n.classList.remove("dragging"));
  });
  document.addEventListener("dragover", (e) => {
    if(!drag) return;
    const t = dropTargetOf(e);
    if(!t){ clearDrop(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if(dropEl !== t){ clearDrop(); dropEl = t; t.classList.add("drop-ok"); }
  });
  document.addEventListener("drop", (e) => {
    if(!drag) return;
    const t = dropTargetOf(e);
    if(!t) return;
    e.preventDefault();
    const d = drag; clearDrop();
    if(t.classList.contains("space-chip")){
      const sp = spaces.find(s => s.id === t.dataset.space);
      if(addToSpace(t.dataset.space, d.id)){ renderHome(false); toast("Agregada a «" + (sp ? sp.name : "espacio") + "»"); }
      else toast("Ya estaba en ese espacio");
      return;
    }
    const dest = t.dataset.folder !== undefined ? t.dataset.folder : (t.dataset.crumb || null);
    if(d.t === "s") setSongFolder(d.id, dest); else setFolderParent(d.id, dest);
  });

  document.getElementById("newFolderBtn").addEventListener("click", newFolder);
  document.getElementById("newSpaceBtn").addEventListener("click", () => openSpaceModal([]));
  document.getElementById("accountBtn").addEventListener("click", openAccount);
  document.getElementById("moveBtn").addEventListener("click", () => { if(activeId) moveSong(activeId); });
  document.getElementById("spaceBtn").addEventListener("click", () => { if(activeId) openSongSpaces(activeId); });

  /* diálogo genérico */
  document.getElementById("dlgOk").addEventListener("click", dlgAccept);
  document.getElementById("dlgCancel").addEventListener("click", () => closeDialog(null));
  document.getElementById("dlgExtra").addEventListener("click", () => closeDialog({ extra:true }));
  document.getElementById("dlgClose").addEventListener("click", () => closeDialog(null));
  document.getElementById("dlgInput").addEventListener("keydown", (e) => { if(e.key === "Enter") dlgAccept(); });
  document.getElementById("dlgVeil").addEventListener("click", (e) => { if(e.target.id === "dlgVeil") closeDialog(null); });
  /* selector de carpeta */
  document.getElementById("pickList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if(b && !b.disabled) closePick(b.dataset.pick || null);
  });
  document.getElementById("pickCancel").addEventListener("click", () => closePick(undefined));
  document.getElementById("pickClose").addEventListener("click", () => closePick(undefined));
  document.getElementById("pickVeil").addEventListener("click", (e) => { if(e.target.id === "pickVeil") closePick(undefined); });
  /* espacios */
  document.getElementById("spaceCreate").addEventListener("click", createSpace);
  document.getElementById("spaceName").addEventListener("keydown", (e) => { if(e.key === "Enter") createSpace(); });
  document.getElementById("spaceCancel").addEventListener("click", closeSpaceModal);
  document.getElementById("spaceClose").addEventListener("click", closeSpaceModal);
  document.getElementById("spaceVeil").addEventListener("click", (e) => { if(e.target.id === "spaceVeil") closeSpaceModal(); });
  document.getElementById("spSongsSearch").addEventListener("input", renderSpaceSongs);
  document.getElementById("spSongsList").addEventListener("change", (e) => {
    const id = e.target.getAttribute("data-sp");
    if(id){ if(e.target.checked) spPick.selected.add(id); else spPick.selected.delete(id); }
  });
  document.getElementById("spSongsSave").addEventListener("click", saveSpaceSongs);
  document.getElementById("spSongsCancel").addEventListener("click", () => document.getElementById("spaceSongsVeil").classList.remove("open"));
  document.getElementById("spSongsClose").addEventListener("click", () => document.getElementById("spaceSongsVeil").classList.remove("open"));
  document.getElementById("songSpacesList").addEventListener("change", (e) => {
    const id = e.target.getAttribute("data-ss");
    if(!id) return;
    const sp = spaces.find(s => s.id === id); if(!sp) return;
    sp.songIds = sp.songIds || [];
    if(e.target.checked){ if(!sp.songIds.includes(spSong.id)) sp.songIds.push(spSong.id); toast("Agregada a «" + sp.name + "»"); }
    else { sp.songIds = sp.songIds.filter(x => x !== spSong.id); }
    persist();
    if(activeId === null) renderHome(false);
  });
  document.getElementById("songSpacesNew").addEventListener("click", () => openSpaceModal([spSong.id]));
  document.getElementById("songSpacesDone").addEventListener("click", () => document.getElementById("songSpacesVeil").classList.remove("open"));
  document.getElementById("songSpacesClose").addEventListener("click", () => document.getElementById("songSpacesVeil").classList.remove("open"));
  /* cuenta */
  document.getElementById("accClose").addEventListener("click", closeAccount);
  document.getElementById("accDone").addEventListener("click", closeAccount);
  document.getElementById("accountVeil").addEventListener("click", (e) => { if(e.target.id === "accountVeil") closeAccount(); });
  document.getElementById("accBody").addEventListener("click", (e) => {
    const m = e.target.closest("[data-accmode]");
    if(m){ acc.mode = m.dataset.accmode; renderAccount(); return; }
    if(e.target.closest("#accSubmit")){ onAccSubmit(); return; }
    const a = e.target.closest("[data-acc]");
    if(a){ onAccAction(a.dataset.acc); return; }
    if(e.target.closest("#accCopy")){
      try{ navigator.clipboard.writeText(RULES_TEXT); toast("Reglas copiadas"); }catch(_){ toast("Selecciona el texto y cópialo"); }
    }
  });
  document.getElementById("accBody").addEventListener("keydown", (e) => {
    if(e.key === "Enter" && (e.target.id === "accUser" || e.target.id === "accPass")) onAccSubmit();
  });

  document.getElementById("viewBtn").addEventListener("click", () => {
    try{ localStorage.setItem("sonarium.vista", isListView() ? "grid" : "list"); }catch(e){}
    renderHome(true);
  });
  document.getElementById("chordsBtn").addEventListener("click", () => setChordsPref(!showChords()));
  document.getElementById("accBody").addEventListener("click", (e) => {
    const av = e.target.closest("[data-av]");
    if(av){
      if(cloud.user){ setPref({ avatar: av.dataset.av }); renderAccount(); toast("Avatar actualizado"); }
      else {
        acc.avatar = av.dataset.av;
        document.querySelectorAll(".av-opt").forEach(b => b.classList.toggle("on", b === av));
        const er = document.getElementById("accErr"); if(er) er.textContent = "";
      }
      return;
    }
    const o = e.target.closest("[data-chords]");
    if(!o) return;
    acc.chords = o.dataset.chords === "1";
    document.querySelectorAll(".choice-opt").forEach(b => b.classList.toggle("on", b === o));
    const er = document.getElementById("accErr"); if(er) er.textContent = "";
  });
  document.getElementById("accBody").addEventListener("change", (e) => {
    if(e.target.id === "accLite"){
      try{ localStorage.setItem("sonarium.ligero", e.target.checked ? "on" : "off"); }catch(_){}
      document.body.classList.toggle("lite", e.target.checked);
      toast(e.target.checked ? "Modo ligero activado" : "Modo ligero desactivado");
      return;
    }
    if(e.target.id === "accShowChords") setChordsPref(e.target.checked);
  });

  /* relojes: vencimiento de espacios y sincronización periódica */
  setInterval(() => {
    if(purgeExpiredSpaces() && activeId === null) renderHome(false);
    else if(activeId === null){
      renderSpacesStrip();
      const st = el.songGrid.querySelector(".sh-sub strong");
      const sp = loc.type === "space" ? spaces.find(s => s.id === loc.id) : null;
      if(st && sp) st.textContent = fmtLeft(sp.expiresAt - Date.now());
    }
    if(cloud.user) updateAccountChip();
  }, 30000);
  setInterval(() => { if(cloud.user && !document.hidden) cloudSync(); }, 90000);
  document.addEventListener("visibilitychange", () => { if(!document.hidden && cloud.user) cloudSync(); });
  window.addEventListener("online", () => { if(cloud.user) cloudSync(); });

  el.searchInput.addEventListener("input", () => renderHome(false));

  document.getElementById("newSongBtn").addEventListener("click", () => openModal(null));
  document.getElementById("backBtn").addEventListener("click", goHome);
  document.getElementById("editBtn").addEventListener("click", () => {
    const song = songs.find(s => s.id === activeId);
    if(song) openModal(song);
  });
  document.getElementById("deleteBtn").addEventListener("click", () => askDelete(activeId));

  document.getElementById("closeModal").addEventListener("click", closeModal);
  document.getElementById("cancelModal").addEventListener("click", closeModal);
  document.getElementById("saveModal").addEventListener("click", saveModal);
  el.fieldTitle.addEventListener("input", () => { dupAck = false; updateDupHint(); });
  document.getElementById("chorusBtn").addEventListener("click", () => {
    const t = el.fieldBody, v = t.value;
    let a = t.selectionStart, b = t.selectionEnd;
    a = v.lastIndexOf("\n", a - 1) + 1;                       /* ampliar a líneas completas */
    let e = v.indexOf("\n", b); if(e < 0) e = v.length;
    const block = v.slice(a, e);
    if(!block.trim()){
      const ins = "{soc}\n\n{eoc}";
      t.value = v.slice(0, a) + ins + v.slice(e);
      t.focus(); t.selectionStart = t.selectionEnd = a + 6;
      return;
    }
    if(/^\s*\{\s*(soc|start_of_chorus)/i.test(block)){ toast("Esas líneas ya son un coro"); return; }
    t.value = v.slice(0, a) + "{soc}\n" + block + "\n{eoc}" + v.slice(e);
    t.focus(); t.selectionStart = a; t.selectionEnd = a + block.length + 12;
    toast("Coro marcado");
  });
  el.modalVeil.addEventListener("click", (e) => { if(e.target === el.modalVeil) closeModal(); });

  document.getElementById("closeConfirm").addEventListener("click", closeConfirm);
  document.getElementById("cancelConfirm").addEventListener("click", closeConfirm);
  document.getElementById("acceptConfirm").addEventListener("click", confirmDelete);
  el.confirmVeil.addEventListener("click", (e) => { if(e.target === el.confirmVeil) closeConfirm(); });

  document.getElementById("trashToggle").addEventListener("click", openTrash);
  document.getElementById("closeTrash").addEventListener("click", closeTrash);
  document.getElementById("closeTrash2").addEventListener("click", closeTrash);
  el.trashVeil.addEventListener("click", (e) => { if(e.target === el.trashVeil) closeTrash(); });
  el.trashList.addEventListener("click", (e) => {
    const restoreBtn = e.target.closest("[data-restore]");
    if(restoreBtn){
      const s = songs.find(x => x.id === restoreBtn.getAttribute("data-restore"));
      if(s) delete s.trashedAt;
      persist();
      renderTrash();
      renderHome();
      return;
    }
    const purgeBtn = e.target.closest("[data-purge]");
    if(purgeBtn){
      if(confirm("Esto borrará la canción para siempre. ¿Continuar?")){
        songs = songs.filter(x => x.id !== purgeBtn.getAttribute("data-purge"));
        persist();
        renderTrash();
        renderHome();
      }
    }
  });

  document.getElementById("notaBtn").addEventListener("click", () => {
    try{ localStorage.setItem("sonarium.notacion", useLatin() ? "abc" : "latin"); }catch(e){}
    applyNotaBtn(); refreshSongView();
    toast(useLatin() ? "Acordes en Do Re Mi" : "Acordes en A B C");
  });
  document.getElementById("sortSel").addEventListener("change", (e) => {
    try{ localStorage.setItem(SORT_KEY, e.target.value); }catch(e2){}
    renderHome(true);
  });
  applyNotaBtn();
  document.getElementById("transposeUp").addEventListener("click", () => updateTranspose(1));
  document.getElementById("transposeDown").addEventListener("click", () => updateTranspose(-1));

  /* ---------------- tamaño de letra ---------------- */
  const FONT_SIZE_KEY = "cancionero.fontSize";
  /* columnas: solo las que caben sin pisar el texto */
  function fitColumns(){
    const r = el.songRender; if(!r) return;
    r.style.setProperty("--cols", "1");
    if(!(window.matchMedia && window.matchMedia("(orientation:landscape) and (max-height:620px)").matches)) return;
    const gap = 30, W = r.clientWidth;
    let maxW = 0;
    if(document.body.classList.contains("no-chords")) maxW = lyricSize * 20;
    else {
      r.querySelectorAll(".lyric-text").forEach(n => { maxW = Math.max(maxW, n.getBoundingClientRect().width); });
      r.querySelectorAll(".chord-tag").forEach(n => { maxW = Math.max(maxW, n.offsetLeft + n.offsetWidth); });
    }
    const cols = Math.max(1, Math.min(3, Math.floor((W + gap) / (maxW + gap + 10))));
    r.style.setProperty("--cols", String(cols));
  }
  let fitT = null;
  const fitSoon = () => { clearTimeout(fitT); fitT = setTimeout(fitColumns, 30); };
  new MutationObserver(fitSoon).observe(el.songRender, { childList:true });
  window.addEventListener("resize", fitSoon);
  window.addEventListener("orientationchange", fitSoon);
  let lyricSize = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10) || 16;
  function applyFontSize(){
    document.documentElement.style.setProperty("--lyric-size", lyricSize + "px");
    if(typeof fitSoon === "function") fitSoon();
    document.getElementById("fontSizeLabel").textContent = lyricSize;
  }
  document.getElementById("fontUp").addEventListener("click", () => {
    lyricSize = Math.min(30, lyricSize + 2);
    localStorage.setItem(FONT_SIZE_KEY, lyricSize);
    applyFontSize();
  });
  document.getElementById("fontDown").addEventListener("click", () => {
    lyricSize = Math.max(10, lyricSize - 2);
    localStorage.setItem(FONT_SIZE_KEY, lyricSize);
    applyFontSize();
  });
  applyFontSize();

  el.playBtn.addEventListener("click", () => {
    if(autoScroll.playing) stopAutoScroll(); else startAutoScroll();
  });
  let speedBubbleT = null;
  el.speedRange.addEventListener("input", (e) => {
    autoScroll.speed = Number(e.target.value);
    document.getElementById("speedVal").textContent = autoScroll.speed;
    const bub = document.getElementById("speedBubble");
    bub.textContent = autoScroll.speed;
    const r = el.speedRange, dock = document.getElementById("scrollDock");
    const rr = r.getBoundingClientRect(), dr = dock.getBoundingClientRect();
    const t = (autoScroll.speed - 1) / 9;
    bub.style.left = (rr.left - dr.left + 8 + t * (rr.width - 16)) + "px";
    bub.classList.add("show");
    clearTimeout(speedBubbleT);
    speedBubbleT = setTimeout(() => bub.classList.remove("show"), 900);
  });
  /* ---------------- modo lectura: tocar la letra oculta/muestra la cabecera ---------------- */
  function setReading(on){
    el.songScreen.classList.toggle("reading", !!on);
  }
  el.lyricsArea.addEventListener("click", () => {
    const sel = window.getSelection && String(window.getSelection());
    if(sel) return;
    setReading(!el.songScreen.classList.contains("reading"));
  });
  document.getElementById("readHandle").addEventListener("click", () => setReading(false));

  document.getElementById("exportBtn").addEventListener("click", exportSongs);
  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("importFile").addEventListener("change", (e) => {
    if(e.target.files[0]) importSongs(e.target.files[0]);
    e.target.value = "";
  });

  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape"){
      closeModal(); closeConfirm(); closeTrash(); closePdfModal(); closeAccount(); closeSpaceModal();
      closeDialog(null); closePick(undefined); closeMore();
      if(tour.on) endTour();
      document.getElementById("spaceSongsVeil").classList.remove("open");
      document.getElementById("songSpacesVeil").classList.remove("open");
    }
  });

  /* ---------------- dock móvil ---------------- */
  document.getElementById("mobileTrash").addEventListener("click", openTrash);
  document.getElementById("mobileExport").addEventListener("click", exportSongs);
  document.getElementById("mobileImport").addEventListener("click", () => document.getElementById("importFile").click());
  document.getElementById("mobileNewSong").addEventListener("click", () => openModal(null));
  const mobileTrashBadge = document.getElementById("mobileTrashBadge");
  const _updateTrashBadgeOrig = updateTrashBadge;
  updateTrashBadge = function(){
    _updateTrashBadgeOrig();
    const n = trashedSongs().length;
    if(n > 0){ mobileTrashBadge.style.display = "flex"; mobileTrashBadge.textContent = n; }
    else mobileTrashBadge.style.display = "none";
  };

  /* ---------------- splash de bienvenida ---------------- */
  (function initSplash(){
    const splash = document.getElementById("splash");
    const ALREADY_SEEN = sessionStorage.getItem("cancionero.splashSeen");
    if(ALREADY_SEEN){ splash.remove(); return; }

    const sq = todayQuote();
    document.getElementById("splashQuote").innerHTML = "“" + escapeHtml(sq[0]) + "”<small>— " + escapeHtml(sq[1]) + "</small>";
    const brand = document.getElementById("splashBrand"), word = "Sonarium";
    const stops = [[222,255,250], [47,216,196], [167,139,250]];
    const mix = (u, v, t) => u.map((c, i) => Math.round(c + (v[i] - c) * t));
    brand.innerHTML = word.split("").map((ch, i) => {
      const t = i / (word.length - 1) * 2, c = t < 1 ? mix(stops[0], stops[1], t) : mix(stops[1], stops[2], t - 1);
      return '<span aria-hidden="true" style="--i:' + i + ';color:rgb(' + c.join(",") + ')">' + ch + '</span>';
    }).join("");
    let dismissed = false;
    function dismiss(){
      if(dismissed) return;
      dismissed = true;
      sessionStorage.setItem("cancionero.splashSeen", "1");
      splash.classList.add("fade-out");
      setTimeout(() => splash.remove(), 1000);
    }
    splash.addEventListener("click", dismiss);
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(dismiss, 4600)));
  })();

  /* ---------------- brillo del cristal que sigue al puntero ---------------- */
  (function initGlass(){
    const fine = window.matchMedia("(hover:hover) and (pointer:fine)").matches;
    if(!fine) return;
    let raf = 0, last = null;
    document.addEventListener("pointermove", (e) => {
      last = e;
      if(raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const t = last.target.closest && last.target.closest(".card, .glass-btn, .space-chip, .mini");
        if(!t) return;
        const r = t.getBoundingClientRect();
        const x = last.clientX - r.left, y = last.clientY - r.top;
        t.style.setProperty("--mx", x + "px");
        t.style.setProperty("--my", y + "px");
        if(t.classList.contains("card")){
          t.style.setProperty("--ry", ((x / r.width) - .5) * 5 + "deg");
          t.style.setProperty("--rx", -((y / r.height) - .5) * 5 + "deg");
        }
      });
    }, { passive:true });
    document.addEventListener("pointerout", (e) => {
      const c = e.target.closest && e.target.closest(".card");
      if(c && !c.contains(e.relatedTarget)){ c.style.setProperty("--rx", "0deg"); c.style.setProperty("--ry", "0deg"); }
    }, { passive:true });
    const L = document.getElementById("cursorLight");
    if(L){
      let tx = innerWidth/2, ty = innerHeight/3, x = tx, y = ty, r2 = 0;
      const tick = () => {
        x += (tx - x) * .1; y += (ty - y) * .1;
        L.style.transform = "translate(" + x + "px," + y + "px)";
        r2 = (Math.abs(tx - x) + Math.abs(ty - y) > .5) ? requestAnimationFrame(tick) : 0;
      };
      window.addEventListener("pointermove", (e) => {
        tx = e.clientX; ty = e.clientY; L.classList.add("on");
        if(!r2) r2 = requestAnimationFrame(tick);
      }, { passive:true });
      document.addEventListener("pointerleave", () => L.classList.remove("on"));
    }
  })();

  /* ---------------- modo ligero automático ---------------- */
  (function autoLite(){
    // si la persona eligió (en su cuenta) activar o desactivar el modo ligero, se respeta sin medir
    let lp = null;
    try{ lp = localStorage.getItem("sonarium.ligero"); }catch(e){}
    if(lp === "on") document.body.classList.add("lite");
    if(lp === "on" || lp === "off") return;
    setTimeout(() => {
      if(document.hidden || !window.requestAnimationFrame) return;
      let n = 0, t0 = 0, aborted = false;
      const onVis = () => { aborted = true; };
      document.addEventListener("visibilitychange", onVis, { once:true });
      const f = (t) => {
        if(aborted) return;
        if(!t0) t0 = t;
        n++;
        if(t - t0 < 2000) return requestAnimationFrame(f);
        document.removeEventListener("visibilitychange", onVis);
        const fps = n / ((t - t0) / 1000);
        if(fps < 40 && !document.body.classList.contains("lite")){
          document.body.classList.add("lite");
          toast("Modo ligero activado para que todo se mueva más fluido");
        }
      };
      requestAnimationFrame(f);
    }, 4600);
  })();

  /* ---------------- canción abierta desde un espacio: anterior / siguiente / volver ---------------- */
  function spaceList(){
    const sp = songCtx && spaces.find(s => s.id === songCtx.spaceId);
    if(!sp) return null;
    return { sp, ids: (sp.songIds || []).filter(id => songs.some(s => s.id === id && !s.trashedAt)) };
  }
  function updateSpaceNav(){
    const nav = document.getElementById("spaceNav"), L = spaceList();
    const i = L ? L.ids.indexOf(activeId) : -1;
    if(!L || i < 0){ nav.style.display = "none"; el.songScreen.classList.remove("has-nav"); return; }
    nav.style.display = "flex"; el.songScreen.classList.add("has-nav");
    document.getElementById("spPrev").disabled = i === 0;
    document.getElementById("spNext").disabled = i === L.ids.length - 1;
    document.getElementById("spPos").textContent = (i + 1) + "/" + L.ids.length;
    document.getElementById("spBack").title = "Volver a «" + L.sp.name + "»";
  }
  function stepSpace(dir){
    const L = spaceList(); if(!L) return;
    const i = L.ids.indexOf(activeId) + dir;
    if(i < 0 || i >= L.ids.length) return;
    stopAutoScroll();
    openSong(L.ids[i]);
  }
  function backToSpace(){
    const L = spaceList();
    if(!L){ toast("Ese espacio ya no existe"); goHome(); return; }
    el.searchInput.value = "";
    loc = { type:"space", id:L.sp.id };
    goHome();
  }
  document.getElementById("spPrev").addEventListener("click", () => stepSpace(-1));
  document.getElementById("spNext").addEventListener("click", () => stepSpace(1));
  document.getElementById("spBack").addEventListener("click", backToSpace);
  document.getElementById("favBtn").addEventListener("click", () => { if(activeId) toggleFav(activeId); });
  document.getElementById("homeBtn").addEventListener("click", () => {
    el.searchInput.value = "";
    loc = { type:"folder", id:null };
    goHome();
  });

  /* ---------------- reordenar las canciones de un espacio arrastrando ≡ (mouse y dedo) ---------------- */
  (function spaceSort(){
    el.songGrid.addEventListener("pointerdown", (e) => {
      const h = e.target.closest(".drag-handle");
      if(!h || loc.type !== "space" || (e.pointerType === "mouse" && e.button !== 0)) return;
      const sp = spaces.find(s => s.id === loc.id); if(!sp) return;
      const cards = [...el.songGrid.querySelectorAll(".song-card")];
      const card = h.closest(".song-card"), from = cards.indexOf(card);
      if(from < 0) return;
      e.preventDefault();
      try{ h.setPointerCapture(e.pointerId); }catch(_){}
      const grid = el.songGrid, rects = cards.map(c => c.getBoundingClientRect());
      const startY = e.clientY, startScroll = grid.scrollTop, dh = rects[from].height + 8;
      let to = from;
      card.classList.add("sorting"); grid.classList.add("sorting");
      const move = (ev) => {
        const gr = grid.getBoundingClientRect();
        if(ev.clientY < gr.top + 50) grid.scrollTop -= 14; else if(ev.clientY > gr.bottom - 50) grid.scrollTop += 14;
        const dy = ev.clientY - startY + (grid.scrollTop - startScroll);
        card.style.transform = "translateY(" + dy + "px) scale(1.015)";
        const center = rects[from].top + rects[from].height/2 + dy;
        let t = from;
        rects.forEach((r, i) => {
          const mid = r.top + r.height/2;
          if(i < from && center < mid) t = Math.min(t, i);
          if(i > from && center > mid) t = Math.max(t, i);
        });
        to = t;
        cards.forEach((c, i) => {
          if(i === from) return;
          let s = 0;
          if(from < to && i > from && i <= to) s = -dh; else if(from > to && i < from && i >= to) s = dh;
          c.style.transform = s ? "translateY(" + s + "px)" : "";
        });
      };
      const end = (ev) => {
        h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", end); h.removeEventListener("pointercancel", end);
        try{ h.releasePointerCapture(e.pointerId); }catch(_){}
        grid.classList.remove("sorting");
        if(ev.type !== "pointercancel" && to !== from){
          const ids = cards.map(c => c.dataset.id);
          const m = ids.splice(from, 1)[0]; ids.splice(to, 0, m);
          sp.songIds = ids.concat((sp.songIds || []).filter(id => !ids.includes(id)));
          persist(); renderHome(false); toast("Orden actualizado");
        } else {
          cards.forEach(c => { c.classList.remove("sorting"); c.style.transform = ""; });
        }
      };
      h.addEventListener("pointermove", move); h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
    });
  })();

  /* ---------------- compartir un espacio: enlace, texto y PDF ---------------- */
  const $t = id => document.getElementById(id);
  const share = { id:null, link:"", text:"" };
  const clean = (v, n) => String(v == null ? "" : v).slice(0, n);
  function spaceSongs(sp){ return (sp.songIds || []).map(id => songs.find(s => s.id === id && !s.trashedAt)).filter(Boolean); }
  const bytesToB64u = (u8) => { let s = ""; for(let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const b64uToBytes = (t) => { t = t.replace(/-/g, "+").replace(/_/g, "/"); while(t.length % 4) t += "="; const s = atob(t), u = new Uint8Array(s.length); for(let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  async function packShare(sp){
    const payload = { v:1, n: sp.name, s: spaceSongs(sp).map(s => {
      const o = { t:s.title, a:s.artist || "", k:s.key || "", b:s.body, c:s.color || "" };
      if(s.semi) o.m = s.semi; if(s.capo) o.p = s.capo; if(s.tags && s.tags.length) o.g = s.tags; if(s.bpm) o.q = s.bpm;
      return o;
    }) };
    const json = new TextEncoder().encode(JSON.stringify(payload));
    if(window.CompressionStream){
      const cs = new CompressionStream("gzip"), w = cs.writable.getWriter(); w.write(json); w.close();
      return "z" + bytesToB64u(new Uint8Array(await new Response(cs.readable).arrayBuffer()));
    }
    return "p" + bytesToB64u(json);
  }
  async function unpackShare(code){
    const kind = code[0], raw = b64uToBytes(code.slice(1));
    if(kind === "z"){
      const ds = new DecompressionStream("gzip"), w = ds.writable.getWriter(); w.write(raw); w.close();
      return JSON.parse(new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()));
    }
    return JSON.parse(new TextDecoder().decode(raw));
  }
  function baseUrl(){ return location.href.split("#")[0]; }
  function shareText(sp){
    const L = spaceSongs(sp);
    return "🎶 " + sp.name + "\n" + L.map((s, i) => (i + 1) + ". " + s.title + (s.artist ? " — " + artistLabel(s.artist) : "") + (s.key ? " (" + shiftKeyLabel(s.key, s.semi || 0) + (s.capo ? ", capo " + s.capo : "") + ")" : "")).join("\n") + "\n\nSonarium";
  }
  async function openShare(id){
    const sp = spaces.find(x => x.id === id); if(!sp) return;
    if(!spaceSongs(sp).length){ toast("Este espacio todavía no tiene canciones"); return; }
    share.id = id; share.text = shareText(sp); share.link = "";
    $t("shareTitle").textContent = "Compartir «" + sp.name + "»";
    $t("shareVeil").classList.add("open");
    $t("shareLinkWarn").hidden = true;
    try{
      const packed = await packShare(sp);
      share.link = baseUrl() + "#e=" + packed;
      // intento de enlace corto: se guarda el espacio en la nube y el enlace lleva solo un código
      try{
        if(navigator.onLine && packed.length < 190000){
          const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
          await fbLoad();
          const { doc, setDoc, serverTimestamp } = cloud.fs;
          await setDoc(doc(cloud.db, "compartidos", code), { datos: packed, creado: serverTimestamp() });
          if(share.id === id) share.link = baseUrl() + "#c=" + code;
        }
      }catch(e){ console.warn("enlace corto no disponible", e); }
      if(share.link.length > 7500){ const w = $t("shareLinkWarn"); w.hidden = false; w.textContent = "El enlace es largo (" + Math.round(share.link.length / 1000) + " mil caracteres). Algunas apps lo cortan: si pasa, mejor usa el PDF o la lista."; }
    }catch(e){ $t("shareLinkWarn").hidden = false; $t("shareLinkWarn").textContent = "No se pudo crear el enlace en este navegador."; }
  }
  function copyText(t, okMsg){
    const done = () => toast(okMsg);
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done)); } else fallbackCopy(t, done);
  }
  function fallbackCopy(t, done){
    const ta = document.createElement("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); done(); }catch(e){ toast("No se pudo copiar"); } ta.remove();
  }
  $t("shareClose").addEventListener("click", () => $t("shareVeil").classList.remove("open"));
  $t("shareVeil").addEventListener("click", (e) => { if(e.target.id === "shareVeil") $t("shareVeil").classList.remove("open"); });
  $t("shareLinkCopy").addEventListener("click", () => { if(share.link) copyText(share.link, "Enlace copiado"); });
  $t("shareLinkSend").addEventListener("click", async () => {
    const sp = spaces.find(x => x.id === share.id); if(!sp || !share.link) return;
    if(navigator.share){ try{ await navigator.share({ title:"Sonarium · " + sp.name, text:"Canciones de «" + sp.name + "» en Sonarium", url:share.link }); }catch(e){} }
    else copyText(share.link, "Enlace copiado");
  });
  $t("shareTextCopy").addEventListener("click", () => copyText(share.text, "Lista copiada"));
  $t("shareWa").addEventListener("click", () => window.open("https://wa.me/?text=" + encodeURIComponent(share.text), "_blank", "noopener"));
  $t("sharePrint").addEventListener("click", () => {
    const sp = spaces.find(x => x.id === share.id); if(!sp) return;
    const withLyrics = $t("shareLyrics").checked, L = spaceSongs(sp);
    let h = '<h1>' + escapeHtml(sp.name) + '</h1><div class="pr-sub">' + escapeHtml(new Date().toLocaleDateString("es", { weekday:"long", day:"numeric", month:"long", year:"numeric" })) + ' · ' + L.length + ' canciones</div><ol class="pr-list">' +
      L.map(s => '<li><b>' + escapeHtml(s.title) + '</b>' + (s.artist ? ' <span>' + escapeHtml(artistLabel(s.artist)) + '</span>' : '') + (s.key ? ' <em>' + escapeHtml(shiftKeyLabel(s.key, s.semi || 0)) + (s.capo ? ' · capo ' + s.capo : '') + '</em>' : '') + '</li>').join("") + '</ol>';
    if(withLyrics) h += L.map((s, i) => '<section class="pr-song"><h2>' + (i + 1) + '. ' + escapeHtml(s.title) + '</h2><div class="pr-meta">' + [s.artist ? escapeHtml(artistLabel(s.artist)) : "", s.key ? 'Tono ' + escapeHtml(shiftKeyLabel(s.key, s.semi || 0)) : "", s.capo ? 'Capo ' + s.capo : ""].filter(Boolean).join(" · ") + '</div><div class="pr-body">' + renderSongBody(s.body, (s.semi || 0) - capoOf(s)) + '</div></section>').join("");
    $t("printRoot").innerHTML = h;
    $t("shareVeil").classList.remove("open");
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); $t("printRoot").innerHTML = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 120);
  });

  /* recibir un espacio compartido (al abrir un enlace con #e=...) */
  const validColor = c => /^#[0-9a-f]{6}$/i.test(c || "") ? c : PALETTE[Math.floor(Math.random() * PALETTE.length)].hex;
  const clampInt = (v, a, b) => { v = parseInt(v, 10); return isFinite(v) ? Math.max(a, Math.min(b, v)) : 0; };
  async function receiveShared(){
    const m = /^#([ec])=([A-Za-z0-9_-]+)$/.exec(location.hash || "");
    if(!m) return;
    history.replaceState(null, "", baseUrl());
    let data, packed = m[2];
    if(m[1] === "c"){
      try{
        await fbLoad();
        const { doc, getDoc } = cloud.fs, snap = await getDoc(doc(cloud.db, "compartidos", m[2]));
        if(!snap.exists()){ toast("Ese enlace ya no existe o está mal escrito"); return; }
        packed = snap.data().datos;
      }catch(e){ toast(navigator.onLine ? "No pude abrir el enlace" : "Necesitas internet para abrir este enlace"); return; }
    }
    try{ data = await unpackShare(packed); }catch(e){ toast("El enlace no es válido o está incompleto"); return; }
    if(!data || data.v !== 1 || !Array.isArray(data.s) || !data.s.length){ toast("El enlace no trae canciones"); return; }
    const list = data.s.slice(0, 60).map(o => ({
      title: clean(o.t, 200).trim() || "Sin título", artist: clean(o.a, 200), key: clean(o.k, 10), body: clean(o.b, 40000), color: validColor(o.c),
      semi: clampInt(o.m, -11, 11), capo: clampInt(o.p, 0, 11), tags: parseTags(Array.isArray(o.g) ? o.g.join(",") : ""), bpm: clampInt(o.q, 40, 220)
    }));
    const name = clean(data.n, 60).trim() || "Espacio compartido";
    const ok = await askDialog({ title:"Te compartieron un espacio", text:"«" + name + "» trae " + list.length + (list.length === 1 ? " canción" : " canciones") + ":", extra: list.map((s, i) => (i + 1) + ". " + s.title).join("\n").slice(0, 500), ok:"Agregar a mi cuaderno" });
    if(!ok) return;
    const ids = [];
    list.forEach(s => {
      const same = songs.find(x => !x.trashedAt && normTitle(x.title) === normTitle(s.title) && x.body === s.body);
      if(same){ ids.push(same.id); return; }
      const id = uid("s-"), o = { id, folderId:null, title:s.title, artist:s.artist, key:s.key, body:s.body, color:s.color };
      if(s.semi) o.semi = s.semi; if(s.capo) o.capo = s.capo; if(s.tags.length) o.tags = s.tags; if(s.bpm) o.bpm = s.bpm;
      songs.unshift(o); ids.push(id);
    });
    const now = Date.now();
    const sp = { id: uid("e-"), name, songIds: ids, createdAt: now, expiresAt: now + 2*24*3600000 };
    spaces.push(sp); persist();
    if(activeId !== null) goHome();
    openSpace(sp.id);
    toast("Espacio «" + name + "» agregado · dura 2 días (puedes editarlo)");
  }
  window.addEventListener("hashchange", () => { if(/^#[ec]=/.test(location.hash)) receiveShared(); });

  /* ---------------- herramientas: metrónomo, afinador y tonos de referencia ---------------- */
  const tools = { ac:null };
  function audioCtx(){
    if(!tools.ac){ const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return null; tools.ac = new AC(); }
    if(tools.ac.state === "suspended") tools.ac.resume();
    return tools.ac;
  }
  function openTools(tab){
    $t("toolsVeil").classList.add("open");
    toolsTab(tab || "metro");
    const song = songs.find(s => s.id === activeId);
    const sv = $t("metroSave"); sv.style.display = song ? "" : "none";
    if(song && song.bpm && !metro.on){ setBpm(song.bpm); }
  }
  function closeTools(){ $t("toolsVeil").classList.remove("open"); tunerStop(); refStop(); }
  function toolsTab(t){
    document.querySelectorAll(".tt").forEach(b => b.classList.toggle("on", b.dataset.tt === t));
    $t("tpMetro").classList.toggle("on", t === "metro"); $t("tpTuner").classList.toggle("on", t === "tuner"); $t("tpRef").classList.toggle("on", t === "ref");
    if(t !== "tuner") tunerStop(); if(t !== "ref") refStop();
  }
  document.querySelector(".tools-tabs").addEventListener("click", (e) => { const b = e.target.closest(".tt"); if(b) toolsTab(b.dataset.tt); });
  $t("toolsClose").addEventListener("click", closeTools);
  $t("toolsVeil").addEventListener("click", (e) => { if(e.target.id === "toolsVeil") closeTools(); });
  $t("toolsBtn").addEventListener("click", () => openTools("metro"));
  $t("toolsHomeBtn").addEventListener("click", () => openTools("metro"));
  $t("mobileTools").addEventListener("click", () => openTools("metro"));

  /* metrónomo (programado con el reloj de audio: no se desfasa) */
  const metro = { on:false, bpm:100, beats:4, beat:0, next:0, timer:0, taps:[] };
  function buildDots(){
    $t("metroDots").innerHTML = Array.from({ length: metro.beats }, (_, i) => '<i class="' + (i === 0 ? "acc" : "") + '"></i>').join("");
  }
  function setBpm(v){
    metro.bpm = Math.max(40, Math.min(220, Math.round(v)));
    $t("bpmVal").textContent = metro.bpm; $t("bpmRange").value = metro.bpm; $t("metroPillBpm").textContent = metro.bpm;
  }
  function click(t, accent){
    const ac = tools.ac; if(!ac) return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = "square"; o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.06);
  }
  function metroSched(){
    const ac = tools.ac; if(!ac || !metro.on) return;
    while(metro.next < ac.currentTime + 0.12){
      const idx = metro.beat % metro.beats, when = metro.next;
      click(when, idx === 0);
      setTimeout(() => {
        const d = $t("metroDots").children; [...d].forEach((x, k) => x.classList.toggle("on", k === idx));
        const pill = $t("metroPill"); pill.classList.remove("tick"); void pill.offsetWidth; pill.classList.add("tick");
      }, Math.max(0, (when - ac.currentTime) * 1000));
      metro.next += 60 / metro.bpm * (metro.beats === 6 ? 0.5 : 1);
      metro.beat++;
    }
  }
  function metroStart(){
    const ac = audioCtx(); if(!ac){ toast("Tu navegador no permite audio"); return; }
    metro.on = true; metro.beat = 0; metro.next = ac.currentTime + 0.08;
    metroSched(); metro.timer = setInterval(metroSched, 25);
    $t("metroGo").textContent = "■ Detener"; $t("metroPill").hidden = false;
  }
  function metroStop(){
    metro.on = false; clearInterval(metro.timer);
    $t("metroGo").textContent = "▶ Iniciar"; $t("metroPill").hidden = true;
    [...$t("metroDots").children].forEach(x => x.classList.remove("on"));
  }
  $t("metroGo").addEventListener("click", () => metro.on ? metroStop() : metroStart());
  $t("bpmDown").addEventListener("click", () => setBpm(metro.bpm - 1));
  $t("bpmUp").addEventListener("click", () => setBpm(metro.bpm + 1));
  $t("bpmRange").addEventListener("input", (e) => setBpm(parseInt(e.target.value, 10)));
  $t("metroBeats").addEventListener("change", (e) => { metro.beats = parseInt(e.target.value, 10); metro.beat = 0; buildDots(); });
  $t("tapBtn").addEventListener("click", () => {
    const now = performance.now();
    if(metro.taps.length && now - metro.taps[metro.taps.length - 1] > 2000) metro.taps = [];
    metro.taps.push(now); if(metro.taps.length > 6) metro.taps.shift();
    if(metro.taps.length >= 2){
      const gaps = []; for(let i = 1; i < metro.taps.length; i++) gaps.push(metro.taps[i] - metro.taps[i - 1]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  });
  $t("metroSave").addEventListener("click", () => {
    const song = songs.find(s => s.id === activeId); if(!song) return;
    song.bpm = metro.bpm; persist(); toast("Tempo guardado: " + metro.bpm + " BPM");
  });
  $t("metroPill").addEventListener("click", (e) => { if(e.target.id === "metroPillStop") metroStop(); else openTools("metro"); });
  buildDots(); setBpm(100);

  /* tonos de referencia (afinar de oído) */
  const REF_NOTES = [["E2", 82.41, "Mi grave"], ["A2", 110, "La"], ["D3", 146.83, "Re"], ["G3", 196, "Sol"], ["B3", 246.94, "Si"], ["E4", 329.63, "Mi agudo"], ["A4", 440, "La 440"], ["C4", 261.63, "Do central"]];
  let refPlay = null;
  $t("refGrid").innerHTML = REF_NOTES.map((n, i) => '<button class="glass-btn" data-ref="' + i + '"><b>' + n[0].replace(/\d/, "") + '</b><small>' + n[2] + '</small></button>').join("");
  function refStop(){
    if(!refPlay) return;
    const { o, g } = refPlay, ac = tools.ac;
    try{ g.gain.cancelScheduledValues(ac.currentTime); g.gain.setTargetAtTime(0.0001, ac.currentTime, 0.05); o.stop(ac.currentTime + 0.3); }catch(e){}
    refPlay = null; document.querySelectorAll("[data-ref]").forEach(b => b.classList.remove("on"));
  }
  $t("refGrid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ref]"); if(!b) return;
    const was = b.classList.contains("on"); refStop(); if(was) return;
    const ac = audioCtx(); if(!ac) return;
    const o = ac.createOscillator(), g = ac.createGain(), f = REF_NOTES[+b.dataset.ref][1];
    o.type = "triangle"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.35, ac.currentTime + 0.05);
    o.connect(g).connect(ac.destination); o.start(); refPlay = { o, g }; b.classList.add("on");
  });

  /* afinador con micrófono (autocorrelación) */
  const tuner = { stream:null, src:null, an:null, raf:0, hist:[], last:0 };
  function autoCorrelate(buf, sr){
    let SIZE = buf.length, rms = 0;
    for(let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE); if(rms < 0.012) return -1;
    let r1 = 0, r2 = SIZE - 1; const th = 0.2;
    for(let i = 0; i < SIZE / 2; i++) if(Math.abs(buf[i]) < th){ r1 = i; break; }
    for(let i = 1; i < SIZE / 2; i++) if(Math.abs(buf[SIZE - i]) < th){ r2 = SIZE - i; break; }
    buf = buf.slice(r1, r2); SIZE = buf.length; if(SIZE < 200) return -1;
    const c = new Float32Array(SIZE);
    for(let i = 0; i < SIZE; i++) for(let j = 0; j < SIZE - i; j++) c[i] += buf[j] * buf[j + i];
    let d = 0; while(d < SIZE - 1 && c[d] > c[d + 1]) d++;
    let max = -1, pos = -1;
    for(let i = d; i < SIZE; i++) if(c[i] > max){ max = c[i]; pos = i; }
    if(pos < 1 || pos >= SIZE - 1) return -1;
    let T0 = pos; const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1], a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
    if(a) T0 = T0 - b / (2 * a);
    return sr / T0;
  }
  function tunerLoop(){
    if(!tuner.an) return;
    const buf = new Float32Array(tuner.an.fftSize); tuner.an.getFloatTimeDomainData(buf);
    const f = autoCorrelate(buf, tools.ac.sampleRate);
    if(f > 60 && f < 1200){
      tuner.hist.push(f); if(tuner.hist.length > 5) tuner.hist.shift();
      const m = [...tuner.hist].sort((a, b) => a - b)[Math.floor(tuner.hist.length / 2)];
      const n = 12 * Math.log2(m / 440) + 69, r = Math.round(n), cents = Math.round((n - r) * 100);
      const name = toNotation(SHARPS[((r % 12) + 12) % 12]);
      $t("tnNote").textContent = name; $t("tnHz").textContent = m.toFixed(1) + " Hz";
      $t("tnNeedle").style.left = (50 + Math.max(-50, Math.min(50, cents))) + "%";
      const ok = Math.abs(cents) <= 5;
      $t("tpTuner").classList.toggle("ok", ok);
      $t("tnCents").textContent = ok ? "✔ Afinada" : (cents < 0 ? "♭ Muy grave: sube " + Math.abs(cents) + "¢" : "♯ Muy aguda: baja " + cents + "¢");
      tuner.last = performance.now();
    } else if(performance.now() - tuner.last > 1200){
      tuner.hist = []; $t("tpTuner").classList.remove("ok");
    }
    tuner.raf = requestAnimationFrame(() => setTimeout(tunerLoop, 45));
  }
  async function tunerStart(){
    const ac = audioCtx(); if(!ac){ toast("Tu navegador no permite audio"); return; }
    try{
      tuner.stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } });
    }catch(e){ toast("No se pudo usar el micrófono (revisa el permiso del navegador)"); return; }
    tuner.src = ac.createMediaStreamSource(tuner.stream);
    tuner.an = ac.createAnalyser(); tuner.an.fftSize = 2048; tuner.src.connect(tuner.an);
    $t("tunerGo").textContent = "■ Detener"; $t("tnHz").textContent = "Escuchando…"; tunerLoop();
  }
  function tunerStop(){
    cancelAnimationFrame(tuner.raf);
    if(tuner.stream){ tuner.stream.getTracks().forEach(t => t.stop()); tuner.stream = null; }
    if(tuner.src){ try{ tuner.src.disconnect(); }catch(e){} tuner.src = null; }
    tuner.an = null; tuner.hist = [];
    const g = $t("tunerGo"); if(g) g.textContent = "🎙 Activar micrófono";
    if($t("tnNote")){ $t("tnNote").textContent = "—"; $t("tnHz").textContent = "Pulsa «Activar» y toca una cuerda"; $t("tnCents").innerHTML = "&nbsp;"; $t("tnNeedle").style.left = "50%"; $t("tpTuner").classList.remove("ok"); }
  }
  $t("tunerGo").addEventListener("click", () => tuner.stream ? tunerStop() : tunerStart());

  /* ---------------- modo escenario: letra grande, sin botones, pantalla encendida ---------------- */
  const STAGE_KEY = "sonarium.escenario";
  const stage = { on:false, size:28, fs:false, lock:null, timer:0, dom:false, auto:true };
  function stageStoredSize(){
    let n = 0; try{ n = parseInt(localStorage.getItem(STAGE_KEY), 10); }catch(e){}
    return (n >= 16 && n <= 64) ? n : (window.innerWidth < 700 ? 22 : 30);
  }
  function stageDom(){
    let b = document.getElementById("stageBar");
    if(b) return b;
    b = document.createElement("div"); b.id = "stageBar";
    b.innerHTML =
      '<button data-st="exit" class="st-exit" title="Salir del modo escenario" aria-label="Salir">✕</button>' +
      '<span class="st-grp" id="stNav"><button data-st="prev" title="Canción anterior" aria-label="Anterior">‹</button><button data-st="next" title="Siguiente canción" aria-label="Siguiente">›</button></span>' +
      '<span class="st-grp"><button data-st="smaller" aria-label="Letra más pequeña">A−</button><button data-st="bigger" aria-label="Letra más grande">A+</button></span>' +
      '<span class="st-grp"><button data-st="down" aria-label="Bajar tono">−</button><b id="stKey">C</b><button data-st="up" aria-label="Subir tono">+</button></span>' +
      '<span class="st-grp"><button data-st="play" id="stPlay" aria-label="Auto-scroll">▶</button><input type="range" id="stSpeed" min="1" max="10" value="4" aria-label="Velocidad"></span>';
    document.body.appendChild(b);
    b.addEventListener("click", (e) => {
      const t = e.target.closest("[data-st]"); if(!t) return;
      const a = t.dataset.st;
      if(a === "exit") exitStage();
      else if(a === "prev") stepSpace(-1);
      else if(a === "next") stepSpace(1);
      else if(a === "bigger" || a === "smaller"){
        stage.auto = false;
        stage.size = Math.max(14, Math.min(64, stage.size + (a === "bigger" ? 2 : -2)));
        try{ localStorage.setItem(STAGE_KEY, String(stage.size)); }catch(_){}
        document.documentElement.style.setProperty("--stage-size", stage.size + "px");
      }
      else if(a === "up") updateTranspose(1);
      else if(a === "down") updateTranspose(-1);
      else if(a === "play"){ document.getElementById("playBtn").click(); stageSync(); }
      stageWake();
    });
    b.querySelector("#stSpeed").addEventListener("input", (e) => {
      el.speedRange.value = e.target.value; el.speedRange.dispatchEvent(new Event("input")); stageWake();
    });
    return b;
  }
  function stageSync(){
    if(!stage.on) return;
    const song = songs.find(s => s.id === activeId); if(!song) return;
    const k = document.getElementById("stKey"); if(k) k.textContent = el.keyLabel.textContent;
    if(stage.auto){   // sin tamaño elegido: el más grande que quepa sin cortar la línea más larga
      let sz = stageStoredSize();
      const apply = () => document.documentElement.style.setProperty("--stage-size", sz + "px");
      apply();
      while(sz > 14 && el.lyricsArea.scrollWidth > el.lyricsArea.clientWidth + 1){ sz -= 1; apply(); }
      stage.size = sz;
    }
    const L = spaceList(), i = L ? L.ids.indexOf(activeId) : -1, nav = document.getElementById("stNav");
    if(nav){
      nav.style.display = (L && i >= 0) ? "" : "none";
      nav.querySelector('[data-st="prev"]').disabled = i <= 0;
      nav.querySelector('[data-st="next"]').disabled = !L || i >= L.ids.length - 1;
    }
    const pl = document.getElementById("stPlay"); if(pl) pl.textContent = autoScroll.playing ? "❚❚" : "▶";
    const sp = document.getElementById("stSpeed"); if(sp) sp.value = el.speedRange.value;
  }
  function stageWake(){
    const b = document.getElementById("stageBar"); if(!b) return;
    b.classList.add("show"); clearTimeout(stage.timer);
    stage.timer = setTimeout(() => b.classList.remove("show"), 4200);
  }
  async function stageLock(){
    try{ if("wakeLock" in navigator && !stage.lock){ stage.lock = await navigator.wakeLock.request("screen"); stage.lock.addEventListener("release", () => { stage.lock = null; }); } }catch(e){}
  }
  function enterStage(){
    if(stage.on || activeId === null) return;
    stage.on = true; stage.size = stageStoredSize();
    let had = false; try{ had = !!localStorage.getItem(STAGE_KEY); }catch(e){}
    stage.auto = !had;
    document.documentElement.style.setProperty("--stage-size", stage.size + "px");
    document.body.classList.add("stage");
    stageDom(); stageSync(); stageWake(); stageLock();
    try{
      const r = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      if(r && r.then) r.then(() => { stage.fs = true; }).catch(() => {});
    }catch(e){}
    toast("Toca la letra para ver u ocultar los controles");
  }
  function exitStage(){
    if(!stage.on) return;
    stage.on = false;
    document.body.classList.remove("stage");
    const b = document.getElementById("stageBar"); if(b) b.classList.remove("show");
    clearTimeout(stage.timer);
    if(stage.lock){ try{ stage.lock.release(); }catch(e){} stage.lock = null; }
    if(document.fullscreenElement){ try{ document.exitFullscreen(); }catch(e){} }
    stage.fs = false;
  }
  document.getElementById("stageBtn").addEventListener("click", enterStage);
  el.lyricsArea.addEventListener("click", (e) => {
    if(!stage.on) return;
    e.stopImmediatePropagation();
    const sel = window.getSelection && String(window.getSelection()); if(sel) return;
    const b = document.getElementById("stageBar");
    if(b.classList.contains("show")){ b.classList.remove("show"); clearTimeout(stage.timer); } else stageWake();
  }, true);
  document.addEventListener("fullscreenchange", () => { if(stage.on && stage.fs && !document.fullscreenElement) exitStage(); });
  document.addEventListener("visibilitychange", () => { if(stage.on && !document.hidden) stageLock(); });
  document.addEventListener("keydown", (e) => {
    if(!stage.on) return;
    if(e.key === "Escape") exitStage();
    else if(e.key === "ArrowRight" || e.key === "PageDown"){ if(spaceList()) stepSpace(1); }
    else if(e.key === "ArrowLeft"){ if(spaceList()) stepSpace(-1); }
    else if(e.key === " " && e.target === document.body){ e.preventDefault(); document.getElementById("playBtn").click(); stageSync(); stageWake(); }
  });
  // si se sale de la canción (casa / volver), se sale también del escenario
  const _goHome0 = goHome; goHome = function(){ exitStage(); return _goHome0.apply(this, arguments); };

  /* ---------------- hoja "Más opciones" (celular) ---------------- */
  function closeMore(){ document.getElementById("moreVeil").classList.remove("open"); }
  document.getElementById("mobileMore").addEventListener("click", () => document.getElementById("moreVeil").classList.add("open"));
  document.getElementById("moreClose").addEventListener("click", closeMore);
  document.getElementById("moreVeil").addEventListener("click", (e) => { if(e.target.id === "moreVeil") closeMore(); });
  document.getElementById("moreList").addEventListener("click", (e) => { if(e.target.closest("button")) closeMore(); });
  document.getElementById("mobileView").addEventListener("click", () => document.getElementById("viewBtn").click());

  /* ---------------- barra lateral: los botones se mudan con animación ---------------- */
  const SIDE_KEY = "sonarium.barra";
  const SIDE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>';
  const sideState = { on:false, holders:new Map() };
  document.getElementById("sideToggle").innerHTML = SIDE_SVG;
  document.querySelector("#sideCollapse .ic").innerHTML = SIDE_SVG;
  const isWide = () => window.matchMedia("(min-width:901px)").matches;
  function sidePref(){ try{ return localStorage.getItem(SIDE_KEY); }catch(e){ return null; } }
  function sideNodes(){
    return ["newFolderBtn", "newSpaceBtn", "pdfBtn", "importBtn", "exportBtn"].map(id => document.getElementById(id))
      .concat([document.getElementById("trashToggle").parentElement]);
  }
  function applySide(animate){
    const want = isWide() && sidePref() === "on";
    if(want === sideState.on) return;
    const home = el.homeScreen, slot = document.getElementById("sideSlot"), nodes = sideNodes();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doAnim = !!animate && !reduce && home.style.display !== "none";
    const before = doAnim ? nodes.map(n => n.getBoundingClientRect()) : null;
    if(want){
      nodes.forEach(n => {
        const c = document.createComment("slot");
        n.parentNode.insertBefore(c, n); sideState.holders.set(n, c); slot.appendChild(n);
      });
    } else {
      nodes.forEach(n => { const c = sideState.holders.get(n); if(c && c.parentNode) c.parentNode.replaceChild(n, c); });
      sideState.holders.clear();
    }
    home.classList.toggle("has-side", want);
    sideState.on = want;
    if(doAnim){
      nodes.forEach((n, i) => {
        const a = before[i], b = n.getBoundingClientRect();
        n.animate([
          { transform:"translate(" + (a.left - b.left) + "px," + (a.top - b.top) + "px) scale(.92)", opacity:.55 },
          { transform:"none", opacity:1 }
        ], { duration:760 + i*70, easing:"cubic-bezier(.34,1.25,.64,1)", fill:"backwards" });
      });
    }
  }
  function setSide(on, animate){
    try{ localStorage.setItem(SIDE_KEY, on ? "on" : "off"); }catch(e){}
    applySide(animate);
  }
  document.getElementById("sideToggle").addEventListener("click", () => setSide(true, true));
  document.getElementById("sideCollapse").addEventListener("click", () => setSide(false, true));
  document.getElementById("sideNewSong").addEventListener("click", () => openModal(null));
  window.addEventListener("resize", () => applySide(false));
  function afterSplash(fn){
    const t = () => { if(document.getElementById("splash")) setTimeout(t, 250); else setTimeout(fn, 800); };
    t();
  }

  /* ---------------- scroll desde cualquier parte del inicio (encabezado, barra, migas) ---------------- */
  (function forwardScroll(){
    const home = el.homeScreen, grid = el.songGrid;
    home.addEventListener("wheel", (e) => {
      if(e.target.closest(".song-grid")) return;
      if(Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      if(grid.scrollHeight <= grid.clientHeight) return;
      grid.scrollTop += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      e.preventDefault();
    }, { passive:false });
    let ty = null;
    home.addEventListener("touchstart", (e) => { ty = e.target.closest(".song-grid") ? null : e.touches[0].clientY; }, { passive:true });
    home.addEventListener("touchmove", (e) => {
      if(ty === null) return;
      const y = e.touches[0].clientY;
      grid.scrollTop += ty - y; ty = y;
    }, { passive:true });
  })();

  /* ---------------- recorrido guiado (solo la primera vez que alguien entra) ---------------- */
  const TOUR_STEPS = [
    { sel:"", t:"¡Bienvenido a Sonarium! 🎶", d:"Te muestro lo básico en menos de un minuto. Puedes saltarlo cuando quieras." },
    { sel:"#newSongBtn, #mobileNewSong", t:"Crea tu primera canción", d:"Escribe la letra y pon cada acorde entre corchetes, así: [Am]Vamos a [F]cantar. ¿Copiaste una con los acordes encima de la letra? Pégala y usa el botón ✨ Convertir." },
    { sel:"#searchInput", t:"Encuentra lo que sea", d:"Busca por título, artista o nombre de carpeta. Con el selector de al lado ordenas por recientes, A–Z o artista." },
    { sel:"#newFolderBtn", t:"Organiza con carpetas", d:"Crea carpetas y subcarpetas, y arrastra las canciones hasta ellas. También puedes cargar las carpetas de la liturgia." },
    { sel:"#newSpaceBtn", t:"Espacios temporales", d:"Reúne las canciones de un momento dado, como la misa del domingo. Al vencer, el espacio desaparece solo y las canciones siguen en tu cuaderno." },
    { sel:"#viewBtn, #mobileView", t:"Lista o cuadrícula", d:"Cambia cómo ves tus canciones: tarjetas grandes o una lista compacta." },
    { sel:"#exportBtn, #mobileMore", t:"Copias y PDF", d:"Exporta tu repertorio como copia de seguridad, impórtalo o saca canciones de un PDF. En el celular están en el botón ⋯." },
    { sel:"#accountBtn", t:"Tu cuenta", d:"Tu cuaderno se guarda cifrado en la nube y se sincroniza solo. Aquí también cambias tu avatar y si ves acordes o solo la letra." },
    { sel:"", t:"¡Listo para cantar! 🎸", d:"Toca una canción para abrirla: sube o baja el tono con − / +, activa el auto-scroll con ▶ y toca la letra para ocultar los controles." }
  ];
  const tour = { on:false, i:0, steps:[] };
  function visibleEl(sel){
    return [...document.querySelectorAll(sel)].find(n => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== "hidden";
    }) || null;
  }
  function tourDom(){
    let t = document.getElementById("tour");
    if(t) return t;
    t = document.createElement("div"); t.id = "tour";
    t.innerHTML = '<div class="tour-block"></div><div class="tour-spot nofocus" id="tourSpot"></div>' +
      '<div class="tour-card" id="tourCard"><div class="tour-count" id="tourCount"></div><h4 id="tourTitle"></h4><p id="tourText"></p>' +
      '<div class="tour-dots" id="tourDots"></div>' +
      '<div class="tour-btns"><button class="tour-skip" id="tourSkip" type="button">Saltar</button><span style="flex:1"></span>' +
      '<button class="glass-btn" id="tourBack" type="button">Atrás</button><button class="glass-btn primary" id="tourNext" type="button">Siguiente</button></div></div>';
    document.body.appendChild(t);
    document.getElementById("tourSkip").addEventListener("click", () => endTour());
    document.getElementById("tourBack").addEventListener("click", () => showTourStep(tour.i - 1));
    document.getElementById("tourNext").addEventListener("click", () => {
      if(tour.i >= tour.steps.length - 1) endTour(); else showTourStep(tour.i + 1);
    });
    return t;
  }
  function showTourStep(i){
    if(i < 0 || i >= tour.steps.length) return;
    tour.i = i;
    const s = tour.steps[i], spot = document.getElementById("tourSpot"), card = document.getElementById("tourCard");
    document.getElementById("tourCount").textContent = (i + 1) + " / " + tour.steps.length;
    document.getElementById("tourTitle").textContent = s.t;
    document.getElementById("tourText").textContent = s.d;
    document.getElementById("tourDots").innerHTML = tour.steps.map((_, k) => '<i' + (k === i ? ' class="on"' : '') + '></i>').join("");
    document.getElementById("tourBack").style.visibility = i ? "visible" : "hidden";
    document.getElementById("tourNext").textContent = i === tour.steps.length - 1 ? "¡Listo!" : "Siguiente";
    const W = window.innerWidth, H = window.innerHeight, cw = Math.min(340, W - 28);
    card.style.width = cw + "px";
    const ch = card.offsetHeight;
    const target = s.sel ? visibleEl(s.sel) : null;
    if(target){
      const r = target.getBoundingClientRect(), pad = 7;
      const rad = (parseFloat(getComputedStyle(target).borderTopLeftRadius) || 12) + pad;
      spot.classList.remove("nofocus");
      spot.style.cssText = "left:" + (r.left - pad) + "px;top:" + (r.top - pad) + "px;width:" + (r.width + pad*2) + "px;height:" + (r.height + pad*2) + "px;border-radius:" + rad + "px";
      let top = r.bottom + pad + 14;
      if(top + ch > H - 12) top = r.top - pad - 14 - ch;
      if(top < 12) top = Math.max(12, Math.min(H - ch - 12, H/2 - ch/2));
      card.style.left = Math.max(14, Math.min(W - cw - 14, r.left + r.width/2 - cw/2)) + "px";
      card.style.top = top + "px";
    } else {
      spot.classList.add("nofocus");
      spot.style.cssText = "left:50%;top:50%;width:0;height:0;border-radius:0";
      card.style.left = (W - cw)/2 + "px";
      card.style.top = Math.max(12, (H - ch)/2) + "px";
    }
  }
  function startTour(){
    if(tour.on) return;
    if(activeId !== null) goHome();
    document.querySelectorAll(".modal-veil.open").forEach(v => v.classList.remove("open"));
    tour.steps = TOUR_STEPS.filter(s => !s.sel || visibleEl(s.sel));
    tour.on = true;
    tourDom().classList.add("on");
    showTourStep(0);
  }
  function endTour(){
    if(!tour.on) return;
    tour.on = false;
    const t = document.getElementById("tour"); if(t) t.classList.remove("on");
    if(cloud.user && !(meta.prefs && meta.prefs.tour)) setPref({ tour:true });
  }
  window.addEventListener("resize", () => { if(tour.on) showTourStep(tour.i); });
  document.addEventListener("keydown", (e) => {
    if(!tour.on) return;
    if(e.key === "ArrowRight" && tour.i < tour.steps.length - 1) showTourStep(tour.i + 1);
    else if(e.key === "ArrowLeft") showTourStep(tour.i - 1);
  });

  /* ---------------- primera carga ---------------- */
  loadState();
  applyChordsPref();
  cleanupTrash();
  purgeExpiredSpaces();
  persist({ noSync:true });
  goHome();
  updateAccountChip();
  restoreSession();
  afterSplash(receiveShared);
  // sin internet: la página y tus canciones (guardadas en el dispositivo) siguen funcionando
  if("serviceWorker" in navigator && /^https?:$/.test(location.protocol)){
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
  window.addEventListener("offline", () => toast("Sin conexión: tus canciones siguen aquí"));
  window.addEventListener("online", () => toast("Conexión recuperada"));
  // a partir de la 4.ª visita, los botones se mudan solos a la barra lateral (una sola vez, con animación)
  if(sidePref() === null && visits >= 4 && isWide()){
    afterSplash(() => { setSide(true, true); toast("Tus herramientas ahora están en la barra de la izquierda · pasa el cursor para ver los nombres"); });
  } else applySide(false);

})();
