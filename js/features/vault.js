/* =============================================================================
   THE VAULT  ·  [data-ks-vault-graph] + [data-ks-vault-list]
   -----------------------------------------------------------------------------
   Every note in assets/notes.json drawn as a force graph on the dark band,
   and the same manifest rendered as a plain index on the paper section.
   One fetch feeds both mounts; either mount may be absent.

   ACCESSIBILITY
   -------------
   The canvas is decorative and aria-hidden. The LIST is the accessible
   representation of the vault: real anchors, real text, date order. A
   screen reader loses nothing if the graph never paints, and the stage
   carries a visually hidden note saying exactly that.

   WHAT IS ACTUALLY MODELLED
   -------------------------
   A small hand-rolled n-body sim: capped pairwise repulsion, springs along
   the manifest links (shorter rest for note-to-note), a weak pull toward
   the canvas centre, velocity damping, fixed timestep. Field hubs carry
   3x mass so notes orbit them rather than the reverse. The rAF loop stops
   when kinetic energy settles, when the tab hides, and when the band
   scrolls out of view; any interaction wakes it. Still mode converges
   synchronously at build time and paints once.

   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksVaultLoaded) { return; }
  window.__ksVaultLoaded = true;

  /* ===========================================================================
     1.  Small helpers
     ======================================================================== */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  /* deterministic layout: same seed, same starting constellation */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* motion contract: the explicit site switch (localStorage ks-motion) wins,
     then the site's html.no-motion flag, then the OS preference */
  function isStill() {
    var v = null;
    try { v = window.localStorage.getItem('ks-motion'); } catch (e) { v = null; }
    if (v === 'off') { return true; }
    if (v === 'on') { return false; }
    if (document.documentElement.classList.contains('no-motion')) { return true; }
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* "2026-08-13" -> "13 Aug 2026" (small caps come from the CSS) */
  function fmtDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) { return ''; }
    var mo = MONTHS[clamp(parseInt(m[2], 10) - 1, 0, 11)];
    return parseInt(m[3], 10) + ' ' + mo + ' ' + m[1];
  }

  /* ===========================================================================
     2.  Manifest: fetch with one retry, then defensive validation
     ======================================================================== */

  function loadManifest(cb) {
    if (typeof fetch !== 'function') { cb(null, ''); return; }
    function attempt(path, base, next) {
      try {
        fetch(path, { credentials: 'same-origin' })
          .then(function (res) { return res && res.ok ? res.json() : null; })
          .then(function (json) {
            if (json && json.notes && json.fields) { cb(json, base); }
            else if (next) { next(); } else { cb(null, ''); }
          })['catch'](function () { if (next) { next(); } else { cb(null, ''); } });
      } catch (e) { if (next) { next(); } else { cb(null, ''); } }
    }
    attempt('assets/notes.json', '', function () {
      attempt('../assets/notes.json', '../', null);
    });
  }

  /* manifest hrefs are site-root relative; if the fetch only succeeded one
     level up, the page lives one level down, so the hrefs need the same hop */
  function makeResolver(base) {
    return function (href) {
      if (typeof href !== 'string' || !href) { return '#'; }
      if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) { return href; }
      return base + href;
    };
  }

  function buildModel(json, base) {
    var resolve = makeResolver(base);
    var fields = [], fieldMap = {}, i, j;

    var rawFields = (json.fields && json.fields.length !== undefined) ? json.fields : [];
    for (i = 0; i < rawFields.length; i++) {
      var f = rawFields[i];
      if (!f || typeof f.id !== 'string' || typeof f.label !== 'string') { continue; }
      if (fieldMap[f.id]) { continue; }
      /* the hub filters the vault in place; workHref is kept so the peek
         card can still offer the field page as a secondary route */
      var hub = { id: f.id, label: f.label, href: '#field-' + f.id,
                  workHref: resolve(f.href), count: 0 };
      fieldMap[f.id] = hub;
      fields.push(hub);
    }

    var notes = [], noteMap = {};
    var rawNotes = (json.notes && json.notes.length !== undefined) ? json.notes : [];
    for (i = 0; i < rawNotes.length; i++) {
      var n = rawNotes[i];
      if (!n || typeof n.id !== 'string' || typeof n.title !== 'string' ||
          typeof n.href !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.date || '')) {
        continue;
      }
      if (noteMap[n.id]) { continue; }
      var fs = [], known = true;
      var nf = (n.fields && n.fields.length !== undefined) ? n.fields : [];
      for (j = 0; j < nf.length; j++) {
        var hit = fieldMap[nf[j]];
        if (!hit) { known = false; break; }
        fs.push(hit);
      }
      /* a note pointing at a field the manifest never declared is bad data:
         skip the note, never throw */
      if (!known) { continue; }
      var note = {
        id: n.id,
        title: n.title,
        date: n.date,
        fields: fs,
        minutes: (typeof n.minutes === 'number' && n.minutes > 0) ? n.minutes : 3,
        summary: typeof n.summary === 'string' ? n.summary : '',
        href: resolve(n.href),
        rawLinks: (n.links && n.links.length !== undefined) ? n.links : []
      };
      noteMap[n.id] = note;
      notes.push(note);
      for (j = 0; j < fs.length; j++) { fs[j].count++; }
    }

    /* note-to-note links are undirected: canonical key, deduped */
    var linkKeys = {}, links = [];
    for (i = 0; i < notes.length; i++) {
      var src = notes[i];
      for (j = 0; j < src.rawLinks.length; j++) {
        var dst = noteMap[src.rawLinks[j]];
        if (!dst || dst === src) { continue; }
        var key = src.id < dst.id ? src.id + '\u0000' + dst.id : dst.id + '\u0000' + src.id;
        if (linkKeys[key]) { continue; }
        linkKeys[key] = true;
        links.push([src, dst]);
      }
      delete src.rawLinks;
    }

    return { fields: fields, notes: notes, links: links };
  }

  /* ===========================================================================
     3.  Failure line: never a silent blank
     ======================================================================== */

  function renderFail(root, isList) {
    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.appendChild(el('p', 'ks-vault-fail-line', 'The vault could not load its index.'));
    if (isList) {
      var a = el('a', 'ks-vault-fail-link', 'Every page, in the sitemap');
      a.href = '/sitemap.xml';
      root.appendChild(a);
    }
  }

  /* ===========================================================================
     4.  The list (paper): the accessible representation of the vault
     ======================================================================== */

  /* ===========================================================================
     Field filter, shared by both mounts.

     A field hub is a lens on the vault, not a shortcut off it: clicking
     Robotics should show the robotics notes, not leave for the robotics
     work page. State lives here so the graph and the list always agree,
     and it is mirrored into the URL hash so a filtered vault is a link
     you can send.
     ======================================================================== */
  var Filter = (function () {
    function fromHash() {
      var m = /^#field-([a-z0-9-]+)$/i.exec(window.location.hash || '');
      return m ? m[1] : null;
    }
    /* seeded from the URL, so notes.html#field-robotics arrives filtered */
    var active = fromHash();
    var subs = [];
    function set(id, pushHash) {
      if (active === id) { return; }
      active = id || null;
      if (pushHash !== false) {
        var url = window.location.pathname + window.location.search +
          (active ? '#field-' + active : '');
        try { window.history.replaceState(null, '', url); } catch (e) { /* fine */ }
      }
      for (var i = 0; i < subs.length; i++) { subs[i](active); }
    }
    window.addEventListener('hashchange', function () { set(fromHash(), false); });

    return {
      get: function () { return active; },
      set: set,
      toggle: function (id) { set(active === id ? null : id); },
      onChange: function (fn) { subs.push(fn); }
    };
  })();

  function mountList(root, model) {
    render(Filter.get());
    Filter.onChange(render);

  function render(fieldId) {
    while (root.firstChild) { root.removeChild(root.firstChild); }

    var field = null;
    if (fieldId) {
      for (var f = 0; f < model.fields.length; f++) {
        if (model.fields[f].id === fieldId) { field = model.fields[f]; }
      }
    }

    var sorted = model.notes.slice().sort(function (a, b) {
      return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
    });
    if (field) {
      sorted = sorted.filter(function (n) {
        for (var k = 0; k < n.fields.length; k++) {
          if (n.fields[k].id === field.id) { return true; }
        }
        return false;
      });
    }

    /* the filter bar is the only thing that says why the list got shorter */
    if (field) {
      var bar = el('div', 'ks-vault-filter');
      bar.appendChild(el('span', 'ks-vault-filter-label',
        'Filtered · ' + field.label + ' · ' +
        sorted.length + (sorted.length === 1 ? ' note' : ' notes')));
      var clear = el('button', 'ks-vault-filter-clear', 'Show all notes');
      clear.type = 'button';
      clear.addEventListener('click', function () { Filter.set(null); });
      bar.appendChild(clear);
      root.appendChild(bar);
    }

    if (!sorted.length) {
      /* the filter bar above already carries the way out, so this is just
         the explanation for the empty space */
      root.appendChild(el('p', 'ks-vault-footline',
        'Nothing filed under ' + (field ? field.label : 'this field') +
        ' yet. It will show up here the moment there is.'));
      return;
    }

    var list = el('ol', 'ks-vault-list');
    for (var i = 0; i < sorted.length; i++) {
      var n = sorted[i];
      var li = el('li');
      var a = el('a', 'ks-vault-row');
      a.href = n.href;
      a.appendChild(el('span', 'ks-vault-date', fmtDate(n.date)));

      var main = el('div', 'ks-vault-main');
      main.appendChild(el('p', 'ks-vault-title', n.title));
      if (n.summary) { main.appendChild(el('p', 'ks-vault-summary', n.summary)); }
      a.appendChild(main);

      var labels = [];
      for (var j = 0; j < n.fields.length; j++) { labels.push(n.fields[j].label); }
      labels.push(n.minutes + ' min');
      a.appendChild(el('p', 'ks-vault-meta', labels.join(' · ')));

      var arrow = el('span', 'ks-vault-arrow', '→');
      arrow.setAttribute('aria-hidden', 'true');
      a.appendChild(arrow);

      li.appendChild(a);
      list.appendChild(li);
    }
    root.appendChild(list);
    root.appendChild(el('p', 'ks-vault-footline',
      field ? 'Click the hub again, or Show all notes, to widen the vault.'
            : 'Every note is a node in the graph above. Click a field hub to filter.'));
  }
  }

  /* ===========================================================================
     5.  The graph (dark band)
     ======================================================================== */

  /* physics constants · px, steps of 1/60 s */
  var DAMP = 0.9;            /* velocity damping per step                     */
  var HUB_MASS = 3;          /* hubs anchor, notes orbit                      */
  var HUB_R = 9;
  var NOTE_R_MIN = 4, NOTE_R_MAX = 6.5;
  var SEED = 20260813;
  var STEP_MS = 1000 / 60;   /* fixed timestep                                */
  var SETTLE_FRAMES = 14;    /* quiet frames before the loop lets go          */
  var STILL_BUDGET = 2400;   /* bounded synchronous convergence, still mode   */
  var CLICK_PX = 5, CLICK_MS = 300;

  function mountGraph(root, model) {
    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-vault-graph');

    /* ---- DOM ------------------------------------------------------------- */

    var head = el('div', 'ks-vault-head');
    head.appendChild(el('p', 'ks-vault-eyebrow', 'The graph · every note is a node'));
    head.appendChild(el('p', 'ks-vault-credit', 'Drag to stir · click to open'));
    root.appendChild(head);

    var stage = el('div', 'ks-vault-stage');
    /* the list below is the accessible representation; say so out loud */
    stage.appendChild(el('span', 'ks-vault-sr',
      'The graph is decorative. Every note is listed below.'));

    var cv = el('canvas', 'ks-vault-canvas');
    cv.setAttribute('aria-hidden', 'true');
    stage.appendChild(cv);

    var card = el('a', 'ks-vault-card');
    card.hidden = true;
    card.setAttribute('aria-hidden', 'true');
    card.setAttribute('tabindex', '-1');
    var cardEyebrow = el('p', 'ks-vault-card-eyebrow');
    var cardTitle = el('p', 'ks-vault-card-title');
    var cardSummary = el('p', 'ks-vault-card-summary');
    var cardOpen = el('span', 'ks-vault-card-open', 'Open →');
    card.appendChild(cardEyebrow);
    card.appendChild(cardTitle);
    card.appendChild(cardSummary);
    card.appendChild(cardOpen);

    /* The card floats over the canvas, so for a hub it, not the node, is
       what a second click lands on. Its href is the field hash, which is
       already the current URL once filtered, so following it would do
       nothing. Toggle instead, and the card and the node behave alike. */
    card.addEventListener('click', function (e) {
      if (!focusNode || focusNode.kind !== 'hub') { return; }
      e.preventDefault();
      Filter.toggle(focusNode.ref.id);
    });

    stage.appendChild(card);
    root.appendChild(stage);

    var legend = el('p', 'ks-vault-legend');
    legend.setAttribute('aria-hidden', 'true');
    function key(swCls, text) {
      var span = el('span', 'ks-vault-key');
      span.appendChild(el('i', 'ks-vault-sw ' + swCls));
      span.appendChild(document.createTextNode(text));
      legend.appendChild(span);
    }
    key('ks-vault-sw-note', 'Filled · note');
    key('ks-vault-sw-field', 'Hollow · field');
    key('ks-vault-sw-link', 'Lines · links');
    root.appendChild(legend);

    var g = cv.getContext ? cv.getContext('2d') : null;
    if (!g) { return; }

    /* ---- nodes + edges ---------------------------------------------------- */

    var nodes = [], i, j;
    var minM = Infinity, maxM = -Infinity;
    for (i = 0; i < model.notes.length; i++) {
      var mm = model.notes[i].minutes;
      if (mm < minM) { minM = mm; }
      if (mm > maxM) { maxM = mm; }
    }
    var mSpan = Math.max(1e-6, maxM - minM);

    for (i = 0; i < model.fields.length; i++) {
      nodes.push({ kind: 'hub', ref: model.fields[i], r: HUB_R, m: HUB_MASS,
                   x: 0, y: 0, vx: 0, vy: 0, fixed: false,
                   phase: i * 1.7 });
    }
    for (i = 0; i < model.notes.length; i++) {
      var nn = model.notes[i];
      var t = model.notes.length > 1 ? (nn.minutes - minM) / mSpan : 0.5;
      nodes.push({ kind: 'note', ref: nn,
                   r: NOTE_R_MIN + (NOTE_R_MAX - NOTE_R_MIN) * t, m: 1,
                   x: 0, y: 0, vx: 0, vy: 0, fixed: false,
                   phase: 2.3 + i * 1.1 });
    }
    var hubByField = {};
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'hub') { hubByField[nodes[i].ref.id] = nodes[i]; }
    }
    var nodeByNote = {};
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'note') { nodeByNote[nodes[i].ref.id] = nodes[i]; }
    }

    /* edges: {a, b, nn} · nn = note-to-note (brighter, shorter rest) */
    var edges = [];
    for (i = 0; i < model.notes.length; i++) {
      var noteNode = nodeByNote[model.notes[i].id];
      for (j = 0; j < model.notes[i].fields.length; j++) {
        edges.push({ a: noteNode, b: hubByField[model.notes[i].fields[j].id], nn: false });
      }
    }
    for (i = 0; i < model.links.length; i++) {
      edges.push({ a: nodeByNote[model.links[i][0].id],
                   b: nodeByNote[model.links[i][1].id], nn: true });
    }

    /* neighbours, for the hover dim */
    for (i = 0; i < nodes.length; i++) { nodes[i].near = [nodes[i]]; }
    for (i = 0; i < edges.length; i++) {
      edges[i].a.near.push(edges[i].b);
      edges[i].b.near.push(edges[i].a);
    }

    /* ---- canvas plumbing -------------------------------------------------- */

    var dpr = 1, W = 0, H = 0, CX = 0, CY = 0;
    var restNF = 120, restNN = 84, repCap = 260, repK = 1400, hubPad = 90;
    var FAMILY = "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function bone(a) { return 'rgba(242,239,233,' + a + ')'; }

    function layout() {
      var w = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 640;
      var h = cv.clientHeight || 420;
      dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2   */
      var pw = Math.max(1, Math.round(w * dpr));
      var ph = Math.max(1, Math.round(h * dpr));
      if (cv.width !== pw) { cv.width = pw; }
      if (cv.height !== ph) { cv.height = ph; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      W = w; H = h; CX = w / 2; CY = h / 2;
      var R = Math.min(W, H);
      restNF = R * 0.24;
      restNN = R * 0.15;          /* linked notes sit closer than field ties  */
      repCap = R * 0.62;
      repK = R * R * 0.013;
      var cs = window.getComputedStyle(root);
      if (cs.fontFamily) { FAMILY = cs.fontFamily; }
      /* each hub keeps its own wall margin: the painted label, in px */
      var widest = 0;
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].kind !== 'hub') { continue; }
        nodes[k].labelW = trackedW(nodes[k].ref.label.toUpperCase(), 9);
        if (nodes[k].labelW > widest) { widest = nodes[k].labelW; }
      }
      hubPad = clamp(widest + HUB_R + 18, 56, W * 0.35);
    }

    function seedPositions() {
      var rand = mulberry32(SEED);
      /* hub ring is an ellipse cut to the box, so a wide band spreads wide */
      var rx = Math.min(W * 0.32, W / 2 - hubPad - 10);
      var ry = H * 0.31;
      var hubs = [];
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i].kind === 'hub') { hubs.push(nodes[i]); }
      }
      for (i = 0; i < hubs.length; i++) {
        var ang = -Math.PI / 2 + (i / Math.max(1, hubs.length)) * Math.PI * 2
                + (rand() - 0.5) * 0.14;
        hubs[i].x = CX + Math.cos(ang) * rx;
        hubs[i].y = CY + Math.sin(ang) * ry;
      }
      for (i = 0; i < nodes.length; i++) {
        var nd = nodes[i];
        if (nd.kind !== 'note') { continue; }
        var home = nd.ref.fields[0] ? hubByField[nd.ref.fields[0].id] : null;
        var hx = home ? home.x : CX;
        var hy = home ? home.y : CY;
        var jr = Math.min(W, H) * (0.10 + rand() * 0.12);
        var ja = rand() * Math.PI * 2;
        nd.x = clamp(hx + Math.cos(ja) * jr, 16, W - 16);
        nd.y = clamp(hy + Math.sin(ja) * jr, 16, H - 16);
        nd.vx = 0; nd.vy = 0;
      }
    }

    /* ---- tracked micro-labels: characters placed by hand ------------------ */
    var wCache = {};
    function charW(ch, size) {
      var k = size + '|' + ch;
      var v = wCache[k];
      if (v === undefined) {
        g.font = '600 ' + size + 'px ' + FAMILY;
        v = g.measureText(ch).width;
        wCache[k] = v;
      }
      return v;
    }
    function trackedW(str, size) {
      var tr = size * 0.18, w = 0;
      for (var k = 0; k < str.length; k++) { w += charW(str.charAt(k), size) + tr; }
      return w - tr;
    }
    /* align: -1 left, 1 right */
    function tracked(str, x, y, size, alpha, align) {
      g.font = '600 ' + size + 'px ' + FAMILY;
      g.fillStyle = bone(alpha);
      var w = trackedW(str, size);
      var tr = size * 0.18;
      var cx = align === 1 ? x - w : x;
      for (var k2 = 0; k2 < str.length; k2++) {
        var ch = str.charAt(k2);
        g.fillText(ch, cx, y);
        cx += charW(ch, size) + tr;
      }
    }

    /* ===========================================================================
       6.  Simulation
       ======================================================================== */

    var ke = 1;              /* total kinetic energy, px^2/step^2 · masses    */
    var keEps = 0.0025;      /* per node, summed below                        */
    var simT = 0;
    var breathe = false;     /* motion mode + pointer inside: slow drift      */

    var ax = [], ay = [];

    function stepSim() {
      var n = nodes.length, a, b, dx, dy, d2, d, f, k;
      simT++;
      for (i = 0; i < n; i++) { ax[i] = 0; ay[i] = 0; }

      /* pairwise repulsion, capped by distance */
      var cap2 = repCap * repCap;
      for (i = 0; i < n; i++) {
        a = nodes[i];
        for (j = i + 1; j < n; j++) {
          b = nodes[j];
          dx = b.x - a.x; dy = b.y - a.y;
          d2 = dx * dx + dy * dy;
          if (d2 > cap2) { continue; }
          if (d2 < 1) { dx = 0.5; dy = 0.3; d2 = 0.34; }
          d = Math.sqrt(d2);
          f = repK / (d2 + 140);
          var fx = (dx / d) * f, fy = (dy / d) * f;
          ax[i] -= fx / a.m; ay[i] -= fy / a.m;
          ax[j] += fx / b.m; ay[j] += fy / b.m;
        }
      }

      /* springs along the edges */
      for (k = 0; k < edges.length; k++) {
        a = edges[k].a; b = edges[k].b;
        dx = b.x - a.x; dy = b.y - a.y;
        d = Math.sqrt(dx * dx + dy * dy) || 1;
        var rest = edges[k].nn ? restNN : restNF;
        f = 0.012 * (d - rest);
        var sfx = (dx / d) * f, sfy = (dy / d) * f;
        var ia = nodes.indexOf(a), ib = nodes.indexOf(b);
        ax[ia] += sfx / a.m; ay[ia] += sfy / a.m;
        ax[ib] -= sfx / b.m; ay[ib] -= sfy / b.m;
      }

      var energy = 0;
      for (i = 0; i < n; i++) {
        a = nodes[i];

        /* weak pull to centre, softer sideways so a wide band stays wide */
        ax[i] += (CX - a.x) * 0.0009 / a.m;
        ay[i] += (CY - a.y) * 0.0022 / a.m;
        /* walls: a hub needs extra room on whichever side its label paints */
        var padL = 24, padR = 24;
        if (a.kind === 'hub') {
          var lw = clamp((a.labelW || 60) + a.r + 16, 30, W * 0.45);
          if (a.x >= CX) { padL = a.r + 12; padR = lw; }
          else { padL = lw; padR = a.r + 12; }
        }
        if (a.x < padL) { ax[i] += (padL - a.x) * 0.05; }
        if (a.x > W - padR) { ax[i] -= (a.x - (W - padR)) * 0.05; }
        if (a.y < 26) { ay[i] += (26 - a.y) * 0.05; }
        if (a.y > H - 26) { ay[i] -= (a.y - (H - 26)) * 0.05; }

        /* ambient breathing: only in motion mode with the pointer inside */
        if (breathe) {
          ax[i] += Math.sin(simT * 0.011 + a.phase) * 0.006;
          ay[i] += Math.cos(simT * 0.009 + a.phase * 1.3) * 0.006;
        }

        if (a.fixed) { a.vx = 0; a.vy = 0; continue; }
        a.vx = (a.vx + ax[i]) * DAMP;
        a.vy = (a.vy + ay[i]) * DAMP;
        var sp2 = a.vx * a.vx + a.vy * a.vy;
        if (sp2 > 196) {                       /* speed cap: stability        */
          var s = 14 / Math.sqrt(sp2);
          a.vx *= s; a.vy *= s;
        }
        a.x += a.vx;
        a.y += a.vy;
        energy += a.m * sp2;
      }
      ke = energy;
    }

    function settledEnergy() { return ke < keEps * nodes.length; }

    /* still mode: run the sim to rest right now, inside a hard budget */
    function stillConverge() {
      var quiet = 0;
      breathe = false;
      for (var s = 0; s < STILL_BUDGET; s++) {
        stepSim();
        quiet = settledEnergy() ? quiet + 1 : 0;
        if (quiet >= 20) { break; }
      }
      for (i = 0; i < nodes.length; i++) { nodes[i].vx = 0; nodes[i].vy = 0; }
      ke = 0;
    }

    /* ===========================================================================
       7.  Hover / focus state
       ======================================================================== */

    var focusNode = null;      /* hovered or touch-selected node              */
    var stickyFocus = false;   /* touch selection survives pointer leave      */
    var focusSet = null;       /* focus + direct neighbours                   */
    var dimT = 0;              /* 0 = everyone lit, 1 = non-neighbours dimmed */

    function inSet(nd) {
      if (!focusSet) { return true; }
      return focusSet.indexOf(nd) !== -1;
    }

    function fillCard(nd) {
      if (nd.kind === 'hub') {
        cardEyebrow.textContent = 'Field · ' + nd.ref.count +
          (nd.ref.count === 1 ? ' note' : ' notes');
        cardTitle.textContent = nd.ref.label;
        cardSummary.textContent = '';
        cardOpen.textContent = Filter.get() === nd.ref.id
          ? 'Show all notes →'
          : (nd.ref.count ? 'Filter to these →' : 'No notes yet');
      } else {
        cardOpen.textContent = 'Open →';
        var fl = nd.ref.fields[0] ? nd.ref.fields[0].label : 'Unfiled';
        cardEyebrow.textContent = 'Note · ' + fl + ' · ' + fmtDate(nd.ref.date);
        cardTitle.textContent = nd.ref.title;
        cardSummary.textContent = nd.ref.summary;
      }
      card.href = nd.ref.href;
    }

    function positionCard() {
      if (!focusNode || card.hidden) { return; }
      var cw = card.offsetWidth, chh = card.offsetHeight;
      var x = focusNode.x + focusNode.r + 14;
      if (x + cw > W - 10) { x = focusNode.x - focusNode.r - 14 - cw; }
      if (x < 10) { x = clamp(focusNode.x - cw / 2, 10, Math.max(10, W - cw - 10)); }
      var y = clamp(focusNode.y - chh * 0.4, 10, Math.max(10, H - chh - 10));
      card.style.left = (cv.offsetLeft + x) + 'px';
      card.style.top = (cv.offsetTop + y) + 'px';
    }

    function setFocus(nd, sticky) {
      if (focusNode === nd) {
        if (sticky) { stickyFocus = true; }
        return;
      }
      focusNode = nd;
      stickyFocus = !!sticky;
      if (nd) {
        focusSet = nd.near;
        fillCard(nd);
        card.hidden = false;
        positionCard();
        cv.style.cursor = 'pointer';
      } else {
        card.hidden = true;
        cv.style.cursor = '';
      }
      wake();
    }

    /* a live filter keeps its hub in focus, so the graph and the list are
       showing the same slice of the vault at all times */
    function applyFilter(fieldId) {
      if (!fieldId) {
        if (stickyFocus) { setFocus(null, false); }
        wake();
        return;
      }
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].kind === 'hub' && nodes[i].ref.id === fieldId) {
          setFocus(nodes[i], true);
          /* setFocus is a no-op when the node is already focused, which is
             exactly the case right after clicking it, so the card copy has
             to be refreshed here or it keeps offering to filter something
             that is already filtered */
          if (focusNode && !card.hidden) { fillCard(focusNode); positionCard(); }
          return;
        }
      }
    }
    Filter.onChange(applyFilter);
    applyFilter(Filter.get());

    function hitNode(x, y) {
      var best = null, bestD = Infinity;
      for (var k = 0; k < nodes.length; k++) {
        var nd = nodes[k];
        var dx = nd.x - x, dy = nd.y - y;
        var d = Math.sqrt(dx * dx + dy * dy) - nd.r;
        if (d < 10 && d < bestD) { bestD = d; best = nd; }
      }
      return best;
    }

    /* ===========================================================================
       8.  Drawing
       ======================================================================== */

    function nodeMul(nd) { return inSet(nd) ? 1 : 1 - dimT * 0.85; }
    function edgeMul(e) {
      if (!focusNode) { return 1; }
      return (e.a === focusNode || e.b === focusNode) ? 1 : 1 - dimT * 0.85;
    }

    function draw() {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      g.lineCap = 'round';
      g.textBaseline = 'alphabetic';
      var k, nd;

      /* edges under everything: field ties faint, note links brighter */
      for (k = 0; k < edges.length; k++) {
        var e = edges[k];
        if (e.nn) { continue; }
        g.strokeStyle = bone(0.10 * edgeMul(e));
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(e.a.x, e.a.y);
        g.lineTo(e.b.x, e.b.y);
        g.stroke();
      }
      for (k = 0; k < edges.length; k++) {
        var e2 = edges[k];
        if (!e2.nn) { continue; }
        g.strokeStyle = bone(0.26 * edgeMul(e2));
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(e2.a.x, e2.a.y);
        g.lineTo(e2.b.x, e2.b.y);
        g.stroke();
      }

      /* hubs: hollow circles, labels always on */
      for (k = 0; k < nodes.length; k++) {
        nd = nodes[k];
        if (nd.kind !== 'hub') { continue; }
        var hm = nodeMul(nd);
        g.strokeStyle = bone(0.8 * hm);
        g.lineWidth = 1.4;
        g.beginPath();
        g.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
        g.stroke();
        /* label sits on the side facing away from centre, brightens when
           its hub joins the hover neighbourhood */
        var la = inSet(nd) && focusNode
          ? 0.52 + 0.4 * dimT
          : 0.52 * hm;
        var right = nd.x >= CX;
        tracked(nd.ref.label.toUpperCase(),
          right ? nd.x + nd.r + 8 : nd.x - nd.r - 8,
          nd.y + 3, 9, la, right ? -1 : 1);
      }

      /* notes: filled bone dots */
      for (k = 0; k < nodes.length; k++) {
        nd = nodes[k];
        if (nd.kind !== 'note') { continue; }
        g.fillStyle = bone(0.92 * nodeMul(nd));
        g.beginPath();
        g.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
        g.fill();
      }

      /* a quiet ring around whatever is in focus */
      if (focusNode && dimT > 0.02) {
        g.strokeStyle = bone(0.5 * dimT);
        g.lineWidth = 1;
        g.beginPath();
        g.arc(focusNode.x, focusNode.y, focusNode.r + 3.5, 0, Math.PI * 2);
        g.stroke();
      }
    }

    /* ===========================================================================
       9.  Frame loop / lifecycle
       ======================================================================== */

    var rafId = 0, lastTs = 0, acc = 0;
    var visible = true;
    var stillMode = isStill();
    var pointerInside = false;   /* hover-capable pointer only                */
    var settleFrames = 0;

    function dimSettled() {
      var target = focusNode ? 1 : 0;
      return Math.abs(dimT - target) < 0.01;
    }

    function frame(ts) {
      rafId = 0;
      if (!lastTs) { lastTs = ts; }
      var elapsed = ts - lastTs;
      lastTs = ts;
      if (elapsed > 100) { elapsed = 100; }
      if (elapsed < 0) { elapsed = 0; }
      acc += elapsed;

      breathe = !stillMode && pointerInside;
      var steps = 0;
      while (acc >= STEP_MS && steps < 4) { stepSim(); acc -= STEP_MS; steps++; }
      if (steps === 4) { acc = 0; }

      /* short lerp toward the dimmed constellation and back */
      var target = focusNode ? 1 : 0;
      dimT += (target - dimT) * 0.22;
      if (Math.abs(dimT - target) < 0.01) { dimT = target; }

      draw();
      if (focusNode && !press.dragging) { positionCard(); }

      var quiet = settledEnergy() && dimSettled() && !press.active;
      settleFrames = quiet ? settleFrames + 1 : 0;

      /* the loop lets go when everything is at rest; in motion mode the
         pointer parked inside keeps the slow breathing alive instead */
      var keep = visible && !document.hidden &&
        (settleFrames < SETTLE_FRAMES || breathe);
      if (keep) { rafId = window.requestAnimationFrame(frame); }
      else { lastTs = 0; }
    }

    function wake() {
      settleFrames = 0;
      if (rafId || document.hidden || !visible) { return; }
      lastTs = 0; acc = 0;
      rafId = window.requestAnimationFrame(frame);
    }

    function stop() {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
      lastTs = 0;
    }

    /* ===========================================================================
       10.  Interaction
       ======================================================================== */

    var press = { active: false, id: -1, node: null, x0: 0, y0: 0, t0: 0,
                  dragging: false, lastX: 0, lastY: 0, lastT: 0, vx: 0, vy: 0 };

    function canvasPos(e) {
      var r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function navigate(nd) {
      if (nd.kind === 'hub') {
        /* hubs filter in place; only notes navigate */
        Filter.toggle(nd.ref.id);
        return;
      }
      window.location.href = nd.ref.href;
    }

    cv.addEventListener('pointerenter', function (e) {
      if (e.pointerType !== 'touch') { pointerInside = true; wake(); }
    });

    stage.addEventListener('pointerleave', function () {
      pointerInside = false;
      if (!stickyFocus && !press.active) { setFocus(null, false); }
      /* no wake needed: a running loop notices breathe = false on its own,
         a stopped loop has nothing to do */
    });

    cv.addEventListener('pointermove', function (e) {
      var p = canvasPos(e);
      if (press.active && e.pointerId === press.id) {
        var ddx = p.x - press.x0, ddy = p.y - press.y0;
        if (!press.dragging && ddx * ddx + ddy * ddy > CLICK_PX * CLICK_PX) {
          press.dragging = true;
          press.node.fixed = true;
          card.hidden = true;
          cv.style.cursor = 'grabbing';
        }
        if (press.dragging) {
          var dt = Math.max(1, e.timeStamp - press.lastT);
          /* px/ms smoothed, converted to px/step on release */
          press.vx = press.vx * 0.7 + ((p.x - press.lastX) / dt) * 0.3;
          press.vy = press.vy * 0.7 + ((p.y - press.lastY) / dt) * 0.3;
          press.lastX = p.x; press.lastY = p.y; press.lastT = e.timeStamp;
          press.node.x = clamp(p.x, 6, W - 6);
          press.node.y = clamp(p.y, 6, H - 6);
          wake();
        }
        return;
      }
      if (e.pointerType === 'touch') { return; }
      pointerInside = true;
      var over = hitNode(p.x, p.y);
      if (over) { setFocus(over, false); }
      else if (!stickyFocus) { setFocus(null, false); }
      if (!rafId && !document.hidden && visible && over) { wake(); }
    });

    cv.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      var p = canvasPos(e);
      var nd = hitNode(p.x, p.y);
      if (!nd) {
        /* touch: a tap on empty space clears the selection */
        if (e.pointerType === 'touch' && stickyFocus) { setFocus(null, false); }
        return;
      }
      press.active = true;
      press.id = e.pointerId;
      press.node = nd;
      press.x0 = p.x; press.y0 = p.y;
      press.t0 = e.timeStamp;
      press.dragging = false;
      press.lastX = p.x; press.lastY = p.y; press.lastT = e.timeStamp;
      press.vx = 0; press.vy = 0;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      if (e.pointerType !== 'touch') { e.preventDefault(); }
      wake();
    });

    function endPress(e, mayFire) {
      if (!press.active || e.pointerId !== press.id) { return; }
      var nd = press.node;
      var wasDrag = press.dragging;
      var quick = (e.timeStamp - press.t0) < CLICK_MS;
      press.active = false;
      press.node = null;
      nd.fixed = false;
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
      cv.style.cursor = focusNode ? 'pointer' : '';

      if (wasDrag) {
        /* release with the velocity the hand gave it · never navigate */
        nd.vx = clamp(press.vx * STEP_MS, -12, 12);
        nd.vy = clamp(press.vy * STEP_MS, -12, 12);
        if (focusNode && mayFire) { card.hidden = false; positionCard(); }
        wake();
        return;
      }
      if (!mayFire || !quick) { wake(); return; }

      if (e.pointerType === 'touch') {
        /* first tap selects and shows the card, second tap opens */
        if (focusNode === nd && stickyFocus) { navigate(nd); }
        else { setFocus(nd, true); }
      } else {
        navigate(nd);
      }
      wake();
    }
    cv.addEventListener('pointerup', function (e) { endPress(e, true); });
    cv.addEventListener('pointercancel', function (e) { endPress(e, false); });

    /* ===========================================================================
       11.  Observers
       ======================================================================== */

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var k = 0; k < entries.length; k++) { visible = entries[k].isIntersecting; }
        if (!visible) { stop(); }
        else if (!stillMode) { wake(); }
        else { draw(); }
      }, { rootMargin: '140px' });
      io.observe(root);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); }
      else if (!stillMode) { wake(); }
    });

    function onMotionChange() {
      var was = stillMode;
      stillMode = isStill();
      if (was === stillMode) { return; }
      if (stillMode) {
        stop();
        stillConverge();
        draw();
      } else {
        wake();
      }
    }
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (mq) {
      if (mq.addEventListener) { mq.addEventListener('change', onMotionChange); }
      else if (mq.addListener) { mq.addListener(onMotionChange); }
    }
    /* the site's motion switch flips html.no-motion and writes ks-motion */
    if (window.MutationObserver) {
      new window.MutationObserver(onMotionChange).observe(document.documentElement, {
        attributes: true, attributeFilter: ['class']
      });
    }
    window.addEventListener('storage', onMotionChange);

    var resizeTimer = null, lastW = -1, lastH = -1;
    function onResize() {
      if (resizeTimer) { window.clearTimeout(resizeTimer); }
      resizeTimer = window.setTimeout(function () {
        resizeTimer = null;
        var w = cv.clientWidth, h = cv.clientHeight;
        if ((w === lastW && h === lastH) || !w || !h) { return; }
        /* keep the constellation: scale positions into the new box */
        var sx2 = lastW > 0 ? w / lastW : 1;
        var sy2 = lastH > 0 ? h / lastH : 1;
        for (var k = 0; k < nodes.length; k++) {
          nodes[k].x *= sx2; nodes[k].y *= sy2;
        }
        lastW = w; lastH = h;
        wCache = {};
        layout();
        if (stillMode) { stillConverge(); draw(); }
        else { draw(); wake(); }
      }, 160);
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      new window.ResizeObserver(onResize).observe(root);
    }

    /* ---- go --------------------------------------------------------------- */

    layout();
    lastW = cv.clientWidth;
    lastH = cv.clientHeight;
    seedPositions();
    if (stillMode) {
      stillConverge();
      draw();
    } else {
      draw();
      wake();
    }

    /* zero-width container (hidden tab, late fonts): retry once */
    if (!lastW) {
      window.setTimeout(function () {
        if (cv.clientWidth) {
          lastW = cv.clientWidth; lastH = cv.clientHeight;
          layout();
          seedPositions();
          if (stillMode) { stillConverge(); draw(); } else { draw(); wake(); }
        }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        /* real font metrics: remeasure the labels the walls make room for */
        wCache = {};
        layout();
        if (stillMode) { draw(); } else { draw(); wake(); }
      }, function () {});
    }
  }

  /* ===========================================================================
     12.  Boot: one fetch, two mounts, each handled on its own
     ======================================================================== */

  function boot() {
    var graphMount = document.querySelector('[data-ks-vault-graph]');
    var listMount = document.querySelector('[data-ks-vault-list]');
    if (!graphMount && !listMount) { return; }

    loadManifest(function (json, base) {
      var model = null;
      if (json) {
        try { model = buildModel(json, base); } catch (e) { model = null; }
      }
      if (!model || !model.notes.length) {
        if (graphMount) { renderFail(graphMount, false); }
        if (listMount) { renderFail(listMount, true); }
        return;
      }
      if (listMount) {
        try { mountList(listMount, model); } catch (e) { renderFail(listMount, true); }
      }
      if (graphMount) {
        try { mountGraph(graphMount, model); } catch (e) { renderFail(graphMount, false); }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
