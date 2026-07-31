/* =============================================================================
   GAIT LAB  --  [data-ks-gait-lab]
   -----------------------------------------------------------------------------
   A side-view, line-drawn quadruped trotting in place on a scrolling ground
   rule, with a Muybridge-style footfall (Hildebrand) diagram underneath.

   HONESTY NOTE
   -------------
   The thigh and calf link lengths, the hip-axis spacing, the body half-width
   and the thigh / calf joint limits used below are the real numbers parsed out
   of Unitree's official go2_description.urdf (unitreerobotics/unitree_ros).
   They are fetched at runtime from /assets/robot-kinematics.json, with the same
   values inlined here as a fallback so the feature never breaks.

   Everything the readout prints is a SIMULATION driven by those numbers. It is
   not telemetry from a real robot, and the on-screen credit says so.

   The URDF gives front-leg limits (FR_*) only, so those are applied to all four
   legs -- stated here rather than quietly glossed over. Trunk depth, the head
   pod and the oblique offset of the far leg pair are drawing decisions, not
   URDF data.

   WHAT IS ACTUALLY MODELLED
   -------------------------
   * Foot trajectories: stance is a straight backward sweep along the ground;
     swing is a cubic Bezier whose end tangents match the stance direction, so
     the foot lifts off and touches down moving backward -- no velocity step.
   * Legs are solved with analytic 2-link IK (law of cosines) and clamped to the
     real URDF joint ranges. The calf limit becomes a reachable hip-to-foot
     distance band; the thigh limit is checked in the body frame and, if hit,
     the leg is re-solved forward from the clamped joint. When a foot cannot
     reach its commanded target the target is drawn as an open cross.
   * Body pitch and heave come from support, not from a canned animation curve:
     vertical support is the contact count, pitch torque is the fore/aft support
     imbalance, and every touchdown adds a small impulse scaled by the foot's
     real vertical closing speed. That is why a trot is smooth and a bound
     pitches, without either being special-cased.

   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksGaitLabLoaded) { return; }
  window.__ksGaitLabLoaded = true;

  /* ===========================================================================
     1.  Kinematics -- real numbers, with an inlined fallback
     ======================================================================== */

  /* Mirrors the "go2" block of /assets/robot-kinematics.json verbatim, so the
     feature is fully functional if the fetch fails (file://, offline, 404...). */
  var FALLBACK = {
    label: 'Unitree Go2',
    links: {
      thigh: 0.213,             /* m -- hip pitch axis to knee axis           */
      calf: 0.213,              /* m -- knee axis to foot                     */
      bodyLengthHalf: 0.1934,   /* m -- trunk centre to hip axis (URDF origin)*/
      bodyWidthHalf: 0.142      /* m -- trunk centre to hip axis, lateral     */
    },
    limits: {
      FR_hip_joint:   { lower: -1.0472, upper: 1.0472,   effort: 23.7 },
      FR_thigh_joint: { lower: -1.5708, upper: 3.4907,   effort: 23.7 },
      FR_calf_joint:  { lower: -2.7227, upper: -0.83776, effort: 45.43 }
    }
  };

  var DATA = FALLBACK;
  var instances = [];
  var fetchStarted = false;

  function loadKinematics() {
    if (fetchStarted || typeof fetch !== 'function') { return; }
    fetchStarted = true;
    /* Absolute path: the site is served at the domain root, so this resolves
       identically from "/" and from "/work/*.html". */
    try {
      fetch('/assets/robot-kinematics.json', { credentials: 'same-origin' })
        .then(function (res) { return res && res.ok ? res.json() : null; })
        .then(function (json) {
          if (!json || !json.go2 || !json.go2.links || !json.go2.links.thigh) { return; }
          DATA = json.go2;
          for (var i = 0; i < instances.length; i++) {
            try { instances[i](); } catch (e) { /* never break the page */ }
          }
        })['catch'](function () { /* keep the inlined fallback */ });
    } catch (e) { /* keep the inlined fallback */ }
  }

  /* ===========================================================================
     2.  Small helpers
     ======================================================================== */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function now() {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }

  function isReduced() {
    return (window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
           document.documentElement.classList.contains('no-motion');
  }

  /* "rgb(11, 11, 12)" / "rgba(...)" -> [11, 11, 12] */
  function parseRGB(str, fallback) {
    if (!str) { return fallback.slice(); }
    var m = String(str).match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
    if (!m) { return fallback.slice(); }
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  /* ===========================================================================
     3.  Gait definitions
     ---------------------------------------------------------------------------
     Leg order is fixed at [LF, RF, LH, RH] -- the same order the footfall
     diagram lists its lanes in. Phase 0 is the instant that foot touches down,
     so a foot is in stance while (cycle + phase) mod 1 < dutyFactor.
     ======================================================================== */

  var GAITS = [
    { id: 'walk',  name: 'Walk',
      phases: [0, 0.5, 0.25, 0.75],
      note: '4-beat · feet lift one at a time',
      need: 3 },
    { id: 'trot',  name: 'Trot',
      phases: [0, 0.5, 0.5, 0],
      note: '2-beat · diagonal pairs',
      need: 2 },
    { id: 'pace',  name: 'Pace',
      phases: [0, 0.5, 0, 0.5],
      note: '2-beat · lateral pairs · rolls, which a side view cannot show',
      need: 2 },
    { id: 'bound', name: 'Bound',
      phases: [0, 0, 0.5, 0.5],
      note: '2-beat · fore pair against hind pair',
      need: 2 }
  ];

  /* near = the left side of the robot, drawn at full weight. The right pair is
     drawn lighter and obliquely offset so trot and pace are distinguishable --
     in a true flat side view they would be identical. */
  var LEGS = [
    { id: 'LF', label: 'Left fore',  front: true,  near: true  },
    { id: 'RF', label: 'Right fore', front: true,  near: false },
    { id: 'LH', label: 'Left hind',  front: false, near: true  },
    { id: 'RH', label: 'Right hind', front: false, near: false }
  ];

  /* ===========================================================================
     4.  Control definitions
     ---------------------------------------------------------------------------
     Range inputs are integer-valued so no float-step rounding can creep in;
     `scale` converts the raw value to the working unit.
     ======================================================================== */

  var CONTROLS = [
    { key: 'freq', label: 'Stride frequency',
      min: 50, max: 350, step: 5, init: 180,
      unit: 'Hz', dp: 2, k: 0.01, spoken: 'hertz' },
    { key: 'duty', label: 'Duty factor',
      min: 20, max: 80, step: 1, init: 50,
      unit: '', dp: 2, k: 0.01, spoken: '' },
    { key: 'step', label: 'Step height',
      min: 20, max: 90, step: 1, init: 45,
      unit: 'mm', dp: 0, k: 1, spoken: 'millimetres' },
    { key: 'body', label: 'Body height',
      min: 160, max: 340, step: 2, init: 270,
      unit: 'mm', dp: 0, k: 1, spoken: 'millimetres' }
  ];

  /* ===========================================================================
     5.  Physics constants (a deliberately small sagittal-plane model)
     ======================================================================== */

  var G_ACC  = 9.81;   /* m/s^2                                               */
  var K_HEAVE = 300;   /* body height spring                                  */
  var C_HEAVE = 20;    /* body height damping                                 */
  var K_PITCH = 13.2;  /* torque per unit fore/aft support imbalance          */
  var S_PITCH = 120;   /* attitude controller stiffness                       */
  var C_PITCH = 9;     /* attitude damping                                    */

  var TRUNK_HALF_DEPTH = 0.056; /* m -- drawn, not URDF                       */
  var HEAD_LEN         = 0.085; /* m -- drawn, not URDF                       */
  var OBLIQUE_X        = 0.13;  /* far pair offset, as a fraction of the      */
  var OBLIQUE_Y        = -0.15; /* body width -- a drawing decision           */

  var CHART_CYCLES = 3;         /* width of the scrolling footfall window     */

  /* Trunk profile in units of (bodyLengthHalf, TRUNK_HALF_DEPTH), +x forward,
     +y down. The chamfered slab that reads as a Go2 from the side. */
  var TRUNK = [
    [-1.00, -0.52], [-0.88, -1.00], [0.60, -1.00], [0.94, -0.68],
    [1.00, -0.10], [0.96, 0.68], [0.74, 1.00], [-0.82, 1.00], [-1.00, 0.52]
  ];

  var uid = 0;

  /* ===========================================================================
     6.  Instance
     ======================================================================== */

  function mount(root) {
    if (root.__ksGaitLab) { return; }
    root.__ksGaitLab = true;
    uid++;

    var ns = 'ks-gait-lab-' + uid;

    /* ---- state ---------------------------------------------------------- */

    var gait = GAITS[1];                       /* trot by default            */
    var requested = (root.getAttribute('data-ks-gait-lab') || '').toLowerCase();
    for (var gi = 0; gi < GAITS.length; gi++) {
      if (GAITS[gi].id === requested) { gait = GAITS[gi]; }
    }

    var raw = {};                              /* raw slider values          */
    for (var ci = 0; ci < CONTROLS.length; ci++) { raw[CONTROLS[ci].key] = CONTROLS[ci].init; }

    var freq = 1.8, duty = 0.5, stepH = 0.045, bodyH = 0.27;
    var strideFoot = 0.28, strideLen = 0.56, speed = 1.0;

    /* derived from the URDF, refreshed by refreshKinematics() */
    var L1 = 0.213, L2 = 0.213, HALF = 0.1934, WHALF = 0.142;
    var D_MIN = 0.0886, D_MAX = 0.3892;
    var THIGH_LO = -1.5708, THIGH_HI = 3.4907;

    /* body state */
    var cycle = 0;          /* cycles elapsed, unbounded float                */
    var drop = 0, dropV = 0;/* m, positive = sagged downward                  */
    var pitch = 0, pitchV = 0; /* rad, positive = nose up                     */
    var scroll = 0;         /* px of ground ruler travel, wrapped            */

    var phase = [0, 0, 0, 0];
    var contact = [false, false, false, false];
    var wasStance = [false, false, false, false];
    var sagX = [0, 0, 0, 0];   /* foot x in the body frame, metres           */
    var sol = [];
    for (var si = 0; si < 4; si++) {
      sol.push({ hx: 0, hy: 0, kx: 0, ky: 0, fx: 0, fy: 0, tx: 0, ty: 0, clamped: false });
    }

    var nContact = 4, minContact = 4, anyClamped = false;

    /* ---- DOM ------------------------------------------------------------ */

    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-gait-lab');
    if (root.hasAttribute('data-ks-gait-lab-dark')) {
      root.classList.add('ks-gait-lab-on-dark');
    }

    var head = el('div', 'ks-gait-lab-head');
    head.appendChild(el('p', 'ks-gait-lab-eyebrow', 'Gait lab · kinematic simulation'));
    head.appendChild(el('p', 'ks-gait-lab-credit', 'Link lengths from Unitree Go2 URDF'));
    root.appendChild(head);

    var body = el('div', 'ks-gait-lab-body');

    var stage = el('div', 'ks-gait-lab-stage');
    var stageCanvas = el('canvas', 'ks-gait-lab-canvas');
    stageCanvas.setAttribute('role', 'img');
    stageCanvas.setAttribute('aria-label',
      'Side view line drawing of a quadruped robot with Unitree Go2 link proportions.');
    stage.appendChild(stageCanvas);
    body.appendChild(stage);

    var panel = el('div', 'ks-gait-lab-panel');

    /* --- gait pills (a real radio group: arrow keys work for free) -------- */
    var fs = el('fieldset', 'ks-gait-lab-field');
    var lg = el('legend', 'ks-gait-lab-legend', 'Gait');
    fs.appendChild(lg);
    var pills = el('div', 'ks-gait-lab-pills');
    var radios = [];
    for (var pi = 0; pi < GAITS.length; pi++) {
      (function (g) {
        var lab = el('label', 'ks-gait-lab-pill');
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = ns + '-gait';
        input.value = g.id;
        input.className = 'ks-gait-lab-sr';
        input.checked = (g === gait);
        var span = el('span', null, g.name);
        lab.appendChild(input);
        lab.appendChild(span);
        pills.appendChild(lab);
        radios.push(input);
        input.addEventListener('change', function () {
          if (!input.checked) { return; }
          gait = g;
          onControlChange();
        });
      }(GAITS[pi]));
    }
    fs.appendChild(pills);
    var gaitNote = el('p', 'ks-gait-lab-note', gait.note);
    fs.appendChild(gaitNote);
    panel.appendChild(fs);

    /* --- sliders --------------------------------------------------------- */
    var valSpans = {};
    var inputs = {};
    for (var qi = 0; qi < CONTROLS.length; qi++) {
      (function (c) {
        var wrap = el('div', 'ks-gait-lab-slider');
        var row = el('div', 'ks-gait-lab-sliderhead');
        var lab = el('label', 'ks-gait-lab-legend', c.label);
        var id = ns + '-' + c.key;
        lab.setAttribute('for', id);
        var val = el('span', 'ks-gait-lab-val');
        val.setAttribute('aria-hidden', 'true');
        row.appendChild(lab);
        row.appendChild(val);

        var input = document.createElement('input');
        input.type = 'range';
        input.id = id;
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        input.value = String(c.init);
        input.className = 'ks-gait-lab-range';

        wrap.appendChild(row);
        wrap.appendChild(input);
        panel.appendChild(wrap);

        valSpans[c.key] = val;
        inputs[c.key] = input;

        function read() {
          raw[c.key] = parseFloat(input.value);
          onControlChange();
        }
        input.addEventListener('input', read);
        input.addEventListener('change', read);
      }(CONTROLS[qi]));
    }

    body.appendChild(panel);
    root.appendChild(body);

    /* --- footfall diagram ------------------------------------------------ */
    var chart = el('div', 'ks-gait-lab-chart');
    var chartHead = el('div', 'ks-gait-lab-charthead');
    chartHead.appendChild(el('p', 'ks-gait-lab-legend', 'Footfall diagram'));
    var key = el('p', 'ks-gait-lab-key');
    var kA = el('span', 'ks-gait-lab-sw ks-gait-lab-sw-fill');
    kA.setAttribute('aria-hidden', 'true');
    key.appendChild(kA);
    key.appendChild(el('span', null, 'Stance'));
    var kB = el('span', 'ks-gait-lab-sw');
    kB.setAttribute('aria-hidden', 'true');
    key.appendChild(kB);
    key.appendChild(el('span', null, 'Swing'));
    chartHead.appendChild(key);
    chart.appendChild(chartHead);

    var chartCanvas = el('canvas', 'ks-gait-lab-plot');
    chartCanvas.setAttribute('role', 'img');
    chartCanvas.setAttribute('aria-label', 'Footfall diagram.');
    chart.appendChild(chartCanvas);
    root.appendChild(chart);

    /* --- readout --------------------------------------------------------- */
    var readout = el('div', 'ks-gait-lab-readout');
    var cells = {};
    var CELL_DEFS = [
      ['duty', 'Duty'], ['stance', 'Stance'], ['swing', 'Swing'],
      ['stride', 'Stride'], ['speed', 'Speed']
    ];
    for (var di = 0; di < CELL_DEFS.length; di++) {
      var cell = el('span', 'ks-gait-lab-cell');
      cell.appendChild(el('span', 'ks-gait-lab-cellkey', CELL_DEFS[di][1]));
      var b = el('b', 'ks-gait-lab-cellval', '··');
      cell.appendChild(b);
      readout.appendChild(cell);
      cells[CELL_DEFS[di][0]] = b;
    }
    var flag = el('p', 'ks-gait-lab-flag');
    flag.setAttribute('aria-hidden', 'true');   /* churns per frame          */
    readout.appendChild(flag);
    root.appendChild(readout);

    /* Debounced, settled description for assistive tech -- the visible
       readout churns far too fast to live-announce. */
    var status = el('p', 'ks-gait-lab-sr');
    status.setAttribute('role', 'status');
    root.appendChild(status);

    /* ---- canvas plumbing ------------------------------------------------ */

    var sctx = stageCanvas.getContext ? stageCanvas.getContext('2d') : null;
    var cctx = chartCanvas.getContext ? chartCanvas.getContext('2d') : null;
    if (!sctx || !cctx) { return; }

    var dpr = 1;
    var SW = 0, SH = 0, CW = 0, CH = 0;
    var scale = 500, originX = 0, groundY = 0;
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

    /* ---- tracked micro-label text on canvas ----------------------------- */
    /* Canvas letterSpacing is not universally supported and the micro-label
       look depends on it, so characters are placed by hand. Widths are memoised
       against a bounded key set (a handful of sizes, ~45 glyphs). */
    var wCache = {};
    function charW(ch, size, weight) {
      var k = size + '|' + weight + '|' + ch;
      var v = wCache[k];
      if (v === undefined) {
        sctx.font = weight + ' ' + size + 'px ' + FAMILY;
        v = sctx.measureText(ch).width;
        wCache[k] = v;
      }
      return v;
    }
    function trackedWidth(str, size, weight, trEm) {
      var tr = size * trEm, w = 0;
      for (var i = 0; i < str.length; i++) { w += charW(str.charAt(i), size, weight) + tr; }
      return w - tr;
    }
    /* align: -1 left, 0 centre, 1 right */
    function tracked(ctx, str, x, y, size, weight, alpha, trEm, align) {
      ctx.font = weight + ' ' + size + 'px ' + FAMILY;
      ctx.fillStyle = ink(alpha);
      var tr = size * trEm;
      var w = trackedWidth(str, size, weight, trEm);
      var cx = align === 1 ? x - w : (align === 0 ? x - w / 2 : x);
      for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        ctx.fillText(ch, cx, y);
        cx += charW(ch, size, weight) + tr;
      }
      return w;
    }

    /* ===========================================================================
       7.  Kinematics -- derived constants and the IK
       ======================================================================== */

    function refreshKinematics() {
      var lk = (DATA && DATA.links) || FALLBACK.links;
      var lm = (DATA && DATA.limits) || FALLBACK.limits;
      L1 = lk.thigh || 0.213;
      L2 = lk.calf || 0.213;
      HALF = lk.bodyLengthHalf || 0.1934;
      WHALF = lk.bodyWidthHalf || 0.142;

      var calf = lm.FR_calf_joint || FALLBACK.limits.FR_calf_joint;
      var thigh = lm.FR_thigh_joint || FALLBACK.limits.FR_thigh_joint;
      THIGH_LO = thigh.lower;
      THIGH_HI = thigh.upper;

      /* The URDF calf angle is the knee's deviation from straight, so the
         interior knee angle is PI + q. Turning that band into a reachable
         hip-to-foot distance band is exactly the calf joint limit, expressed
         in the space the IK works in. */
      var gLo = Math.PI + calf.lower;    /* most folded   */
      var gHi = Math.PI + calf.upper;    /* most extended */
      D_MIN = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(gLo));
      D_MAX = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(gHi));
    }
    refreshKinematics();

    /* Analytic 2-link IK in canvas space (x right, y down), followed by a
       joint-limit pass in the body frame.

       fx/fy = body forward unit, dx/dy = body down unit. The knee-behind branch
       is the only one Unitree's leg can fold into: the URDF calf angle is
       negative on all four legs, so the knee always sits behind the hip-to-foot
       line when the robot faces +x. */
    function solveLeg(o, hx, hy, tx, ty, fxu, fyu, dxu, dyu) {
      o.hx = hx; o.hy = hy; o.tx = tx; o.ty = ty;
      o.clamped = false;

      var vx = tx - hx, vy = ty - hy;
      var d = Math.sqrt(vx * vx + vy * vy);
      var ux, uy;
      if (d < 1e-6) { ux = dxu; uy = dyu; d = 1e-6; } else { ux = vx / d; uy = vy / d; }

      var dc = clamp(d, D_MIN, D_MAX);        /* calf joint limit             */
      if (Math.abs(dc - d) > 1e-5) { o.clamped = true; }
      d = dc;

      var base = Math.atan2(uy, ux);
      var ca = clamp((d * d + L1 * L1 - L2 * L2) / (2 * d * L1), -1, 1);
      var th = base + Math.acos(ca);

      var kdx = Math.cos(th), kdy = Math.sin(th);

      /* Thigh angle in the body frame: measured from body-down, positive
         rotates the knee rearward. Matches the URDF sign convention -- the
         nominal Go2 stand (thigh 0.9, calf -1.8) reproduces exactly this. */
      var qt = Math.atan2(-(kdx * fxu + kdy * fyu), kdx * dxu + kdy * dyu);
      var qc = clamp(qt, THIGH_LO, THIGH_HI);

      if (Math.abs(qc - qt) > 1e-6) {
        /* Thigh limit hit: keep the knee bend the IK asked for and re-solve
           forward from the clamped joint. The foot then falls short of the
           commanded target, which is what a real leg does. */
        o.clamped = true;
        var cq = Math.cos(qc), sq = Math.sin(qc);
        kdx = dxu * cq - fxu * sq;
        kdy = dyu * cq - fyu * sq;
        var cg = clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
        var beta = Math.PI - Math.acos(cg);           /* knee bend           */
        var cb = Math.cos(-beta), sb = Math.sin(-beta);
        o.kx = hx + kdx * L1 * scale;
        o.ky = hy + kdy * L1 * scale;
        o.fx = o.kx + (kdx * cb - kdy * sb) * L2 * scale;
        o.fy = o.ky + (kdx * sb + kdy * cb) * L2 * scale;
        return;
      }

      o.kx = hx + kdx * L1 * scale;
      o.ky = hy + kdy * L1 * scale;
      o.fx = hx + ux * d * scale;
      o.fy = hy + uy * d * scale;
    }

    /* Swing trajectory, in metres relative to the leg's neutral stance point.
       A cubic Bezier whose first and last control legs point backward, so the
       foot leaves and lands moving with the stance sweep -- continuous velocity
       at both liftoff and touchdown. Apex height works out to ~0.99 * stepH. */
    var bez = { x0: 0, y0: 0, x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0 };
    function swingCtrl() {
      var s = strideFoot, h = stepH;
      bez.x0 = -s * 0.5;      bez.y0 = 0;
      bez.x1 = -s * 0.5 - s * 0.10; bez.y1 = h * 1.32;
      bez.x2 =  s * 0.5 + s * 0.10; bez.y2 = h * 1.32;
      bez.x3 =  s * 0.5;      bez.y3 = 0;
    }
    function bezAt(t, out) {
      var m = 1 - t, a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
      out.x = a * bez.x0 + b * bez.x1 + c * bez.x2 + d * bez.x3;
      out.y = a * bez.y0 + b * bez.y1 + c * bez.y2 + d * bez.y3;
    }
    var bp = { x: 0, y: 0 };

    /* ===========================================================================
       8.  Derived quantities
       ======================================================================== */

    function recompute() {
      freq  = raw.freq * 0.01;
      duty  = raw.duty * 0.01;
      stepH = raw.step / 1000;
      bodyH = raw.body / 1000;

      /* Foot excursion is a geometric quantity, not a free parameter: it is
         bounded by how far the foot can travel fore/aft at the commanded body
         height without running the leg out to full extension. Raising the body
         therefore shortens the stride, which is the real trade-off. */
      var comfort = D_MAX * 0.95;
      var reach = Math.sqrt(Math.max(0, comfort * comfort - bodyH * bodyH));
      strideFoot = Math.min(0.34, 2 * reach * 0.56);

      /* A non-slipping stance foot travels the full body displacement, so the
         body covers strideFoot during a stance of duty/freq seconds. */
      strideLen = strideFoot / duty;
      speed = strideLen * freq;

      swingCtrl();

      /* Minimum feet in contact anywhere in the cycle -- sampled once per
         control change, not per frame. */
      minContact = 4;
      for (var s = 0; s < 240; s++) {
        var c = s / 240, n = 0;
        for (var i = 0; i < 4; i++) {
          var p = (c + gait.phases[i]) % 1;
          if (p < duty) { n++; }
        }
        if (n < minContact) { minContact = n; }
      }
    }

    /* ===========================================================================
       9.  Simulation step
       ======================================================================== */

    function stepSim(dt) {
      var i, leg, p, u, sweep;

      cycle += dt * freq;
      if (cycle > 1e6) { cycle -= 1e6; }

      var frontSup = 0, rearSup = 0;
      nContact = 0;

      /* Foot vertical closing speed at touchdown, straight off the Bezier:
         dP/dt at t=1 is 3*(P3 - P2), rescaled into seconds. */
      var vTD = 3 * (bez.y2 - bez.y3) * (freq / Math.max(0.05, 1 - duty));
      var imp = clamp(vTD * 0.13, 0, 0.55);

      for (i = 0; i < 4; i++) {
        leg = LEGS[i];
        p = (cycle + gait.phases[i]) % 1;
        phase[i] = p;
        var stance = p < duty;
        contact[i] = stance;

        if (stance) {
          u = p / duty;
          sweep = strideFoot * 0.5 - strideFoot * u;
          sagX[i] = (leg.front ? HALF : -HALF) + sweep;
          footY[i] = 0;
        } else {
          u = (p - duty) / Math.max(1e-4, 1 - duty);
          bezAt(u, bp);
          sagX[i] = (leg.front ? HALF : -HALF) + bp.x;
          footY[i] = bp.y;
        }

        if (stance) {
          nContact++;
          if (leg.front) { frontSup++; } else { rearSup++; }
          if (!wasStance[i] && dt > 0) {
            /* Touchdown impulse: the body absorbs the landing. Front and rear
               impulses have opposite pitch sign, which is why a trot (both at
               once) stays level and a bound does not. */
            dropV += imp;
            pitchV += (leg.front ? -1 : 1) * imp * 2.6;
          }
        }
        wasStance[i] = stance;
      }

      /* Vertical: two legs are enough to hold the weight; fewer and the body
         starts falling at g. */
      var support = clamp(nContact / 2, 0, 1);
      var accY = G_ACC * (1 - support) - K_HEAVE * drop - C_HEAVE * dropV;
      dropV += accY * dt;
      drop += dropV * dt;
      var dropMax = Math.min(0.11, bodyH - 0.10);
      if (drop > dropMax) { drop = dropMax; if (dropV > 0) { dropV = 0; } }
      if (drop < -0.05) { drop = -0.05; if (dropV < 0) { dropV = 0; } }

      /* Pitch: torque from the fore/aft support imbalance against an attitude
         controller that is always trying to level the body. */
      var imbalance = (frontSup - rearSup) / 2;
      var accP = K_PITCH * imbalance - S_PITCH * pitch - C_PITCH * pitchV;
      pitchV += accP * dt;
      pitch += pitchV * dt;
      if (pitch > 0.40) { pitch = 0.40; pitchV = 0; }
      if (pitch < -0.40) { pitch = -0.40; pitchV = 0; }

      scroll += speed * scale * dt;
    }
    var footY = [0, 0, 0, 0];   /* foot height above ground, metres */

    /* The reduced-motion pose: leg LF parked at its swing apex, which is the
       single most legible instant, with the body at its static equilibrium.
       Phase offset 0 belongs to LF in every gait, so this reads correctly for
       all four. */
    function staticPose() {
      cycle = (1 + duty) / 2;
      var i, leg, p, u, frontSup = 0, rearSup = 0;
      nContact = 0;
      for (i = 0; i < 4; i++) {
        leg = LEGS[i];
        p = (cycle + gait.phases[i]) % 1;
        phase[i] = p;
        var stance = p < duty;
        contact[i] = stance;
        wasStance[i] = stance;
        if (stance) {
          u = p / duty;
          sagX[i] = (leg.front ? HALF : -HALF) + strideFoot * 0.5 - strideFoot * u;
          footY[i] = 0;
          nContact++;
          if (leg.front) { frontSup++; } else { rearSup++; }
        } else {
          u = (p - duty) / Math.max(1e-4, 1 - duty);
          bezAt(u, bp);
          sagX[i] = (leg.front ? HALF : -HALF) + bp.x;
          footY[i] = bp.y;
        }
      }
      var support = clamp(nContact / 2, 0, 1);
      drop = G_ACC * (1 - support) / K_HEAVE;   /* spring equilibrium         */
      drop = clamp(drop, -0.05, Math.min(0.11, bodyH - 0.10));
      dropV = 0;
      pitch = K_PITCH * ((frontSup - rearSup) / 2) / S_PITCH;
      pitchV = 0;
    }

    /* ===========================================================================
       10.  Layout
       ======================================================================== */

    function sizeCanvas(canvas, ctx) {
      var w = canvas.clientWidth || canvas.parentNode.clientWidth || 320;
      var h = canvas.clientHeight || 200;
      dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2   */
      var pw = Math.max(1, Math.round(w * dpr));
      var ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw) { canvas.width = pw; }
      if (canvas.height !== ph) { canvas.height = ph; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [w, h];
    }

    function layout() {
      var s = sizeCanvas(stageCanvas, sctx);
      SW = s[0]; SH = s[1];
      var c = sizeCanvas(chartCanvas, cctx);
      CW = c[0]; CH = c[1];

      groundY = Math.round(SH * 0.82);
      var vBudget = groundY - 20;
      var vNeed = 0.34 + TRUNK_HALF_DEPTH + 0.03;                 /* metres   */
      var hNeed = 2 * HALF + HEAD_LEN + 0.34;                     /* metres   */
      scale = Math.min(vBudget / vNeed, (SW * 0.72) / hNeed);
      scale = clamp(scale, 110, 900);
      originX = Math.round(SW * 0.48);
    }

    /* ===========================================================================
       11.  Stage drawing
       ======================================================================== */

    function labelPx() { return clamp(SW / 78, 8.5, 10.5); }

    function drawStage() {
      var ctx = sctx, i, leg, o;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SW, SH);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.textBaseline = 'alphabetic';

      var obX = WHALF * 2 * OBLIQUE_X * scale;
      var obY = WHALF * 2 * OBLIQUE_Y * scale;

      /* --- ground rules ------------------------------------------------- */
      ctx.strokeStyle = ink(0.20);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, groundY + obY);
      ctx.lineTo(SW, groundY + obY);
      ctx.stroke();

      drawRuler(ctx);

      ctx.strokeStyle = ink(0.55);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, groundY);
      ctx.lineTo(SW, groundY);
      ctx.stroke();

      /* --- body frame ---------------------------------------------------- */
      var fxu = Math.cos(pitch), fyu = -Math.sin(pitch);   /* forward unit    */
      var dxu = -fyu, dyu = fxu;                           /* down unit       */
      var cx = originX;
      var cy = groundY - (bodyH - drop) * scale;

      /* --- solve all four legs ------------------------------------------- */
      anyClamped = false;
      for (i = 0; i < 4; i++) {
        leg = LEGS[i];
        var sgn = leg.front ? 1 : -1;
        var ox = leg.near ? 0 : obX;
        var oy = leg.near ? 0 : obY;
        var hx = cx + fxu * HALF * sgn * scale + ox;
        var hy = cy + fyu * HALF * sgn * scale + oy;
        var tx = cx + sagX[i] * scale + ox;
        var ty = groundY - footY[i] * scale + oy;
        solveLeg(sol[i], hx, hy, tx, ty, fxu, fyu, dxu, dyu);
        if (sol[i].clamped) { anyClamped = true; }
      }

      /* --- far pair (behind the trunk) ----------------------------------- */
      for (i = 0; i < 4; i++) {
        if (LEGS[i].near) { continue; }
        drawTrace(ctx, i, obX, obY, 0.10);
        drawLeg(ctx, i, 0.34, 1.1);
      }

      /* --- trunk: punch a hole so the far legs read as behind it ---------- */
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      trunkPath(ctx, cx, cy, fxu, fyu, dxu, dyu);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = ink(0.92);
      ctx.lineWidth = 1.7;
      trunkPath(ctx, cx, cy, fxu, fyu, dxu, dyu);
      ctx.stroke();
      drawHead(ctx, cx, cy, fxu, fyu, dxu, dyu);

      /* --- near pair ------------------------------------------------------ */
      for (i = 0; i < 4; i++) {
        if (!LEGS[i].near) { continue; }
        drawTrace(ctx, i, 0, 0, 0.20);
        drawLeg(ctx, i, 0.92, 1.9);
      }

      drawAnnotations(ctx, cx, cy, fxu, fyu, dxu, dyu);
    }

    function bodyPt(ctx, cx, cy, fxu, fyu, dxu, dyu, ax, ay, out) {
      out.x = cx + fxu * ax * scale + dxu * ay * scale;
      out.y = cy + fyu * ax * scale + dyu * ay * scale;
    }
    var pt = { x: 0, y: 0 };

    function trunkPath(ctx, cx, cy, fxu, fyu, dxu, dyu) {
      ctx.beginPath();
      for (var i = 0; i < TRUNK.length; i++) {
        bodyPt(ctx, cx, cy, fxu, fyu, dxu, dyu,
          TRUNK[i][0] * HALF, TRUNK[i][1] * TRUNK_HALF_DEPTH, pt);
        if (i === 0) { ctx.moveTo(pt.x, pt.y); } else { ctx.lineTo(pt.x, pt.y); }
      }
      ctx.closePath();
    }

    function drawHead(ctx, cx, cy, fxu, fyu, dxu, dyu) {
      var head = [
        [HALF, -TRUNK_HALF_DEPTH * 0.66],
        [HALF + HEAD_LEN, -TRUNK_HALF_DEPTH * 0.50],
        [HALF + HEAD_LEN, TRUNK_HALF_DEPTH * 0.30],
        [HALF, TRUNK_HALF_DEPTH * 0.34]
      ];
      ctx.strokeStyle = ink(0.92);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (var i = 0; i < head.length; i++) {
        bodyPt(ctx, cx, cy, fxu, fyu, dxu, dyu, head[i][0], head[i][1], pt);
        if (i === 0) { ctx.moveTo(pt.x, pt.y); } else { ctx.lineTo(pt.x, pt.y); }
      }
      ctx.stroke();

      /* L1 lidar dome */
      bodyPt(ctx, cx, cy, fxu, fyu, dxu, dyu,
        HALF + HEAD_LEN * 0.40, -TRUNK_HALF_DEPTH * 0.66 - HEAD_LEN * 0.16, pt);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(2, HEAD_LEN * 0.17 * scale), Math.PI, Math.PI * 2);
      ctx.stroke();
    }

    function drawLeg(ctx, i, alpha, lw) {
      var o = sol[i];
      ctx.strokeStyle = ink(alpha);
      ctx.fillStyle = ink(alpha);
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(o.hx, o.hy);
      ctx.lineTo(o.kx, o.ky);
      ctx.lineTo(o.fx, o.fy);
      ctx.stroke();

      ctx.lineWidth = 1;
      circle(ctx, o.hx, o.hy, lw * 1.7, false);
      circle(ctx, o.kx, o.ky, lw * 1.35, false);
      circle(ctx, o.fx, o.fy, lw * 1.3, !!contact[i]);

      if (contact[i]) {
        ctx.beginPath();
        ctx.moveTo(o.fx - lw * 3.2, o.fy + lw * 2.2);
        ctx.lineTo(o.fx + lw * 3.2, o.fy + lw * 2.2);
        ctx.stroke();
      }

      /* Commanded target the joint limits would not let the foot reach. */
      if (o.clamped) {
        var r = Math.max(3, lw * 2.2);
        ctx.strokeStyle = ink(alpha * 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(o.tx - r, o.ty); ctx.lineTo(o.tx + r, o.ty);
        ctx.moveTo(o.tx, o.ty - r); ctx.lineTo(o.tx, o.ty + r);
        ctx.stroke();
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(o.fx, o.fy);
        ctx.lineTo(o.tx, o.ty);
        ctx.stroke();
        ctx.restore();
      }
    }

    function circle(ctx, x, y, r, filled) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (filled) { ctx.fill(); } else { ctx.stroke(); }
    }

    /* The swing path, stroked as the very Bezier the foot is following. */
    function drawTrace(ctx, i, ox, oy, alpha) {
      var nx = originX + (LEGS[i].front ? HALF : -HALF) * scale + ox;
      var gy = groundY + oy;
      ctx.strokeStyle = ink(alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(nx + bez.x0 * scale, gy - bez.y0 * scale);
      ctx.bezierCurveTo(
        nx + bez.x1 * scale, gy - bez.y1 * scale,
        nx + bez.x2 * scale, gy - bez.y2 * scale,
        nx + bez.x3 * scale, gy - bez.y3 * scale);
      ctx.stroke();
    }

    /* Ground ruler: ticks scroll leftward at the derived speed, so the number
       in the SPEED readout is something you can watch. Tick spacing steps up
       as the speed rises so the rule never strobes. */
    function drawRuler(ctx) {
      var tickM = 0.1, px = tickM * scale;
      var STEPS = [0.1, 0.25, 0.5, 1];
      for (var k = 0; k < STEPS.length; k++) {
        tickM = STEPS[k]; px = tickM * scale;
        var perSec = speed * scale;
        if (px >= 26 && (perSec / px) < 14) { break; }
      }
      var off = scroll % px;
      if (off < 0) { off += px; }
      var alpha = clamp(0.30 - (speed * scale) / 9000, 0.10, 0.30);
      ctx.strokeStyle = ink(alpha);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var x = -off; x < SW + px; x += px) {
        ctx.moveTo(Math.round(x) + 0.5, groundY + 1);
        ctx.lineTo(Math.round(x) + 0.5, groundY + 6);
      }
      ctx.stroke();
      var lp = labelPx();
      tracked(ctx, 'TICK ' + Math.round(tickM * 1000) + ' MM',
        8, groundY + 6 + lp * 1.9, lp, 600, 0.42, 0.2, -1);
    }

    /* Dimension leaders. Only URDF-derived numbers are drawn as dimensions;
       the model figures are labelled as such. */
    function drawAnnotations(ctx, cx, cy, fxu, fyu, dxu, dyu) {
      var lp = labelPx();
      var lf = sol[0];   /* left fore -- the near front leg */
      var lh = sol[2];   /* left hind -- the near rear leg  */

      ctx.strokeStyle = ink(0.30);
      ctx.lineWidth = 1;

      /* thigh + calf, on the near front leg */
      leader(ctx, (lf.hx + lf.kx) / 2, (lf.hy + lf.ky) / 2,
        Math.round(L1 * 1000) + ' MM THIGH', 1, lp);
      leader(ctx, (lf.kx + lf.fx) / 2, (lf.ky + lf.fy) / 2,
        Math.round(L2 * 1000) + ' MM CALF', 1, lp);

      /* commanded body height, at the rear */
      var bx = lh.hx - HALF * 0.55 * scale;
      ctx.strokeStyle = ink(0.24);
      ctx.beginPath();
      ctx.moveTo(bx, lh.hy);
      ctx.lineTo(bx, groundY);
      ctx.moveTo(bx - 4, lh.hy); ctx.lineTo(bx + 4, lh.hy);
      ctx.moveTo(bx - 4, groundY); ctx.lineTo(bx + 4, groundY);
      ctx.stroke();
      tracked(ctx, Math.round(bodyH * 1000) + ' MM BODY',
        bx - 7, (lh.hy + groundY) / 2 + lp * 0.36, lp, 600, 0.45, 0.2, 1);

      /* step height, measured on the drawn swing apex */
      var apexX = originX + HALF * scale;
      var apexY = groundY - stepH * scale;
      ctx.strokeStyle = ink(0.22);
      ctx.beginPath();
      ctx.moveTo(apexX - strideFoot * 0.5 * scale - 10, apexY);
      ctx.lineTo(apexX + strideFoot * 0.5 * scale + 14, apexY);
      ctx.stroke();
      tracked(ctx, Math.round(stepH * 1000) + ' MM STEP',
        apexX + strideFoot * 0.5 * scale + 18, apexY + lp * 0.36, lp, 600, 0.45, 0.2, -1);

      /* provenance, bottom right */
      tracked(ctx, 'URDF LINKS + JOINT LIMITS · SIMULATED MOTION',
        SW - 8, SH - 6, lp, 600, 0.34, 0.2, 1);
    }

    function leader(ctx, x, y, text, dir, lp) {
      var lx = x + 13 * dir, ly = y - 9;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(lx, ly);
      ctx.lineTo(lx + 9 * dir, ly);
      ctx.stroke();
      tracked(ctx, text, lx + 12 * dir, ly + lp * 0.36, lp, 600, 0.5, 0.2, dir === 1 ? -1 : 1);
    }

    /* ===========================================================================
       12.  Footfall diagram
       ======================================================================== */

    function drawChart(reduced) {
      var ctx = cctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, CW, CH);
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';

      var lp = labelPx();
      var padT = 4, axisH = Math.round(lp * 2.1), gap = 4, gutter = Math.max(26, lp * 3.1);
      var x0 = gutter + 6, x1 = CW - 6;
      var plotW = Math.max(10, x1 - x0);
      var laneH = Math.max(8, (CH - padT - axisH - gap * 3) / 4);

      var win = reduced ? 1 : CHART_CYCLES;
      var cEnd = reduced ? 1 : cycle;
      var cStart = cEnd - win;

      function xOf(c) { return x0 + ((c - cStart) / win) * plotW; }

      for (var i = 0; i < 4; i++) {
        var top = padT + i * (laneH + gap);
        var barH = Math.max(5, laneH - 5);
        var barY = top + (laneH - barH) / 2;

        /* lane bed + baseline */
        ctx.fillStyle = ink(0.045);
        ctx.fillRect(x0, barY, plotW, barH);
        ctx.strokeStyle = ink(0.16);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(barY + barH) + 0.5);
        ctx.lineTo(x1, Math.round(barY + barH) + 0.5);
        ctx.stroke();

        /* lane label */
        tracked(ctx, LEGS[i].id, gutter, barY + barH * 0.5 + lp * 0.36, lp, 600, 0.6, 0.2, 1);

        /* stance bars: (c + phase) mod 1 < duty  ->  c in [k - phase, +duty) */
        var ph = gait.phases[i];
        var kStart = Math.floor(cStart + ph) - 1;
        var kEnd = Math.ceil(cEnd + ph) + 1;
        ctx.fillStyle = ink(0.82);
        for (var k = kStart; k <= kEnd; k++) {
          var a = k - ph, b = a + duty;
          if (b <= cStart || a >= cEnd) { continue; }
          var ax = xOf(Math.max(a, cStart)), bx = xOf(Math.min(b, cEnd));
          if (bx - ax < 0.6) { continue; }
          ctx.fillRect(ax, barY, bx - ax, barH);
        }
      }

      /* axis */
      var axisY = padT + 4 * (laneH + gap) + Math.round(lp * 1.25);
      ctx.strokeStyle = ink(0.22);
      ctx.lineWidth = 1;
      var T = Math.round(1000 / freq);
      if (reduced) {
        var marks = [[0, '0'], [0.5, '0.5'], [1, '1.0']];
        for (var m = 0; m < marks.length; m++) {
          var mx = xOf(marks[m][0]);
          ctx.beginPath();
          ctx.moveTo(Math.round(mx) + 0.5, padT);
          ctx.lineTo(Math.round(mx) + 0.5, axisY - lp * 1.2);
          ctx.stroke();
          tracked(ctx, marks[m][1], mx, axisY, lp, 600,
            0.45, 0.2, m === 0 ? -1 : (m === 2 ? 1 : 0));
        }
        tracked(ctx, 'ONE CYCLE · T = ' + T + ' MS',
          x0 + plotW * 0.5, axisY, lp, 600, 0.42, 0.2, 0);
      } else {
        var labels = ['−3T', '−2T', '−1T', 'NOW'];
        for (var t = 0; t < 4; t++) {
          var tx = x0 + (t / 3) * plotW;
          ctx.strokeStyle = ink(t === 3 ? 0.5 : 0.16);
          ctx.beginPath();
          ctx.moveTo(Math.round(tx) + 0.5, padT);
          ctx.lineTo(Math.round(tx) + 0.5, axisY - lp * 1.2);
          ctx.stroke();
          tracked(ctx, labels[t], tx, axisY, lp, 600, t === 3 ? 0.6 : 0.4, 0.2,
            t === 0 ? -1 : (t === 3 ? 1 : 0));
        }
        tracked(ctx, 'T = ' + T + ' MS', x0 + plotW * 0.5, axisY, lp, 600, 0.42, 0.2, 0);
      }
    }

    /* ===========================================================================
       13.  Readouts
       ======================================================================== */

    function fmt(v, dp) { return v.toFixed(dp); }

    function syncControlText() {
      for (var i = 0; i < CONTROLS.length; i++) {
        var c = CONTROLS[i];
        var v = raw[c.key] * c.k;
        var txt = fmt(v, c.dp) + (c.unit ? ' ' + c.unit : '');
        valSpans[c.key].textContent = txt;
        inputs[c.key].setAttribute('aria-valuetext',
          fmt(v, c.dp) + (c.spoken ? ' ' + c.spoken : ''));
      }
      gaitNote.textContent = gait.note;
    }

    function syncReadout() {
      cells.duty.textContent = fmt(duty, 2);
      cells.stance.textContent = Math.round(duty / freq * 1000) + ' ms';
      cells.swing.textContent = Math.round((1 - duty) / freq * 1000) + ' ms';
      cells.stride.textContent = fmt(strideLen, 2) + ' m';
      cells.speed.textContent = fmt(speed, 2) + ' m/s';
    }

    var lastFlag = '';
    function syncFlag() {
      var word = nContact === 1 ? 'foot' : 'feet';
      var txt, bad = false;
      if (nContact < gait.need) {
        txt = 'Unstable · ' + nContact + ' ' + word + ' in contact';
        bad = true;
      } else if (anyClamped) {
        txt = 'Joint limit · foot short of commanded target';
        bad = true;
      } else {
        txt = 'Support · ' + nContact + ' ' + word + ' in contact';
      }
      if (txt !== lastFlag) {
        lastFlag = txt;
        flag.textContent = txt;
      }
      if (bad !== root.classList.contains('ks-gait-lab-warn')) {
        root.classList.toggle('ks-gait-lab-warn', bad);
      }
    }

    var statusTimer = null;
    function syncStatus() {
      if (statusTimer) { window.clearTimeout(statusTimer); }
      statusTimer = window.setTimeout(function () {
        statusTimer = null;
        var msg = gait.name + ' at ' + fmt(freq, 2) + ' hertz, duty factor ' +
          fmt(duty, 2) + '. Stance ' + Math.round(duty / freq * 1000) +
          ' milliseconds, swing ' + Math.round((1 - duty) / freq * 1000) +
          ' milliseconds. Step height ' + Math.round(stepH * 1000) +
          ' millimetres, body height ' + Math.round(bodyH * 1000) +
          ' millimetres. Stride ' + fmt(strideLen, 2) + ' metres, simulated speed ' +
          fmt(speed, 2) + ' metres per second. Minimum ' + minContact +
          ' of 4 feet in contact during the cycle' +
          (minContact < gait.need ? ', which is not enough to keep this gait stable.' : '.');
        status.textContent = msg;
        stageCanvas.setAttribute('aria-label',
          'Side view line drawing of a quadruped robot with Unitree Go2 link ' +
          'proportions, simulating a ' + gait.name.toLowerCase() + ' in place at ' +
          fmt(freq, 2) + ' hertz. ' + minContact + ' to ' + maxContactOf() +
          ' of 4 feet are on the ground.');
        chartCanvas.setAttribute('aria-label',
          'Footfall diagram, four lanes: left fore, right fore, left hind, right ' +
          'hind. Filled bars are stance, gaps are swing. ' + gait.name + ', ' +
          gait.note.replace(/·/g, ',') + ', duty factor ' + fmt(duty, 2) + '.');
      }, 420);
    }

    function maxContactOf() {
      var mx = 0;
      for (var s = 0; s < 240; s++) {
        var c = s / 240, n = 0;
        for (var i = 0; i < 4; i++) {
          if ((c + gait.phases[i]) % 1 < duty) { n++; }
        }
        if (n > mx) { mx = n; }
      }
      return mx;
    }

    /* ===========================================================================
       14.  Frame loop / lifecycle
       ======================================================================== */

    var rafId = 0;
    var last = 0;
    var visible = true;
    var reduced = isReduced();

    function frame(ts) {
      rafId = 0;
      var dt = last ? (ts - last) / 1000 : 0;
      last = ts;
      if (dt > 0.05) { dt = 0.05; }     /* survive tab switches / long GCs   */
      if (dt < 0) { dt = 0; }

      stepSim(dt);
      drawStage();
      drawChart(false);
      syncFlag();

      if (running()) { rafId = window.requestAnimationFrame(frame); }
    }

    function running() {
      return !reduced && visible && !document.hidden;
    }

    function start() {
      if (rafId || !running()) { return; }
      last = 0;
      rafId = window.requestAnimationFrame(frame);
    }

    function stop() {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    }

    function renderStatic() {
      staticPose();
      scroll = 0;
      drawStage();
      drawChart(true);
      syncFlag();
    }

    function redraw() {
      if (reduced) { renderStatic(); }
      else if (running()) { start(); }
      else { drawStage(); drawChart(false); syncFlag(); }
    }

    function onControlChange() {
      recompute();
      syncControlText();
      syncReadout();
      syncStatus();
      redraw();
    }

    function relayout() {
      readColors();
      wCache = {};
      layout();
      redraw();
    }

    /* ---- observers ------------------------------------------------------ */

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

    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    function onMotionChange() {
      var was = reduced;
      reduced = isReduced();
      if (was === reduced) { return; }
      if (reduced) { stop(); renderStatic(); } else { start(); }
    }
    if (mq) {
      if (mq.addEventListener) { mq.addEventListener('change', onMotionChange); }
      else if (mq.addListener) { mq.addListener(onMotionChange); }
    }
    /* The site has its own motion toggle, which flips html.no-motion. */
    if (window.MutationObserver) {
      new window.MutationObserver(onMotionChange).observe(document.documentElement, {
        attributes: true, attributeFilter: ['class']
      });
    }

    var resizeTimer = null, lastW = -1, lastH = -1;
    function onResize() {
      if (resizeTimer) { window.clearTimeout(resizeTimer); }
      resizeTimer = window.setTimeout(function () {
        resizeTimer = null;
        var w = stageCanvas.clientWidth, h = stageCanvas.clientHeight;
        if (w === lastW && h === lastH) { return; }
        lastW = w; lastH = h;
        relayout();
      }, 120);
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      new window.ResizeObserver(onResize).observe(root);
    }

    /* ---- go -------------------------------------------------------------- */

    instances.push(function () {
      refreshKinematics();
      recompute();
      syncStatus();
      redraw();
    });

    readColors();
    layout();
    lastW = stageCanvas.clientWidth;
    lastH = stageCanvas.clientHeight;
    recompute();
    staticPose();
    syncControlText();
    syncReadout();
    syncStatus();
    if (reduced) { renderStatic(); } else { start(); }

    /* Zero-width container (hidden tab, late fonts) -- retry once. */
    if (!lastW) {
      window.setTimeout(function () {
        if (stageCanvas.clientWidth) { relayout(); }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { relayout(); }, function () {});
    }
  }

  /* ===========================================================================
     15.  Boot
     ======================================================================== */

  function boot() {
    loadKinematics();
    var nodes = document.querySelectorAll('[data-ks-gait-lab]');
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
