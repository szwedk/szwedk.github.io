/* =============================================================================
   INTELLIPARK SANDBOX  ·  [data-ks-intellipark]
   -----------------------------------------------------------------------------
   A top-down, line-drawn parking lot: 24 stalls in two facing rows, a one-way
   drive lane, an entrance on the left. Cars arrive on a Poisson-ish schedule
   set by the DEMAND slider, pull into a chosen stall, dwell, back out, leave.

   The point is the system layer, not the cars. Three edge nodes (CAM 1..3)
   each watch a zone of eight stalls. Every stall renders its SENSED state as
   a small dot: filled = occupied confirmed, open = free, pulsing briefly on
   change. Dropping CAM 2 freezes its zone's sensed states while ground truth
   keeps moving underneath; the entrance sign goes stale and a timer counts.
   Restoring the node sweeps the zone, reconciles, and pulses corrections.

   This condenses the real IntelliPARK deployment at Sacred Heart University
   (CV cameras + ultrasonic occupancy sensors + edge processing) into a sketch.
   Everything here is a simulation; the credit line says so.

   No dependencies. Deterministic seeded rng, so every visit starts the same.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksIntelliparkLoaded) { return; }
  window.__ksIntelliparkLoaded = true;

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

  /* "rgb(11, 11, 12)" / "rgba(...)" -> [11, 11, 12] */
  function parseRGB(str, fallback) {
    if (!str) { return fallback.slice(); }
    var m = String(str).match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
    if (!m) { return fallback.slice(); }
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }

  /* deterministic rng · the same mulberry32 the home page uses */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* The site motion switch writes ks-motion; an explicit choice outranks the
     OS preference. Storage access can throw in private browsing, so guard. */
  function isStill() {
    var stored = null;
    try { stored = window.localStorage.getItem('ks-motion'); } catch (e) { stored = null; }
    if (stored === 'off') { return true; }
    if (stored === 'on') { return false; }
    if (document.documentElement.classList.contains('no-motion')) { return true; }
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* easings · keyframed motion, no physics needed */
  function easeIO(t) { return t * t * (3 - 2 * t); }
  function easeOut(t) { var u = 1 - t; return 1 - u * u; }
  function easeIn(t) { return t * t; }
  function eased(kind, t) {
    t = clamp(t, 0, 1);
    if (kind === 'io') { return easeIO(t); }
    if (kind === 'out') { return easeOut(t); }
    if (kind === 'in') { return easeIn(t); }
    return t;
  }

  /* ===========================================================================
     2.  Lot constants
     ======================================================================== */

  var COLS = 12;                 /* stalls per row                            */
  var ZONE_COLS = 4;             /* columns per camera zone                   */
  var N = COLS * 2;              /* 24 stalls                                 */
  var SEED = 20240117;           /* fixed seed · every visit starts the same  */
  var TONES = [0.34, 0.46, 0.58, 0.70];   /* car body greys, as ink alphas    */

  var uid = 0;

  /* ===========================================================================
     3.  Instance
     ======================================================================== */

  function mount(root) {
    if (root.__ksIntellipark) { return; }
    root.__ksIntellipark = true;
    uid++;
    var ns = 'ks-intellipark-' + uid;

    /* ---- state ---------------------------------------------------------- */

    var rng = mulberry32(SEED);
    var still = isStill();
    var userActed = false;              /* once the visitor runs it, respect that */
    var playing = !still;               /* still mode starts paused               */

    var simT = 0;                       /* simulation seconds, frozen while paused */
    var demandRaw = 45;                 /* slider 0..100                          */
    var perMin = 1;                     /* arrival rate, derived                  */

    var stalls = [];                    /* truth vs sensed, per stall             */
    var cars = [];
    var nextArrivalAt = 0;
    var nextDepartFree = 0;
    var arrivalLog = [];                /* spawn timestamps for the /min readout  */

    var cam2 = { on: true, downAt: 0 };
    var rescan = { active: false, t0: 0, dur: 1.5, fixed: 0, done: null };

    for (var s = 0; s < N; s++) {
      var row = s < COLS ? 0 : 1;
      var col = s % COLS;
      stalls.push({
        row: row, col: col,
        id: (row === 0 ? 'A' : 'B') + (col + 1),
        zone: Math.floor(col / ZONE_COLS),
        truth: false, sensed: false,
        truthAt: -99, delay: 0.6,
        pulseAt: -99,
        reserved: false, car: null
      });
    }

    function dwell() { return 40 + rng() * 160; }
    function detectDelay() { return 0.5 + rng() * 0.8; }
    function ratePerMin() { return 1 + Math.pow(demandRaw / 100, 1.4) * 11; }
    function sampleGap() {
      return clamp(-Math.log(1 - rng()) / (perMin / 60), 0.9, 90);
    }

    /* seeded half-full lot: 12 parked cars, deterministic */
    (function seedLot() {
      var idx = [];
      for (var i = 0; i < N; i++) { idx.push(i); }
      for (var j = N - 1; j > 0; j--) {
        var k = Math.floor(rng() * (j + 1));
        var tmp = idx[j]; idx[j] = idx[k]; idx[k] = tmp;
      }
      for (var m = 0; m < 12; m++) {
        var st = stalls[idx[m]];
        st.truth = true; st.sensed = true;
        var car = {
          state: 'parked', stall: st,
          tone: TONES[Math.floor(rng() * TONES.length)],
          departAt: 20 + rng() * 200,
          segs: null, si: 0, st: 0
        };
        st.car = car; st.reserved = true;
        cars.push(car);
      }
      perMin = ratePerMin();
      nextArrivalAt = sampleGap();
    }());

    /* ---- DOM ------------------------------------------------------------ */

    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-intellipark');

    var head = el('div', 'ks-intellipark-head');
    head.appendChild(el('p', 'ks-intellipark-eyebrow',
      'IntelliPARK · campus parking, condensed'));
    head.appendChild(el('p', 'ks-intellipark-credit',
      'Built at Sacred Heart University · CV + ultrasonic + edge nodes'));
    root.appendChild(head);

    /* dashboard row · the entrance sign, then the system counters */
    var readout = el('div', 'ks-intellipark-readout');

    var freeCell = el('span', 'ks-intellipark-cell');
    freeCell.appendChild(el('span', 'ks-intellipark-cellkey', 'Free stalls · sign'));
    var freeLine = el('span');
    var freeVal = el('b', 'ks-intellipark-cellval-big', '··');
    var freeFlag = el('span', 'ks-intellipark-flag', '');
    freeLine.appendChild(freeVal);
    freeLine.appendChild(freeFlag);
    freeCell.appendChild(freeLine);
    readout.appendChild(freeCell);

    var occCell = el('span', 'ks-intellipark-cell');
    occCell.appendChild(el('span', 'ks-intellipark-cellkey', 'Occupancy'));
    var occVal = el('b', 'ks-intellipark-cellval', '··');
    occCell.appendChild(occVal);
    readout.appendChild(occCell);

    var arrCell = el('span', 'ks-intellipark-cell');
    arrCell.appendChild(el('span', 'ks-intellipark-cellkey', 'Arrivals / min'));
    var arrVal = el('b', 'ks-intellipark-cellval', '··');
    arrCell.appendChild(arrVal);
    readout.appendChild(arrCell);

    var logCell = el('span', 'ks-intellipark-cell ks-intellipark-cell-log');
    logCell.appendChild(el('span', 'ks-intellipark-cellkey', 'Event log'));
    var logLine = el('p', 'ks-intellipark-log', 'lot seeded · 12 occupied');
    logLine.setAttribute('aria-hidden', 'true');   /* the sr region speaks    */
    logCell.appendChild(logLine);
    readout.appendChild(logCell);

    root.appendChild(readout);

    /* stage */
    var stage = el('div', 'ks-intellipark-stage');
    var canvas = el('canvas', 'ks-intellipark-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label',
      'Top-down parking lot simulation. 24 stalls in two rows, one drive ' +
      'lane, three camera zones. Dots show each stall sensor state.');
    stage.appendChild(canvas);
    root.appendChild(stage);

    /* controls */
    var panel = el('div', 'ks-intellipark-panel');

    var sliderWrap = el('div', 'ks-intellipark-slider');
    var sliderHead = el('div', 'ks-intellipark-sliderhead');
    var sliderLab = el('label', null, 'Demand');
    sliderLab.setAttribute('for', ns + '-demand');
    var sliderVal = el('span', 'ks-intellipark-val');
    sliderVal.setAttribute('aria-hidden', 'true');
    sliderHead.appendChild(sliderLab);
    sliderHead.appendChild(sliderVal);
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.id = ns + '-demand';
    slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.value = String(demandRaw);
    slider.className = 'ks-intellipark-range';
    sliderWrap.appendChild(sliderHead);
    sliderWrap.appendChild(slider);
    panel.appendChild(sliderWrap);

    var buttons = el('div', 'ks-intellipark-buttons');
    var btnCam = el('button', 'ks-intellipark-btn', 'Drop cam 2');
    btnCam.type = 'button';
    btnCam.setAttribute('aria-pressed', 'false');
    var btnRun = el('button', 'ks-intellipark-btn', playing ? 'Pause' : 'Run');
    btnRun.type = 'button';
    buttons.appendChild(btnCam);
    buttons.appendChild(btnRun);
    panel.appendChild(buttons);
    root.appendChild(panel);

    /* polite live region · visible log churns too fast to speak raw */
    var status = el('p', 'ks-intellipark-sr');
    status.setAttribute('role', 'status');
    root.appendChild(status);

    /* ---- canvas plumbing ------------------------------------------------ */

    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) { return; }

    var dpr = 1, W = 0, H = 0;
    var INK = [11, 11, 12];
    var FAMILY = "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function ink(a) {
      return 'rgba(' + INK[0] + ',' + INK[1] + ',' + INK[2] + ',' + a + ')';
    }

    function readColors() {
      var cs = window.getComputedStyle(root);
      INK = parseRGB(cs.color, [11, 11, 12]);
      if (cs.fontFamily) { FAMILY = cs.fontFamily; }
    }

    /* hand-tracked micro labels, memoised per glyph like the gait lab */
    var wCache = {};
    function charW(ch, size) {
      var k = size + '|' + ch;
      var v = wCache[k];
      if (v === undefined) {
        ctx.font = '600 ' + size + 'px ' + FAMILY;
        v = ctx.measureText(ch).width;
        wCache[k] = v;
      }
      return v;
    }
    /* align: -1 left, 0 centre, 1 right */
    function tracked(str, x, y, size, alpha, align) {
      ctx.font = '600 ' + size + 'px ' + FAMILY;
      ctx.fillStyle = ink(alpha);
      var tr = size * 0.2, w = 0, i;
      for (i = 0; i < str.length; i++) { w += charW(str.charAt(i), size) + tr; }
      w -= tr;
      var cx = align === 1 ? x - w : (align === 0 ? x - w / 2 : x);
      for (i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        ctx.fillText(ch, cx, y);
        cx += charW(ch, size) + tr;
      }
      return w;
    }

    /* ---- layout --------------------------------------------------------- */

    var lotL = 0, lotR = 0, lotT = 0, lotB = 0;
    var stallW = 0, depth = 0, laneTop = 0, laneBot = 0, laneY = 0;
    var carL = 0, carW = 0, CRUISE = 100;

    function layout() {
      var w = canvas.clientWidth || (canvas.parentNode && canvas.parentNode.clientWidth) || 320;
      var h = canvas.clientHeight || 280;
      dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2   */
      var pw = Math.max(1, Math.round(w * dpr));
      var ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw) { canvas.width = pw; }
      if (canvas.height !== ph) { canvas.height = ph; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      W = w; H = h;

      lotL = 34; lotR = W - 34;
      lotT = 30; lotB = H - 26;
      stallW = (lotR - lotL) / COLS;
      var avail = lotB - lotT;
      depth = avail / (2 + 1.15);
      laneTop = lotT + depth;
      laneBot = lotB - depth;
      laneY = (laneTop + laneBot) / 2;
      carL = depth * 0.62;
      carW = Math.min(stallW * 0.56, carL * 0.52);
      CRUISE = clamp(W * 0.16, 70, 120);
    }

    function stallX(st) { return lotL + (st.col + 0.5) * stallW; }
    function parkY(st) {
      return st.row === 0 ? lotT + depth * 0.45 : lotB - depth * 0.45;
    }
    function parkAng(st) { return st.row === 0 ? -Math.PI / 2 : Math.PI / 2; }
    function dotY(st) { return st.row === 0 ? laneTop - 6 : laneBot + 6; }

    /* ---- paths ---------------------------------------------------------- */
    /* every segment is a quadratic bezier (straight when the control point is
       the midpoint), eased per segment. heading comes from the tangent, and a
       reversing segment draws it flipped, which is what backing out is. */

    function seg(ax, ay, cx, cy, bx, by, dur, ease, rev, end) {
      return { ax: ax, ay: ay, cx: cx, cy: cy, bx: bx, by: by,
               dur: Math.max(0.2, dur), ease: ease, rev: !!rev, end: end || null };
    }
    function line(ax, ay, bx, by, dur, ease, end) {
      return seg(ax, ay, (ax + bx) / 2, (ay + by) / 2, bx, by, dur, ease, false, end);
    }
    function segLen(g) {
      var d1 = Math.sqrt((g.cx - g.ax) * (g.cx - g.ax) + (g.cy - g.ay) * (g.cy - g.ay));
      var d2 = Math.sqrt((g.bx - g.cx) * (g.bx - g.cx) + (g.by - g.cy) * (g.by - g.cy));
      return (d1 + d2) * 0.9;
    }
    function segPos(g, u, out) {
      var m = 1 - u;
      out.x = m * m * g.ax + 2 * m * u * g.cx + u * u * g.bx;
      out.y = m * m * g.ay + 2 * m * u * g.cy + u * u * g.by;
      var tx = 2 * m * (g.cx - g.ax) + 2 * u * (g.bx - g.cx);
      var ty = 2 * m * (g.cy - g.ay) + 2 * u * (g.by - g.cy);
      if (tx * tx + ty * ty < 1e-6) { tx = 1; ty = 0; }
      out.a = Math.atan2(ty, tx) + (g.rev ? Math.PI : 0);
    }
    var pose = { x: 0, y: 0, a: 0 };

    function arrivePath(st) {
      var sx = stallX(st), py = parkY(st);
      var lead = stallW * 1.4;
      var s1 = line(-carL, laneY, sx - lead, laneY, 0, 'out');
      s1.dur = segLen(s1) / CRUISE;
      var s2 = seg(sx - lead, laneY, sx, laneY, sx, py, 1.6, 'io', false, 'park');
      return [s1, s2];
    }
    function departPath(st) {
      var sx = stallX(st), py = parkY(st);
      var back = stallW * 1.1;
      var s1 = seg(sx, py, sx, laneY, sx - back, laneY, 1.8, 'io', true, 'out');
      var s2 = line(sx - back, laneY, W + carL, laneY, 0, 'in', 'gone');
      s2.dur = segLen(s2) / CRUISE * 1.1;
      return [s1, s2];
    }
    function passPath() {
      var s1 = line(-carL, laneY, W + carL, laneY, 0, 'linear', 'gone');
      s1.dur = segLen(s1) / CRUISE;
      return [s1];
    }

    /* ---- events / announcements ----------------------------------------- */

    var srLast = 0, srTimer = null, srPending = '';
    function announce(text) {
      srPending = text;
      var since = Date.now() - srLast;
      if (srTimer) { return; }
      var wait = since > 2800 ? 30 : 2800 - since;
      srTimer = window.setTimeout(function () {
        srTimer = null;
        srLast = Date.now();
        status.textContent = srPending;
      }, wait);
    }

    function pushEvent(text) {
      logLine.textContent = text;
      announce(text);
    }

    /* ---- sensing layer --------------------------------------------------- */

    function camOn(st) { return st.zone !== 1 || cam2.on; }

    function sensedFree() {
      var n = 0;
      for (var i = 0; i < N; i++) { if (!stalls[i].sensed) { n++; } }
      return n;
    }

    function commit(st, quiet) {
      var changed = st.sensed !== st.truth;
      st.sensed = st.truth;
      if (changed) {
        if (!still) { st.pulseAt = simT; }
        if (!quiet) {
          pushEvent(st.id + (st.truth ? ' occupied' : ' released') +
                    ' · cam ' + (st.zone + 1));
        }
      }
      return changed;
    }

    function senseTick() {
      for (var i = 0; i < N; i++) {
        var st = stalls[i];
        if (!camOn(st)) { continue; }
        if (st.zone === 1 && rescan.active) { continue; }
        if (st.sensed !== st.truth && simT >= st.truthAt + st.delay) {
          commit(st, false);
          st.delay = detectDelay();
        }
      }
      if (rescan.active) {
        var u = clamp((simT - rescan.t0) / rescan.dur, 0, 1);
        var x0 = lotL + ZONE_COLS * stallW;
        var sweepX = x0 + u * ZONE_COLS * stallW;
        for (var j = 0; j < N; j++) {
          var zs = stalls[j];
          if (zs.zone !== 1 || rescan.done[j]) { continue; }
          if (stallX(zs) <= sweepX) {
            rescan.done[j] = true;
            if (commit(zs, true)) { rescan.fixed++; }
          }
        }
        if (u >= 1) {
          rescan.active = false;
          pushEvent('cam 2 online · ' +
            (rescan.fixed ? rescan.fixed + ' corrected' : 'no drift'));
        }
      }
    }

    function setCam2(on) {
      if (cam2.on === on) { return; }
      cam2.on = on;
      btnCam.textContent = on ? 'Drop cam 2' : 'Restore cam 2';
      btnCam.setAttribute('aria-pressed', on ? 'false' : 'true');
      btnCam.classList.toggle('is-active', !on);
      root.classList.toggle('ks-intellipark-stale', !on);
      if (!on) {
        cam2.downAt = simT;
        rescan.active = false;
        pushEvent('cam 2 offline · zone stale');
      } else if (still || !playing) {
        /* no sweep animation in still mode or while paused: reconcile now */
        var fixed = 0;
        for (var i = 0; i < N; i++) {
          if (stalls[i].zone === 1 && commit(stalls[i], true)) { fixed++; }
        }
        pushEvent('cam 2 online · ' + (fixed ? fixed + ' corrected' : 'no drift'));
      } else {
        rescan.active = true;
        rescan.t0 = simT;
        rescan.fixed = 0;
        rescan.done = {};
      }
      syncReadout();
      syncAria();
      if (!playing) { draw(); }
    }

    /* ---- traffic --------------------------------------------------------- */

    function movingCount() {
      var n = 0;
      for (var i = 0; i < cars.length; i++) {
        if (cars[i].state !== 'parked') { n++; }
      }
      return n;
    }

    function pickStall() {
      var best = null, bestScore = 1e9;
      for (var i = 0; i < N; i++) {
        var st = stalls[i];
        if (st.truth || st.reserved) { continue; }
        var score = st.col + rng() * 7;   /* prefer the entrance end, loosely */
        if (score < bestScore) { bestScore = score; best = st; }
      }
      return best;
    }

    function spawnArrival() {
      if (movingCount() > 7) { nextArrivalAt = simT + 1.5; return; }
      arrivalLog.push(simT);
      var st = pickStall();
      var car = {
        state: 'arrive', stall: st,
        tone: TONES[Math.floor(rng() * TONES.length)],
        departAt: 0, si: 0, st: 0,
        segs: st ? arrivePath(st) : passPath()
      };
      if (st) { st.reserved = true; st.car = car; }
      else { car.state = 'pass'; }        /* lot full: drive through           */
      cars.push(car);
      nextArrivalAt = simT + sampleGap();
    }

    function fireSegEnd(car, end) {
      var st = car.stall;
      if (end === 'park' && st) {
        car.state = 'parked';
        car.departAt = simT + dwell();
        st.truth = true;
        st.truthAt = simT;
        st.delay = detectDelay();
      } else if (end === 'out' && st) {
        st.truth = false;
        st.truthAt = simT;
        st.delay = detectDelay();
        st.reserved = false;
        st.car = null;
        car.stall = null;
      } else if (end === 'gone') {
        car.state = 'gone';
      }
    }

    function stepSim(dt) {
      simT += dt;

      /* arrivals */
      if (simT >= nextArrivalAt) { spawnArrival(); }
      while (arrivalLog.length && arrivalLog[0] < simT - 60) { arrivalLog.shift(); }

      /* departures, spaced so the lane is not a wall of reversing cars */
      for (var i = 0; i < cars.length; i++) {
        var pc = cars[i];
        if (pc.state === 'parked' && simT >= pc.departAt && simT >= nextDepartFree) {
          pc.state = 'depart';
          pc.segs = departPath(pc.stall);
          pc.si = 0; pc.st = 0;
          nextDepartFree = simT + 1.1;
        }
      }

      /* motion */
      for (var j = cars.length - 1; j >= 0; j--) {
        var c = cars[j];
        if (c.state === 'parked') { continue; }
        c.st += dt;
        while (c.segs && c.si < c.segs.length && c.st >= c.segs[c.si].dur) {
          c.st -= c.segs[c.si].dur;
          fireSegEnd(c, c.segs[c.si].end);
          c.si++;
        }
        if (c.state === 'gone' || (c.segs && c.si >= c.segs.length && c.state !== 'parked')) {
          cars.splice(j, 1);
        }
      }

      senseTick();
    }

    /* ---- drawing --------------------------------------------------------- */

    function labelPx() { return clamp(W / 78, 8, 10); }

    function crisp(v) { return Math.round(v) + 0.5; }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x, y + r, r);
      ctx.closePath();
    }

    function drawLot() {
      var lp = labelPx();

      /* boundary, with entrance / exit gaps at the lane */
      ctx.strokeStyle = ink(0.45);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(lotL, crisp(lotT)); ctx.lineTo(lotR, crisp(lotT));
      ctx.moveTo(lotL, crisp(lotB)); ctx.lineTo(lotR, crisp(lotB));
      ctx.moveTo(crisp(lotL), lotT); ctx.lineTo(crisp(lotL), laneTop);
      ctx.moveTo(crisp(lotL), laneBot); ctx.lineTo(crisp(lotL), lotB);
      ctx.moveTo(crisp(lotR), lotT); ctx.lineTo(crisp(lotR), laneTop);
      ctx.moveTo(crisp(lotR), laneBot); ctx.lineTo(crisp(lotR), lotB);
      ctx.stroke();

      /* stall dividers · zone seams slightly stronger */
      for (var c = 0; c <= COLS; c++) {
        var x = crisp(lotL + c * stallW);
        var seam = (c % ZONE_COLS === 0);
        ctx.strokeStyle = ink(seam ? 0.4 : 0.26);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, lotT); ctx.lineTo(x, laneTop);
        ctx.moveTo(x, laneBot); ctx.lineTo(x, lotB);
        ctx.stroke();
      }

      /* one-way chevrons along the lane */
      ctx.strokeStyle = ink(0.18);
      ctx.lineWidth = 1;
      var chn = 4, sp = (lotR - lotL) / (chn + 1);
      for (var k = 1; k <= chn; k++) {
        var cx2 = lotL + k * sp;
        ctx.beginPath();
        ctx.moveTo(cx2 - 4, laneY - 4);
        ctx.lineTo(cx2 + 2, laneY);
        ctx.lineTo(cx2 - 4, laneY + 4);
        ctx.stroke();
      }

      /* entrance / exit arrows */
      ctx.strokeStyle = ink(0.5);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(lotL - 26, laneY); ctx.lineTo(lotL - 8, laneY);
      ctx.moveTo(lotL - 13, laneY - 4); ctx.lineTo(lotL - 8, laneY);
      ctx.lineTo(lotL - 13, laneY + 4);
      ctx.moveTo(lotR + 8, laneY); ctx.lineTo(lotR + 26, laneY);
      ctx.moveTo(lotR + 21, laneY - 4); ctx.lineTo(lotR + 26, laneY);
      ctx.lineTo(lotR + 21, laneY + 4);
      ctx.stroke();
      tracked('IN', lotL - 8, laneY - 8, lp * 0.9, 0.5, 1);
      tracked('OUT', lotR + 8, laneY - 8, lp * 0.9, 0.5, -1);

      /* stall letters, at the outer end where the car nose stops short */
      for (var i = 0; i < N; i++) {
        var st = stalls[i];
        var y = st.row === 0 ? lotT + lp + 2 : lotB - 4;
        tracked(st.id, stallX(st), y, lp * 0.86, 0.38, 0);
      }
    }

    function drawZones() {
      var lp = labelPx();
      for (var z = 0; z < 3; z++) {
        var x0 = lotL + z * ZONE_COLS * stallW + 3;
        var x1 = lotL + (z + 1) * ZONE_COLS * stallW - 3;
        var off = (z === 1 && !cam2.on);
        var yT = lotT - 8, yB = lotB + 8;

        ctx.strokeStyle = ink(off ? 0.62 : 0.34);
        ctx.lineWidth = 1;
        if (off) { ctx.setLineDash([3, 3]); }
        ctx.beginPath();
        ctx.moveTo(x0, yT + 4); ctx.lineTo(x0, yT); ctx.lineTo(x1, yT); ctx.lineTo(x1, yT + 4);
        ctx.moveTo(x0, yB - 4); ctx.lineTo(x0, yB); ctx.lineTo(x1, yB); ctx.lineTo(x1, yB - 4);
        ctx.stroke();
        ctx.setLineDash([]);

        var label = 'CAM ' + (z + 1);
        if (off) { label += ' · OFFLINE ' + mmss(simT - cam2.downAt); }
        tracked(label, (x0 + x1) / 2, yT - 5, lp * 0.9, off ? 0.75 : 0.42, 0);

        /* stale zone tint, both stall strips */
        if (off) {
          ctx.fillStyle = ink(0.035);
          ctx.fillRect(x0 - 3, lotT, (x1 - x0) + 6, depth);
          ctx.fillRect(x0 - 3, laneBot, (x1 - x0) + 6, depth);
        }
      }

      /* rescan sweep line */
      if (rescan.active) {
        var u = clamp((simT - rescan.t0) / rescan.dur, 0, 1);
        var sx = lotL + ZONE_COLS * stallW + u * ZONE_COLS * stallW;
        ctx.strokeStyle = ink(0.55);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(sx, lotT - 4); ctx.lineTo(sx, lotB + 4);
        ctx.stroke();
      }
    }

    function drawDots() {
      var lp = labelPx();
      for (var i = 0; i < N; i++) {
        var st = stalls[i];
        var x = stallX(st), y = dotY(st);
        var stale = !camOn(st);

        if (stale) {
          /* hollow with a question: the node is not reporting */
          ctx.strokeStyle = ink(0.4);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.stroke();
          tracked('?', x + 6, y + lp * 0.35, lp * 0.82, 0.55, -1);
          continue;
        }

        if (st.sensed) {
          ctx.fillStyle = ink(0.85);
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = ink(0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.stroke();
        }

        /* brief pulse on state change · suppressed in still mode */
        var age = simT - st.pulseAt;
        if (!still && age >= 0 && age < 0.8) {
          var t = age / 0.8;
          ctx.strokeStyle = ink(0.5 * (1 - t));
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, 4 + t * 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    function drawCar(x, y, ang, tone) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      var L = carL, Wc = carW, r = Wc * 0.3;

      ctx.fillStyle = ink(tone);
      roundRect(-L / 2, -Wc / 2, L, Wc, r);
      ctx.fill();
      ctx.strokeStyle = ink(0.85);
      ctx.lineWidth = 1;
      ctx.stroke();

      /* two-tone: lighter roof, darker windshield band toward the nose */
      ctx.fillStyle = ink(tone * 0.5);
      roundRect(-L * 0.3, -Wc * 0.34, L * 0.42, Wc * 0.68, r * 0.6);
      ctx.fill();
      ctx.fillStyle = ink(Math.min(0.92, tone + 0.24));
      ctx.fillRect(L * 0.13, -Wc * 0.34, L * 0.14, Wc * 0.68);

      ctx.restore();
    }

    function drawCars() {
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i];
        if (c.state === 'parked') {
          drawCar(stallX(c.stall), parkY(c.stall), parkAng(c.stall), c.tone);
        } else if (c.segs && c.si < c.segs.length) {
          var g = c.segs[c.si];
          segPos(g, eased(g.ease, c.st / g.dur), pose);
          drawCar(pose.x, pose.y, pose.a, c.tone);
        }
      }
    }

    function drawFooter() {
      var lp = labelPx();
      var free = sensedFree();
      var sign = 'SIGN · FREE ' + free + (cam2.on ? '' : ' · STALE');
      tracked(sign, 8, H - 6, lp, cam2.on ? 0.5 : 0.7, -1);
      tracked('SIMULATED LOT · SENSED STATE VS GROUND TRUTH',
        W - 8, H - 6, lp, 0.34, 1);
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.textBaseline = 'alphabetic';
      drawLot();
      drawZones();
      drawDots();
      drawCars();
      drawFooter();
    }

    /* ---- readouts -------------------------------------------------------- */

    function mmss(sec) {
      var s2 = Math.max(0, Math.floor(sec));
      return Math.floor(s2 / 60) + ':' + ('0' + (s2 % 60)).slice(-2);
    }

    var lastFree = '', lastFlag = '', lastOcc = '', lastArr = '';
    function syncReadout() {
      var free = String(sensedFree());
      var flagTxt = cam2.on ? '' : 'Stale ' + mmss(simT - cam2.downAt);
      var occ = Math.round((N - sensedFree()) / N * 100) + '%';
      var span = Math.max(15, Math.min(60, simT));
      var arr = (arrivalLog.length * 60 / span).toFixed(1);
      if (free !== lastFree) { lastFree = free; freeVal.textContent = free; }
      if (flagTxt !== lastFlag) { lastFlag = flagTxt; freeFlag.textContent = flagTxt; }
      if (occ !== lastOcc) { lastOcc = occ; occVal.textContent = occ; }
      if (arr !== lastArr) { lastArr = arr; arrVal.textContent = arr; }
    }

    function syncDemandText() {
      var word = demandRaw < 25 ? 'Calm'
        : demandRaw < 50 ? 'Steady'
        : demandRaw < 75 ? 'Busy' : 'Rush';
      var rate = perMin.toFixed(1);
      sliderVal.textContent = word + ' · ' + rate + '/min';
      slider.setAttribute('aria-valuetext',
        word + ', about ' + rate + ' arrivals per minute');
    }

    var ariaTimer = null;
    function syncAria() {
      if (ariaTimer) { window.clearTimeout(ariaTimer); }
      ariaTimer = window.setTimeout(function () {
        ariaTimer = null;
        canvas.setAttribute('aria-label',
          'Top-down parking lot simulation. 24 stalls in two rows, three ' +
          'camera zones. ' + sensedFree() + ' stalls read free' +
          (cam2.on ? '. All cameras online.'
                   : '. Camera 2 offline, its zone is stale.') +
          (playing ? '' : ' Simulation paused.'));
      }, 420);
    }

    /* ---- frame loop / lifecycle ------------------------------------------ */

    var rafId = 0, last = 0, visible = true;

    function running() { return playing && visible && !document.hidden; }

    function frame(ts) {
      rafId = 0;
      var dt = last ? (ts - last) / 1000 : 0;
      last = ts;
      if (dt > 0.05) { dt = 0.05; }     /* survive tab switches / long GCs   */
      if (dt < 0) { dt = 0; }
      stepSim(dt);
      draw();
      syncReadout();
      if (running()) { rafId = window.requestAnimationFrame(frame); }
    }

    function start() {
      if (rafId || !running()) { return; }
      last = 0;
      rafId = window.requestAnimationFrame(frame);
    }

    function stop() {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    }

    function setPlaying(p, fromUser) {
      if (fromUser) { userActed = true; }
      if (playing === p) { return; }
      playing = p;
      btnRun.textContent = p ? 'Pause' : 'Run';
      if (p) {
        /* do not bill paused time as staleness or dwell */
        start();
      } else {
        stop();
        draw();
        syncReadout();
      }
      syncAria();
    }

    /* ---- wiring ---------------------------------------------------------- */

    btnRun.addEventListener('click', function () {
      setPlaying(!playing, true);
      if (playing) { announce('Simulation running.'); }
      else { announce('Simulation paused.'); }
    });

    btnCam.addEventListener('click', function () {
      userActed = true;
      setCam2(!cam2.on);
    });

    function readDemand() {
      demandRaw = clamp(parseFloat(slider.value) || 0, 0, 100);
      perMin = ratePerMin();
      nextArrivalAt = Math.min(nextArrivalAt, simT + sampleGap());
      syncDemandText();
      if (!playing) { syncReadout(); }
    }
    slider.addEventListener('input', readDemand);
    slider.addEventListener('change', readDemand);

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) { visible = entries[i].isIntersecting; }
        if (running()) { start(); } else { stop(); }
      }, { rootMargin: '140px' });
      io.observe(root);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); } else { start(); }
    });

    /* motion preference can change live: site toggle flips html.no-motion,
       the OS switch fires the media query. respect it unless the visitor
       already pressed Run themselves. */
    function onMotionChange() {
      var was = still;
      still = isStill();
      if (was === still) { return; }
      if (!userActed) { setPlaying(!still, false); }
      if (!playing) { draw(); }
    }
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (mq) {
      if (mq.addEventListener) { mq.addEventListener('change', onMotionChange); }
      else if (mq.addListener) { mq.addListener(onMotionChange); }
    }
    if (window.MutationObserver) {
      new window.MutationObserver(onMotionChange).observe(document.documentElement, {
        attributes: true, attributeFilter: ['class']
      });
    }

    /* resize: moving cars hold coordinates from the old layout, so they are
       resolved cleanly rather than redrawn mid-manoeuvre at the wrong scale. */
    function settleMovingCars() {
      for (var i = cars.length - 1; i >= 0; i--) {
        var c = cars[i];
        if (c.state === 'parked') { continue; }
        var st = c.stall;
        if (c.state === 'arrive' && st) {
          st.reserved = false; st.car = null;
        } else if (c.state === 'depart' && st) {
          st.truth = false; st.truthAt = simT; st.reserved = false; st.car = null;
        }
        cars.splice(i, 1);
      }
    }

    var resizeTimer = null, lastW = -1, lastH = -1;
    function relayout() {
      readColors();
      wCache = {};
      settleMovingCars();
      layout();
      draw();
      syncReadout();
    }
    function onResize() {
      if (resizeTimer) { window.clearTimeout(resizeTimer); }
      resizeTimer = window.setTimeout(function () {
        resizeTimer = null;
        var w = canvas.clientWidth, h = canvas.clientHeight;
        if (w === lastW && h === lastH) { return; }
        lastW = w; lastH = h;
        relayout();
      }, 160);
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      new window.ResizeObserver(onResize).observe(root);
    }

    /* ---- go -------------------------------------------------------------- */

    readColors();
    layout();
    lastW = canvas.clientWidth;
    lastH = canvas.clientHeight;
    syncDemandText();
    syncReadout();
    syncAria();
    draw();
    if (playing) { start(); }

    /* zero-width container (hidden tab, late fonts) · retry once */
    if (!lastW) {
      window.setTimeout(function () {
        if (canvas.clientWidth) { relayout(); }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { relayout(); }, function () {});
    }
  }

  /* ===========================================================================
     4.  Boot
     ======================================================================== */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-intellipark]');
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
