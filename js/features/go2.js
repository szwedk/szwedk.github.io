/* =============================================================================
   GO2 - the resident quadruped                                   (easter egg)
   -----------------------------------------------------------------------------
   Type "go2" anywhere on the page and a small line-drawn Unitree Go2 trots in
   along the top edge of whatever page rule is nearest the cursor. Type "go2"
   again - or press Escape - and it leaves.

   This feature does NOT mount into a container. It self-initialises on load,
   builds its own fixed full-viewport canvas overlay (pointer-events: none,
   z-index 45, aria-hidden) and stays dormant - no canvas, no listeners beyond a
   single keydown probe - until the sequence is typed.

   HONESTY NOTE
   The thigh / calf link lengths, the hip-axis spacing and the calf joint limits
   used by the IK below are the real numbers parsed out of Unitree's official
   go2_description.urdf (unitreerobotics/unitree_ros). They are loaded at runtime
   from /assets/robot-kinematics.json, with the same values inlined here as a
   fallback so the feature never breaks. Everything the readout prints is a
   SIMULATION driven by those numbers - it is not telemetry from a real robot,
   and the on-screen credit says exactly that.

   Trunk depth, the head pod and the 2.5D offset of the far leg pair are drawing
   decisions, not URDF data. Only the annotated dimensions come from the file,
   and the one modelled figure (stance height) is labelled "MODEL".
   ========================================================================== */

(function () {
  'use strict';

  /* Guard against a double include. */
  if (window.__ksGo2Loaded) { return; }
  window.__ksGo2Loaded = true;

  /* ===========================================================================
     1.  KINEMATICS - real numbers, with an inlined fallback
     ======================================================================== */

  /* Mirrors the "go2" block of /assets/robot-kinematics.json verbatim, so the
     feature is fully functional if the fetch fails (file://, offline, 404…). */
  var FALLBACK = {
    label: 'Unitree Go2',
    links: {
      thigh: 0.213,            /* m - hip pitch axis to knee axis             */
      calf: 0.213,             /* m - knee axis to foot                       */
      bodyLengthHalf: 0.1934,  /* m - trunk centre to hip axis (URDF origin)  */
      bodyWidthHalf: 0.142
    },
    limits: {
      FR_hip_joint:   { lower: -1.0472, upper: 1.0472,   effort: 23.7 },
      FR_thigh_joint: { lower: -1.5708, upper: 3.4907,   effort: 23.7 },
      FR_calf_joint:  { lower: -2.7227, upper: -0.83776, effort: 45.43 }
    }
  };

  var K = FALLBACK;
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
          if (json && json.go2 && json.go2.links && json.go2.links.thigh) {
            K = json.go2;
            recomputeScale();
          }
        })['catch'](function () { /* keep the inlined fallback */ });
    } catch (e) { /* keep the inlined fallback */ }
  }

  /* ===========================================================================
     2.  Helpers
     ======================================================================== */

  var FONT = '"Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  var GROUND_SEL = '.work-row, .path-stop, .platform-card, .marquee, .contact, .project';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { t = clamp(t, 0, 1); var u = 1 - t; return 1 - u * u * u; }
  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  /* Frame-rate independent exponential approach. */
  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }
  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }
  /* Distance from a point to a segment - so a fast cursor flick that jumps the
     robot in a single event still counts as a sweep across it. */
  function segDist(px, py, ax, ay, bx2, by2) {
    var vx = bx2 - ax, vy = by2 - ay;
    var len2 = vx * vx + vy * vy;
    var t = len2 > 0 ? clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1) : 0;
    var dx = px - (ax + vx * t), dy = py - (ay + vy * t);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v && v.trim()) { return v.trim(); }
    } catch (e) { /* noop */ }
    return fallback;
  }
  function isReduced() {
    return (window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
           document.documentElement.classList.contains('no-motion');
  }
  function isTypingTarget(el) {
    if (!el) { return false; }
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
           el.isContentEditable === true;
  }

  /* ===========================================================================
     3.  Overlay state
     ======================================================================== */

  var active = false;
  var canvas = null, ctx = null;
  var srLive = null;              /* text equivalent for the hidden canvas   */
  var dpr = 1, W = 0, H = 0;
  var rafId = null, removeTimer = null, resizeTimer = null;
  var lastT = 0;
  var staticDrawn = false;
  var lastReduced = null;

  /* white strokes + mix-blend-mode: difference is exactly how the site's .rail
     elements invert themselves over both the dark hero and the paper sections.
     If a browser lacks blend support we sample the backdrop instead and switch
     between --bone and --ink. */
  var BLEND_OK = !!(window.CSS && CSS.supports &&
                    CSS.supports('mix-blend-mode', 'difference'));
  var STROKE = '#ffffff';
  var INK = cssVar('--ink', '#0b0b0c');
  var BONE = cssVar('--bone', '#f2efe9');

  /* --- scale-derived constants (recomputed on resize / on data load) ------ */
  var PX = 260;          /* pixels per metre                                 */
  var L1 = 55, L2 = 55;  /* thigh / calf, px                                 */
  var HL = 50;           /* trunk centre → hip axis, px (URDF)               */
  var HH = 15;           /* trunk half-depth, px (drawing choice)            */
  var HEAD_L = 20, HEAD_H = 15;
  var D_MAX = 100, D_MIN = 25;  /* reach window implied by the calf limits   */
  var HIP_STAND = 72;    /* hip height at rest, px                           */
  var LIFT = 11;         /* swing-foot clearance, px                         */
  var STRIDE_MAX = 78;
  var MAX_V = 480;       /* px/s                                             */

  function reach(bend) {
    /* Triangle side opposite the knee's interior angle (π − bend). */
    return Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(Math.PI - bend));
  }

  function recomputeScale() {
    /* Nose to tail the silhouette is 2·bodyLengthHalf + head (0.072 m), i.e.
       2.372 × bodyLengthHalf. Solve for the px/m that lands it at 94–124 px. */
    var lenPx = clamp(window.innerWidth * 0.082, 94, 124);
    PX = lenPx / (2.372 * K.links.bodyLengthHalf);

    L1 = K.links.thigh * PX;
    L2 = K.links.calf * PX;
    HL = K.links.bodyLengthHalf * PX;
    HH = 0.057 * PX;              /* trunk half-depth - a drawing choice     */
    HEAD_L = 0.072 * PX;
    HEAD_H = 0.055 * PX;

    /* The URDF calf joint never reaches full extension: its range is
       [-2.7227, -0.83776] rad, so the knee is flexed by at least 0.838 rad and
       at most 2.723 rad. Converting that to a reach window with the law of
       cosines keeps every pose the IK produces inside the real joint limits. */
    var lim = (K.limits && K.limits.FR_calf_joint) || FALLBACK.limits.FR_calf_joint;
    D_MAX = reach(Math.abs(lim.upper));
    D_MIN = reach(Math.abs(lim.lower));

    HIP_STAND = 0.72 * D_MAX;     /* ≈ the real 0.28 m stance hip height     */
    LIFT = 0.15 * HIP_STAND;
    STRIDE_MAX = 0.30 * PX;       /* 0.30 m of stance travel per cycle       */
    MAX_V = 1.8 * PX;             /* 1.8 m·s - inside Go2's trot envelope    */
    staticDrawn = false;
  }

  /* ===========================================================================
     4.  Robot state
     ======================================================================== */

  var bx = 0, by = 0;            /* trunk centre, viewport px                */
  var bvx = 0;                   /* horizontal velocity, px/s                */
  var facing = 1, pendingFace = 1, turnT = 0;
  var TURN_DUR = 0.20;
  var gy = 0, gyTarget = 0;      /* ground line y (eased)                    */
  var segX0 = 0, segX1 = 0;      /* walkable span of the current ground line */
  var groundKey = null;
  var hipH = 72, hipHTarget = 72;
  var bob = 0, bobV = 0;         /* spring–damper vertical bob               */
  var pitch = 0, pitchV = 0, pitchTarget = 0;
  var gaitPhase = 0, gaitFreq = 1.4, stride = 0, gaitAmp = 0;
  var sitBlend = 0;
  var state = 'TROT';            /* TROT | STAGGER | RECOVER                 */
  var stateT = 0;
  var shove = 1, splayLeg = 0, pushCooldown = 0;
  var lastScrollAt = 0;
  var lastDt = 1 / 60;
  var roX = null, roY = null;   /* eased readout block anchor */

  var STAGGER_T = 0.42, RECOVER_T = 0.78;
  var DUTY = 0.5;                /* trot: 50 % stance                        */

  /* Diagonal pairs share a phase - that is what makes it a trot.
     `near` is the side of the robot facing the viewer. */
  var LEGS = [
    { id: 'FR', front: true,  near: true,  phase: 0.0 },
    { id: 'RL', front: false, near: false, phase: 0.0 },
    { id: 'FL', front: true,  near: false, phase: 0.5 },
    { id: 'RR', front: false, near: true,  phase: 0.5 }
  ];
  var NLEG = LEGS.length;
  var LEG_FR = 0, LEG_RR = 3;
  var sol = [], contact = [], wasStance = [], holdX = [], holdY = [];
  for (var li = 0; li < NLEG; li++) {
    sol.push({ hx: 0, hy: 0, kx: 0, ky: 0, fx: 0, fy: 0 });
    contact.push(true); wasStance.push(true); holdX.push(0); holdY.push(0);
  }

  var ptr = { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, t: 0, seen: false };

  /* ===========================================================================
     5.  Ground lines - the top edges of real page elements
     ======================================================================== */

  var groundEls = [], ioSeen = null, io = null;

  function collectGroundEls() {
    groundEls = Array.prototype.slice.call(document.querySelectorAll(GROUND_SEL));
    if (io) { io.disconnect(); io = null; }
    ioSeen = null;
    if (typeof IntersectionObserver === 'function' && groundEls.length) {
      /* Only candidates near the viewport get measured each frame. */
      ioSeen = [];
      io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var idx = groundEls.indexOf(entries[i].target);
          if (idx >= 0) { ioSeen[idx] = entries[i].isIntersecting; }
        }
      }, { rootMargin: '25% 0px 25% 0px', threshold: 0 });
      for (var j = 0; j < groundEls.length; j++) {
        ioSeen[j] = true;
        io.observe(groundEls[j]);
      }
    }
  }

  /* Picks the page rule to stand on: the one nearest to just below the cursor.
     A little stickiness stops it flickering between two adjacent rules. */
  function measureGround(snap) {
    var refY = ptr.seen ? ptr.y + HIP_STAND * 0.45 : H * 0.62;
    var best = null, bestScore = Infinity, bestEl = null;
    var minW = Math.max(160, HL * 3);

    for (var i = 0; i < groundEls.length; i++) {
      if (ioSeen && !ioSeen[i]) { continue; }
      var el = groundEls[i];
      var r = el.getBoundingClientRect();
      if (r.width < minW) { continue; }
      var y = r.top;
      if (y < 72 || y > H - 20) { continue; }
      /* Prefer a rule at or below the cursor: the robot then reads as standing
         on the line the visitor is looking at, not floating above it. */
      var score = Math.abs(y - refY) + (y < refY ? H * 0.09 : 0);
      if (el === groundKey) { score -= 26; }
      if (score < bestScore) {
        bestScore = score; bestEl = el;
        best = { y: y, x0: r.left, x1: r.right };
      }
    }

    if (!best) {
      /* Nothing usable on this page - walk along the viewport bottom. */
      bestEl = null;
      best = { y: H - 10, x0: 0, x1: W };
    }

    /* Only re-resolve the stroke colour when the rule underneath changes -
       getComputedStyle every frame would be wasteful. */
    var groundChanged = (bestEl !== groundKey);
    groundKey = bestEl;
    gyTarget = best.y;

    /* Pad by more than the nose overhang so the head never clips the edge. */
    var pad = HL * 1.5;
    segX0 = clamp(best.x0 + pad, 8, Math.max(8, W - 8));
    segX1 = clamp(best.x1 - pad, 8, Math.max(8, W - 8));
    if (segX1 < segX0) {
      segX0 = segX1 = clamp((best.x0 + best.x1) / 2, 8, Math.max(8, W - 8));
    }
    if (snap) { gy = gyTarget; }
    if (!BLEND_OK && (groundChanged || snap)) { resolveStroke(bestEl); }
  }

  /* Fallback ink resolution for the (vanishingly rare) browser without blend
     modes: walk up from the ground element to the first opaque background and
     pick --bone over dark, --ink over light. */
  function resolveStroke(el) {
    var node = el || document.body, guard = 0, rgb = null;
    while (node && guard++ < 8) {
      var m = String(getComputedStyle(node).backgroundColor).match(/rgba?\(([^)]+)\)/);
      if (m) {
        var parts = m[1].split(',');
        var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
        if (a > 0.4) {
          rgb = [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
          break;
        }
      }
      node = node.parentElement;
    }
    if (!rgb) { STROKE = BONE; return; }
    STROKE = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 128 ? BONE : INK;
  }

  /* ===========================================================================
     6.  Canvas plumbing
     ======================================================================== */

  function buildCanvas() {
    if (canvas) { return; }
    canvas = document.createElement('canvas');
    canvas.className = 'ks-go2-canvas';
    /* Purely decorative - the live region below carries the text equivalent. */
    canvas.setAttribute('aria-hidden', 'true');
    if (!BLEND_OK) { canvas.style.mixBlendMode = 'normal'; }
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas) { return; }
    dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2 */
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    recomputeScale();
  }

  function announce(msg) {
    if (!srLive) {
      srLive = document.createElement('p');
      srLive.className = 'ks-go2-sr';
      srLive.setAttribute('aria-live', 'polite');
      document.body.appendChild(srLive);
    }
    srLive.textContent = msg;
  }

  /* ===========================================================================
     7.  Simulation
     ======================================================================== */

  var tmp = { x: 0, y: 0 };

  /* Body frame → viewport. Mirror first, then pitch, so a positive pitch is
     always "nose down" no matter which way the robot faces. */
  function toWorld(lx, ly, out) {
    var fx = lx * facing;
    var p = pitch * facing;
    var c = Math.cos(p), s = Math.sin(p);
    out.x = bx + fx * c - ly * s;
    out.y = by + fx * s + ly * c;
    return out;
  }

  /* Analytic 2-bone IK. `face` selects the knee-rearward solution: every Go2
     leg folds the same way - the URDF calf angle is negative on all four legs -
     so the knee always sits behind the hip→foot line. */
  function solveIK(out, hx, hy, tx, ty, face) {
    var dx = tx - hx, dy = ty - hy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var ux, uy;
    if (d < 1e-4) { ux = 0; uy = 1; d = 1e-4; } else { ux = dx / d; uy = dy / d; }
    d = clamp(d, D_MIN, D_MAX);          /* honour the real joint limits */
    var base = Math.atan2(uy, ux);
    var ca = clamp((d * d + L1 * L1 - L2 * L2) / (2 * d * L1), -1, 1);
    var th = base + face * Math.acos(ca);
    out.hx = hx; out.hy = hy;
    out.kx = hx + Math.cos(th) * L1;
    out.ky = hy + Math.sin(th) * L1;
    out.fx = hx + ux * d;
    out.fy = hy + uy * d;
  }

  function snapHold() {
    for (var i = 0; i < NLEG; i++) {
      toWorld(LEGS[i].front ? HL : -HL, 0, tmp);
      holdX[i] = tmp.x;
      holdY[i] = gy;
    }
  }

  function placeRobot() {
    measureGround(true);
    bx = clamp(ptr.seen ? ptr.x - HL * 2.4 : W * 0.28, segX0, segX1);
    bvx = 0;
    facing = pendingFace = 1; turnT = 0;
    pitch = pitchV = pitchTarget = 0;
    bob = bobV = 0;
    gaitPhase = 0; stride = 0; gaitAmp = 0; sitBlend = 0;
    roX = roY = null;
    hipH = hipHTarget = HIP_STAND * 0.42;
    by = gy - hipH;
    snapHold();
    /* Arrive with the Unitree stand-up: crouched, then push to full stance. */
    state = 'RECOVER'; stateT = 0;
    lastScrollAt = now();
  }

  function step(dt) {
    var t = now();
    var i;
    lastDt = dt;

    measureGround(false);
    gy = approach(gy, gyTarget, 7, dt);

    /* ---- follow the cursor at a polite standoff ------------------------- */
    var STANDOFF = HL * 2.6;
    var tx = bx;
    if (ptr.seen) {
      var d = ptr.x - bx;
      if (Math.abs(d) > STANDOFF) { tx = ptr.x - (d > 0 ? STANDOFF : -STANDOFF); }
    }
    tx = clamp(tx, segX0, segX1);

    var walking = (state === 'TROT');
    var err = tx - bx;
    var want = 0;
    if (walking) {
      want = clamp(err * 2.6, -MAX_V, MAX_V);
      if (Math.abs(err) < 4) { want = 0; }
    } else if (state === 'STAGGER') {
      want = bvx * 0.6;                       /* shoved, then coasting */
    }
    bvx = approach(bvx, want, walking ? 7 : 3.4, dt);
    bx = clamp(bx + bvx * dt, segX0, segX1);

    var speed = Math.abs(bvx);

    /* ---- turning: hysteresis, then a short pivot squash ------------------ */
    if (walking && speed > 34) {
      var nf = bvx > 0 ? 1 : -1;
      if (nf !== pendingFace) { pendingFace = nf; turnT = TURN_DUR; }
    }
    if (turnT > 0) {
      turnT = Math.max(0, turnT - dt);
      /* Flip at the mid-point of the squash, where the body is edge-on. */
      if (turnT <= TURN_DUR * 0.5 && facing !== pendingFace) {
        facing = pendingFace;
        pitchV += 1.2 * facing;               /* a small lean into the turn */
      }
    }

    /* ---- sit when the page has been still ------------------------------- */
    var settled = Math.abs(err) < 6 && speed < 24;
    var sitWanted = walking && (t - lastScrollAt) > 2500 && settled;
    sitBlend = approach(sitBlend, sitWanted ? 1 : 0, sitWanted ? 2.4 : 4.5, dt);
    if (sitBlend < 0.002) { sitBlend = 0; }

    /* ---- gait ------------------------------------------------------------ */
    var speedMs = speed / PX;
    gaitAmp = walking ? smoothstep(8 / PX, 0.22, speedMs) * (1 - sitBlend) : 0;
    gaitFreq = 1.4 + speedMs * 1.3;
    /* stride = v · duty / f keeps the loaded foot world-fixed. Past the stride
       ceiling the cadence takes over instead - audibly/visibly faster trot. */
    stride = speed * DUTY / gaitFreq;
    if (stride > STRIDE_MAX) {
      stride = STRIDE_MAX;
      gaitFreq = speed * DUTY / STRIDE_MAX;
    }
    gaitFreq = clamp(gaitFreq, 1.2, 4.2);
    if (gaitAmp > 0.02) { gaitPhase = (gaitPhase + gaitFreq * dt) % 1; }

    /* ---- state machine --------------------------------------------------- */
    stateT += dt;
    if (state === 'STAGGER' && stateT >= STAGGER_T) { state = 'RECOVER'; stateT = 0; }
    else if (state === 'RECOVER' && stateT >= RECOVER_T) {
      state = 'TROT'; stateT = 0; gaitPhase = 0;
    }
    if (pushCooldown > 0) { pushCooldown -= dt; }

    /* ---- posture --------------------------------------------------------- */
    var recoverPull = 0;
    if (state === 'STAGGER') {
      hipHTarget = HIP_STAND * 0.52;
      pitchTarget = shove * facing * 0.26;
      hipH = approach(hipH, hipHTarget, 11, dt);
    } else if (state === 'RECOVER') {
      /* Tuck the feet under the body first, then extend all four together -
         the shape of Unitree's own stand-up recovery. */
      var r = stateT / RECOVER_T;
      var crouch = Math.max(D_MIN + 6, HIP_STAND * 0.40);
      hipHTarget = crouch + (HIP_STAND - crouch) * easeOutCubic((r - 0.34) / 0.66);
      pitchTarget = 0;
      hipH = approach(hipH, hipHTarget, 15, dt);
      recoverPull = 2 + 12 * easeOutCubic(r / 0.42);
    } else {
      hipHTarget = lerp(HIP_STAND, HIP_STAND * 0.68, sitBlend);
      pitchTarget = lerp(0, -0.40, sitBlend);   /* nose up, haunches down */
      hipH = approach(hipH, hipHTarget, 9, dt);
    }

    /* ---- springs --------------------------------------------------------- */
    var bk = 300, bc = 2 * Math.sqrt(bk) * 0.5;
    bobV += (-bk * bob - bc * bobV) * dt;
    bob = clamp(bob + bobV * dt, -16, 16);

    var pk = 150, pc = 2 * Math.sqrt(pk) * 0.55;
    pitchV += (-pk * (pitch - pitchTarget) - pc * pitchV) * dt;
    pitch = clamp(pitch + pitchV * dt, -0.6, 0.6);

    by = gy - hipH + bob;

    /* Recovery: pull the locked feet in under the hips. */
    if (recoverPull > 0) {
      var kk = 1 - Math.exp(-recoverPull * dt);
      for (i = 0; i < NLEG; i++) {
        toWorld(LEGS[i].front ? HL : -HL, 0, tmp);
        holdX[i] = lerp(holdX[i], tmp.x, kk);
        holdY[i] = lerp(holdY[i], gy, kk);
      }
    }

    /* ---- feet ------------------------------------------------------------ */
    var locked = (state === 'STAGGER' || state === 'RECOVER');
    for (i = 0; i < NLEG; i++) {
      var leg = LEGS[i];
      toWorld(leg.front ? HL : -HL, 0, tmp);
      var hx = tmp.x, hy = tmp.y;
      /* 2.5D: the far pair sits slightly up and back. */
      if (!leg.near) { hx -= facing * HL * 0.11; hy -= HH * 0.42; }

      var tfx, tfy, inStance;

      if (locked) {
        tfx = holdX[i];
        tfy = holdY[i];
        if (state === 'STAGGER' && i === splayLeg) {
          tfx += shove * HL * 1.15 * easeOutCubic(stateT / STAGGER_T);
        }
        if (!leg.near) { tfx -= facing * HL * 0.11; tfy -= HH * 0.42; }
        inStance = true;
      } else {
        var p = (gaitPhase + leg.phase) % 1;
        inStance = p < DUTY;
        var sx, lift = 0;
        if (inStance) {
          sx = stride * 0.5 - stride * (p / DUTY);   /* world-fixed under load */
        } else {
          var u = (p - DUTY) / (1 - DUTY);
          sx = -stride * 0.5 + stride * u;
          lift = LIFT * Math.sin(Math.PI * u) * gaitAmp;
        }
        /* Sitting: front feet reach forward, rear feet tuck under the belly. */
        if (sitBlend > 0) {
          sx = lerp(sx, leg.front ? HL * 0.16 : HL * 0.30, sitBlend);
          lift *= (1 - sitBlend);
        }
        tfx = hx + facing * sx;
        tfy = gy - lift;
        if (!leg.near) { tfy -= HH * 0.42; }
        holdX[i] = tfx; holdY[i] = gy;
      }

      /* Touchdown impulses drive the bob and the pitch - the body reacts to
         the legs rather than riding its own animation curve. */
      if (inStance && !wasStance[i] && !locked) {
        bobV += 34 * gaitAmp;
        pitchV += (leg.front ? 1.6 : -1.6) * gaitAmp;
      }
      wasStance[i] = inStance;
      contact[i] = locked ? true : (gaitAmp < 0.06 ? true : inStance);

      solveIK(sol[i], hx, hy, tfx, tfy, facing);
    }
  }

  /* ---- perturbation: a fast cursor sweep across the body ----------------- */
  function testPush() {
    if (!active || state !== 'TROT' || pushCooldown > 0) { return; }
    if (Math.sqrt(ptr.vx * ptr.vx + ptr.vy * ptr.vy) < 1500) { return; }
    if (segDist(bx, by, ptr.px, ptr.py, ptr.x, ptr.y) > HL * 1.5) { return; }

    shove = ptr.vx >= 0 ? 1 : -1;
    state = 'STAGGER'; stateT = 0;
    pushCooldown = 2.2;
    sitBlend = 0;
    snapHold();
    /* The leg on the shoved side splays out to catch the fall. */
    splayLeg = (shove * facing > 0) ? LEG_FR : LEG_RR;
    bvx += shove * 190;
    bobV += 250;
    pitchV += shove * facing * 5.4;
  }

  /* ===========================================================================
     8.  Drawing
     ======================================================================== */

  /* Manual letter tracking - canvas letterSpacing is not universally supported
     and the micro-label look depends on it. */
  function trackedWidth(str, tr) {
    var w = 0;
    for (var i = 0; i < str.length; i++) {
      w += ctx.measureText(str.charAt(i)).width + tr;
    }
    return w - tr;
  }
  function tracked(str, x, y, size, weight, alpha, trEm) {
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    ctx.globalAlpha = alpha;
    var tr = size * trEm, cx = x;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charAt(i);
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + tr;
    }
    return cx - tr - x;
  }
  function dot(x, y, r, filled) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (filled) { ctx.fill(); } else { ctx.stroke(); }
  }

  function drawLeg(i, alpha, lw) {
    var s = sol[i];
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(s.hx, s.hy);
    ctx.lineTo(s.kx, s.ky);
    ctx.lineTo(s.fx, s.fy);
    ctx.stroke();

    ctx.lineWidth = 1.2;
    dot(s.hx, s.hy, lw * 1.7, false);          /* hip pitch axis   */
    dot(s.kx, s.ky, lw * 1.35, false);         /* knee / calf axis */
    dot(s.fx, s.fy, lw * 1.3, !!contact[i]);   /* foot             */
    if (contact[i]) {                          /* contact serif    */
      ctx.beginPath();
      ctx.moveTo(s.fx - lw * 3.4, s.fy + lw * 2.4);
      ctx.lineTo(s.fx + lw * 3.4, s.fy + lw * 2.4);
      ctx.stroke();
    }
  }

  /* Trunk profile in units of (HL, HH), +x forward. A chamfered slab - the Go2
     silhouette. The length is the URDF hip-axis spacing; the depth is drawn. */
  var TRUNK = [
    [-1.00, -0.52], [-0.88, -1.00], [0.60, -1.00], [0.94, -0.68],
    [1.00, -0.10], [0.96, 0.68], [0.74, 1.00], [-0.82, 1.00], [-1.00, 0.52]
  ];

  function drawTorso() {
    var i;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (i = 0; i < TRUNK.length; i++) {
      toWorld(TRUNK[i][0] * HL, TRUNK[i][1] * HH, tmp);
      if (i === 0) { ctx.moveTo(tmp.x, tmp.y); } else { ctx.lineTo(tmp.x, tmp.y); }
    }
    ctx.closePath();
    ctx.stroke();

    /* Head pod. */
    var hx = HL, hw = HEAD_L;
    var head = [
      [hx, -HH * 0.66], [hx + hw, -HH * 0.54],
      [hx + hw, HH * 0.30], [hx, HH * 0.34]
    ];
    ctx.beginPath();
    for (i = 0; i < head.length; i++) {
      toWorld(head[i][0], head[i][1], tmp);
      if (i === 0) { ctx.moveTo(tmp.x, tmp.y); } else { ctx.lineTo(tmp.x, tmp.y); }
    }
    ctx.stroke();

    /* L1 lidar dome + front camera. */
    ctx.lineWidth = 1.5;
    toWorld(HL + HEAD_L * 0.42, -HH * 0.62 - HEAD_H * 0.34, tmp);
    dot(tmp.x, tmp.y, HEAD_H * 0.26, false);
    toWorld(HL + HEAD_L * 0.82, -HH * 0.06, tmp);
    dot(tmp.x, tmp.y, 1.5, true);

    /* Trunk seam. */
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 1;
    ctx.beginPath();
    toWorld(-HL * 0.86, -HH * 0.24, tmp); ctx.moveTo(tmp.x, tmp.y);
    toWorld(HL * 0.62, -HH * 0.24, tmp); ctx.lineTo(tmp.x, tmp.y);
    ctx.stroke();
  }

  function drawRobot() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = STROKE;
    ctx.fillStyle = STROKE;
    var i;
    for (i = 0; i < NLEG; i++) { if (!LEGS[i].near) { drawLeg(i, 0.40, 1.5); } }
    drawTorso();
    for (i = 0; i < NLEG; i++) { if (LEGS[i].near) { drawLeg(i, 0.95, 1.9); } }
    ctx.globalAlpha = 1;
  }

  /* ---- the live readout, on the trailing side of the robot --------------- */
  function gaitLabel() {
    if (state === 'STAGGER') { return 'PERTURBED'; }
    if (state === 'RECOVER') { return 'RECOVERY'; }
    if (sitBlend > 0.5) { return 'SIT / IDLE'; }
    if (gaitAmp < 0.06) { return 'STAND'; }
    return 'TROT';
  }

  function drawReadout() {
    var BW = 176, ROW = 14, BH = 120;

    /* Rides in the robot's own band, on its trailing side. The canvas
       composites with mix-blend-mode difference, so the block is only legible
       over clear space, and the clear space that reliably exists is the strip
       the robot is already walking through (it walks along section rules, which
       sit in the gutter between content rows). Anchoring level with the body,
       rather than a fixed height above it, keeps the block inside that gutter
       instead of drifting up into headings. Eased so turns do not pop it. */
    var left = facing > 0 ? bx - HL * 1.9 - BW : bx + HL * 1.9;
    left = clamp(left, 16, Math.max(16, W - BW - 16));
    var top = clamp(gy - hipH - HH - 12, 70, Math.max(70, H - BH - 24));
    roX = (roX === null) ? left : approach(roX, left, 9, lastDt);
    roY = (roY === null) ? top : approach(roY, top, 9, lastDt);
    left = roX; top = roY;

    ctx.strokeStyle = STROKE;
    ctx.fillStyle = STROKE;
    ctx.textBaseline = 'alphabetic';

    /* editorial rule down the left edge of the block */
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left - 9, top - 2);
    ctx.lineTo(left - 9, top + 76);
    ctx.stroke();

    var y = top + 8;
    tracked('GO2 / RESIDENT', left, y, 10, '600', 0.62, 0.20);
    y += 12;
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(left, y); ctx.lineTo(left + BW - 10, y); ctx.stroke();
    y += 14;

    var col = left + 94;
    tracked('GAIT', left, y, 9.5, '600', 0.50, 0.20);
    tracked(gaitLabel(), col, y, 9.5, '600', 0.86, 0.16);
    y += ROW;

    tracked('VEL', left, y, 9.5, '600', 0.50, 0.20);
    var adv = tracked((Math.abs(bvx) / PX).toFixed(2), col, y, 9.5, '600', 0.86, 0.10);
    tracked(' m·s', col + adv, y, 9, '500', 0.48, 0.10);
    y += ROW;

    tracked('FOOT CONTACT', left, y, 9.5, '600', 0.50, 0.20);
    /* live contact pattern, read FR FL RR RL */
    var order = [0, 2, 3, 1], sq = 5, gap = 4, sx = col;
    ctx.lineWidth = 1;
    for (var i = 0; i < order.length; i++) {
      if (contact[order[i]]) {
        ctx.globalAlpha = 0.90;
        ctx.fillRect(sx, y - sq, sq, sq);
      } else {
        ctx.globalAlpha = 0.34;
        ctx.strokeRect(sx + 0.5, y - sq + 0.5, sq - 1, sq - 1);
      }
      sx += sq + gap;
    }
    y += 20;

    tracked('SIMULATION · LINK LENGTHS', left, y, 8, '600', 0.34, 0.16);
    y += 10;
    tracked('FROM UNITREE GO2 URDF', left, y, 8, '600', 0.34, 0.16);
    y += 13;
    tracked('ESC OR "GO2" TO DISMISS', left, y, 8, '600', 0.26, 0.16);
    ctx.globalAlpha = 1;
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    /* The pivot squash: the whole robot compresses horizontally through the
       turn, so the mirror never reads as a teleport. */
    if (turnT > 0) {
      var u = 1 - turnT / TURN_DUR;
      var sq = 0.28 + 0.72 * Math.abs(Math.cos(Math.PI * u));
      ctx.translate(bx, 0);
      ctx.scale(sq, 1);
      ctx.translate(-bx, 0);
    }
    drawRobot();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawReadout();
  }

  /* ===========================================================================
     9.  Reduced motion - one static, labelled blueprint
     ======================================================================== */

  function drawStatic() {
    if (!ctx) { return; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = STROKE;
    ctx.fillStyle = STROKE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'alphabetic';

    /* A clean standing pose, parked in the lower left. */
    facing = 1; turnT = 0;
    pitch = 0; bob = 0; hipH = HIP_STAND; gaitAmp = 0;
    var margin = clamp(W * 0.055, 24, 64);
    gy = Math.max(H * 0.42, H - margin - 108);
    /* Two-column composition: the drawing sits against the left margin and all
       of the annotation runs off to its right, where there is room for it. */
    bx = clamp(margin + HL * 1.5, HL * 1.5, Math.max(HL * 1.5, W - HL * 1.6));
    by = gy - hipH;

    for (var i = 0; i < NLEG; i++) {
      var leg = LEGS[i];
      toWorld(leg.front ? HL : -HL, 0, tmp);
      var baseX = tmp.x, hx = tmp.x, hy = tmp.y, fox = 0, foy = 0;
      if (!leg.near) {
        hx -= HL * 0.11; hy -= HH * 0.42;
        fox = -HL * 0.11 + (leg.front ? HL * 0.18 : -HL * 0.18);
        foy = -HH * 0.42;
      }
      contact[i] = true;
      solveIK(sol[i], hx, hy, baseX + fox, gy + foy, 1);
    }

    /* Ground datum with hatch ticks. */
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx - HL * 1.9, gy);
    ctx.lineTo(bx + HL * 2.6, gy);
    ctx.stroke();
    for (var g = -3; g <= 4; g++) {
      var gx = bx + g * HL * 0.58;
      ctx.beginPath();
      ctx.moveTo(gx, gy); ctx.lineTo(gx - 5, gy + 6); ctx.stroke();
    }
    tracked('GROUND', bx + HL * 1.7, gy + 19, 8, '600', 0.36, 0.18);

    drawRobot();

    /* --- dimensions, straight off the URDF ------------------------------- */
    var fl = sol[LEG_FR];
    dimLine(fl.hx, fl.hy, fl.kx, fl.ky, 'THIGH ' + K.links.thigh.toFixed(3) + ' M', -30);
    dimLine(fl.kx, fl.ky, fl.fx, fl.fy, 'CALF ' + K.links.calf.toFixed(3) + ' M', -30);
    dimLine(sol[LEG_RR].hx, sol[LEG_RR].hy, fl.hx, fl.hy,
            'HIP AXES ' + (K.links.bodyLengthHalf * 2).toFixed(4) + ' M', -(HH + 40));

    /* Joint call-outs, clear of the dimension lines. Below ~620 px there is no
       room for them without them colliding, so the caption carries the load. */
    if (W >= 620) {
      var lead = HL * 3.4;
      callout(fl.hx, fl.hy, lead, -32, 'HIP PITCH AXIS');
      callout(fl.kx, fl.ky, lead, 4, 'CALF JOINT');
      callout(fl.fx, fl.fy, lead, 24, 'FOOT');
    }

    /* --- caption block ---------------------------------------------------- */
    var lim = (K.limits && K.limits.FR_calf_joint) || FALLBACK.limits.FR_calf_joint;
    var cx = bx - HL * 1.5;
    /* Clear of the bottom nav pill, which floats to the bottom below 430 px. */
    var cy = Math.min(gy + 48, H - 124);
    ctx.globalAlpha = 0.24;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 236, cy - 12); ctx.stroke();

    tracked('GO2 · SAGITTAL LINKAGE', cx, cy + 2, 10, '600', 0.62, 0.20);
    tracked('STATIC DIAGRAM · REDUCED MOTION', cx, cy + 16, 8.5, '600', 0.40, 0.17);
    /* The one number here that is not from the URDF, said plainly. */
    tracked('STANCE ' + (HIP_STAND / PX).toFixed(2) + ' M · MODELLED',
            cx, cy + 28, 8.5, '600', 0.40, 0.17);
    tracked('CALF JOINT LIMIT ' + lim.lower.toFixed(2) + ' … ' + lim.upper.toFixed(2) +
            ' RAD', cx, cy + 40, 8.5, '600', 0.40, 0.17);
    tracked('LINK LENGTHS FROM UNITREE GO2 URDF', cx, cy + 52, 8.5, '600', 0.40, 0.17);
    tracked('ESC OR "GO2" TO DISMISS', cx, cy + 67, 8, '600', 0.26, 0.16);

    ctx.globalAlpha = 1;
    staticDrawn = true;
  }

  /* Dimension line with end ticks, leaders back to the joints, and a label on
     the outward side. `off` is the perpendicular offset (sign picks the side). */
  function dimLine(x1, y1, x2, y2, label, off) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var ox = nx * off, oy = ny * off;

    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1 + ox, y1 + oy); ctx.lineTo(x2 + ox, y2 + oy);
    ctx.moveTo(x1 + ox - nx * 4, y1 + oy - ny * 4);
    ctx.lineTo(x1 + ox + nx * 4, y1 + oy + ny * 4);
    ctx.moveTo(x2 + ox - nx * 4, y2 + oy - ny * 4);
    ctx.lineTo(x2 + ox + nx * 4, y2 + oy + ny * 4);
    ctx.moveTo(x1, y1); ctx.lineTo(x1 + ox, y1 + oy);
    ctx.moveTo(x2, y2); ctx.lineTo(x2 + ox, y2 + oy);
    ctx.stroke();

    /* Outward unit vector - the label always sits clear of the geometry. */
    var so = off < 0 ? -1 : 1;
    var lox = nx * so, loy = ny * so;
    var mx = (x1 + x2) / 2 + ox, my = (y1 + y2) / 2 + oy;

    ctx.font = '600 8.5px ' + FONT;
    var w = trackedWidth(label, 8.5 * 0.17);
    var lx = mx + lox * 9, ly = my + loy * 9 + 3;
    if (lox < -0.3) { lx -= w; }
    else if (lox <= 0.3) { lx -= w / 2; }
    tracked(label, lx, ly, 8.5, '600', 0.48, 0.17);
  }

  /* Leader from a joint out to a label: diagonal, then a short horizontal
     shoulder the text sits on. `dx` sign picks the side. */
  function callout(x, y, dx, dy, label) {
    ctx.globalAlpha = 0.30;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * 0.62, y + dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
    dot(x, y, 2.4, false);
    ctx.font = '600 8px ' + FONT;
    var w = trackedWidth(label, 8 * 0.17);
    var lx = dx < 0 ? x + dx - 5 - w : x + dx + 5;
    tracked(label, lx, y + dy + 3, 8, '600', 0.44, 0.17);
  }

  /* ===========================================================================
     10.  Loop + lifecycle
     ======================================================================== */

  function frame(t) {
    if (!active || !ctx) { rafId = null; return; }
    rafId = requestAnimationFrame(frame);
    var dt = lastT ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    if (dt > 0.05) { dt = 0.05; }   /* tab-switch / long-task guard */
    step(dt);
    render();
  }

  function startLoop() {
    if (rafId !== null) { return; }
    lastT = 0;
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function applyMode() {
    if (!active) { return; }
    if (isReduced()) {
      stopLoop();
      if (!staticDrawn) { drawStatic(); }
    } else {
      staticDrawn = false;
      if (rafId === null && !document.hidden) { placeRobot(); startLoop(); }
    }
  }

  /* ---- listeners, bound only while the egg is on screen ------------------ */

  function onPointer(e) {
    var t = now();
    var dt = ptr.seen ? Math.max((t - ptr.t) / 1000, 1 / 240) : 0;
    ptr.px = ptr.seen ? ptr.x : e.clientX;
    ptr.py = ptr.seen ? ptr.y : e.clientY;
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = t;
    if (dt > 0 && dt < 0.12) {
      ptr.vx = (ptr.x - ptr.px) / dt;
      ptr.vy = (ptr.y - ptr.py) / dt;
    } else {
      ptr.vx = ptr.vy = 0;
    }
    ptr.seen = true;
    if (!isReduced()) { testPush(); }
  }
  function onScroll() { lastScrollAt = now(); }
  function onResize() {
    if (resizeTimer) { clearTimeout(resizeTimer); }
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      resizeCanvas();
      if (isReduced()) { drawStatic(); }
      else { measureGround(true); bx = clamp(bx, segX0, segX1); }
    }, 140);
  }
  function onVisibility() {
    if (!active) { return; }
    if (document.hidden) { stopLoop(); }        /* no rAF behind a hidden tab */
    else if (!isReduced()) { startLoop(); }
  }

  var mo = null, mql = null;
  function onMotionPrefChange() {
    var red = isReduced();
    if (red === lastReduced) { return; }        /* ignore unrelated class churn */
    lastReduced = red;
    staticDrawn = false;
    applyMode();
  }

  function bind() {
    lastReduced = isReduced();
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    /* The site's own motion toggle flips html.no-motion at runtime. */
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver(onMotionPrefChange);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
    if (window.matchMedia) {
      mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mql.addEventListener) { mql.addEventListener('change', onMotionPrefChange); }
      else if (mql.addListener) { mql.addListener(onMotionPrefChange); }
    }
  }

  function unbind() {
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (mql) {
      if (mql.removeEventListener) { mql.removeEventListener('change', onMotionPrefChange); }
      else if (mql.removeListener) { mql.removeListener(onMotionPrefChange); }
      mql = null;
    }
    if (io) { io.disconnect(); io = null; }
    groundEls = []; ioSeen = null; groundKey = null;
  }

  function activate() {
    if (active) { return; }
    if (removeTimer) { clearTimeout(removeTimer); removeTimer = null; }
    active = true;
    loadKinematics();
    buildCanvas();
    collectGroundEls();
    bind();
    staticDrawn = false;

    if (isReduced()) {
      drawStatic();
      announce('Go2 quadruped: a static blueprint of the Unitree Go2 leg linkage ' +
               'is shown in the lower left, annotated with link lengths taken from ' +
               'Unitree’s published URDF. Press Escape or type g o 2 to dismiss.');
    } else {
      placeRobot();
      startLoop();
      announce('Go2 quadruped: a small line-drawn Unitree Go2 is now trotting along ' +
               'the page rules and following the cursor. It is a simulation driven by ' +
               'link lengths from Unitree’s published URDF, not live telemetry. ' +
               'Press Escape or type g o 2 to dismiss.');
    }
    /* Next frame, so the CSS opacity transition actually runs. */
    requestAnimationFrame(function () {
      if (canvas && active) { canvas.classList.add('ks-go2-is-in'); }
    });
  }

  function deactivate() {
    if (!active) { return; }
    active = false;
    stopLoop();
    unbind();
    if (canvas) { canvas.classList.remove('ks-go2-is-in'); }
    announce('Go2 quadruped dismissed.');
    /* Tear the canvas down after the fade - nothing left painting or held. */
    removeTimer = setTimeout(function () {
      removeTimer = null;
      if (active || !canvas) { return; }
      if (canvas.parentNode) { canvas.parentNode.removeChild(canvas); }
      canvas = null; ctx = null; staticDrawn = false;
    }, 520);
  }

  /* ===========================================================================
     11.  The trigger - type "go2"
     ======================================================================== */

  var CODE = 'go2';
  var buf = '';

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) { return; }
    if (isTypingTarget(e.target)) { return; }

    if (e.key === 'Escape' && active) {
      buf = '';
      deactivate();
      return;
    }
    if (!e.key || e.key.length !== 1) { return; }
    buf = (buf + e.key.toLowerCase()).slice(-CODE.length);
    if (buf === CODE) {
      buf = '';
      if (active) { deactivate(); } else { activate(); }
    }
  }

  function init() {
    /* Nothing is created until the sequence is typed - one keydown listener is
       this feature's entire idle cost. (Typing "go2" also fires main.js's own
       "g" dissolve pulse on the hero; the two read as a single moment.) */
    document.addEventListener('keydown', onKeyDown);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
