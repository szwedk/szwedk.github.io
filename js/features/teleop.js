/* =============================================================================
   THE LATENCY BUDGET  ·  [data-ks-teleop]
   -----------------------------------------------------------------------------
   Whole-body VR teleoperation, made physical. Drag the operator hand on the
   left. The G1 arm on the right chases it THROUGH A DELAY LINE: every operator
   position is stamped and buffered, and the arm is rendered at the position the
   operator held (now minus the total pipeline latency). The gap you can see
   between the two markers is the latency, in centimetres.

   Underneath, the budget bar breaks that latency into the stages that actually
   spend it, against a 120 ms presence threshold.

   HONESTY NOTE
   ------------
   * pelvisToShoulder (0.23778 m), shoulderToElbow (0.08205 m) and
     shoulderSpacing (0.20042 m) are real numbers out of Unitree's official
     g1_29dof.urdf, fetched at runtime from ../assets/robot-kinematics.json with
     the same values inlined below as a fallback.
   * The elbow-to-hand link is NOT in that published subset. FOREARM below is an
     estimate for a 1.32 m humanoid and is labelled as estimated on screen. It
     is not presented as URDF data.
   * Every millisecond figure in the budget is a NOMINAL cost for this pipeline
     (90 Hz headset pose, WebRTC encode / decode, a 500 Hz SDK2 motor loop,
     mechanical settling), not a live measurement from a running link. The
     on-screen note says so. The only measured number here is the spatial error,
     and that is measured off this simulation, not off a robot.
   * Network figures are typical round-trip costs for each link type, not a
     speed test.

   WHAT IS ACTUALLY MODELLED
   -------------------------
   * A real delay line: a timestamped ring buffer of operator positions, sampled
     by linear interpolation at (now - latency). Whip the hand and the arm
     traces the path you drew, late. That is the whole point.
   * Applied latency is rate limited toward its target so the sampled timestamp
     never runs backward faster than wall clock. A receiver absorbs jitter in a
     de-jitter buffer exactly this way.
   * Analytic 2-link IK, elbow-down branch, clamped to the reachable annulus
     between |L2 - L1| and L1 + L2. Outside it the target is clamped and a
     REACH LIMIT flag comes up rather than the arm quietly lying about it.

   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksTeleopLoaded) { return; }
  window.__ksTeleopLoaded = true;

  /* ===========================================================================
     1.  Kinematics · real numbers, with an inlined fallback
     ======================================================================== */

  /* Mirrors the "g1" block of assets/robot-kinematics.json verbatim. */
  var FALLBACK = {
    label: 'Unitree G1 (29 DOF)',
    links: {
      pelvisToShoulder: 0.23778, /* m · pelvis origin up to shoulder axis    */
      shoulderToElbow: 0.08205,  /* m · shoulder pitch axis to elbow axis    */
      shoulderSpacing: 0.20042   /* m · left shoulder to right shoulder      */
    }
  };

  /* Elbow to hand. NOT in the published URDF subset · estimated for a 1.32 m
     humanoid so the arm has a sane workspace. Flagged as estimated on screen. */
  var FOREARM = 0.25;

  var DATA = FALLBACK;
  var instances = [];
  var fetchStarted = false;

  function loadKinematics() {
    if (fetchStarted || typeof fetch !== 'function') { return; }
    fetchStarted = true;
    /* relative first: this feature ships on /work/ pages, one level under the
       site root. A root-level mount is covered by the retry, file:// by the
       inlined fallback. */
    function attempt(path, next) {
      try {
        fetch(path, { credentials: 'same-origin' })
          .then(function (res) { return res && res.ok ? res.json() : null; })
          .then(function (json) {
            if (json && json.g1 && json.g1.links && json.g1.links.shoulderToElbow) {
              DATA = json.g1;
              for (var i = 0; i < instances.length; i++) {
                try { instances[i](); } catch (e) { /* never break the page */ }
              }
            } else if (next) { attempt(next, null); }
          })['catch'](function () { if (next) { attempt(next, null); } });
      } catch (e) { if (next) { attempt(next, null); } }
    }
    attempt('../assets/robot-kinematics.json', 'assets/robot-kinematics.json');
  }

  /* ===========================================================================
     2.  Small helpers
     ======================================================================== */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function ss(t) { return t * t * (3 - 2 * t); }            /* smoothstep    */

  function now() {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }

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

  /* Seeded PRNG (mulberry32). Jitter has to be reproducible run to run, so a
     screenshot or a bug report describes the same sequence every time. */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ===========================================================================
     3.  The budget
     ---------------------------------------------------------------------------
     Nominal per-stage costs for this pipeline. The network segment is driven by
     the LINK control, the capture segment by the HEADSET control.
     ======================================================================== */

  var STAGES = [
    { key: 'capture', label: 'Pose capture',  ms: 11 },
    { key: 'encode',  label: 'Encode',        ms: 3  },
    { key: 'network', label: 'Network',       ms: 25 },
    { key: 'decode',  label: 'Decode',        ms: 3  },
    { key: 'ik',      label: 'IK solve',      ms: 2  },
    { key: 'motor',   label: 'Motor command', ms: 2  },
    { key: 'act',     label: 'Actuation',     ms: 15 }
  ];
  var I_CAP = 0, I_NET = 2;

  var LINKS = [
    { id: 'lan',  label: 'Wired LAN',       ms: 8   },
    { id: '5g',   label: '5G, good',        ms: 25  },
    { id: '5gc',  label: '5G, congested',   ms: 85  },
    { id: 'wifi', label: 'Wi-Fi, busy room', ms: 45 },
    { id: 'sat',  label: 'Satellite',       ms: 240 }
  ];

  var HEADSETS = [
    { id: '90',  label: '90 Hz',  ms: 11 },
    { id: '72',  label: '72 Hz',  ms: 14 },
    { id: '120', label: '120 Hz', ms: 8  }
  ];

  var THRESHOLD = 120;          /* ms · presence threshold                    */
  var UNUSABLE = 250;           /* ms · past here it is not teleoperation     */
  var SCALES = [140, 200, 340]; /* bar full-scale steps, ms                   */

  /* ===========================================================================
     4.  Stage geometry (world metres, y up, robot faces -x toward the operator)
     ======================================================================== */

  /* Chest and pelvis outlines relative to the pelvis origin. Drawing decisions,
     not URDF data · only the link lengths above are real. */
  var CHEST = [
    [0.052, 0.042], [0.066, 0.106], [0.058, 0.217], [0.028, 0.238],
    [-0.042, 0.238], [-0.064, 0.190], [-0.058, 0.079], [-0.042, 0.042]
  ];
  var PELV = [[0.055, 0.028], [0.048, -0.052], [-0.048, -0.052], [-0.055, 0.028]];

  var NECK = 0.050, HEAD_R = 0.043;

  /* Operator drag box, relative to the shoulder at (0, 0). Kept entirely to the
     operator's side of the shoulder so the elbow-down branch never flips, and
     wider than the arm's reach so the workspace limit is discoverable. */
  var BOX = { x0: -0.40, x1: -0.09, y0: -0.22, y1: 0.22 };

  var PELV_DROP = 0.052; /* pelvis block depth below its origin, drawn       */

  var REST_X = -0.245, REST_Y = -0.02;

  /* Idle drift · a rate-modulated figure that stays inside the workspace, so
     the piece demonstrates the lag without anyone touching it. */
  var DX_C = -0.240, DX_A = 0.075, DY_C = -0.010, DY_A = 0.085;
  var IDLE_WAIT = 3.2;   /* s of no input before the drift returns            */
  var DRIFT_FADE = 1.6;  /* s to glide from the released hand onto the curve  */

  var TRAIL_N = 34;      /* ghost trail sample count                          */
  var BUF_N = 1024;      /* delay line depth                                  */

  var uid = 0;

  /* ===========================================================================
     5.  Instance
     ======================================================================== */

  function mount(root) {
    if (root.__ksTeleop) { return; }
    root.__ksTeleop = true;
    uid++;

    var ns = 'ks-teleop-' + uid;
    var stillMode = isStill();

    /* ---- state ---------------------------------------------------------- */

    var link = LINKS[1];        /* 5G, good                                   */
    var hset = HEADSETS[0];     /* 90 Hz                                      */
    var jitterMs = 10;

    var L1 = FALLBACK.links.shoulderToElbow;
    var L2 = FOREARM;
    var P2S = FALLBACK.links.pelvisToShoulder;
    var SPAN = FALLBACK.links.shoulderSpacing;
    var D_MIN = Math.abs(L2 - L1), D_MAX = L1 + L2;
    var ruleY = -(P2S + PELV_DROP + 0.026);   /* rule sits under the pelvis  */

    var hand = { x: REST_X, y: REST_Y };
    var userPos = { x: REST_X, y: REST_Y };
    var lagged = { x: REST_X, y: REST_Y };
    var arm = { ex: 0, ey: 0, hx: 0, hy: 0, clamped: false };

    var clock = 0;              /* s · drift phase, motion mode only          */
    var idleT = stillMode ? 0 : IDLE_WAIT;
    var driftW = stillMode ? 0 : 1;

    var jitterVal = 0, jitterAcc = 0;
    var rand = rng(0x5EED1A7);

    var latTarget = 0, latApplied = 0;
    var netNow = link.ms, totalNow = 0, errCm = 0;
    var scaleMs = 140;
    var verdict = '', reachFlag = false;

    var visible = true, active = !stillMode, rafId = 0, last = 0;

    /* ---- DOM ------------------------------------------------------------ */

    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-teleop');
    if ((root.getAttribute('data-ks-teleop') || '').toLowerCase() === 'light') {
      root.classList.add('ks-teleop-on-light');
    }

    var headRow = el('div', 'ks-teleop-head');
    headRow.appendChild(el('p', 'ks-teleop-eyebrow',
      'The latency budget · VR teleoperation'));
    headRow.appendChild(el('p', 'ks-teleop-credit',
      'Arm proportions from the Unitree G1 URDF · forearm not in the published subset, estimated'));
    root.appendChild(headRow);

    var stage = el('div', 'ks-teleop-stage');
    var cv = el('canvas', 'ks-teleop-canvas');
    cv.setAttribute('tabindex', '0');
    cv.setAttribute('aria-label',
      'Line drawing of a VR operator hand on the left and a Unitree G1 torso ' +
      'with one arm on the right. Drag the hand, or focus this canvas and use ' +
      'the arrow keys, and the arm follows one full pipeline latency behind. ' +
      'Hold shift for a larger step.');
    stage.appendChild(cv);
    var reachEl = el('span', 'ks-teleop-reach', 'Reach limit');
    reachEl.hidden = true;
    reachEl.setAttribute('aria-hidden', 'true');   /* the flag line speaks it */
    stage.appendChild(reachEl);
    root.appendChild(stage);

    root.appendChild(el('p', 'ks-teleop-hint',
      'Drag the hand · the arm is always this far behind'));

    /* --- budget bar ------------------------------------------------------ */
    var budget = el('div', 'ks-teleop-budget');

    var bHead = el('div', 'ks-teleop-budgethead');
    bHead.appendChild(el('span', null, 'Latency budget'));
    var scaleEl = el('span', 'ks-teleop-num', '0 to 140 ms');
    bHead.appendChild(scaleEl);
    budget.appendChild(bHead);

    /* the caption rides above the rule, so both are positioned against one
       wrapper whose width is the full-scale axis */
    var barWrap = el('div', 'ks-teleop-barwrap');
    var markLab = el('span', 'ks-teleop-marklab', 'Presence threshold');
    barWrap.appendChild(markLab);

    var track = el('div', 'ks-teleop-track');
    track.setAttribute('aria-hidden', 'true');   /* the legend carries the text */
    var segs = [], divs = [];
    var i;
    for (i = 0; i < STAGES.length; i++) {
      var seg = el('span', 'ks-teleop-seg');
      seg.style.opacity = String(0.14 + i * 0.043);
      track.appendChild(seg);
      segs.push(seg);
    }
    var over = el('span', 'ks-teleop-over');
    over.hidden = true;
    track.appendChild(over);
    var band = el('span', 'ks-teleop-band');
    band.hidden = true;
    track.appendChild(band);
    for (i = 0; i <= STAGES.length; i++) {
      var dv = el('span', 'ks-teleop-div');
      track.appendChild(dv);
      divs.push(dv);
    }
    var mark = el('span', 'ks-teleop-mark');
    track.appendChild(mark);
    barWrap.appendChild(track);
    budget.appendChild(barWrap);

    var legend = el('div', 'ks-teleop-legend');
    var lvals = [];
    for (i = 0; i < STAGES.length; i++) {
      var cellL = el('span', 'ks-teleop-lcell');
      var sw = el('span', 'ks-teleop-sw');
      sw.style.opacity = String(0.28 + i * 0.085);
      sw.setAttribute('aria-hidden', 'true');
      cellL.appendChild(sw);
      cellL.appendChild(el('span', 'ks-teleop-lkey', STAGES[i].label));
      var lv = el('span', 'ks-teleop-lval ks-teleop-num', STAGES[i].ms + ' ms');
      cellL.appendChild(lv);
      lvals.push(lv);
      legend.appendChild(cellL);
    }
    budget.appendChild(legend);

    var flag = el('p', 'ks-teleop-flag', 'Inside the budget');
    flag.setAttribute('aria-hidden', 'true');   /* the live region speaks it  */
    budget.appendChild(flag);

    budget.appendChild(el('p', 'ks-teleop-note',
      'Stage costs are nominal figures for this pipeline: 90 Hz headset pose, ' +
      'WebRTC encode and decode, a 500 Hz SDK2 motor loop, mechanical settling. ' +
      'They are not a live measurement of a running link.'));

    root.appendChild(budget);

    /* --- controls -------------------------------------------------------- */
    var panel = el('div', 'ks-teleop-panel');

    function pillGroup(name, items, current, onPick) {
      var wrap = el('div', 'ks-teleop-field');
      var lid = ns + '-' + name.toLowerCase().replace(/\W+/g, '');
      var lab = el('span', 'ks-teleop-legendkey', name);
      lab.id = lid;
      wrap.appendChild(lab);
      var group = el('div', 'ks-teleop-pills');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', lid);
      var btns = [];
      for (var k = 0; k < items.length; k++) {
        (function (item) {
          var b = el('button', 'ks-teleop-pill', item.label);
          b.type = 'button';
          b.setAttribute('aria-pressed', item === current ? 'true' : 'false');
          b.addEventListener('click', function () {
            for (var q = 0; q < btns.length; q++) {
              btns[q].setAttribute('aria-pressed', btns[q] === b ? 'true' : 'false');
            }
            onPick(item);
          });
          group.appendChild(b);
          btns.push(b);
        }(items[k]));
      }
      wrap.appendChild(group);
      panel.appendChild(wrap);
    }

    pillGroup('Link', LINKS, link, function (item) {
      link = item;
      onControlChange();
    });

    pillGroup('Headset', HEADSETS, hset, function (item) {
      hset = item;
      onControlChange();
    });

    var jField = el('div', 'ks-teleop-field');
    var jRow = el('div', 'ks-teleop-sliderhead');
    var jLab = el('label', 'ks-teleop-legendkey', 'Jitter');
    jLab.setAttribute('for', ns + '-jitter');
    var jVal = el('span', 'ks-teleop-val ks-teleop-num', '± 10 ms');
    jVal.setAttribute('aria-hidden', 'true');
    jRow.appendChild(jLab);
    jRow.appendChild(jVal);
    var jIn = document.createElement('input');
    jIn.type = 'range';
    jIn.id = ns + '-jitter';
    jIn.min = '0';
    jIn.max = '40';
    jIn.step = '1';
    jIn.value = String(jitterMs);
    jIn.className = 'ks-teleop-range';
    jIn.setAttribute('aria-valuetext', '± 10 milliseconds');
    jField.appendChild(jRow);
    jField.appendChild(jIn);
    panel.appendChild(jField);

    function readJitter() {
      jitterMs = parseFloat(jIn.value) || 0;
      jVal.textContent = '± ' + jitterMs + ' ms';
      jIn.setAttribute('aria-valuetext', '± ' + jitterMs + ' milliseconds');
      onControlChange();
    }
    jIn.addEventListener('input', readJitter);
    jIn.addEventListener('change', readJitter);

    root.appendChild(panel);

    /* --- readout --------------------------------------------------------- */
    var readout = el('div', 'ks-teleop-readout');
    var cells = {};
    var CELL_DEFS = [
      ['total', 'Total'], ['share', 'Network share'],
      ['err', 'Spatial error'], ['verdict', 'Verdict']
    ];
    for (i = 0; i < CELL_DEFS.length; i++) {
      var cell = el('span', 'ks-teleop-cell');
      cell.appendChild(el('span', 'ks-teleop-cellkey', CELL_DEFS[i][1]));
      var b = el('b', 'ks-teleop-cellval ks-teleop-num', '··');
      cell.appendChild(b);
      readout.appendChild(cell);
      cells[CELL_DEFS[i][0]] = b;
    }
    root.appendChild(readout);

    var status = el('p', 'ks-teleop-sr');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.appendChild(status);

    /* ---- canvas plumbing ------------------------------------------------ */

    var g = cv.getContext ? cv.getContext('2d') : null;
    if (!g) { return; }

    var dpr = 1, SW = 0, SH = 0;
    var scale = 400, originX = 0, originY = 0;
    var INK = [242, 239, 233];
    var RUST = [176, 58, 46];
    var FAMILY = "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function ink(a) {
      return 'rgba(' + INK[0] + ',' + INK[1] + ',' + INK[2] + ',' + a + ')';
    }
    function rust(a) {
      return 'rgba(' + RUST[0] + ',' + RUST[1] + ',' + RUST[2] + ',' + a + ')';
    }
    function readColors() {
      var cs = window.getComputedStyle(root);
      INK = parseRGB(cs.color, [242, 239, 233]);
      if (cs.fontFamily) { FAMILY = cs.fontFamily; }
    }

    function sx(x) { return originX + x * scale; }
    function sy(y) { return originY - y * scale; }

    function layout() {
      var w = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 320;
      var h = cv.clientHeight || 300;
      dpr = Math.min(window.devicePixelRatio || 1, 2);    /* DPR capped at 2 */
      var pw = Math.max(1, Math.round(w * dpr));
      var ph = Math.max(1, Math.round(h * dpr));
      if (cv.width !== pw) { cv.width = pw; }
      if (cv.height !== ph) { cv.height = ph; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      SW = w; SH = h;
      /* vertical budget: the top of the drag box down to the scale rule, plus
         58 px of caption room under the rule and a top margin */
      var vspan = BOX.y1 - ruleY;
      scale = clamp(Math.min((SH - 58) / vspan, (SW * 0.66) / 0.50), 190, 700);
      /* centre the drawn extent: the operator box runs out to BOX.x0 on the
         left, the robot's back reaches +0.075 on the right */
      var half = (BOX.x0 + 0.075) / 2;
      originX = Math.round(clamp(SW * 0.5 - half * scale,
        -BOX.x0 * scale + 16, SW - 0.10 * scale - 16));
      /* keep the top of the drag box on canvas and leave the rule its caption */
      originY = Math.round(clamp(SH * 0.42,
        BOX.y1 * scale + 12, SH + ruleY * scale - 40));
    }

    function labelPx() { return clamp(SW / 82, 8.5, 10.5); }

    /* Tracked micro-labels, characters placed by hand (canvas letterSpacing is
       not universal). Widths memoised against a bounded key set. */
    var wCache = {};
    function charW(ch, size, weight) {
      var k = size + '|' + weight + '|' + ch;
      var v = wCache[k];
      if (v === undefined) {
        g.font = weight + ' ' + size + 'px ' + FAMILY;
        v = g.measureText(ch).width;
        wCache[k] = v;
      }
      return v;
    }
    function trackedWidth(str, size, weight, trEm) {
      var tr = size * trEm, w = 0;
      for (var q = 0; q < str.length; q++) { w += charW(str.charAt(q), size, weight) + tr; }
      return w - tr;
    }
    /* align: -1 left, 0 centre, 1 right */
    function tracked(str, x, y, size, weight, style, trEm, align) {
      g.font = weight + ' ' + size + 'px ' + FAMILY;
      g.fillStyle = style;
      var tr = size * trEm;
      var w = trackedWidth(str, size, weight, trEm);
      var cx = align === 1 ? x - w : (align === 0 ? x - w / 2 : x);
      for (var q = 0; q < str.length; q++) {
        var ch = str.charAt(q);
        g.fillText(ch, cx, y);
        cx += charW(ch, size, weight) + tr;
      }
      return w;
    }

    function circle(x, y, r, filled) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      if (filled) { g.fill(); } else { g.stroke(); }
    }

    /* ===========================================================================
       6.  Kinematics
       ======================================================================== */

    function refreshKinematics() {
      var lk = (DATA && DATA.links) || FALLBACK.links;
      L1 = lk.shoulderToElbow || FALLBACK.links.shoulderToElbow;
      P2S = lk.pelvisToShoulder || FALLBACK.links.pelvisToShoulder;
      SPAN = lk.shoulderSpacing || FALLBACK.links.shoulderSpacing;
      L2 = FOREARM;
      D_MIN = Math.abs(L2 - L1);
      D_MAX = L1 + L2;
      /* the rule and the whole vertical budget hang off the fetched pelvis
         height, so a different URDF cannot push the torso off the canvas */
      ruleY = -(P2S + PELV_DROP + 0.026);
    }
    refreshKinematics();

    /* Analytic 2-link IK about the shoulder at world (0, 0). The target is
       clamped into the reachable annulus first, so a commanded point outside
       the workspace produces the nearest pose the arm can actually hold, plus
       a flag · never a silently wrong arm. */
    function solveArm(tx, ty, o) {
      var d = Math.sqrt(tx * tx + ty * ty);
      var ux, uy;
      o.clamped = false;
      if (d < 1e-6) { ux = -1; uy = 0; d = 1e-6; } else { ux = tx / d; uy = ty / d; }
      var dc = clamp(d, D_MIN, D_MAX);
      if (Math.abs(dc - d) > 1e-6) { o.clamped = true; }
      d = dc;

      var base = Math.atan2(uy, ux);
      var ca = clamp((d * d + L1 * L1 - L2 * L2) / (2 * d * L1), -1, 1);
      var a = Math.acos(ca);
      /* elbow-down: with the target on the operator's side (world -x), adding
         the half-angle drops the elbow below the shoulder-to-hand line. The
         drag box never crosses the shoulder, so the branch never flips. */
      var s = ux > 0 ? -1 : 1;
      var th = base + s * a;
      o.ex = Math.cos(th) * L1;
      o.ey = Math.sin(th) * L1;
      o.hx = ux * d;
      o.hy = uy * d;
    }

    /* ===========================================================================
       7.  The delay line
       ---------------------------------------------------------------------------
       A timestamped ring of operator positions. The arm renders whatever the
       operator was holding at (now - latency), interpolated between the two
       samples that straddle it.
       ======================================================================== */

    var bt = [], bx = [], by = [], bHeadI = -1, bCount = 0;
    for (i = 0; i < BUF_N; i++) { bt.push(0); bx.push(0); by.push(0); }

    function pushSample(t, x, y) {
      bHeadI = (bHeadI + 1) % BUF_N;
      bt[bHeadI] = t; bx[bHeadI] = x; by[bHeadI] = y;
      if (bCount < BUF_N) { bCount++; }
    }

    function sampleAt(tq, out) {
      if (bCount === 0) { out.x = hand.x; out.y = hand.y; return; }
      var prev = -1, idx, k;
      for (k = 0; k < bCount; k++) {
        idx = (bHeadI - k + BUF_N * 2) % BUF_N;
        if (bt[idx] <= tq) {
          if (prev < 0) { out.x = bx[idx]; out.y = by[idx]; return; }
          var t0 = bt[idx], t1 = bt[prev];
          var f = t1 > t0 ? clamp((tq - t0) / (t1 - t0), 0, 1) : 0;
          out.x = bx[idx] + (bx[prev] - bx[idx]) * f;
          out.y = by[idx] + (by[prev] - by[idx]) * f;
          return;
        }
        prev = idx;
      }
      idx = (bHeadI - (bCount - 1) + BUF_N * 2) % BUF_N;   /* older than history */
      out.x = bx[idx]; out.y = by[idx];
    }

    /* ===========================================================================
       8.  Budget arithmetic
       ======================================================================== */

    function stageMs(k) {
      if (k === I_CAP) { return hset.ms; }
      if (k === I_NET) { return netNow; }
      return STAGES[k].ms;
    }

    function baseTotal() {
      var s = 0;
      for (var k = 0; k < STAGES.length; k++) {
        s += (k === I_CAP) ? hset.ms : (k === I_NET ? link.ms : STAGES[k].ms);
      }
      return s;
    }

    function pickScale() {
      /* Scale off the BASE total plus the full jitter amplitude, so the bar
         never rescales while jitter wobbles · only when a control moves. */
      var need = baseTotal() + jitterMs;
      for (var k = 0; k < SCALES.length; k++) {
        if (need <= SCALES[k]) { return SCALES[k]; }
      }
      return SCALES[SCALES.length - 1];
    }

    function verdictOf(total) {
      if (total < THRESHOLD) { return 'inside'; }
      if (total < UNUSABLE) { return 'above'; }
      return 'unusable';
    }
    var VERDICT_WORD = {
      inside: 'Inside budget',
      above: 'Above threshold',
      unusable: 'Unusable'
    };

    /* ===========================================================================
       9.  Bar rendering
       ======================================================================== */

    var lastBarNet = -1, lastBarScale = -1;

    function syncBar(force) {
      var total = 0, k;
      var ms = [];
      for (k = 0; k < STAGES.length; k++) { ms.push(stageMs(k)); total += ms[k]; }

      if (!force && Math.abs(netNow - lastBarNet) < 0.4 && scaleMs === lastBarScale) {
        return total;
      }
      lastBarNet = netNow;
      lastBarScale = scaleMs;

      var s = scaleMs, x = 0;
      for (k = 0; k < STAGES.length; k++) {
        var w = ms[k] / s * 100;
        segs[k].style.left = x + '%';
        segs[k].style.width = w + '%';
        divs[k].style.left = x + '%';
        x += w;
      }
      divs[STAGES.length].style.left = Math.min(100, x) + '%';

      var thr = THRESHOLD / s * 100;
      mark.style.left = thr + '%';
      markLab.style.left = thr + '%';
      /* keep the threshold caption inside the track at both ends */
      markLab.style.transform = thr > 78 ? 'translateX(-100%)'
        : (thr < 12 ? 'translateX(0)' : 'translateX(-50%)');

      if (x > thr) {
        over.hidden = false;
        over.style.left = thr + '%';
        over.style.width = Math.max(0, Math.min(100, x) - thr) + '%';
      } else {
        over.hidden = true;
      }

      /* still mode: jitter is a static plus-or-minus band, never a shimmer */
      if (stillMode && jitterMs > 0) {
        var pre = 0;
        for (k = 0; k < I_NET; k++) { pre += ms[k]; }
        var lo = clamp((pre + link.ms - jitterMs) / s * 100, 0, 100);
        var hi = clamp((pre + link.ms + jitterMs) / s * 100, 0, 100);
        band.hidden = false;
        band.style.left = lo + '%';
        band.style.width = Math.max(0, hi - lo) + '%';
      } else {
        band.hidden = true;
      }

      scaleEl.textContent = '0 to ' + s + ' ms';
      return total;
    }

    /* ===========================================================================
       10.  Drawing
       ======================================================================== */

    var trail = [];
    for (i = 0; i < TRAIL_N; i++) { trail.push({ x: 0, y: 0 }); }
    var tmp = { x: 0, y: 0 };

    function polyArc(r, a0, a1, steps) {
      g.beginPath();
      for (var k = 0; k <= steps; k++) {
        var a = a0 + (a1 - a0) * (k / steps);
        var px = sx(Math.cos(a) * r), py = sy(Math.sin(a) * r);
        if (k === 0) { g.moveTo(px, py); } else { g.lineTo(px, py); }
      }
      g.stroke();
    }

    function poly(pts, ox, oy) {
      g.beginPath();
      for (var k = 0; k < pts.length; k++) {
        var px = sx(ox + pts[k][0]), py = sy(oy + pts[k][1]);
        if (k === 0) { g.moveTo(px, py); } else { g.lineTo(px, py); }
      }
      g.closePath();
    }

    function drawOperator(x, y) {
      var px = sx(x), py = sy(y);
      g.strokeStyle = ink(0.92);
      g.fillStyle = ink(0.92);
      g.lineWidth = 1.4;

      /* controller: a grip stroke, a tracking ring, and a crosshair on the
         exact commanded point */
      var gx = px + 13, gy = py + 17;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(gx, gy);
      g.stroke();
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(px, py, 9, Math.PI * 0.78, Math.PI * 2.12);
      g.stroke();

      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px - 6.5, py); g.lineTo(px - 2.5, py);
      g.moveTo(px + 2.5, py); g.lineTo(px + 6.5, py);
      g.moveTo(px, py - 6.5); g.lineTo(px, py - 2.5);
      g.moveTo(px, py + 2.5); g.lineTo(px, py + 6.5);
      g.stroke();
      circle(px, py, 1.7, true);
    }

    /* A metric rule across the full canvas width. It anchors the drawing, and
       it is what makes the centimetre readout legible: the gap you see has a
       physical size you can check against the ticks. */
    function drawRule(lp) {
      var ry = Math.round(sy(ruleY)) + 0.5;
      g.strokeStyle = ink(0.28);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, ry); g.lineTo(SW, ry);
      g.stroke();

      var span = SW / scale;
      var t0 = Math.floor((-originX / scale) / 0.05) * 0.05;
      g.beginPath();
      for (var x = t0; x < t0 + span + 0.05; x += 0.05) {
        var isM = Math.abs(x / 0.1 - Math.round(x / 0.1)) < 0.01;
        var px = Math.round(sx(x)) + 0.5;
        g.moveTo(px, ry + 1);
        g.lineTo(px, ry + (isM ? 7 : 4));
      }
      g.strokeStyle = ink(0.16);
      g.stroke();

      /* one labelled 100 mm span, at the first major tick clear of the edge */
      var m0 = t0;
      while (sx(m0) < 10 || Math.abs(m0 / 0.1 - Math.round(m0 / 0.1)) > 0.01) { m0 += 0.05; }
      var a = sx(m0), b = sx(m0 + 0.1);
      var by2 = ry + 15;
      g.strokeStyle = ink(0.3);
      g.beginPath();
      g.moveTo(a, by2); g.lineTo(b, by2);
      g.moveTo(a + 0.5, by2 - 3); g.lineTo(a + 0.5, by2 + 3);
      g.moveTo(b - 0.5, by2 - 3); g.lineTo(b - 0.5, by2 + 3);
      g.stroke();

      /* Both side captions live on this one baseline. Anchoring OPERATOR to the
         moving marker instead put it in the path of the lag label on every
         downward drag, so it labels the column, not the crosshair. */
      var capY = by2 + lp * 1.7;
      tracked('100 MM', (a + b) / 2, capY, lp, 600, ink(0.42), 0.2, 0);
      tracked('OPERATOR', sx((BOX.x0 + BOX.x1) / 2), capY, lp, 600, ink(0.5), 0.2, 0);
      tracked('UNITREE G1', sx(0.005), capY, lp, 600, ink(0.5), 0.2, 0);
    }

    function drawRobot() {
      var pelX = 0.005, pelY = -P2S;

      /* shoulder yoke out to the far shoulder · shoulderSpacing, drawn as an
         oblique so a single-arm side view still reads as a pair of shoulders */
      var fdx = SPAN * 0.22, fdy = SPAN * 0.10;
      g.strokeStyle = ink(0.34);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(sx(0), sy(0));
      g.lineTo(sx(fdx), sy(fdy));
      g.stroke();
      g.lineWidth = 1;
      circle(sx(fdx), sy(fdy), 2.4, false);

      /* torso: pelvis block, waist, chest */
      g.strokeStyle = ink(0.92);
      g.lineWidth = 1.7;
      poly(PELV, pelX, pelY);
      g.stroke();
      poly(CHEST, pelX, pelY);
      g.stroke();
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(sx(pelX - 0.026), sy(pelY + 0.028));
      g.lineTo(sx(pelX - 0.026), sy(pelY + 0.042));
      g.moveTo(sx(pelX + 0.030), sy(pelY + 0.028));
      g.lineTo(sx(pelX + 0.030), sy(pelY + 0.042));
      g.stroke();

      /* neck + head, facing the operator */
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(sx(0), sy(0.004));
      g.lineTo(sx(-0.004), sy(NECK));
      g.stroke();
      var hcx = -0.008, hcy = NECK + HEAD_R;
      circle(sx(hcx), sy(hcy), HEAD_R * scale, false);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(sx(hcx - 0.016), sy(hcy + 0.010));
      g.lineTo(sx(hcx - 0.048), sy(hcy + 0.010));
      g.stroke();

      /* arm: shoulder, elbow, end effector */
      g.strokeStyle = ink(0.95);
      g.fillStyle = ink(0.95);
      g.lineWidth = 1.9;
      g.beginPath();
      g.moveTo(sx(0), sy(0));
      g.lineTo(sx(arm.ex), sy(arm.ey));
      g.lineTo(sx(arm.hx), sy(arm.hy));
      g.stroke();
      g.lineWidth = 1;
      circle(sx(0), sy(0), 3.2, false);
      circle(sx(arm.ex), sy(arm.ey), 2.6, false);

      var ehx = sx(arm.hx), ehy = sy(arm.hy);
      g.lineWidth = 1.3;
      circle(ehx, ehy, 4.4, false);
      circle(ehx, ehy, 1.6, true);
    }

    function drawFrame() {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, SW, SH);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.textBaseline = 'alphabetic';
      var lp = labelPx();
      var k;

      drawRule(lp);

      /* --- reachable annulus: the arm's real workspace ------------------- */
      var wa = arm.clamped ? 0.30 : 0.15;
      g.setLineDash([1.5, 4]);
      g.strokeStyle = arm.clamped ? rust(0.7) : ink(wa);
      g.lineWidth = 1;
      polyArc(D_MAX, Math.PI * 0.62, Math.PI * 1.42, 36);
      polyArc(D_MIN, Math.PI * 0.62, Math.PI * 1.42, 26);
      g.setLineDash([]);

      /* --- ghost trail: the operator path still in flight ---------------- */
      if (stillMode) {
        g.setLineDash([1.5, 4]);
        g.strokeStyle = ink(0.26);
        g.lineWidth = 1;
        g.beginPath();
        for (k = 0; k < TRAIL_N; k++) {
          var tx = sx(trail[k].x), ty = sy(trail[k].y);
          if (k === 0) { g.moveTo(tx, ty); } else { g.lineTo(tx, ty); }
        }
        g.stroke();
        g.setLineDash([]);
      } else {
        g.lineWidth = 1;
        for (k = 0; k < TRAIL_N - 1; k++) {
          g.strokeStyle = ink(0.05 + 0.27 * (k / (TRAIL_N - 2)));
          g.beginPath();
          g.moveTo(sx(trail[k].x), sy(trail[k].y));
          g.lineTo(sx(trail[k + 1].x), sy(trail[k + 1].y));
          g.stroke();
        }
      }

      /* --- commanded target when the arm cannot reach it ----------------- */
      if (arm.clamped) {
        var cxp = sx(lagged.x), cyp = sy(lagged.y);
        g.strokeStyle = rust(0.9);
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(cxp - 5, cyp - 5); g.lineTo(cxp + 5, cyp + 5);
        g.moveTo(cxp + 5, cyp - 5); g.lineTo(cxp - 5, cyp + 5);
        g.stroke();
      }

      /* --- leader between the hand and the commanded point ----------------
         The commanded point is where the arm has been told to be. Inside the
         workspace it sits exactly on the end effector; outside it, the cross
         above marks it and the arm is visibly short of it. */
      var ax = sx(hand.x), ay = sy(hand.y);
      var bxp = sx(lagged.x), byp = sy(lagged.y);
      var dx = bxp - ax, dy = byp - ay;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 7) {
        g.strokeStyle = ink(0.4);
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(ax + dx / dist * 8, ay + dy / dist * 8);
        g.lineTo(bxp - dx / dist * 7, byp - dy / dist * 7);
        g.stroke();
        g.setLineDash([]);
      }
      /* label placement: perpendicular off the midpoint once the gap is wide
         enough to hold it, otherwise parked clear of the crosshair. Either way
         it rides one normal, and the OPERATOR caption gets the other. */
      var nx = 0, ny = -1;
      if (dist > 52) {
        nx = -dy / dist; ny = dx / dist;
        if (ny > 0) { nx = -nx; ny = -ny; }         /* keep the label above  */
      }
      var lx = dist > 52 ? (ax + bxp) / 2 + nx * 16 : ax + nx * 28;
      var ly = dist > 52 ? (ay + byp) / 2 + ny * 16 : ay + ny * 28;
      var warn = totalNow >= THRESHOLD;
      tracked(Math.round(latApplied) + ' MS BEHIND', lx, ly,
        lp, 600, warn ? rust(0.95) : ink(0.78), 0.2, 0);
      tracked(errCm.toFixed(1) + ' CM', lx, ly + lp * 1.5,
        lp, 600, ink(0.55), 0.2, 0);

      drawRobot();
      drawOperator(hand.x, hand.y);
    }

    /* ===========================================================================
       11.  Readouts + announcements
       ======================================================================== */

    var txtCache = { total: '', share: '', err: '', verdict: '' };
    function setCell(key, txt) {
      if (txtCache[key] !== txt) { txtCache[key] = txt; cells[key].textContent = txt; }
    }

    var statusTimer = null;
    function announce(v, total) {
      if (statusTimer) { window.clearTimeout(statusTimer); }
      statusTimer = window.setTimeout(function () {
        statusTimer = null;
        var msg;
        if (v === 'inside') {
          msg = 'Inside the budget. ' + total + ' milliseconds total.';
        } else if (v === 'above') {
          msg = 'Above the presence threshold at ' + total +
                ' milliseconds. The robot stops feeling like your body.';
        } else {
          msg = 'Unusable at ' + total + ' milliseconds.';
        }
        status.textContent = msg;
      }, 420);
    }

    var syncAcc = 0;
    function syncReadout(dt, force) {
      syncAcc += dt;
      if (!force && syncAcc < 0.11) { return; }
      syncAcc = 0;

      /* verdict off the ROUNDED total, so the cell never reads 120 ms and
         "inside budget" in the same breath */
      var shown = Math.round(totalNow);
      setCell('total', shown + ' ms');
      setCell('share', Math.round(netNow / Math.max(1, totalNow) * 100) + ' %');
      setCell('err', errCm.toFixed(1) + ' cm');

      var v = verdictOf(shown);
      setCell('verdict', VERDICT_WORD[v]);
      if (v !== verdict) {
        verdict = v;
        root.classList.toggle('ks-teleop-warn', v !== 'inside');
        flag.textContent = v === 'inside'
          ? 'Inside the budget'
          : 'Above threshold · the robot stops feeling like your body';
        announce(v, shown);
      }

      if (reachFlag !== arm.clamped) {
        reachFlag = arm.clamped;
        reachEl.hidden = !reachFlag;
      }

      /* legend: live network in motion mode, a static band in still mode */
      var netTxt = stillMode
        ? (jitterMs > 0 ? link.ms + ' ± ' + jitterMs + ' ms' : link.ms + ' ms')
        : Math.round(netNow) + ' ms';
      if (lvals[I_NET].textContent !== netTxt) { lvals[I_NET].textContent = netTxt; }
      var capTxt = hset.ms + ' ms';
      if (lvals[I_CAP].textContent !== capTxt) { lvals[I_CAP].textContent = capTxt; }
    }

    /* ===========================================================================
       12.  Step + loop
       ======================================================================== */

    function driftAt(t) {
      /* rate modulation gives the path slow arcs and fast whips, so the lag is
         visible at both ends of the speed range */
      var u = t * 1.15 + 0.75 * Math.sin(t * 0.5);
      tmp.x = DX_C + DX_A * Math.sin(u * 1.9);
      tmp.y = DY_C + DY_A * Math.sin(u * 3.1 + 0.9);
      return tmp;
    }

    function step(t, dt) {
      /* --- network jitter ------------------------------------------------ */
      if (!stillMode && jitterMs > 0) {
        jitterAcc += dt;
        if (jitterAcc >= 0.07) {          /* one draw per packet-ish interval */
          jitterAcc = 0;
          jitterVal = (rand() * 2 - 1) * jitterMs;
        }
      } else {
        jitterVal = 0;
      }
      netNow = Math.max(1, link.ms + jitterVal);

      /* --- operator hand ------------------------------------------------- */
      if (!drag.on) {
        if (stillMode) {
          hand.x = userPos.x; hand.y = userPos.y;
        } else {
          clock += dt;
          idleT += dt;
          if (idleT >= IDLE_WAIT) {
            driftW = Math.min(1, driftW + dt / DRIFT_FADE);
          }
          var d = driftAt(clock);
          var w = ss(driftW);
          hand.x = userPos.x + (d.x - userPos.x) * w;
          hand.y = userPos.y + (d.y - userPos.y) * w;
        }
      }
      pushSample(t, hand.x, hand.y);

      /* --- applied latency ----------------------------------------------- */
      totalNow = syncBar(false);
      latTarget = totalNow;
      var diff = latTarget - latApplied;
      var stp = diff * Math.min(1, dt * 12);
      var ms = dt * 1000;
      /* the sampled timestamp must never run backward faster than wall clock,
         which is exactly what a de-jitter buffer guarantees */
      stp = clamp(stp, -4 * ms, 0.85 * ms);
      latApplied += stp;
      if (Math.abs(latTarget - latApplied) < 0.25) { latApplied = latTarget; }

      /* --- the delay line ------------------------------------------------ */
      sampleAt(t - latApplied, lagged);
      solveArm(lagged.x, lagged.y, arm);

      /* the spatial error is the DELAY component only: hand now, versus the
         point the arm has been commanded to. When the arm cannot reach that
         point the reach flag and the open cross say so separately, rather than
         folding a workspace limit into a latency number. */
      var ex = hand.x - lagged.x, ey = hand.y - lagged.y;
      errCm = Math.sqrt(ex * ex + ey * ey) * 100;

      /* --- trail: the path still in flight, oldest first ------------------ */
      for (var k = 0; k < TRAIL_N; k++) {
        var f = k / (TRAIL_N - 1);
        sampleAt(t - latApplied * (1 - f), trail[k]);
      }
    }

    function settled() {
      var ex = hand.x - lagged.x, ey = hand.y - lagged.y;
      return !drag.on &&
             Math.abs(latTarget - latApplied) < 0.3 &&
             (ex * ex + ey * ey) < 4e-6;
    }

    function running() {
      return visible && !document.hidden && (!stillMode || active);
    }

    function frame(ts) {
      rafId = 0;
      var t = ts || now();
      var dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
      last = t;

      step(t, dt);
      drawFrame();
      syncReadout(dt, false);

      if (stillMode && settled()) {
        active = false;
        syncReadout(0, true);
        return;
      }
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

    function renderOnce() {
      var t = now();
      step(t, 1 / 60);
      drawFrame();
      syncReadout(0, true);
    }

    function wake() {
      if (stillMode) { active = true; }
      start();
      if (!rafId) { renderOnce(); }
    }

    function onControlChange() {
      scaleMs = pickScale();
      syncBar(true);
      wake();
      if (!rafId) { renderOnce(); }
    }

    /* ===========================================================================
       13.  Interaction
       ======================================================================== */

    var drag = { on: false, id: -1, ox: 0, oy: 0 };

    function setHand(wx, wy) {
      userPos.x = clamp(wx, BOX.x0, BOX.x1);
      userPos.y = clamp(wy, BOX.y0, BOX.y1);
      hand.x = userPos.x;
      hand.y = userPos.y;
      driftW = 0;
      idleT = 0;
    }

    function worldFromEvent(e) {
      var r = cv.getBoundingClientRect();
      return {
        x: (e.clientX - r.left - originX) / scale,
        y: (originY - (e.clientY - r.top)) / scale
      };
    }

    cv.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      var p = worldFromEvent(e);
      var dx = (p.x - hand.x) * scale, dy = (p.y - hand.y) * scale;
      drag.on = true;
      drag.id = e.pointerId;
      /* grab the marker if the press lands on it, otherwise jump to the press */
      if (dx * dx + dy * dy < 40 * 40) {
        drag.ox = hand.x - p.x; drag.oy = hand.y - p.y;
      } else {
        drag.ox = 0; drag.oy = 0;
        setHand(p.x, p.y);
      }
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      cv.classList.add('ks-teleop-grabbing');
      e.preventDefault();
      wake();
    });

    cv.addEventListener('pointermove', function (e) {
      if (!drag.on || e.pointerId !== drag.id) { return; }
      var p = worldFromEvent(e);
      setHand(p.x + drag.ox, p.y + drag.oy);
      wake();
    });

    function endDrag(e) {
      if (!drag.on || e.pointerId !== drag.id) { return; }
      drag.on = false;
      cv.classList.remove('ks-teleop-grabbing');
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
      wake();
    }
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);

    cv.addEventListener('keydown', function (e) {
      var kx = 0, ky = 0;
      if (e.key === 'ArrowLeft') { kx = -1; }
      else if (e.key === 'ArrowRight') { kx = 1; }
      else if (e.key === 'ArrowUp') { ky = 1; }
      else if (e.key === 'ArrowDown') { ky = -1; }
      else { return; }
      e.preventDefault();
      var stp = e.shiftKey ? 0.05 : 0.014;
      setHand(userPos.x + kx * stp, userPos.y + ky * stp);
      wake();
    });

    /* ===========================================================================
       14.  Observers
       ======================================================================== */

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var q = 0; q < entries.length; q++) { visible = entries[q].isIntersecting; }
        if (running()) { start(); } else { stop(); }
      }, { rootMargin: '160px' });
      io.observe(root);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); } else if (running()) { start(); }
    });

    function onMotionChange() {
      var was = stillMode;
      stillMode = isStill();
      if (was === stillMode) { return; }
      if (stillMode) {
        stop();
        active = false;
        driftW = 0;
        hand.x = userPos.x; hand.y = userPos.y;
        syncBar(true);
        renderOnce();
      } else {
        idleT = IDLE_WAIT;
        active = true;
        syncBar(true);
        start();
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
        if (w === lastW && h === lastH) { return; }
        lastW = w; lastH = h;
        readColors();
        wCache = {};
        layout();
        drawFrame();
      }, 160);
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      new window.ResizeObserver(onResize).observe(root);
    }

    /* ---- go -------------------------------------------------------------- */

    instances.push(function () {
      refreshKinematics();
      layout();
      renderOnce();
    });

    readColors();
    layout();
    lastW = cv.clientWidth;
    lastH = cv.clientHeight;
    scaleMs = pickScale();
    latApplied = baseTotal();
    syncBar(true);
    renderOnce();
    if (!stillMode) { start(); }

    /* zero-width container (hidden tab, late fonts): retry once */
    if (!lastW) {
      window.setTimeout(function () {
        if (cv.clientWidth) { layout(); drawFrame(); }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        readColors(); wCache = {}; layout(); drawFrame();
      }, function () {});
    }
  }

  /* ===========================================================================
     15.  Boot
     ======================================================================== */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-teleop]');
    if (!nodes.length) { return; }
    loadKinematics();
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
