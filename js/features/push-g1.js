/* =============================================================================
   PUSH THE HUMANOID  ·  [data-ks-push-g1]
   -----------------------------------------------------------------------------
   A side-view, line-drawn Unitree G1 standing on a ground rule. Shove it with
   a press-drag-release on the torso, or the arrow keys, and it recovers the
   way a real humanoid does: ankle torque first, then hip + arms, then a step
   to the capture point. Past a hard limit it simply falls, and gets back up.

   HONESTY NOTE
   ------------
   The leg and arm link lengths, the standing height and the knee / elbow
   joint limits below are the real numbers parsed out of Unitree's official
   g1_29dof.urdf. They are fetched at runtime from ../assets/robot-kinematics.json
   (this feature ships on /work/ pages, one level under the site root), with
   the same values inlined here as a fallback so the feature never breaks.

   WHAT IS ACTUALLY MODELLED
   -------------------------
   * Planar linear inverted pendulum: the centre of mass rides at pelvis
     height h, ddx = (g/h)(x - cop), g = 9.81. A small viscous term is added
     so quiet stance is reachable; a real controller does that job with
     sensor feedback.
   * Capture point: x_cp = x_com + v * sqrt(h/g), drawn live on the ground.
   * Strategy ladder: the ankle places the centre of pressure to drive the
     capture point home and SATURATES at the 0.20 m foot edge. When it
     saturates, the hip strategy pitches the torso into the fall and
     windmills the arms; the lumbar torque cap and windmill rate are tuned
     for the drawing, the mechanism is the real one. When the capture point
     leaves the foot the swing leg steps TO the capture point (2-link IK,
     real knee limit), support transfers, the trailing foot tidies itself
     back under the pelvis. Big shoves chain several steps: a stumble.
   * Falls: past the capturable band the body tips rigidly about the foot
     edge, crumples, holds a beat, and stands back up. A counter keeps score.

   Mass (35 kg, spec sheet), foot length (0.20 m), forearm length and every
   purely visual proportion are drawing decisions, not URDF joint data.

   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksPushG1Loaded) { return; }
  window.__ksPushG1Loaded = true;

  /* ===========================================================================
     1.  Kinematics - real numbers, with an inlined fallback
     ======================================================================== */

  /* Mirrors the "g1" block of assets/robot-kinematics.json verbatim. */
  var FALLBACK = {
    label: 'Unitree G1 (29 DOF)',
    standingHeight: 1.32,
    links: {
      hipToKnee: 0.19386,        /* m · hip pitch axis to knee axis          */
      kneeToAnkle: 0.30001,      /* m · knee axis to ankle pitch axis        */
      pelvisToHip: 0.1027,       /* m · pelvis origin down to hip axis       */
      pelvisToShoulder: 0.23778, /* m · pelvis origin up to shoulder axis    */
      shoulderToElbow: 0.08205   /* m · shoulder pitch axis to elbow axis    */
    },
    limits: {
      right_knee_joint:  { lower: -0.087267, upper: 2.8798, effort: 139 },
      right_elbow_joint: { lower: -1.0472,   upper: 2.0944, effort: 25 }
    }
  };

  var DATA = FALLBACK;
  var instances = [];
  var fetchStarted = false;

  function loadKinematics() {
    if (fetchStarted || typeof fetch !== 'function') { return; }
    fetchStarted = true;
    /* Relative because this feature ships on /work/ pages; a root-level
       mount is covered by the second attempt, and file:// by the fallback. */
    function attempt(path, next) {
      try {
        fetch(path, { credentials: 'same-origin' })
          .then(function (res) { return res && res.ok ? res.json() : null; })
          .then(function (json) {
            if (json && json.g1 && json.g1.links && json.g1.links.hipToKnee) {
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
  function sgn(v) { return v < 0 ? -1 : 1; }
  function ss(t) { return t * t * (3 - 2 * t); }          /* smoothstep      */
  function wrapPi(a) {
    a = (a + Math.PI) % (2 * Math.PI);
    if (a < 0) { a += 2 * Math.PI; }
    return a - Math.PI;
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

  /* ===========================================================================
     3.  Physics constants (a deliberately small sagittal-plane model)
     ======================================================================== */

  var G_ACC = 9.81;      /* m/s^2                                            */
  var MASS = 35;         /* kg · G1 spec sheet, not URDF                     */
  var FOOT_HALF = 0.10;  /* m · support foot is 0.20 m long                  */
  var ANKLE_H = 0.058;   /* m · drawn ankle height, not URDF                 */
  var ANKLE_BACK = 0.02; /* m · ankle sits behind the foot centre            */
  var K_CP = 1.35;       /* CoP gain > 1 drives the capture point home       */
  var C_V = 1.15;        /* small viscous term so quiet stance is reachable  */
  var C_V_STILL = 2.6;   /* heavier damping in still mode: calm settling     */
  var HIP_ACC = 2.6;     /* m/s^2 · lumbar + arm torque cap over m*h         */
  var STEP_MARGIN = 0.03;/* m · capture point past foot + this fires a step  */
  var STEP_DUR = 0.30;   /* s                                                */
  var TIDY_DUR = 0.26;   /* s · trailing foot regroups under the pelvis      */
  var REACH = 0.34;      /* m · foot placement reach from the pelvis         */
  var MAX_STEP = 0.46;   /* m · beyond this no step can capture              */
  var V_FALL = 1.95;     /* m/s · hard fall threshold                        */
  var TH_DOWN = 1.35;    /* rad · tip angle at which the body is down        */
  var CRUMPLE_T = 0.38, HOLD_T = 0.9, RISE_T = 1.15;
  var CRUMPLE_PX = 0.34; /* m · pelvis offset from the pivot when down       */
  var J_MAX = 90;        /* N·s · drag charge cap                            */
  var J_KEY = 12, J_KEY_BIG = 40;
  var DRAG_J_PER_M = 60; /* N·s per metre of on-screen drag: a fall takes a
                            long, deliberate pull, the ladder stays legible  */
  var S_PITCH = 34, C_PITCH = 8.5;
  var ARM_REST = 0.12;   /* rad · hanging arm angle                          */
  var FOREARM = 0.17;    /* m · drawn, the URDF stops at the elbow           */
  var NECK = 0.045, HEAD_R = 0.082;   /* m · drawn                          */

  var STRAT_WORD = {
    quiet: 'Quiet', ankle: 'Ankle', hip: 'Hip', step: 'Step', falling: 'Falling'
  };

  var uid = 0;

  /* ===========================================================================
     4.  Instance
     ======================================================================== */

  function mount(root) {
    if (root.__ksPushG1) { return; }
    root.__ksPushG1 = true;
    uid++;

    /* ---- URDF-derived constants, refreshed when the fetch lands --------- */
    var L1 = 0.19386, L2 = 0.30001, P2HIP = 0.1027;
    var TORSO = 0.23778, UPARM = 0.08205;
    var STAND_H = 1.32;
    var D_MIN = 0.1234, D_MAX = 0.49387;
    var ELB_HI = 2.0944;
    var H = 0.642;                 /* pelvis (CoM) height, from the links    */
    var Tc = Math.sqrt(H / G_ACC); /* the capture point time constant        */

    function refreshKinematics() {
      var lk = (DATA && DATA.links) || FALLBACK.links;
      var lm = (DATA && DATA.limits) || FALLBACK.limits;
      L1 = lk.hipToKnee || 0.19386;
      L2 = lk.kneeToAnkle || 0.30001;
      P2HIP = lk.pelvisToHip || 0.1027;
      TORSO = lk.pelvisToShoulder || 0.23778;
      UPARM = lk.shoulderToElbow || 0.08205;
      STAND_H = DATA.standingHeight || 1.32;
      var knee = lm.right_knee_joint || FALLBACK.limits.right_knee_joint;
      var elb = lm.right_elbow_joint || FALLBACK.limits.right_elbow_joint;
      ELB_HI = elb.upper;
      /* Knee flexion q maps to the interior knee angle PI - q, so the joint
         range becomes a reachable hip-to-ankle distance band for the IK. */
      var gLo = Math.PI - knee.upper;   /* most folded                       */
      var gHi = Math.PI - knee.lower;   /* hyper-extended end                */
      function law(g) {
        return Math.sqrt(Math.max(0, L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(g)));
      }
      D_MIN = law(gLo);
      D_MAX = (gLo <= Math.PI && Math.PI <= gHi)
        ? (L1 + L2) : Math.max(law(gLo), law(gHi));
      /* Stand with a touch of knee bend; CoM height follows the real links. */
      H = ANKLE_H + 0.975 * D_MAX + P2HIP;
      Tc = Math.sqrt(H / G_ACC);
    }
    refreshKinematics();

    /* ---- simulation state ----------------------------------------------- */

    var xCom = 0, vCom = 0;
    var ft = [{ x: 0, y: 0 }, { x: 0, y: 0 }];   /* [near, far] foot centres */
    var support = 0;
    var swing = { on: false, kind: 'step', leg: 1, t: 0, dur: STEP_DUR, x0: 0, x1: 0, h: 0.06 };
    var torsoPitch = 0, pitchV = 0;
    var hipEff = 0, armEng = 0, armDir = 1;
    var armA = { ang: ARM_REST, v: 0 };
    var armB = { ang: ARM_REST, v: 0 };
    var fall = { phase: 0, dir: 1, pivot: 0, th: 0, thV: 0, t: 0,
                 px0: 0, py0: 0, pitch0: 0, fax0: 0, fbx0: 0,
                 pA: null, pB: null, pC: null, standX: 0 };
    var falls = 0;
    var lastJ = 0;
    var lastCpOff = 0;
    var idleT = 0;
    var camX = 0;
    var mode = 'quiet';

    /* The one pose everything is drawn from. Balance, falling and getting
       up all reduce to these numbers, so blending states stays trivial. */
    var pose = { px: 0, py: H, pitch: 0, fax: 0, fay: 0, fbx: 0, fby: 0,
                 aA: ARM_REST, aB: ARM_REST, bendA: 0.32, bendB: 0.32, drop: 0 };

    /* ---- DOM ------------------------------------------------------------ */

    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-push-g1');
    if ((root.getAttribute('data-ks-push-g1') || '').toLowerCase() === 'light') {
      root.classList.add('ks-push-g1-on-light');
    }

    var head = el('div', 'ks-push-g1-head');
    head.appendChild(el('p', 'ks-push-g1-eyebrow', 'Push the humanoid · balance recovery'));
    head.appendChild(el('p', 'ks-push-g1-credit', 'Link lengths + joint limits from Unitree G1 URDF'));
    root.appendChild(head);

    var stage = el('div', 'ks-push-g1-stage');
    var cv = el('canvas', 'ks-push-g1-canvas');
    cv.setAttribute('tabindex', '0');
    cv.setAttribute('aria-label',
      'Side view line drawing of a Unitree G1 humanoid balancing on the spot. ' +
      'Drag the torso and release to shove it, or press the left and right ' +
      'arrow keys. Hold shift for a harder push.');
    stage.appendChild(cv);
    var fallsEl = el('span', 'ks-push-g1-falls', 'Falls · 0');
    fallsEl.hidden = true;
    fallsEl.setAttribute('aria-hidden', 'true');   /* the live region scores */
    stage.appendChild(fallsEl);
    root.appendChild(stage);

    root.appendChild(el('p', 'ks-push-g1-hint',
      'Drag the torso · release to shove · arrow keys push'));

    var readout = el('div', 'ks-push-g1-readout');
    var cells = {};
    var CELL_DEFS = [
      ['strategy', 'Strategy'], ['impulse', 'Impulse'],
      ['com', 'CoM offset'], ['cp', 'Capture point']
    ];
    for (var di = 0; di < CELL_DEFS.length; di++) {
      var cell = el('span', 'ks-push-g1-cell');
      cell.appendChild(el('span', 'ks-push-g1-cellkey', CELL_DEFS[di][1]));
      var b = el('b', 'ks-push-g1-cellval', '··');
      cell.appendChild(b);
      readout.appendChild(cell);
      cells[CELL_DEFS[di][0]] = b;
    }
    root.appendChild(readout);

    var status = el('p', 'ks-push-g1-sr');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.appendChild(status);

    /* ---- canvas plumbing ------------------------------------------------ */

    var g = cv.getContext ? cv.getContext('2d') : null;
    if (!g) { return; }

    var dpr = 1, SW = 0, SH = 0;
    var scale = 220, originX = 0, groundY = 0;
    var INK = [242, 239, 233];
    var FAMILY = "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    function ink(a) {
      return 'rgba(' + INK[0] + ',' + INK[1] + ',' + INK[2] + ',' + a + ')';
    }
    function readColors() {
      var cs = window.getComputedStyle(root);
      INK = parseRGB(cs.color, [242, 239, 233]);
      if (cs.fontFamily) { FAMILY = cs.fontFamily; }
    }

    function sx(x) { return originX + (x - camX) * scale; }
    function sy(y) { return groundY - y * scale; }

    function layout() {
      var w = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 320;
      var h = cv.clientHeight || 300;
      dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2  */
      var pw = Math.max(1, Math.round(w * dpr));
      var ph = Math.max(1, Math.round(h * dpr));
      if (cv.width !== pw) { cv.width = pw; }
      if (cv.height !== ph) { cv.height = ph; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      SW = w; SH = h;
      groundY = SH - Math.max(34, Math.round(SH * 0.14));
      scale = Math.min((groundY - 26) / (STAND_H * 1.1), (SW * 0.42) / 0.8);
      scale = clamp(scale, 80, 460);
      originX = Math.round(SW * 0.5);
    }

    function labelPx() { return clamp(SW / 78, 8.5, 10.5); }

    /* Tracked micro-labels, characters placed by hand (canvas letterSpacing
       is not universal). Widths memoised against a bounded key set. */
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
      for (var i = 0; i < str.length; i++) { w += charW(str.charAt(i), size, weight) + tr; }
      return w - tr;
    }
    /* align: -1 left, 0 centre, 1 right */
    function tracked(str, x, y, size, weight, alpha, trEm, align) {
      g.font = weight + ' ' + size + 'px ' + FAMILY;
      g.fillStyle = ink(alpha);
      var tr = size * trEm;
      var w = trackedWidth(str, size, weight, trEm);
      var cx = align === 1 ? x - w : (align === 0 ? x - w / 2 : x);
      for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        g.fillText(ch, cx, y);
        cx += charW(ch, size, weight) + tr;
      }
    }

    /* ===========================================================================
       5.  2-link leg IK, knee limit enforced as a distance band
       ======================================================================== */

    var solA = { hx: 0, hy: 0, kx: 0, ky: 0, fx: 0, fy: 0, clamped: false };
    var solB = { hx: 0, hy: 0, kx: 0, ky: 0, fx: 0, fy: 0, clamped: false };

    /* All in metres, y up. The knee-forward branch is the only one the G1's
       knee can fold into while the figure faces +x. */
    function solveLeg(hx, hy, tx, ty, o) {
      o.hx = hx; o.hy = hy;
      var vx = tx - hx, vy = ty - hy;
      var d = Math.sqrt(vx * vx + vy * vy);
      var ux, uy;
      if (d < 1e-6) { ux = 0; uy = -1; d = 1e-6; } else { ux = vx / d; uy = vy / d; }
      var dc = clamp(d, D_MIN, D_MAX);
      o.clamped = Math.abs(dc - d) > 1e-4;
      d = dc;
      var ca = clamp((d * d + L1 * L1 - L2 * L2) / (2 * d * L1), -1, 1);
      var al = Math.acos(ca);
      var c = Math.cos(al), s = Math.sin(al);
      /* two mirror knees; take the one that sits forward (+x) */
      var k1x = hx + L1 * (ux * c - uy * s), k1y = hy + L1 * (ux * s + uy * c);
      var k2x = hx + L1 * (ux * c + uy * s), k2y = hy + L1 * (ux * (-s) + uy * c);
      if (k1x >= k2x) { o.kx = k1x; o.ky = k1y; } else { o.kx = k2x; o.ky = k2y; }
      o.fx = hx + ux * d;
      o.fy = hy + uy * d;
    }

    /* ===========================================================================
       6.  Balance simulation
       ======================================================================== */

    function startSwing(kind, leg, x1) {
      swing.on = true;
      swing.kind = kind;
      swing.leg = leg;
      swing.t = 0;
      swing.dur = kind === 'step' ? STEP_DUR : TIDY_DUR;
      swing.x0 = ft[leg].x;
      swing.x1 = x1;
      swing.h = kind === 'step'
        ? 0.05 + 0.12 * Math.min(1, Math.abs(x1 - swing.x0) / 0.4)
        : 0.035;
    }

    function stepArm(a, lag, dt) {
      if (armEng > 0.05) {
        var rate = armDir * (6.5 + 9.5 * armEng);
        a.v += (rate - a.v) * Math.min(1, 6 * dt);
        a.ang += a.v * dt;
      } else {
        var rest = ARM_REST + (stillMode ? 0 : Math.sin(idleT * 1.05 + lag) * 0.06);
        var d = wrapPi(rest - a.ang);
        a.v += (26 * d - 8 * a.v) * dt;
        a.ang += a.v * dt;
      }
    }

    function beginFall(dir) {
      falls++;
      fallsEl.textContent = 'Falls · ' + falls;
      fallsEl.hidden = false;
      fall.phase = 1;
      fall.dir = dir || 1;
      fall.pivot = ft[support].x + fall.dir * FOOT_HALF;
      fall.th = Math.max(0.03, clamp(fall.dir * (xCom - fall.pivot) / H, -0.12, 0.45));
      fall.thV = Math.abs(vCom) / H;
      fall.t = 0;
      fall.px0 = pose.px; fall.py0 = pose.py; fall.pitch0 = pose.pitch;
      fall.fax0 = ft[0].x; fall.fbx0 = ft[1].x;
      swing.on = false;
      hipEff = 0;
      armEng = 1;
      armDir = fall.dir;
    }

    function stepFall(dt) {
      var i;
      if (fall.phase === 1) {
        /* rigid tip about the foot edge */
        var acc = (G_ACC / H) * Math.sin(Math.max(fall.th, 0.02));
        fall.thV += acc * dt;
        fall.th += fall.thV * dt;
        for (i = 0; i < 2; i++) {
          var a = i ? armB : armA;
          a.v += (fall.dir * 13 - a.v) * Math.min(1, 5 * dt);
          a.ang += a.v * dt;
        }
        if (fall.th >= TH_DOWN) {
          fall.th = TH_DOWN;
          fall.phase = 2;
          fall.t = 0;
          rotPose(TH_DOWN, pose);
          pose.aA = wrapPi(armA.ang); pose.aB = wrapPi(armB.ang);
          fall.pA = copyPose(pose, fall.pA);
          fall.pB = crumplePose(fall.pB);
        }
      } else if (fall.phase === 2) {
        fall.t += dt;
        if (fall.t >= CRUMPLE_T + HOLD_T) {
          fall.phase = 3;
          fall.t = 0;
          fall.standX = fall.pivot + fall.dir * CRUMPLE_PX;
          fall.pC = standPose(fall.standX, fall.pC);
        }
      } else if (fall.phase === 3) {
        fall.t += dt;
        if (fall.t >= RISE_T) {
          fall.phase = 0;
          xCom = fall.standX; vCom = 0;
          ft[0].x = fall.standX; ft[0].y = 0;
          ft[1].x = fall.standX; ft[1].y = 0;
          support = 0;
          torsoPitch = 0; pitchV = 0;
          hipEff = 0; armEng = 0;
          armA.ang = ARM_REST; armA.v = 0;
          armB.ang = ARM_REST; armB.v = 0;
          lastCpOff = 0;
        }
      }
    }

    function stepSim(dt) {
      idleT += dt;
      if (fall.phase) { stepFall(dt); return; }

      var sup = ft[support].x;
      var cp = xCom + vCom * Tc;
      var cpOff = cp - sup;

      /* ankle strategy: capture-point CoP controller, clamped to the foot */
      var p = sup + K_CP * cpOff;
      var sat = false;
      if (p < sup - FOOT_HALF) { p = sup - FOOT_HALF; sat = true; }
      else if (p > sup + FOOT_HALF) { p = sup + FOOT_HALF; sat = true; }

      /* idle sway: a millimetre CoP wander, motion mode only */
      if (!stillMode && !sat && hipEff < 0.04 && !swing.on) {
        p += Math.sin(idleT * 0.9) * 0.006 + Math.sin(idleT * 1.7 + 2.1) * 0.0035;
        p = clamp(p, sup - FOOT_HALF, sup + FOOT_HALF);
      }

      var damp = stillMode ? C_V_STILL : C_V;
      vCom += ((G_ACC / H) * (xCom - p) - damp * vCom) * dt;
      xCom += vCom * dt;

      /* hip strategy: engages as the CoP saturates */
      var effT = sat ? clamp((Math.abs(cpOff) - FOOT_HALF * 0.72) / 0.10, 0, 1) : 0;
      hipEff += (effT - hipEff) * Math.min(1, 9 * dt);
      if (hipEff > 0.02) {
        armDir = sgn(cpOff);
        vCom -= sgn(cpOff) * HIP_ACC * hipEff * dt;
      }

      cp = xCom + vCom * Tc;
      cpOff = cp - sup;

      if (swing.on) {
        /* a fall mid-swing means no reachable placement can capture */
        if (Math.abs(cp - xCom) > REACH + FOOT_HALF + 0.05) {
          beginFall(sgn(vCom || cpOff));
          return;
        }
        swing.t += dt / swing.dur;
        if (swing.kind === 'step') {
          /* capture-point stepping: the target tracks the live x_cp */
          var tgt = clamp(cp, xCom - REACH, xCom + REACH);
          swing.x1 += (tgt - swing.x1) * Math.min(1, 9 * dt);
        }
        if (swing.t >= 1) {
          swing.t = 1;
          ft[swing.leg].x = swing.x1;
          ft[swing.leg].y = 0;
          if (swing.kind === 'step') { support = swing.leg; }
          swing.on = false;
        } else {
          var u = ss(swing.t);
          ft[swing.leg].x = swing.x0 + (swing.x1 - swing.x0) * u;
          ft[swing.leg].y = Math.sin(Math.PI * swing.t) * swing.h;
        }
      } else {
        if (Math.abs(vCom) > V_FALL || Math.abs(cpOff) > MAX_STEP) {
          beginFall(sgn(vCom || cpOff));
          return;
        }
        if (Math.abs(cpOff) > FOOT_HALF + STEP_MARGIN) {
          startSwing('step', 1 - support, clamp(cp, xCom - REACH, xCom + REACH));
        } else if (Math.abs(vCom) < 0.14 && Math.abs(cpOff) < 0.05 &&
                   Math.abs(ft[1 - support].x - sup) > 0.045) {
          startSwing('tidy', 1 - support, sup);
        }
      }

      /* torso pitch: a lean with the offset, plus the hip strategy demand */
      var pitchT = clamp((xCom - sup) * 0.5, -0.10, 0.10) + sgn(cpOff) * 0.55 * hipEff;
      if (swing.on && swing.kind === 'step') {
        pitchT += sgn(swing.x1 - swing.x0) * 0.07;
      }
      pitchV += (S_PITCH * (pitchT - torsoPitch) - C_PITCH * pitchV) * dt;
      torsoPitch += pitchV * dt;

      /* arms: windmill while the hip strategy or a step is live */
      var engT = Math.max(hipEff, (swing.on && swing.kind === 'step') ? 0.45 : 0);
      armEng += (engT - armEng) * Math.min(1, 7 * dt);
      stepArm(armA, 0, dt);
      stepArm(armB, 2.2, dt);

      lastCpOff = cpOff;
    }

    /* ===========================================================================
       7.  Pose construction: balance, tipping, crumple, rise
       ======================================================================== */

    function copyPose(src, out) {
      out = out || {};
      out.px = src.px; out.py = src.py; out.pitch = src.pitch;
      out.fax = src.fax; out.fay = src.fay; out.fbx = src.fbx; out.fby = src.fby;
      out.aA = src.aA; out.aB = src.aB;
      out.bendA = src.bendA; out.bendB = src.bendB;
      out.drop = src.drop;
      return out;
    }

    function blendPose(a, b, k, out) {
      var k2 = ss(Math.min(1, k * 1.6));   /* feet lead the body            */
      out.px = a.px + (b.px - a.px) * k;
      out.py = a.py + (b.py - a.py) * k;
      out.pitch = a.pitch + (b.pitch - a.pitch) * k;
      out.fax = a.fax + (b.fax - a.fax) * k2;
      out.fay = a.fay + (b.fay - a.fay) * k2;
      out.fbx = a.fbx + (b.fbx - a.fbx) * k2;
      out.fby = a.fby + (b.fby - a.fby) * k2;
      out.aA = a.aA + (b.aA - a.aA) * k;
      out.aB = a.aB + (b.aB - a.aB) * k;
      out.bendA = a.bendA + (b.bendA - a.bendA) * k;
      out.bendB = a.bendB + (b.bendB - a.bendB) * k;
      out.drop = a.drop + (b.drop - a.drop) * k;
      return out;
    }

    /* the frozen pre-fall pose, rotated rigidly about the foot edge */
    function rotPose(th, out) {
      var d = fall.dir, c = Math.cos(th), s = Math.sin(th);
      var dx = fall.px0 - fall.pivot;
      out.px = fall.pivot + dx * c + fall.py0 * d * s;
      out.py = -dx * d * s + fall.py0 * c;
      if (out.py < 0.06) { out.py = 0.06; }
      out.pitch = fall.pitch0 + d * th;
      out.fax = fall.fax0; out.fay = 0;
      out.fbx = fall.fbx0; out.fby = 0;
      out.aA = armA.ang; out.aB = armB.ang;
      out.bendA = 0.55; out.bendB = 0.55;
      out.drop = d * Math.min(0.3, th * 0.3);
      return out;
    }

    function crumplePose(out) {
      out = out || {};
      var d = fall.dir, P = fall.pivot;
      out.px = P + d * CRUMPLE_PX;
      out.py = ANKLE_H + 0.10;
      out.pitch = d * 1.25;
      out.fax = P + d * 0.03; out.fay = 0.02;
      out.fbx = P + d * 0.10; out.fby = 0.05;
      out.aA = d * 2.3; out.aB = d * 1.9;
      out.bendA = 0.5; out.bendB = 0.65;
      out.drop = d * 0.55;
      return out;
    }

    function standPose(x, out) {
      out = out || {};
      out.px = x; out.py = H; out.pitch = 0;
      out.fax = x; out.fay = 0; out.fbx = x; out.fby = 0;
      out.aA = ARM_REST; out.aB = ARM_REST;
      out.bendA = 0.32; out.bendB = 0.32;
      out.drop = 0;
      return out;
    }

    function buildPose() {
      if (!fall.phase) {
        var stepK = (swing.on && swing.kind === 'step') ? Math.sin(Math.PI * swing.t) : 0;
        pose.px = xCom;
        pose.py = H - 0.045 * stepK - 0.02 * hipEff
          + (stillMode ? 0 : Math.sin(idleT * 1.25) * 0.005);
        pose.pitch = torsoPitch;
        pose.fax = ft[0].x; pose.fay = ft[0].y;
        pose.fbx = ft[1].x; pose.fby = ft[1].y;
        pose.aA = armA.ang;
        pose.aB = armB.ang + armEng * 0.5;   /* far arm trails the windmill  */
        pose.bendA = 0.32 + 0.25 * armEng;
        pose.bendB = 0.32 + 0.25 * armEng;
        pose.drop = 0;
      } else if (fall.phase === 1) {
        rotPose(fall.th, pose);
      } else if (fall.phase === 2) {
        var k = ss(Math.min(1, fall.t / CRUMPLE_T));
        blendPose(fall.pA, fall.pB, k, pose);
      } else {
        var k3 = ss(Math.min(1, fall.t / RISE_T));
        blendPose(fall.pB, fall.pC, k3, pose);
      }
      pose.bendA = clamp(pose.bendA, 0, ELB_HI * 0.9);
      pose.bendB = clamp(pose.bendB, 0, ELB_HI * 0.9);
    }

    /* ===========================================================================
       8.  Drawing
       ======================================================================== */

    /* chest slab and pelvis box, in the torso frame (metres) */
    var CHEST = [
      [-0.052, 0.045], [-0.066, 0.115], [-0.058, 0.235], [-0.028, 0.257],
      [0.042, 0.257], [0.064, 0.205], [0.058, 0.085], [0.042, 0.045]
    ];
    var PELV = [[-0.055, 0.028], [-0.048, -0.052], [0.048, -0.052], [0.055, 0.028]];

    function circle(x, y, r, filled) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      if (filled) { g.fill(); } else { g.stroke(); }
    }

    function drawFootShape(cxm, cym, ox, oy, alpha, lw) {
      var ax = sx(cxm - ANKLE_BACK) + ox, ay = sy(cym + ANKLE_H) + oy;
      var hx = sx(cxm - FOOT_HALF) + ox, hy = sy(cym + 0.004) + oy;
      var tx = sx(cxm + FOOT_HALF) + ox, ty = hy;
      g.strokeStyle = ink(alpha);
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(hx, hy); g.lineTo(ax, ay); g.lineTo(tx, ty);
      g.moveTo(hx, hy); g.lineTo(tx, ty);
      g.stroke();
      g.lineWidth = 1;
      circle(ax, ay, lw * 1.3, false);
    }

    function drawLegAndFoot(hipx, hipy, footCx, footCy, sol, ox, oy, alpha, lw) {
      solveLeg(hipx, hipy, footCx - ANKLE_BACK, footCy + ANKLE_H, sol);
      g.strokeStyle = ink(alpha);
      g.fillStyle = ink(alpha);
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(sx(sol.hx) + ox, sy(sol.hy) + oy);
      g.lineTo(sx(sol.kx) + ox, sy(sol.ky) + oy);
      g.lineTo(sx(sol.fx) + ox, sy(sol.fy) + oy);
      g.stroke();
      g.lineWidth = 1;
      circle(sx(sol.hx) + ox, sy(sol.hy) + oy, lw * 1.6, false);
      circle(sx(sol.kx) + ox, sy(sol.ky) + oy, lw * 1.3, false);
      /* the foot rides the ankle the IK actually reached, so a leg pinned by
         its joint limits visibly leaves the commanded spot behind */
      drawFootShape(sol.fx + ANKLE_BACK, sol.fy - ANKLE_H, ox, oy, alpha, Math.max(1, lw - 0.4));
    }

    function drawArm(shx, shy, ang, bend, ox, oy, alpha, lw) {
      var ex = shx + Math.sin(ang) * UPARM;
      var ey = shy - Math.cos(ang) * UPARM;
      var a2 = ang + bend;
      var wx = ex + Math.sin(a2) * FOREARM;
      var wy = ey - Math.cos(a2) * FOREARM;
      g.strokeStyle = ink(alpha);
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(sx(shx) + ox, sy(shy) + oy);
      g.lineTo(sx(ex) + ox, sy(ey) + oy);
      g.lineTo(sx(wx) + ox, sy(wy) + oy);
      g.stroke();
      g.lineWidth = 1;
      circle(sx(shx) + ox, sy(shy) + oy, lw * 1.4, false);
      circle(sx(ex) + ox, sy(ey) + oy, lw * 1.1, false);
      circle(sx(wx) + ox, sy(wy) + oy, lw * 0.9, true);
    }

    function torsoPoly(pts, fx, fy, ux, uyv) {
      g.beginPath();
      for (var i = 0; i < pts.length; i++) {
        var wx = pose.px + fx * pts[i][0] + ux * pts[i][1];
        var wy = pose.py + fy * pts[i][0] + uyv * pts[i][1];
        if (i === 0) { g.moveTo(sx(wx), sy(wy)); } else { g.lineTo(sx(wx), sy(wy)); }
      }
      g.closePath();
    }

    function leader(x, y, text, dir, lp) {
      var lx = x + 13 * dir, ly = y - 9;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(lx, ly);
      g.lineTo(lx + 9 * dir, ly);
      g.stroke();
      tracked(text, lx + 12 * dir, ly + lp * 0.36, lp, 600, 0.5, 0.2, dir === 1 ? -1 : 1);
    }

    function drawFrame() {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, SW, SH);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.textBaseline = 'alphabetic';
      var lp = labelPx();
      var i;

      /* --- ground rule with world-fixed ticks, so steps read as travel --- */
      g.strokeStyle = ink(0.55);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(0, groundY);
      g.lineTo(SW, groundY);
      g.stroke();

      var span = SW / scale;
      var t0 = Math.floor((camX - span / 2) / 0.25) * 0.25;
      g.lineWidth = 1;
      g.beginPath();
      for (var tx = t0; tx < camX + span / 2 + 0.25; tx += 0.25) {
        var isM = Math.abs(tx - Math.round(tx)) < 0.01;
        var px = Math.round(sx(tx)) + 0.5;
        g.moveTo(px, groundY + 1);
        g.lineTo(px, groundY + (isM ? 8 : 4));
      }
      g.strokeStyle = ink(0.16);
      g.stroke();

      /* --- support foot band: the CoP constraint made visible ------------ */
      if (fall.phase < 2) {
        var sc = ft[support].x;
        g.strokeStyle = ink(0.44);
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(sx(sc - FOOT_HALF), groundY + 3);
        g.lineTo(sx(sc + FOOT_HALF), groundY + 3);
        g.stroke();
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(sx(sc - FOOT_HALF) + 0.5, groundY + 1);
        g.lineTo(sx(sc - FOOT_HALF) + 0.5, groundY + 7);
        g.moveTo(sx(sc + FOOT_HALF) + 0.5, groundY + 1);
        g.lineTo(sx(sc + FOOT_HALF) + 0.5, groundY + 7);
        g.stroke();
        if (mode === 'quiet') {
          /* right-aligned off the heel, clear of the CP marker at centre */
          tracked('200 MM FOOT', sx(sc - FOOT_HALF) - 10, groundY + 8 + lp * 1.4,
            lp, 600, 0.4, 0.2, 1);
        }
      }

      /* --- capture point marker ------------------------------------------ */
      if (!fall.phase) {
        var cp = xCom + vCom * Tc;
        var out = Math.abs(cp - ft[support].x) > FOOT_HALF;
        var cpx = sx(cp);
        g.strokeStyle = ink(0.85);
        g.fillStyle = ink(0.85);
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(cpx, groundY + 2);
        g.lineTo(cpx - 5, groundY + 12);
        g.lineTo(cpx + 5, groundY + 12);
        g.closePath();
        if (out) { g.fill(); } else { g.stroke(); }
        tracked('CP', cpx, groundY + 13 + lp * 1.25, lp, 600, 0.6, 0.2, 0);
      }

      /* --- torso frame ---------------------------------------------------- */
      var fx = Math.cos(pose.pitch), fy = -Math.sin(pose.pitch);   /* fwd    */
      var ux = Math.sin(pose.pitch), uy = Math.cos(pose.pitch);    /* up     */
      var pt = pose.pitch * 0.25;
      var hipx = pose.px - Math.sin(pt) * P2HIP;
      var hipy = pose.py - Math.cos(pt) * P2HIP;
      var shx = pose.px + ux * TORSO;
      var shy = pose.py + uy * TORSO;

      var farDx = Math.max(3, scale * 0.015);
      var farDy = -Math.max(2, scale * 0.010);

      /* --- far limbs, then torso, then near limbs ------------------------- */
      drawLegAndFoot(hipx, hipy, pose.fbx, pose.fby, solB, farDx, farDy, 0.34, 1.1);
      drawArm(shx, shy, pose.aB, pose.bendB, farDx, farDy, 0.34, 1.2);

      g.strokeStyle = ink(0.92);
      g.lineWidth = 1.7;
      torsoPoly(PELV, fx, fy, ux, uy);
      g.stroke();
      torsoPoly(CHEST, fx, fy, ux, uy);
      g.stroke();
      g.lineWidth = 1.3;
      g.beginPath();                       /* pelvis yoke down to the hips   */
      g.moveTo(sx(pose.px), sy(pose.py));
      g.lineTo(sx(hipx), sy(hipy));
      g.stroke();

      /* head: circle + visor slit, tipped a little further than the chest */
      var hp = pose.pitch + pose.drop;
      var hux = Math.sin(hp), huy = Math.cos(hp);
      var hcx = shx + hux * (NECK + HEAD_R);
      var hcy = shy + huy * (NECK + HEAD_R);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(sx(shx), sy(shy));
      g.lineTo(sx(shx + hux * NECK), sy(shy + huy * NECK));
      g.stroke();
      circle(sx(hcx), sy(hcy), HEAD_R * scale, false);
      var vfx = Math.cos(hp), vfy = -Math.sin(hp);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(sx(hcx + vfx * 0.015 + hux * 0.012), sy(hcy + vfy * 0.015 + huy * 0.012));
      g.lineTo(sx(hcx + vfx * 0.062 + hux * 0.012), sy(hcy + vfy * 0.062 + huy * 0.012));
      g.stroke();

      drawLegAndFoot(hipx, hipy, pose.fax, pose.fay, solA, 0, 0, 0.92, 1.9);
      drawArm(shx, shy, pose.aA, pose.bendA, 0, 0, 0.9, 1.7);

      /* --- centre of mass glyph + drop line ------------------------------- */
      var cmx = sx(pose.px), cmy = sy(pose.py);
      var cr = Math.max(3.5, scale * 0.02);
      g.strokeStyle = ink(0.9);
      g.fillStyle = ink(0.9);
      g.lineWidth = 1.2;
      circle(cmx, cmy, cr, false);
      g.beginPath();
      g.moveTo(cmx, cmy);
      g.arc(cmx, cmy, cr, -Math.PI / 2, 0);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(cmx, cmy);
      g.arc(cmx, cmy, cr, Math.PI / 2, Math.PI);
      g.closePath();
      g.fill();
      if (!fall.phase) {
        g.save();
        g.setLineDash([2, 4]);
        g.strokeStyle = ink(0.3);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(cmx, cmy + cr + 3);
        g.lineTo(cmx, groundY - 2);
        g.stroke();
        g.restore();
      }

      /* --- dimensions: only URDF numbers get leaders ---------------------- */
      if (!fall.phase) {
        g.strokeStyle = ink(0.3);
        g.lineWidth = 1;
        leader((sx(solA.hx) + sx(solA.kx)) / 2, (sy(solA.hy) + sy(solA.ky)) / 2,
          Math.round(L1 * 1000) + ' MM THIGH', 1, lp);
        leader((sx(solA.kx) + sx(solA.fx)) / 2, (sy(solA.ky) + sy(solA.fy)) / 2,
          Math.round(L2 * 1000) + ' MM SHIN', 1, lp);

        /* the pendulum height the whole model runs on, flagged as model */
        var bx = sx(pose.px - 0.40);
        g.strokeStyle = ink(0.24);
        g.beginPath();
        g.moveTo(bx, sy(pose.py));
        g.lineTo(bx, groundY);
        g.moveTo(bx - 4, sy(pose.py)); g.lineTo(bx + 4, sy(pose.py));
        g.moveTo(bx - 4, groundY); g.lineTo(bx + 4, groundY);
        g.stroke();
        tracked('H ' + Math.round(H * 1000) + ' MM · MODEL',
          bx - 7, (sy(pose.py) + groundY) / 2 + lp * 0.36, lp, 600, 0.45, 0.2, 1);
      }

      /* --- charge arrow ---------------------------------------------------- */
      if (charging.on && charging.J >= 2) {
        var full = TORSO + NECK + HEAD_R * 2;
        var awx = pose.px + Math.sin(pose.pitch) * (charging.u * full);
        var awy = pose.py + Math.cos(pose.pitch) * (charging.u * full);
        var ax = sx(awx), ay = sy(awy);
        var len = 22 + (charging.J / J_MAX) * 96;
        var tipx = ax + charging.dir * len;
        g.strokeStyle = ink(0.9);
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(tipx, ay);
        g.moveTo(tipx, ay);
        g.lineTo(tipx - charging.dir * 7, ay - 4.5);
        g.moveTo(tipx, ay);
        g.lineTo(tipx - charging.dir * 7, ay + 4.5);
        g.stroke();
        tracked(Math.round(charging.J) + ' N·S',
          (ax + tipx) / 2, ay - 8, lp, 600, 0.8, 0.2, 0);
      }

      /* --- provenance ------------------------------------------------------ */
      tracked('URDF LINKS + JOINT LIMITS · SIMULATED BALANCE',
        SW - 8, SH - 6, lp, 600, 0.34, 0.2, 1);
    }

    /* ===========================================================================
       9.  Readouts + announcements
       ======================================================================== */

    function classify() {
      if (fall.phase) { return 'falling'; }
      if (swing.on && swing.kind === 'step') { return 'step'; }
      if (hipEff > 0.06) { return 'hip'; }
      if (Math.abs(lastCpOff) > 0.012 || Math.abs(vCom) > 0.06) { return 'ankle'; }
      return 'quiet';
    }

    var txtCache = { strategy: '', impulse: '', com: '', cp: '' };
    function setCell(key, txt) {
      if (txtCache[key] !== txt) {
        txtCache[key] = txt;
        cells[key].textContent = txt;
      }
    }

    var statusTimer = null;
    function announceMode(m) {
      if (statusTimer) { window.clearTimeout(statusTimer); }
      statusTimer = window.setTimeout(function () {
        statusTimer = null;
        var msg;
        if (m === 'quiet') { msg = 'Quiet stance.'; }
        else if (m === 'ankle') { msg = 'Ankle strategy, capture point inside the foot.'; }
        else if (m === 'hip') { msg = 'Hip strategy, torso and arms recruited.'; }
        else if (m === 'step') { msg = 'Recovery step toward the capture point.'; }
        else { msg = 'Fall ' + falls + ', beyond recovery, standing back up.'; }
        status.textContent = msg;
      }, 380);
    }

    function syncReadout() {
      var m = classify();
      if (m !== mode) {
        mode = m;
        setCell('strategy', STRAT_WORD[m]);
        announceMode(m);
      }
      var supRef = fall.phase ? (fall.pivot - fall.dir * FOOT_HALF) : ft[support].x;
      var off = (pose.px - supRef) * 100;
      var mag = Math.abs(off);
      var offTxt = mag < 0.05 ? '0.0 cm'
        : (off > 0 ? '+' : '−') + mag.toFixed(1) + ' cm';
      setCell('com', offTxt);
      var inFoot = !fall.phase && Math.abs(lastCpOff) <= FOOT_HALF;
      setCell('cp', inFoot ? 'In' : 'Out');
      setCell('impulse', lastJ ? lastJ.toFixed(1) + ' N·s' : '··');
    }

    /* ===========================================================================
       10.  Frame loop / lifecycle
       ======================================================================== */

    var rafId = 0, last = 0;
    var visible = true;
    var stillMode = isStill();
    var active = false;      /* still mode: a push transient is resolving   */
    var activeT = 0;

    function running() {
      if (document.hidden || !visible) { return false; }
      return stillMode ? active : true;
    }

    function settledNow() {
      return fall.phase === 0 && !swing.on &&
        Math.abs(vCom) < 0.02 &&
        Math.abs(xCom - ft[support].x) < 0.008 &&
        Math.abs(ft[1 - support].x - ft[support].x) < 0.05 &&
        hipEff < 0.03 && armEng < 0.05 &&
        Math.abs(torsoPitch) < 0.02 && Math.abs(pitchV) < 0.06 &&
        Math.abs(armA.v) < 0.2 && Math.abs(armB.v) < 0.2 &&
        Math.abs(wrapPi(armA.ang - ARM_REST)) < 0.08 &&
        Math.abs(wrapPi(armB.ang - ARM_REST)) < 0.08;
    }

    function snapRest() {
      xCom = ft[support].x; vCom = 0;
      ft[1 - support].x = ft[support].x; ft[1 - support].y = 0;
      torsoPitch = 0; pitchV = 0;
      hipEff = 0; armEng = 0;
      armA.ang = ARM_REST; armA.v = 0;
      armB.ang = ARM_REST; armB.v = 0;
      lastCpOff = 0;
      camX = ft[support].x;
      if (fall.phase) {
        fall.phase = 0;
        ft[0].x = xCom; ft[1].x = xCom;
      }
    }

    function frame(ts) {
      rafId = 0;
      var dt = last ? (ts - last) / 1000 : 0;
      last = ts;
      if (dt > 0.05) { dt = 0.05; }   /* survive tab switches / long GCs    */
      if (dt < 0) { dt = 0; }

      stepSim(dt);
      var camT = fall.phase ? pose.px : (ft[support].x * 0.7 + xCom * 0.3);
      camX += (camT - camX) * Math.min(1, 2.4 * dt);
      buildPose();
      drawFrame();
      syncReadout();

      if (stillMode) {
        activeT += dt;
        /* still mode: the transient ends, then the loop ends with it */
        if (settledNow() || (fall.phase === 0 && activeT > 9)) {
          active = false;
          snapRest();
          buildPose();
          drawFrame();
          syncReadout();
          return;
        }
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
      buildPose();
      drawFrame();
      syncReadout();
    }

    /* ===========================================================================
       11.  Interaction
       ======================================================================== */

    var charging = { on: false, id: -1, sx: 0, J: 0, dir: 1, u: 0.6 };

    function applyPush(J, dir) {
      if (fall.phase) { return; }
      vCom += dir * (J / MASS);
      lastJ = J;
      status.textContent = 'Push ' + Math.round(J) + ' newton seconds ' +
        (dir > 0 ? 'right.' : 'left.');
      if (stillMode) { active = true; activeT = 0; }
      start();
    }

    function distToSeg(px, py, x1, y1, x2, y2) {
      var dx = x2 - x1, dy = y2 - y1;
      var t = ((px - x1) * dx + (py - y1) * dy) / Math.max(1e-6, dx * dx + dy * dy);
      t = clamp(t, 0, 1);
      var qx = x1 + t * dx, qy = y1 + t * dy;
      return Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
    }

    cv.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      if (fall.phase) { return; }
      var r = cv.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var full = TORSO + NECK + HEAD_R * 2;
      var tpx = pose.px + Math.sin(pose.pitch) * full;
      var tpy = pose.py + Math.cos(pose.pitch) * full;
      var x1 = sx(pose.px), y1 = sy(pose.py);
      var x2 = sx(tpx), y2 = sy(tpy);
      if (distToSeg(mx, my, x1, y1, x2, y2) > Math.max(26, scale * 0.14)) { return; }
      charging.on = true;
      charging.id = e.pointerId;
      charging.sx = e.clientX;
      charging.J = 0;
      charging.dir = 1;
      charging.u = clamp((y1 - my) / Math.max(1, y1 - y2), 0.15, 0.95);
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      cv.classList.add('ks-push-g1-grabbing');
      e.preventDefault();
      if (!rafId) { renderOnce(); }
    });

    cv.addEventListener('pointermove', function (e) {
      if (!charging.on || e.pointerId !== charging.id) { return; }
      var dx = e.clientX - charging.sx;
      charging.dir = dx < 0 ? -1 : 1;
      charging.J = clamp(Math.abs(dx) / scale * DRAG_J_PER_M, 0, J_MAX);
      if (!rafId) { renderOnce(); }
    });

    function endCharge(e, fire) {
      if (!charging.on || e.pointerId !== charging.id) { return; }
      charging.on = false;
      cv.classList.remove('ks-push-g1-grabbing');
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
      if (fire && charging.J >= 3) { applyPush(charging.J, charging.dir); }
      if (!rafId) { renderOnce(); }
    }
    cv.addEventListener('pointerup', function (e) { endCharge(e, true); });
    cv.addEventListener('pointercancel', function (e) { endCharge(e, false); });

    cv.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { return; }
      e.preventDefault();
      var dir = e.key === 'ArrowLeft' ? -1 : 1;
      applyPush(e.shiftKey ? J_KEY_BIG : J_KEY, dir);
    });

    /* ===========================================================================
       12.  Observers
       ======================================================================== */

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) { visible = entries[i].isIntersecting; }
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
        snapRest();
        renderOnce();
      } else {
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
        renderOnce();
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
    setCell('strategy', STRAT_WORD.quiet);
    renderOnce();
    if (!stillMode) { start(); }

    /* zero-width container (hidden tab, late fonts): retry once */
    if (!lastW) {
      window.setTimeout(function () {
        if (cv.clientWidth) { layout(); renderOnce(); }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        readColors(); wCache = {}; layout(); renderOnce();
      }, function () {});
    }
  }

  /* ===========================================================================
     13.  Boot
     ======================================================================== */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-push-g1]');
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
