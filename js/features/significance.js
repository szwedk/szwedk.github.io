/* =============================================================================
   IS IT REAL YET?  ·  [data-ks-significance]
   -----------------------------------------------------------------------------
   An A/B significance reader for campaign results. Type the two arms in,
   see the two posterior humps overlap, and get a verdict you can defend.

   HONESTY NOTE
   ------------
   Nothing here is telemetry. The visitor and conversion counts are whatever
   you type; every curve and every number below is MODELLED from those two
   pairs of integers and nothing else.

   WHAT IS ACTUALLY COMPUTED
   -------------------------
   * Each arm gets a Beta posterior over its true conversion rate:
     Beta(1 + conversions, 1 + visitors - conversions). That is a Bayesian
     update from a uniform Beta(1,1) prior, which is the honest "I knew
     nothing before the test started" position. The plot draws those two
     densities on one shared vertical scale, so the humps are comparable.
   * P(B > A) is the exact closed form, the standard finite sum over Beta
     functions. No Monte Carlo, no sampling, no random seed:
       P = sum_{i=0}^{aB-1} B(aA+i, bA+bB) / ((bB+i) B(1+i, bB) B(aA, bA))
     evaluated in log space with a Lanczos log-gamma so the factorials never
     overflow. The sum runs over whichever arm has fewer terms and the mirror
     identity P(A>B) = 1 - P(B>A) recovers the other. Past a term budget the
     readout falls back to a normal approximation of the posterior difference
     and prefixes the number with "~" so you know which one you are reading.
   * MORE VISITORS is a normal-approximation power estimate, n* =
     z^2 (pA qA + pB qB) / (pB - pA)^2 at z = 1.6449, minus what you already
     have. It assumes the observed rates hold exactly, which they will not.
     The label says so.

   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksSignificanceLoaded) { return; }
  window.__ksSignificanceLoaded = true;

  /* ===========================================================================
     1.  Small helpers
     ======================================================================== */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

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

  /* "rgb(11, 11, 12)" / "rgba(...)" -> [11, 11, 12] */
  function parseRGB(str, fallback) {
    if (!str) { return fallback.slice(); }
    var m = String(str).match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
    if (!m) { return fallback.slice(); }
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }

  /* Motion contract: the explicit site switch (localStorage ks-motion) wins,
     then the site's html.no-motion flag, then the OS preference. Still mode
     only removes the curve morph. Every control keeps working. */
  function isStill() {
    var v = null;
    try { v = window.localStorage.getItem('ks-motion'); } catch (e) { v = null; }
    if (v === 'off') { return true; }
    if (v === 'on') { return false; }
    if (document.documentElement.classList.contains('no-motion')) { return true; }
    return !!(window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* 1234567 -> "1,234,567" · toLocaleString is locale-dependent, this is not */
  function groupInt(v) {
    var s = String(Math.round(v)), out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      c++;
      if (c % 3 === 0 && i > 0) { out = ',' + out; }
    }
    return out;
  }

  /* ===========================================================================
     2.  Numerics · log-gamma, log-beta, Beta pdf, normal CDF
     ======================================================================== */

  /* Lanczos g=7, n=9. Accurate to ~15 significant figures across our range,
     and it works in log space so 48,000-trial factorials never overflow. */
  var LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7
  ];

  function lgamma(z) {
    if (z < 0.5) {
      /* reflection · never hit by our arguments, kept so the helper is total */
      return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
    }
    z -= 1;
    var x = 0.99999999999980993;
    for (var i = 0; i < 8; i++) { x += LANCZOS[i] / (z + i + 1); }
    var t = z + 7.5;
    return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function lbeta(a, b) { return lgamma(a) + lgamma(b) - lgamma(a + b); }

  function betaPdf(x, a, b, lb) {
    /* the endpoints are only reachable when a or b is exactly 1, so nudging
       off them costs nothing and keeps log(0) out of the loop */
    if (x <= 0) { x = 1e-12; } else if (x >= 1) { x = 1 - 1e-12; }
    var lp = (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - lb;
    return lp < -700 ? 0 : Math.exp(lp);
  }

  function betaMean(a, b) { return a / (a + b); }
  function betaSd(a, b) {
    var m = a / (a + b);
    return Math.sqrt(m * (1 - m) / (a + b + 1));
  }

  /* Zelen & Severo, A&S 26.2.17 · |error| < 7.5e-8, plenty for a readout */
  function normCdf(z) {
    if (!isFinite(z)) { return z > 0 ? 1 : 0; }
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989422804014327 * Math.exp(-z * z / 2);
    var p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
  }

  /* Term budget for the exact sum. Every preset and every plausible typed
     campaign lands well inside it; only absurd inputs trip the fallback. */
  var MAX_TERMS = 40000;

  /* Exact P(B > A) for Beta(a1,b1) vs Beta(a2,b2), integer a2. */
  function exactBOverA(a1, b1, a2, b2) {
    var base = lbeta(a1, b1);
    var lbb = b1 + b2;
    var total = 0;
    for (var i = 0; i < a2; i++) {
      var t = lbeta(a1 + i, lbb) - Math.log(b2 + i) - lbeta(1 + i, b2) - base;
      /* each term is a slice of probability, so it can never exceed 1 ·
         clamping the exponent at 0 is a cheap overflow guard */
      if (t > 0) { t = 0; }
      total += Math.exp(t);
      if (total >= 1) { return 1; }
    }
    return total < 0 ? 0 : total;
  }

  /* Returns [p, approximated]. Sums over the shorter arm and mirrors. */
  function probBOverA(a1, b1, a2, b2) {
    if (Math.min(a1, a2) > MAX_TERMS) {
      var sa = betaSd(a1, b1), sb = betaSd(a2, b2);
      var s = Math.sqrt(sa * sa + sb * sb);
      if (!(s > 0)) { return [betaMean(a2, b2) > betaMean(a1, b1) ? 1 : 0, true]; }
      return [clamp(normCdf((betaMean(a2, b2) - betaMean(a1, b1)) / s), 0, 1), true];
    }
    if (a2 <= a1) { return [clamp(exactBOverA(a1, b1, a2, b2), 0, 1), false]; }
    return [clamp(1 - exactBOverA(a2, b2, a1, b1), 0, 1), false];
  }

  /* ===========================================================================
     3.  Verdict + copy
     ======================================================================== */

  var Z95 = 1.6448536269514722;   /* one-sided 95%                           */
  var MAX_N = 1000000;            /* per-arm visitor ceiling                 */

  function verdictOf(pct) {
    if (pct >= 95) { return 'CALL IT · B WINS'; }
    if (pct >= 80) { return 'LEANING B'; }
    if (pct > 20) { return 'TOO CLOSE TO CALL'; }
    if (pct > 5) { return 'LEANING A'; }
    return 'CALL IT · A WINS';
  }

  var PRESETS = [
    /* tiny sample, doubled apparent rate, and still nowhere near a call */
    { id: 'early', label: 'Early and exciting', nA: 300, cA: 2, nB: 290, cB: 4 },
    /* the unglamorous one: 7% lift, but enough traffic to prove it */
    { id: 'boring', label: 'The boring truth', nA: 48000, cA: 1920, nB: 47500, cB: 2033 },
    /* same rate both sides, huge sample · the coin is fair */
    { id: 'flat', label: 'No difference', nA: 60000, cA: 1800, nB: 59000, cB: 1770 }
  ];

  var uid = 0;

  /* ===========================================================================
     4.  Mount
     ======================================================================== */

  function mount(root) {
    if (root.__ksSignificance) { return; }
    root.__ksSignificance = true;
    uid++;
    var ns = 'ks-sig-' + uid;

    var stillMode = isStill();
    var visible = true;
    var rafId = 0;
    var lastT = 0;

    /* ---- DOM ------------------------------------------------------------ */

    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-significance');
    if ((root.getAttribute('data-ks-significance') || '').toLowerCase() === 'dark') {
      root.classList.add('ks-significance-on-dark');
    }

    var head = el('div', 'ks-significance-head');
    head.appendChild(el('p', 'ks-significance-eyebrow', 'Is it real yet? · A/B significance'));
    head.appendChild(el('p', 'ks-significance-credit',
      'Bayesian beta posteriors · no sampling, closed form'));
    root.appendChild(head);

    /* -- two variant rows -- */
    var arms = el('div', 'ks-significance-arms');
    var fields = {};

    function buildArm(key, title, filled) {
      var row = el('div', 'ks-significance-arm');

      var akey = el('span', 'ks-significance-armkey');
      var sw = el('span', 'ks-significance-sw' + (filled ? ' ks-significance-sw-fill' : ''));
      sw.setAttribute('aria-hidden', 'true');
      akey.appendChild(sw);
      akey.appendChild(document.createTextNode(title));
      row.appendChild(akey);

      function field(kind, labelText) {
        var wrap = el('span', 'ks-significance-field');
        var id = ns + '-' + key + '-' + kind;
        var lab = el('label', 'ks-significance-fieldlab', labelText);
        lab.setAttribute('for', id);
        var inp = el('input', 'ks-significance-input');
        inp.id = id;
        inp.type = 'number';
        inp.min = '0';
        inp.max = String(MAX_N);
        inp.step = '1';
        inp.setAttribute('inputmode', 'numeric');
        inp.setAttribute('autocomplete', 'off');
        wrap.appendChild(lab);
        wrap.appendChild(inp);
        row.appendChild(wrap);
        return inp;
      }

      var visitors = field('n', 'Visitors');
      var conversions = field('c', 'Conversions');

      var cell = el('span', 'ks-significance-field ks-significance-ratewrap');
      cell.appendChild(el('span', 'ks-significance-fieldlab', 'Rate'));
      var rate = el('b', 'ks-significance-rate', '··');
      cell.appendChild(rate);
      row.appendChild(cell);

      arms.appendChild(row);
      fields[key] = { n: visitors, c: conversions, rate: rate };
    }

    buildArm('a', 'A, control', false);
    buildArm('b', 'B, variant', true);
    root.appendChild(arms);

    /* -- plot -- */
    var stage = el('div', 'ks-significance-stage');
    var plothead = el('div', 'ks-significance-plothead');
    plothead.appendChild(el('span', null, 'Posterior density · uniform Beta(1,1) prior'));
    plothead.appendChild(el('span', null, 'Shaded · where B outweighs A'));
    stage.appendChild(plothead);

    var cv = el('canvas', 'ks-significance-plot');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label',
      'Two overlapping probability density curves over conversion rate. The ' +
      'thin outline is A, the control. The filled outline is B, the variant. ' +
      'The shaded band is where B carries more probability than A. The numbers ' +
      'are repeated in the readout below.');
    stage.appendChild(cv);
    root.appendChild(stage);

    root.appendChild(el('p', 'ks-significance-note',
      'A big apparent lift on a small sample is the most common way marketing ' +
      'fools itself.'));

    /* -- readout -- */
    var readout = el('div', 'ks-significance-readout');
    var cells = {};
    var CELL_DEFS = [
      ['lift', 'Lift'],
      ['prob', 'P(B beats A)'],
      ['verdict', 'Verdict'],
      ['more', 'More visitors · if rates hold']
    ];
    for (var di = 0; di < CELL_DEFS.length; di++) {
      var cell = el('span', 'ks-significance-cell');
      cell.appendChild(el('span', 'ks-significance-cellkey', CELL_DEFS[di][1]));
      var b = el('b', 'ks-significance-cellval', '··');
      cell.appendChild(b);
      readout.appendChild(cell);
      cells[CELL_DEFS[di][0]] = b;
    }
    root.appendChild(readout);

    /* -- presets -- */
    var presetWrap = el('div', 'ks-significance-presets');
    presetWrap.appendChild(el('span', 'ks-significance-presetlab', 'Presets'));
    var pillBox = el('div', 'ks-significance-pills');
    var pills = [];
    for (var pi = 0; pi < PRESETS.length; pi++) {
      var pill = el('button', 'ks-significance-pill', PRESETS[pi].label);
      pill.type = 'button';
      pill.setAttribute('aria-pressed', 'false');
      pill.setAttribute('data-preset', PRESETS[pi].id);
      pillBox.appendChild(pill);
      pills.push(pill);
    }
    presetWrap.appendChild(pillBox);
    root.appendChild(presetWrap);

    var status = el('p', 'ks-significance-sr');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.appendChild(status);

    /* ---- canvas plumbing ------------------------------------------------ */

    var pctx = cv.getContext ? cv.getContext('2d') : null;
    if (!pctx) { return; }

    var dpr = 1, PW = 0, PH = 0;
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

    function layout() {
      var w = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 320;
      var h = cv.clientHeight || 200;
      dpr = Math.min(window.devicePixelRatio || 1, 2);   /* DPR capped at 2  */
      var pw = Math.max(1, Math.round(w * dpr));
      var ph = Math.max(1, Math.round(h * dpr));
      if (cv.width !== pw) { cv.width = pw; }
      if (cv.height !== ph) { cv.height = ph; }
      pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      PW = w; PH = h;
    }

    function labelPx() { return clamp(PW / 78, 8.5, 10.5); }

    /* Tracked micro-labels, characters placed by hand (canvas letterSpacing
       is not universal). Widths memoised against a bounded key set. */
    var wCache = {};
    function charW(ch, size, weight) {
      var k = size + '|' + weight + '|' + ch;
      var v = wCache[k];
      if (v === undefined) {
        pctx.font = weight + ' ' + size + 'px ' + FAMILY;
        v = pctx.measureText(ch).width;
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
      pctx.font = weight + ' ' + size + 'px ' + FAMILY;
      pctx.fillStyle = ink(alpha);
      var tr = size * trEm;
      var w = trackedWidth(str, size, weight, trEm);
      var cx = align === 1 ? x - w : (align === 0 ? x - w / 2 : x);
      for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        pctx.fillText(ch, cx, y);
        cx += charW(ch, size, weight) + tr;
      }
      return w;
    }

    /* ---- state ---------------------------------------------------------- */

    /* target = the truth from the inputs; cur = what is drawn. They differ
       only while the morph tween runs, which still mode skips entirely. */
    var target = { a1: 97, b1: 1105, a2: 119, b2: 1063, lo: 0.05, hi: 0.13 };
    var cur = { a1: 97, b1: 1105, a2: 119, b2: 1063, lo: 0.05, hi: 0.13 };
    var TWEEN_MS = 300;
    var tweenT = 1;
    var from = { a1: 0, b1: 0, a2: 0, b2: 0, lo: 0, hi: 0 };
    var lastVerdict = '';
    var activePreset = '';

    var dA = null, dB = null, bufN = 0;
    function ensureBuf(n) {
      if (bufN === n && dA) { return; }
      bufN = n;
      dA = new Float64Array(n);
      dB = new Float64Array(n);
    }

    /* ---- input reading -------------------------------------------------- */

    /* Non-numeric, empty, negative, fractional and absurd all land somewhere
       sane. The sign is kept through the strip so "-40" floors to 0 rather
       than reading as 40. */
    function readNum(input) {
      var raw = String(input.value == null ? '' : input.value).replace(/[^0-9.eE+\-]/g, '');
      var v = parseFloat(raw);
      if (!isFinite(v) || v < 0) { v = 0; }
      v = Math.floor(v);
      return v > MAX_N ? MAX_N : v;
    }

    function readArms() {
      var nA = readNum(fields.a.n);
      var cA = Math.min(readNum(fields.a.c), nA);   /* conversions <= visitors */
      var nB = readNum(fields.b.n);
      var cB = Math.min(readNum(fields.b.c), nB);
      return { nA: nA, cA: cA, nB: nB, cB: cB };
    }

    function writeArms(v) {
      fields.a.n.value = String(v.nA);
      fields.a.c.value = String(v.cA);
      fields.b.n.value = String(v.nB);
      fields.b.c.value = String(v.cB);
    }

    /* ---- the actual work ------------------------------------------------ */

    function pctText(x, dp) { return (x * 100).toFixed(dp == null ? 1 : dp) + '%'; }

    function update(announceForce) {
      var v = readArms();
      var a1 = 1 + v.cA, b1 = 1 + v.nA - v.cA;
      var a2 = 1 + v.cB, b2 = 1 + v.nB - v.cB;

      var rA = v.nA > 0 ? v.cA / v.nA : NaN;
      var rB = v.nB > 0 ? v.cB / v.nB : NaN;
      fields.a.rate.textContent = isFinite(rA) ? pctText(rA, 2) : '··';
      fields.b.rate.textContent = isFinite(rB) ? pctText(rB, 2) : '··';

      var res = probBOverA(a1, b1, a2, b2);
      var p = res[0], approx = res[1];
      var pct = p * 100;

      /* lift, relative · undefined when the control never converted */
      if (isFinite(rA) && isFinite(rB) && rA > 0) {
        var lift = (rB - rA) / rA * 100;
        cells.lift.textContent = (lift >= 0 ? '+' : '') + lift.toFixed(1) + '%';
      } else if (isFinite(rB) && rB > 0 && rA === 0) {
        cells.lift.textContent = 'FROM ZERO';
      } else {
        cells.lift.textContent = '··';
      }

      cells.prob.textContent = (approx ? '~' : '') + pct.toFixed(1) + '%';

      var verdict = verdictOf(pct);
      cells.verdict.textContent = verdict;

      /* sample size to a 95% call, if the observed rates hold exactly */
      var moreText;
      if (!isFinite(rA) || !isFinite(rB)) {
        moreText = '··';
      } else if (pct >= 95 || pct <= 5) {
        moreText = 'NONE · CALLED';
      } else if (rA === rB) {
        moreText = 'NO GAP TO CLOSE';
      } else {
        var d = rB - rA;
        var vs = rA * (1 - rA) + rB * (1 - rB);
        var nStar = Z95 * Z95 * vs / (d * d);
        var extra = Math.max(0, Math.ceil(nStar) - Math.min(v.nA, v.nB));
        moreText = extra > 9999999 ? 'OVER 10M · PER ARM'
                                   : '+' + groupInt(extra) + ' · PER ARM';
      }
      cells.more.textContent = moreText;

      /* plot range: the union of both posteriors out to ~4 sd */
      var mA = betaMean(a1, b1), sA = betaSd(a1, b1);
      var mB = betaMean(a2, b2), sB = betaSd(a2, b2);
      var lo = Math.min(mA - 4.2 * sA, mB - 4.2 * sB);
      var hi = Math.max(mA + 4.2 * sA, mB + 4.2 * sB);
      lo = clamp(lo, 0, 1);
      hi = clamp(hi, 0, 1);
      if (hi - lo < 1e-5) {
        var mid = (hi + lo) / 2;
        lo = clamp(mid - 5e-6, 0, 1);
        hi = clamp(mid + 5e-6, 0, 1);
      }

      setTarget(a1, b1, a2, b2, lo, hi);

      if (verdict !== lastVerdict || announceForce) {
        lastVerdict = verdict;
        status.textContent = 'Verdict, ' + verdict.replace(' · ', ', ').toLowerCase() +
          '. Probability B beats A, ' + pct.toFixed(1) + ' percent.';
      }
    }

    function setTarget(a1, b1, a2, b2, lo, hi) {
      target.a1 = a1; target.b1 = b1; target.a2 = a2; target.b2 = b2;
      target.lo = lo; target.hi = hi;
      if (stillMode || !visible || document.hidden) {
        snap();
        if (visible && !document.hidden) { drawPlot(); }
        return;
      }
      from.a1 = cur.a1; from.b1 = cur.b1; from.a2 = cur.a2; from.b2 = cur.b2;
      from.lo = cur.lo; from.hi = cur.hi;
      tweenT = 0;
      lastT = now();
      start();
    }

    function snap() {
      cur.a1 = target.a1; cur.b1 = target.b1;
      cur.a2 = target.a2; cur.b2 = target.b2;
      cur.lo = target.lo; cur.hi = target.hi;
      tweenT = 1;
    }

    /* ---- drawing -------------------------------------------------------- */

    function tickStep(span, want) {
      var raw = span / want;
      if (!(raw > 0)) { return 0.01; }
      var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
      var cands = [1, 2, 2.5, 5];
      for (var i = 0; i < cands.length; i++) {
        if (cands[i] * pow >= raw) { return cands[i] * pow; }
      }
      return 10 * pow;
    }

    function drawPlot() {
      var ctx = pctx;
      if (PW <= 0 || PH <= 0) { return; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, PW, PH);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.textBaseline = 'alphabetic';

      var lp = labelPx();
      var topY = Math.round(lp * 2.1);
      var baseY = Math.max(topY + 12, PH - Math.round(lp * 2.6));
      var left = 1, right = Math.max(2, PW - 1);
      var plotW = right - left;
      var plotH = baseY - topY;

      var lo = cur.lo, hi = cur.hi;
      var span = Math.max(1e-12, hi - lo);
      var n = Math.max(24, Math.min(1000, Math.round(plotW)));
      ensureBuf(n);

      var lbA = lbeta(cur.a1, cur.b1);
      var lbB = lbeta(cur.a2, cur.b2);
      var maxD = 0, i, x;
      for (i = 0; i < n; i++) {
        x = lo + span * (i / (n - 1));
        var va = betaPdf(x, cur.a1, cur.b1, lbA);
        var vb = betaPdf(x, cur.a2, cur.b2, lbB);
        dA[i] = va; dB[i] = vb;
        if (va > maxD) { maxD = va; }
        if (vb > maxD) { maxD = vb; }
      }
      if (!(maxD > 0)) { maxD = 1; }
      /* one shared vertical scale · two humps you can honestly compare */
      var ys = (plotH * 0.94) / maxD;

      function PX(idx) { return left + plotW * (idx / (n - 1)); }
      function PY(v) { return baseY - v * ys; }

      /* --- light fill under B ------------------------------------------- */
      ctx.beginPath();
      ctx.moveTo(PX(0), baseY);
      for (i = 0; i < n; i++) { ctx.lineTo(PX(i), PY(dB[i])); }
      ctx.lineTo(PX(n - 1), baseY);
      ctx.closePath();
      ctx.fillStyle = ink(0.07);
      ctx.fill();

      /* --- shade every stretch where B carries more mass than A ---------- */
      ctx.beginPath();
      i = 0;
      while (i < n) {
        if (dB[i] > dA[i]) {
          var s = i;
          while (i < n && dB[i] > dA[i]) { i++; }
          var e = i - 1;
          ctx.moveTo(PX(s), PY(dB[s]));
          for (var k = s + 1; k <= e; k++) { ctx.lineTo(PX(k), PY(dB[k])); }
          for (var k2 = e; k2 >= s; k2--) { ctx.lineTo(PX(k2), PY(dA[k2])); }
          ctx.closePath();
        } else { i++; }
      }
      ctx.fillStyle = ink(0.17);
      ctx.fill();

      /* --- outlines ------------------------------------------------------ */
      ctx.strokeStyle = ink(0.42);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        if (i === 0) { ctx.moveTo(PX(i), PY(dA[i])); }
        else { ctx.lineTo(PX(i), PY(dA[i])); }
      }
      ctx.stroke();

      ctx.strokeStyle = ink(0.82);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (i = 0; i < n; i++) {
        if (i === 0) { ctx.moveTo(PX(i), PY(dB[i])); }
        else { ctx.lineTo(PX(i), PY(dB[i])); }
      }
      ctx.stroke();

      /* --- axis + percent ticks ------------------------------------------ */
      ctx.strokeStyle = ink(0.22);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, Math.round(baseY) + 0.5);
      ctx.lineTo(right, Math.round(baseY) + 0.5);
      ctx.stroke();

      var step = tickStep(span, 5);
      var dp = (step * 100) >= 1 ? 0 : ((step * 100) >= 0.1 ? 1 : 2);
      var t0 = Math.ceil(lo / step) * step;
      var guard = 0;
      for (var tv = t0; tv <= hi + step * 1e-6 && guard < 40; tv += step, guard++) {
        var tx = left + plotW * ((tv - lo) / span);
        if (tx < left - 0.5 || tx > right + 0.5) { continue; }
        ctx.strokeStyle = ink(0.22);
        ctx.beginPath();
        ctx.moveTo(Math.round(tx) + 0.5, baseY);
        ctx.lineTo(Math.round(tx) + 0.5, baseY + Math.round(lp * 0.55));
        ctx.stroke();
        /* the end ticks hug the edges, so flip their alignment inward */
        var align = tx < left + plotW * 0.06 ? -1
                  : (tx > right - plotW * 0.06 ? 1 : 0);
        tracked((tv * 100).toFixed(dp) + '%', tx, baseY + lp * 2.05,
                lp, 600, 0.5, 0.14, align);
      }

      /* --- mean markers, so the two humps are named on the canvas -------- */
      function markerX(a, b) {
        var m = betaMean(a, b);
        if (m < lo || m > hi) { return null; }
        return clamp(Math.round((m - lo) / span * (n - 1)), 0, n - 1);
      }
      function marker(idx, dens, letter, alpha, dx) {
        if (idx == null) { return; }
        var mx = PX(idx), my = PY(dens[idx]);
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = ink(alpha * 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(mx) + 0.5, baseY);
        ctx.lineTo(Math.round(mx) + 0.5, my);
        ctx.stroke();
        ctx.restore();
        var ly = clamp(my - lp * 0.9, topY + lp * 0.9, baseY - 2);
        tracked(letter, clamp(mx + dx, left + lp, right - lp), ly, lp, 600, alpha, 0.16, 0);
      }
      var iA = markerX(cur.a1, cur.b1), iB = markerX(cur.a2, cur.b2);
      /* identical arms stack the two means on one pixel · split the letters
         so the reader can still see there are two curves under there */
      var nudge = (iA != null && iB != null && Math.abs(PX(iA) - PX(iB)) < lp * 2.6)
        ? lp * 1.5 : 0;
      marker(iA, dA, 'A', 0.5, -nudge);
      marker(iB, dB, 'B', 0.85, nudge);
    }

    /* ---- loop ----------------------------------------------------------- */

    function running() { return !stillMode && visible && !document.hidden && tweenT < 1; }

    function step() {
      rafId = 0;
      var t = now();
      var dt = Math.min(64, t - lastT);
      lastT = t;
      tweenT = clamp(tweenT + dt / TWEEN_MS, 0, 1);
      var u = 1 - Math.pow(1 - tweenT, 3);          /* ease out cubic        */
      cur.a1 = from.a1 + (target.a1 - from.a1) * u;
      cur.b1 = from.b1 + (target.b1 - from.b1) * u;
      cur.a2 = from.a2 + (target.a2 - from.a2) * u;
      cur.b2 = from.b2 + (target.b2 - from.b2) * u;
      cur.lo = from.lo + (target.lo - from.lo) * u;
      cur.hi = from.hi + (target.hi - from.hi) * u;
      drawPlot();
      if (running()) { rafId = window.requestAnimationFrame(step); }
    }

    function start() {
      if (rafId || !running()) { return; }
      lastT = now();
      rafId = window.requestAnimationFrame(step);
    }

    function stop() {
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
    }

    /* ---- events --------------------------------------------------------- */

    function clearPreset() {
      if (!activePreset) { return; }
      activePreset = '';
      for (var i = 0; i < pills.length; i++) { pills[i].setAttribute('aria-pressed', 'false'); }
    }

    function bindInput(inp) {
      inp.addEventListener('input', function () { clearPreset(); update(false); });
      /* commit-time clamp: rewriting mid-keystroke fights the typist */
      inp.addEventListener('change', function () {
        writeArms(readArms());
        update(false);
      });
    }
    bindInput(fields.a.n); bindInput(fields.a.c);
    bindInput(fields.b.n); bindInput(fields.b.c);

    for (var qi = 0; qi < pills.length; qi++) {
      pills[qi].addEventListener('click', function (e) {
        var id = e.currentTarget.getAttribute('data-preset');
        var def = null;
        for (var j = 0; j < PRESETS.length; j++) {
          if (PRESETS[j].id === id) { def = PRESETS[j]; }
        }
        if (!def) { return; }
        writeArms(def);
        activePreset = id;
        for (var m = 0; m < pills.length; m++) {
          pills[m].setAttribute('aria-pressed',
            pills[m].getAttribute('data-preset') === id ? 'true' : 'false');
        }
        update(true);
      });
    }

    /* ---- observers ------------------------------------------------------ */

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) { visible = entries[i].isIntersecting; }
        if (running()) { start(); } else { stop(); if (visible) { snap(); drawPlot(); } }
      }, { rootMargin: '160px' });
      io.observe(root);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { stop(); }
      else if (running()) { start(); }
      else { snap(); drawPlot(); }
    });

    function onMotionChange() {
      var was = stillMode;
      stillMode = isStill();
      if (was === stillMode) { return; }
      if (stillMode) { stop(); snap(); drawPlot(); } else { start(); }
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
        drawPlot();
      }, 160);
    }
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) {
      new window.ResizeObserver(onResize).observe(root);
    }

    /* ---- go -------------------------------------------------------------- */

    writeArms({ nA: 1200, cA: 96, nB: 1180, cB: 118 });
    readColors();
    layout();
    lastW = cv.clientWidth;
    lastH = cv.clientHeight;
    update(false);
    snap();
    drawPlot();

    /* zero-width container (hidden tab, late fonts): retry once */
    if (!lastW) {
      window.setTimeout(function () {
        if (cv.clientWidth) { layout(); drawPlot(); }
      }, 300);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        readColors(); wCache = {}; layout(); drawPlot();
      }, function () {});
    }
  }

  /* ===========================================================================
     5.  Boot
     ======================================================================== */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-significance]');
    if (!nodes.length) { return; }
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
