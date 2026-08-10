/* =============================================================================
   THE CONTACT SHEET  ·  [data-ks-contact-sheet]
   -----------------------------------------------------------------------------
   A 35mm contact sheet marked up the way a photographer edits a roll: hover
   for a loupe, click a frame to cycle a grease-pencil mark, none to keeper
   circle to reject X and back to none. Marks live in the page only, nothing
   is stored.

   HONESTY NOTE
   ------------
   The 18 frames are procedural monochrome light studies drawn on canvas from
   fixed per-frame seeds: gradient washes, horizons, window glows, bokeh and
   film grain, with a few deliberately thin near-black frames like a real
   roll. They are not photographs. No client work is shown or imitated.

   Lives on the dark #050505 band of work/photography.html.
   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksContactSheetLoaded) { return; }
  window.__ksContactSheetLoaded = true;

  var STRIPS = 3, COLS = 6, N = STRIPS * COLS;
  var ZOOM = 2.5;                     /* loupe magnification                  */
  var PENCIL = '#cf3a28';             /* china-marker red                     */
  var UNDER = { 4: 1, 9: 1, 15: 1 };  /* the thin, near-black frames          */
  var GRAIN_T = 128;                  /* grain tile side, px                  */
  var SHIMMER_MS = 110;               /* grain re-jitter cadence, ~9 fps      */
  var DUR_KEEP = 340, DUR_REJ = 320;  /* stroke-on times, ms                  */
  var GROUND = '#050505';             /* the darkroom band this sits on       */

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

  /* "rgb(242, 239, 233)" -> [242, 239, 233] */
  function parseRGB(str, fallback) {
    if (!str) { return fallback.slice(); }
    var m = String(str).match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
    if (!m) { return fallback.slice(); }
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }

  /* Motion contract: the explicit site switch (localStorage ks-motion) wins,
     then the site's html.no-motion flag, then the OS preference. */
  function isStill() {
    var v = null;
    try { v = window.localStorage.getItem('ks-motion'); } catch (e) { v = null; }
    if (v === 'off') { return true; }
    if (v === 'on') { return false; }
    if (document.documentElement.classList.contains('no-motion')) { return true; }
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* mulberry32 · every frame and every pencil wobble comes from a fixed seed,
     so the sheet and the marks look identical on every visit and redraw. */
  function rng(seed) {
    var t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      var r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ===========================================================================
     2.  Instance
     ======================================================================== */

  function mount(root) {
    if (root.__ksContactSheet) { return; }
    root.__ksContactSheet = true;

    /* ---- state ---------------------------------------------------------- */

    var marks = [];                       /* 0 none · 1 keeper · 2 reject    */
    for (var mi = 0; mi < N; mi++) { marks.push(0); }
    var still = isStill();
    var focusIdx = 0;

    /* ---- DOM ------------------------------------------------------------ */

    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-contact-sheet');

    var head = el('div', 'ks-contact-sheet-head');
    head.appendChild(el('p', 'ks-contact-sheet-eyebrow',
      'The contact sheet · the edit is the craft'));
    head.appendChild(el('p', 'ks-contact-sheet-credit',
      'Every wedding comes home as a marked sheet'));
    root.appendChild(head);

    var stage = el('div', 'ks-contact-sheet-stage');
    var film = el('div', 'ks-contact-sheet-film');

    var sheet = el('canvas', 'ks-contact-sheet-canvas');
    sheet.setAttribute('role', 'img');
    sheet.setAttribute('aria-label',
      'Contact sheet, three film strips of six frames. The frames are ' +
      'procedural monochrome light studies, not photographs. Use the frame ' +
      'buttons to mark keepers and rejects.');
    film.appendChild(sheet);

    var marksCv = el('canvas', 'ks-contact-sheet-marks');
    marksCv.setAttribute('aria-hidden', 'true');
    film.appendChild(marksCv);

    var frames = el('div', 'ks-contact-sheet-frames');
    var btns = [];
    for (var bi = 0; bi < N; bi++) {
      (function (i) {
        var b = el('button', 'ks-contact-sheet-frame');
        b.type = 'button';
        b.tabIndex = i === 0 ? 0 : -1;
        b.addEventListener('click', function () { cycleMark(i); });
        b.addEventListener('focus', function () { setFocus(i, false); });
        frames.appendChild(b);
        btns.push(b);
      }(bi));
    }
    film.appendChild(frames);

    var loupe = el('div', 'ks-contact-sheet-loupe');
    loupe.setAttribute('aria-hidden', 'true');
    var loupeCv = el('canvas', 'ks-contact-sheet-loupecv');
    loupe.appendChild(loupeCv);
    film.appendChild(loupe);

    stage.appendChild(film);
    root.appendChild(stage);

    root.appendChild(el('p', 'ks-contact-sheet-hint',
      'Hover to loupe · click to mark'));

    var readout = el('div', 'ks-contact-sheet-readout');
    var cells = {};
    var CELL_DEFS = [['keep', 'Keepers'], ['rej', 'Rejects'], ['und', 'Undecided']];
    for (var di = 0; di < CELL_DEFS.length; di++) {
      var cell = el('span', 'ks-contact-sheet-cell');
      cell.appendChild(el('span', 'ks-contact-sheet-cellkey', CELL_DEFS[di][1]));
      var b = el('b', 'ks-contact-sheet-cellval', '0');
      cell.appendChild(b);
      readout.appendChild(cell);
      cells[CELL_DEFS[di][0]] = b;
    }
    var clearBtn = el('button', 'ks-contact-sheet-clear', 'Clear the sheet');
    clearBtn.type = 'button';
    readout.appendChild(clearBtn);
    root.appendChild(readout);

    var live = el('p', 'ks-contact-sheet-sr');
    live.setAttribute('aria-live', 'polite');
    root.appendChild(live);

    /* ---- canvas plumbing ------------------------------------------------ */

    var sctx = sheet.getContext ? sheet.getContext('2d') : null;
    var mctx = marksCv.getContext ? marksCv.getContext('2d') : null;
    var lctx = loupeCv.getContext ? loupeCv.getContext('2d') : null;
    if (!sctx || !mctx || !lctx) { return; }

    /* offscreen base: the sheet without grain, rebuilt on resize only, so a
       shimmer tick is one drawImage plus eighteen pattern fills */
    var base = document.createElement('canvas');
    var bctx = base.getContext('2d');
    if (!bctx) { return; }

    var dpr = 1;
    var W = 0, H = 0;
    var fw = 0, fh = 0, gf = 0, sb = 0, fe = 0, filmH = 0, eb = 0;
    var rects = [];
    var BONE = [242, 239, 233];
    var FAMILY = "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function bone(a) {
      return 'rgba(' + BONE[0] + ',' + BONE[1] + ',' + BONE[2] + ',' + a + ')';
    }

    function readColors() {
      var cs = window.getComputedStyle(root);
      BONE = parseRGB(cs.color, [242, 239, 233]);
      if (cs.fontFamily) { FAMILY = cs.fontFamily; }
    }

    /* print tone: a slightly warm silver-print white, scaled by alpha */
    function wa(a) { return 'rgba(236,231,222,' + clamp(a, 0, 1).toFixed(3) + ')'; }

    /* hand-tracked micro caps, same trick as the other features: canvas
       letterSpacing is not universal and the edge print depends on it */
    function tracked(ctx, str, x, y, size, alpha, align) {
      ctx.font = '600 ' + size + 'px ' + FAMILY;
      ctx.fillStyle = bone(alpha);
      var tr = size * 0.18, w = 0, i;
      for (i = 0; i < str.length; i++) { w += ctx.measureText(str.charAt(i)).width + tr; }
      w -= tr;
      var cx = align === 1 ? x - w : (align === 0 ? x - w / 2 : x);
      for (i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        ctx.fillText(ch, cx, y);
        cx += ctx.measureText(ch).width + tr;
      }
    }

    /* ===========================================================================
       3.  Layout · the sheet is 6 frames wide, height follows from the strips
       ======================================================================== */

    function layout() {
      W = film.clientWidth || root.clientWidth || 640;
      dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2   */

      gf = Math.max(3, Math.round(W * 0.011));           /* gap between frames */
      fw = (W - (COLS - 1) * gf) / COLS;
      fh = fw / 1.5;                                     /* 3:2 landscape      */
      sb = Math.max(7, fh * 0.14);                       /* sprocket band      */
      fe = Math.max(2, fh * 0.03);                       /* film edge margin   */
      filmH = fh + 2 * (sb + fe);
      eb = Math.max(14, Math.round(fh * 0.20));          /* edge print band    */
      H = Math.round(eb + STRIPS * (filmH + eb));

      rects = [];
      for (var i = 0; i < N; i++) {
        var s = Math.floor(i / COLS), c = i % COLS;
        rects.push({
          x: c * (fw + gf),
          y: eb + s * (filmH + eb) + fe + sb,
          w: fw, h: fh
        });
      }

      var pw = Math.max(1, Math.round(W * dpr));
      var ph = Math.max(1, Math.round(H * dpr));
      sheet.style.height = H + 'px';
      sheet.width = pw; sheet.height = ph;
      marksCv.width = pw; marksCv.height = ph;
      base.width = pw; base.height = ph;

      for (var k = 0; k < N; k++) {
        var r = rects[k], st = btns[k].style;
        st.left = r.x + 'px';
        st.top = r.y + 'px';
        st.width = r.w + 'px';
        st.height = r.h + 'px';
      }

      lpD = Math.round(clamp(fw * 1.5, 110, 180));
      loupe.style.width = lpD + 'px';
      loupe.style.height = lpD + 'px';
      loupeCv.width = Math.round(lpD * dpr);
      loupeCv.height = Math.round(lpD * dpr);
      loupeCv.style.width = lpD + 'px';
      loupeCv.style.height = lpD + 'px';

      markPaths = [];                     /* wobble is sized to the frame     */
    }

    /* ===========================================================================
       4.  The frames · seeded monochrome light studies
       ======================================================================== */

    function drawFrame(ctx, i, r) {
      var rand = rng(1234 + i * 997);
      /* exposure variance frame to frame, with a few near-black duds */
      var e = UNDER[i] ? (0.05 + rand() * 0.07) : (0.55 + rand() * 0.55);
      var motif = Math.floor(rand() * 3);

      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();

      ctx.fillStyle = 'rgb(8,8,9)';
      ctx.fillRect(r.x, r.y, r.w, r.h);

      var g, cxg, rad;

      if (motif === 0) {
        /* horizon study: sky wash, a glow sitting on the line, quiet water */
        var yh = r.y + r.h * (0.52 + rand() * 0.24);
        g = ctx.createLinearGradient(0, r.y, 0, yh);
        g.addColorStop(0, wa(0.78 * e));
        g.addColorStop(0.7, wa(0.18 * e));
        g.addColorStop(1, wa(0.05 * e));
        ctx.fillStyle = g;
        ctx.fillRect(r.x, r.y, r.w, yh - r.y);

        cxg = r.x + r.w * (0.25 + rand() * 0.5);
        rad = r.w * (0.28 + rand() * 0.34);
        g = ctx.createRadialGradient(cxg, yh, 0, cxg, yh, rad);
        g.addColorStop(0, wa(0.55 * e));
        g.addColorStop(1, wa(0));
        ctx.fillStyle = g;
        ctx.fillRect(r.x, r.y, r.w, r.h);

        g = ctx.createLinearGradient(0, yh, 0, r.y + r.h);
        g.addColorStop(0, wa(0.14 * e));
        g.addColorStop(1, wa(0.015 * e));
        ctx.fillStyle = g;
        ctx.fillRect(r.x, yh, r.w, r.y + r.h - yh);
      } else if (motif === 1) {
        /* window study: one bright soft-edged opening and its floor spill */
        ctx.fillStyle = wa(0.05 * e);
        ctx.fillRect(r.x, r.y, r.w, r.h);

        var wx = r.x + r.w * (0.14 + rand() * 0.42);
        var ww = r.w * (0.16 + rand() * 0.2);
        var wy = r.y + r.h * (0.10 + rand() * 0.18);
        var wh = r.h * (0.38 + rand() * 0.30);
        for (var k = 4; k >= 0; k--) {
          var pad = k * r.w * 0.018;
          ctx.fillStyle = wa(e * (k === 0 ? 0.85 : 0.06));
          ctx.fillRect(wx - pad, wy - pad, ww + 2 * pad, wh + 2 * pad);
        }
        if (rand() < 0.7) {
          ctx.fillStyle = 'rgba(8,8,9,0.85)';
          ctx.fillRect(wx + ww * 0.47, wy, Math.max(1.5, ww * 0.06), wh);
        }
        g = ctx.createLinearGradient(0, wy + wh, 0, r.y + r.h);
        g.addColorStop(0, wa(0.20 * e));
        g.addColorStop(1, wa(0));
        ctx.fillStyle = g;
        ctx.fillRect(wx - ww * 0.4, wy + wh, ww * 1.8, r.y + r.h - wy - wh);
      } else {
        /* drape study: one long diagonal wash and a corner bloom */
        var flip = rand() < 0.5;
        g = ctx.createLinearGradient(
          flip ? r.x : r.x + r.w, r.y,
          flip ? r.x + r.w : r.x, r.y + r.h);
        g.addColorStop(0, wa(0.70 * e));
        g.addColorStop(0.55, wa(0.16 * e));
        g.addColorStop(1, wa(0.02 * e));
        ctx.fillStyle = g;
        ctx.fillRect(r.x, r.y, r.w, r.h);

        cxg = flip ? r.x : r.x + r.w;
        g = ctx.createRadialGradient(cxg, r.y, 0, cxg, r.y, r.w * 0.55);
        g.addColorStop(0, wa(0.30 * e));
        g.addColorStop(1, wa(0));
        ctx.fillStyle = g;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }

      /* occasional bokeh, clustered to one side like lights past the couple */
      if (motif === 2 || rand() < 0.4) {
        var nB = 3 + Math.floor(rand() * 6);
        var sideX = rand();
        for (var q = 0; q < nB; q++) {
          var bx = r.x + r.w * (sideX * 0.5 + rand() * 0.5);
          var by = r.y + r.h * (0.15 + rand() * 0.7);
          var br = r.w * (0.025 + rand() * 0.06);
          var ba = e * (0.25 + rand() * 0.5);
          g = ctx.createRadialGradient(bx, by, br * 0.2, bx, by, br);
          g.addColorStop(0, wa(ba));
          g.addColorStop(0.75, wa(ba * 0.7));
          g.addColorStop(1, wa(0));
          ctx.fillStyle = g;
          ctx.fillRect(bx - br, by - br, br * 2, br * 2);
        }
      }

      /* vignette, the print look */
      g = ctx.createRadialGradient(
        r.x + r.w / 2, r.y + r.h / 2, r.w * 0.2,
        r.x + r.w / 2, r.y + r.h / 2, r.w * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.4)');
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);

      ctx.restore();
    }

    /* ===========================================================================
       5.  The base sheet · film strips, sprockets, edge print
       ======================================================================== */

    function roundRect(ctx, x, y, w, h, r) {
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function buildBase() {
      var ctx = bctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'alphabetic';

      var ep = Math.round(clamp(fw * 0.05, 7, 9.5) * 10) / 10;  /* edge print px */
      var i, s, r, x;

      /* sheet annotation, top band */
      var topY = eb * 0.68 + ep * 0.36;
      tracked(ctx, 'KAMIL SZWED · WEDDING · ROLL 07', 0, topY, ep, 0.5, -1);
      tracked(ctx, 'TRI-X 400', W * 0.62, topY, ep, 0.42, 0);
      tracked(ctx, 'TRI-X 400', W, topY, ep, 0.42, 1);

      for (s = 0; s < STRIPS; s++) {
        var fy = eb + s * (filmH + eb);

        /* film base · the rebate prints darker than the sheet frames */
        ctx.fillStyle = '#111113';
        ctx.fillRect(0, fy, W, filmH);
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, fy, W, 1);
        ctx.fillRect(0, fy + filmH - 1, W, 1);

        /* sprocket holes, both edges, continuous pitch across the strip */
        var pitch = fw / 8;
        var hw = pitch * 0.5, hh = sb * 0.6;
        var yTop = fy + fe + (sb - hh) / 2;
        var yBot = fy + filmH - fe - sb + (sb - hh) / 2;
        ctx.fillStyle = GROUND;
        ctx.beginPath();
        for (x = pitch * 0.25; x < W; x += pitch) {
          roundRect(ctx, x, yTop, hw, hh, Math.min(2, hw * 0.3));
          roundRect(ctx, x, yBot, hw, hh, Math.min(2, hw * 0.3));
        }
        ctx.fill();

        /* frames */
        for (i = s * COLS; i < (s + 1) * COLS; i++) {
          drawFrame(ctx, i, rects[i]);
        }

        /* edge print band under the strip: frame numbers, >14 >14A style */
        var by = fy + filmH + eb * 0.68 + ep * 0.36;
        for (i = s * COLS; i < (s + 1) * COLS; i++) {
          r = rects[i];
          var n = i + 1;
          tracked(ctx, '>' + n, r.x + r.w * 0.04, by, ep, 0.5, -1);
          tracked(ctx, '>' + n + 'A', r.x + r.w * 0.52, by, ep, 0.5, -1);
        }
      }
    }

    /* ---- grain · one seeded salt-and-pepper tile, offset per frame ------- */

    var tile = document.createElement('canvas');
    var grainPat = null;
    var grainOx = [], grainOy = [], grainA = [];

    function buildGrain() {
      tile.width = GRAIN_T; tile.height = GRAIN_T;
      var tctx = tile.getContext('2d');
      if (!tctx) { return; }
      var img = tctx.createImageData(GRAIN_T, GRAIN_T);
      var d = img.data;
      var rand = rng(20260810);
      for (var p = 0; p < d.length; p += 4) {
        var v = rand();
        var lum = v < 0.5 ? 0 : 255;
        d[p] = lum; d[p + 1] = lum; d[p + 2] = lum;
        d[p + 3] = Math.round(Math.abs(v - 0.5) * 2 * 90);
      }
      tctx.putImageData(img, 0, 0);
      grainPat = null;

      var orand = rng(424242);
      for (var i = 0; i < N; i++) {
        grainOx.push(Math.floor(orand() * GRAIN_T));
        grainOy.push(Math.floor(orand() * GRAIN_T));
        var fr = rng(1234 + i * 997);
        var e = UNDER[i] ? (0.05 + fr() * 0.07) : (0.55 + fr() * 0.55);
        grainA.push(0.16 + 0.14 * e);
      }
    }
    buildGrain();

    /* compose the visible sheet: base plus grain. jx/jy shift the grain,
       which is the whole of the idle shimmer. */
    function compose(jx, jy) {
      var ctx = sctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(base, 0, 0, W, H);
      if (!grainPat) {
        try { grainPat = ctx.createPattern(tile, 'repeat'); } catch (e) { grainPat = null; }
      }
      if (!grainPat) { return; }
      for (var i = 0; i < N; i++) {
        var r = rects[i];
        var ox = (grainOx[i] + jx + i * 29) % GRAIN_T;
        var oy = (grainOy[i] + jy + i * 13) % GRAIN_T;
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.globalAlpha = grainA[i];
        ctx.translate(-ox, -oy);
        ctx.fillStyle = grainPat;
        ctx.fillRect(r.x + ox, r.y + oy, r.w, r.h);
        ctx.restore();
      }
    }

    /* ===========================================================================
       6.  Grease pencil · seeded wobble, quick stroke-on
       ======================================================================== */

    var markPaths = [];   /* per frame: { keep, rejA, rejB } polylines        */

    function polyLen(pts) {
      var cum = [0];
      for (var i = 1; i < pts.length; i++) {
        var dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
        cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
      }
      return cum;
    }

    function pathsFor(i) {
      if (markPaths[i]) { return markPaths[i]; }
      var r = rects[i];
      var rand = rng(5678 + i * 131);

      /* keeper: one quick china-marker circle, ends overlapping */
      var cx = r.x + r.w / 2 + (rand() - 0.5) * r.w * 0.06;
      var cy = r.y + r.h / 2 + (rand() - 0.5) * r.h * 0.06;
      var rx = r.w * 0.52 * (0.96 + rand() * 0.1);
      var ry = r.h * 0.62 * (0.96 + rand() * 0.1);
      var a0 = -0.6 - rand() * 0.8;
      var a1 = a0 + Math.PI * 2 + 0.35 + rand() * 0.5;
      var p1 = rand() * 6.283, p2 = rand() * 6.283;
      var m1 = 0.025 + rand() * 0.02, m2 = 0.015 + rand() * 0.015;
      var keep = [], k, nK = 30;
      for (k = 0; k <= nK; k++) {
        var ang = a0 + (a1 - a0) * (k / nK);
        var wob = 1 + m1 * Math.sin(ang * 2 + p1) + m2 * Math.sin(ang * 5 + p2) +
                  (rand() - 0.5) * 0.012;
        keep.push([
          cx + Math.cos(ang) * rx * wob + Math.sin(ang * 0.5 + p1) * r.w * 0.012,
          cy + Math.sin(ang) * ry * wob
        ]);
      }

      /* reject: two wobbly strokes with a little overshoot at the corners */
      function stroke(x0, y0, x1, y1) {
        var pts = [], nS = 9;
        var ex = (x1 - x0) * 0.06, ey = (y1 - y0) * 0.06;
        x0 -= ex; y0 -= ey; x1 += ex; y1 += ey;
        var px = -(y1 - y0), py = (x1 - x0);
        var pl = Math.sqrt(px * px + py * py) || 1;
        px /= pl; py /= pl;
        var ph = rand() * 6.283, amp = r.h * 0.035;
        for (var t = 0; t <= nS; t++) {
          var u = t / nS;
          var j = Math.sin(u * Math.PI * 1.6 + ph) * amp * (0.4 + 0.6 * Math.sin(u * Math.PI)) +
                  (rand() - 0.5) * amp * 0.5;
          pts.push([x0 + (x1 - x0) * u + px * j, y0 + (y1 - y0) * u + py * j]);
        }
        return pts;
      }
      var rejA = stroke(r.x + r.w * 0.10, r.y + r.h * 0.08,
                        r.x + r.w * 0.92, r.y + r.h * 0.94);
      var rejB = stroke(r.x + r.w * 0.90, r.y + r.h * 0.06,
                        r.x + r.w * 0.08, r.y + r.h * 0.92);

      markPaths[i] = {
        keep: keep, keepCum: polyLen(keep),
        rejA: rejA, rejACum: polyLen(rejA),
        rejB: rejB, rejBCum: polyLen(rejB)
      };
      return markPaths[i];
    }

    /* stroke a polyline up to fraction p of its arc length */
    function strokeTo(ctx, pts, cum, p) {
      var total = cum[cum.length - 1] * clamp(p, 0, 1);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) {
        if (cum[i] <= total) { ctx.lineTo(pts[i][0], pts[i][1]); continue; }
        var seg = cum[i] - cum[i - 1];
        var u = seg > 0 ? (total - cum[i - 1]) / seg : 0;
        if (u > 0) {
          ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u,
                     pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u);
        }
        break;
      }
      ctx.stroke();
    }

    /* waxy double pass: a solid line and a lighter offset ghost */
    function pencil(ctx, pts, cum, p) {
      var lw = Math.max(2.5, fw * 0.05);
      ctx.strokeStyle = PENCIL;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = lw;
      strokeTo(ctx, pts, cum, p);
      ctx.save();
      ctx.translate(lw * 0.22, -lw * 0.16);
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = lw * 0.55;
      strokeTo(ctx, pts, cum, p);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    var anim = null;   /* { i, start } · at most one mark strokes on at once  */

    function drawMarks(ts) {
      var ctx = mctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < N; i++) {
        if (!marks[i]) { continue; }
        var P = pathsFor(i);
        var p = 1;
        if (anim && anim.i === i && ts != null) {
          var dur = marks[i] === 1 ? DUR_KEEP : DUR_REJ;
          p = clamp((ts - anim.start) / dur, 0, 1);
        }
        if (marks[i] === 1) {
          pencil(ctx, P.keep, P.keepCum, p);
        } else {
          /* the X is two strokes: first down, then across */
          pencil(ctx, P.rejA, P.rejACum, clamp(p * 2, 0, 1));
          if (p > 0.5) { pencil(ctx, P.rejB, P.rejBCum, clamp(p * 2 - 1, 0, 1)); }
        }
        if (anim && anim.i === i && p >= 1) { anim = null; }
      }
    }

    /* ===========================================================================
       7.  Tally, labels, announcements
       ======================================================================== */

    var MARK_WORD = ['unmarked', 'marked keeper', 'marked reject'];

    function counts() {
      var k = 0, r = 0;
      for (var i = 0; i < N; i++) {
        if (marks[i] === 1) { k++; } else if (marks[i] === 2) { r++; }
      }
      return [k, r, N - k - r];
    }

    function syncTally() {
      var c = counts();
      cells.keep.textContent = String(c[0]);
      cells.rej.textContent = String(c[1]);
      cells.und.textContent = String(c[2]);
    }

    function syncLabel(i) {
      btns[i].setAttribute('aria-label', 'Frame ' + (i + 1) + ', ' + MARK_WORD[marks[i]]);
    }

    function announce(msg) { live.textContent = msg; }

    function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

    function cycleMark(i) {
      marks[i] = (marks[i] + 1) % 3;
      syncLabel(i);
      syncTally();
      var c = counts();
      var what = marks[i] === 0 ? 'Frame ' + (i + 1) + ' cleared.'
        : 'Frame ' + (i + 1) + ' ' + MARK_WORD[marks[i]] + '.';
      announce(what + ' ' + plural(c[0], 'keeper') + ', ' +
        plural(c[1], 'reject') + ', ' + c[2] + ' undecided.');
      if (still || marks[i] === 0) {
        anim = null;
        drawMarks(null);
        if (lpOn) { drawLoupe(); }
      } else {
        anim = { i: i, start: performance.now() };
        startLoop();
      }
    }

    clearBtn.addEventListener('click', function () {
      for (var i = 0; i < N; i++) { marks[i] = 0; syncLabel(i); }
      anim = null;
      drawMarks(null);
      syncTally();
      if (lpOn) { drawLoupe(); }
      announce('Sheet cleared. ' + N + ' frames undecided.');
    });

    /* roving tabindex over the 6 x 3 grid */
    function setFocus(i, doFocus) {
      btns[focusIdx].tabIndex = -1;
      focusIdx = i;
      btns[focusIdx].tabIndex = 0;
      if (doFocus) { btns[focusIdx].focus(); }
    }

    frames.addEventListener('keydown', function (e) {
      var i = focusIdx, to = -1;
      if (e.key === 'ArrowRight') { to = Math.min(N - 1, i + 1); }
      else if (e.key === 'ArrowLeft') { to = Math.max(0, i - 1); }
      else if (e.key === 'ArrowDown') { to = Math.min(N - 1, i + COLS); }
      else if (e.key === 'ArrowUp') { to = Math.max(0, i - COLS); }
      else if (e.key === 'Home') { to = 0; }
      else if (e.key === 'End') { to = N - 1; }
      if (to >= 0) { e.preventDefault(); setFocus(to, true); }
    });

    /* ===========================================================================
       8.  Loupe · pointer only, skipped for touch
       ======================================================================== */

    var lpOn = false;
    var lpD = 140;
    var lpX = 0, lpY = 0, tX = 0, tY = 0;

    function placeLoupe() {
      loupe.style.transform =
        'translate(' + (lpX - lpD / 2) + 'px,' + (lpY - lpD / 2) + 'px)';
    }

    function blit(src) {
      var s = lpD / ZOOM;
      var SX = (lpX - s / 2) * dpr, SY = (lpY - s / 2) * dpr, S = s * dpr;
      var sx0 = Math.max(0, SX), sy0 = Math.max(0, SY);
      var sx1 = Math.min(src.width, SX + S), sy1 = Math.min(src.height, SY + S);
      if (sx1 <= sx0 || sy1 <= sy0) { return; }
      lctx.drawImage(src, sx0, sy0, sx1 - sx0, sy1 - sy0,
        (sx0 - SX) / S * lpD, (sy0 - SY) / S * lpD,
        (sx1 - sx0) / S * lpD, (sy1 - sy0) / S * lpD);
    }

    function drawLoupe() {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.clearRect(0, 0, lpD, lpD);
      lctx.save();
      lctx.beginPath();
      lctx.arc(lpD / 2, lpD / 2, lpD / 2, 0, Math.PI * 2);
      lctx.clip();
      lctx.fillStyle = GROUND;
      lctx.fillRect(0, 0, lpD, lpD);
      blit(sheet);
      blit(marksCv);
      /* a whisper of barrel shading so the glass reads as glass */
      var g = lctx.createRadialGradient(lpD / 2, lpD / 2, lpD * 0.34,
        lpD / 2, lpD / 2, lpD * 0.5);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.34)');
      lctx.fillStyle = g;
      lctx.fillRect(0, 0, lpD, lpD);
      lctx.restore();
    }

    function showLoupe() {
      if (!lpOn) {
        lpOn = true;
        loupe.classList.add('ks-contact-sheet-loupe-on');
      }
    }

    function hideLoupe() {
      if (lpOn) {
        lpOn = false;
        loupe.classList.remove('ks-contact-sheet-loupe-on');
      }
    }

    function onPointer(e) {
      if (e.pointerType === 'touch') { hideLoupe(); return; }
      var b = film.getBoundingClientRect();
      tX = e.clientX - b.left;
      tY = e.clientY - b.top;
      if (tX < 0 || tY < 0 || tX > W || tY > H) { hideLoupe(); return; }
      showLoupe();
      if (still) {
        /* still mode: the loupe snaps, no easing loop */
        lpX = tX; lpY = tY;
        placeLoupe();
        drawLoupe();
      } else {
        startLoop();
      }
    }

    film.addEventListener('pointerenter', onPointer);
    film.addEventListener('pointermove', onPointer);
    film.addEventListener('pointerleave', function () { hideLoupe(); });

    /* ===========================================================================
       9.  Frame loop · runs only while something is alive: grain shimmer on
           screen, a loupe easing after the pointer, or a mark stroking on.
           Nothing loops in still mode or in a hidden tab.
       ======================================================================== */

    var rafId = 0;
    var onScreen = true;
    var lastShimmer = 0;
    var jrand = rng(777);

    function shimmerRunning() {
      return !still && onScreen && !document.hidden;
    }

    function loopNeeded() {
      return !still && !document.hidden &&
             (shimmerRunning() || lpOn || !!anim);
    }

    function frameTick(ts) {
      rafId = 0;

      if (shimmerRunning() && ts - lastShimmer >= SHIMMER_MS) {
        lastShimmer = ts;
        compose(Math.floor(jrand() * GRAIN_T), Math.floor(jrand() * GRAIN_T));
        if (lpOn && !anim) { drawLoupe(); }
      }

      if (anim) {
        drawMarks(ts);
        if (lpOn) { drawLoupe(); }
      }

      if (lpOn) {
        lpX += (tX - lpX) * 0.35;
        lpY += (tY - lpY) * 0.35;
        if (Math.abs(tX - lpX) < 0.25 && Math.abs(tY - lpY) < 0.25) {
          lpX = tX; lpY = tY;
        }
        placeLoupe();
        if (!anim) { drawLoupe(); }
      }

      if (loopNeeded()) { rafId = window.requestAnimationFrame(frameTick); }
    }

    function startLoop() {
      if (rafId || !loopNeeded()) { return; }
      rafId = window.requestAnimationFrame(frameTick);
    }

    function stopLoop() {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
      if (anim) { anim = null; drawMarks(null); }   /* never lose a mark      */
    }

    /* ---- observers ------------------------------------------------------ */

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) { onScreen = entries[i].isIntersecting; }
        if (loopNeeded()) { startLoop(); } else { stopLoop(); }
      }, { rootMargin: '140px' });
      io.observe(root);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stopLoop(); } else { startLoop(); }
    });

    function onMotionChange() {
      var was = still;
      still = isStill();
      if (was === still) { return; }
      if (still) {
        stopLoop();
        hideLoupe();
        compose(0, 0);            /* park the grain                          */
        drawMarks(null);
      } else {
        startLoop();
      }
    }
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (mq) {
      if (mq.addEventListener) { mq.addEventListener('change', onMotionChange); }
      else if (mq.addListener) { mq.addListener(onMotionChange); }
    }
    /* the site's motion switch flips html.no-motion */
    if (window.MutationObserver) {
      new window.MutationObserver(onMotionChange).observe(document.documentElement, {
        attributes: true, attributeFilter: ['class']
      });
    }

    var resizeTimer = null, lastW = -1;
    function onResize() {
      if (resizeTimer) { window.clearTimeout(resizeTimer); }
      resizeTimer = window.setTimeout(function () {
        resizeTimer = null;
        var w = film.clientWidth;
        if (w === lastW) { return; }
        lastW = w;
        rebuild();
      }, 160);
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      new window.ResizeObserver(onResize).observe(root);
    }

    /* ---- build / go ------------------------------------------------------ */

    function rebuild() {
      readColors();
      layout();
      buildBase();
      compose(0, 0);
      anim = null;
      drawMarks(null);
      if (lpOn) { drawLoupe(); }
      startLoop();
    }

    for (var li = 0; li < N; li++) { syncLabel(li); }
    syncTally();
    rebuild();
    lastW = film.clientWidth;

    /* zero-width container (hidden tab, late layout) · retry once */
    if (!lastW) {
      window.setTimeout(function () {
        if (film.clientWidth) { lastW = film.clientWidth; rebuild(); }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { rebuild(); }, function () {});
    }
  }

  /* ===========================================================================
     10.  Boot
     ======================================================================== */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-contact-sheet]');
    for (var i = 0; i < nodes.length; i++) {
      try { mount(nodes[i]); } catch (err) { /* never break the page */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
