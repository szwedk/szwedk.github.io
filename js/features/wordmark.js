/* =============================================================================
   Wordmark, reprinted  \u2014  [data-ks-wordmark]
   -----------------------------------------------------------------------------
   Press and hold the footer wordmark: the rendered name dissolves and is then
   re-printed on screen as a simulated FDM slicer preview \u2014 outer perimeter,
   inner perimeter, 45-degree infill, layer by layer, with a live telemetry
   readout.

   The toolpath is NOT canned data. At runtime the name is rasterised to an
   offscreen canvas with the site font, the alpha channel is turned into a
   signed Euclidean distance field, and the paths are derived from it:

     outer perimeter  = marching-squares isoline at D = 0.5 * bead width
     inner perimeter  = marching-squares isoline at D = 1.55 * bead width
     infill           = 45-degree scanlines clipped to D >= 2.2 * bead width

   Contours are simplified with Ramer-Douglas-Peucker, ordered nearest-first
   (as a slicer would), and the infill runs boustrophedon with the hatch angle
   alternating +45/-45 per layer. Travel moves are dashed, extrusions solid.

   Everything here is a SIMULATION of a slicer preview. The temperatures, flow
   rate and time estimate are plausible model values, not machine telemetry.

   No dependencies. GSAP / Lenis are not used or required.
   ============================================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
     Tunables
     --------------------------------------------------------------------------- */

  var LAYERS        = 38;      // layer count quoted in the readout
  var DISSOLVE_MS   = 450;     // "un-printing" wipe + preheat
  var PRINT_MS      = 8600;    // the build itself (per-instance override below)
  var COOL_MS       = 950;     // part-cooling shimmer + settle
  var CANCEL_MS     = 340;     // graceful restore after an early release

  var SAMPLE_INK_H  = 170;     // ink height, in sample px, used for geometry
  var TRACK_EM      = -0.03;   // display tracking, matches the site's headings
  var FONT_WEIGHT   = 600;
  var VPAD          = 4;       // px of breathing room above/below the mark
  var HPAD          = 6;       // px kept clear at the left/right edges

  var READOUT_MS    = 90;      // telemetry refresh interval

  /* Fallback ink colour if the computed colour cannot be parsed (dark footer). */
  var FALLBACK_INK  = [242, 239, 233];   // --bone
  var FALLBACK_HOT  = [246, 214, 170];   // hot-end tint, see the CSS custom prop

  /* ---------------------------------------------------------------------------
     Small helpers
     --------------------------------------------------------------------------- */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function parseRGB(str, fallback) {
    if (!str) return fallback.slice();
    var m = String(str).match(/(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/);
    if (!m) return fallback.slice();
    return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  }

  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  function mixRGB(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  function pad(n, width) {
    var s = String(Math.max(0, Math.round(n)));
    while (s.length < width) s = '0' + s;
    return s;
  }

  /* hh:mm:ss -- the format a slicer shows for "time remaining" */
  function clock(seconds) {
    var s = Math.max(0, Math.ceil(seconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s % 60, 2);
  }

  function now() {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }

  /* =============================================================================
     --- ks-wordmark:geometry:begin ---
     Pure computational geometry. No DOM access below this line until the
     matching :end marker, so the block can be lifted out and unit-tested.
     ============================================================================= */

  var LINE_W        = 3.4;     // extrusion bead width, in sample px
  var INFILL_GAP    = 8.0;     // perpendicular hatch spacing, in sample px
  var RDP_EPS       = 0.32;    // contour simplification tolerance, sample px
  var MIN_INFILL    = 2.2;     // shortest infill segment worth extruding
  var SPEED_EXTRUDE = 1.0;     // relative feed rates; only the ratio matters
  var SPEED_TRAVEL  = 3.2;

  var ISO_OUTER     = LINE_W * 0.5;
  var ISO_INNER     = LINE_W * 1.55;
  var ISO_INFILL    = LINE_W * 2.2;

  var BIG = 1e20;              // stands in for infinity in the distance passes

  /* 1-D squared distance transform (Felzenszwalb & Huttenlocher's lower
     envelope). Ported from the classic implementation; `f` is the sampled
     function, `d` receives the transform, `v`/`z` are scratch. */
  function edt1d(f, d, v, z, n) {
    var q, k = 0, s = 0, r;
    v[0] = 0;
    z[0] = -BIG;
    z[1] = BIG;
    for (q = 1; q < n; q++) {
      do {
        r = v[k];
        s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
      } while (s <= z[k] && --k > -1);
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = BIG;
    }
    k = 0;
    for (q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      r = v[k];
      d[q] = (q - r) * (q - r) + f[r];
    }
  }

  /* Separable 2-D squared EDT, in place. `f` holds 0 at seed pixels, BIG
     everywhere else; afterwards it holds the squared distance to the nearest
     seed. */
  function edt2d(f, w, h) {
    var n = w > h ? w : h;
    var d = new Float64Array(n);
    var v = new Int32Array(n);
    var z = new Float64Array(n + 1);
    var col = new Float64Array(n);
    var x, y;

    for (x = 0; x < w; x++) {
      for (y = 0; y < h; y++) col[y] = f[y * w + x];
      edt1d(col, d, v, z, h);
      for (y = 0; y < h; y++) f[y * w + x] = d[y];
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) col[x] = f[y * w + x];
      edt1d(col, d, v, z, w);
      for (x = 0; x < w; x++) f[y * w + x] = d[x];
    }
    return f;
  }

  /* Separable [1,2,1] blur, in place.

     A distance field is locally linear with unit slope, and a symmetric kernel
     leaves a linear ramp untouched -- so this does not shift a straight edge by
     even a thousandth of a pixel (verified). What it does remove is the
     half-pixel staircase the tracer inherits from a binary mask, which is
     exactly the high-frequency noise we do not want on a curved letterform.
     Cost: about one square pixel of rounding at a sharp corner. */
  function blurField(D, w, h, passes) {
    var tmp = new Float32Array(w * h);
    var p, x, y, i, up, dn;
    for (p = 0; p < passes; p++) {
      for (y = 0; y < h; y++) {
        i = y * w;
        for (x = 0; x < w; x++) {
          tmp[i + x] = (D[i + (x > 0 ? x - 1 : x)] + 2 * D[i + x] +
                        D[i + (x < w - 1 ? x + 1 : x)]) * 0.25;
        }
      }
      for (y = 0; y < h; y++) {
        up = (y > 0 ? y - 1 : y) * w;
        dn = (y < h - 1 ? y + 1 : y) * w;
        i = y * w;
        for (x = 0; x < w; x++) {
          D[i + x] = (tmp[up + x] + 2 * tmp[i + x] + tmp[dn + x]) * 0.25;
        }
      }
    }
    return D;
  }

  /* Signed distance field from a binary mask: positive inside the glyphs,
     negative outside, in sample pixels. The zero crossing sits on the true
     glyph boundary, so every isoline we trace nests correctly. */
  function buildSDF(mask, w, h) {
    var n = w * h, i;
    var fOut = new Float64Array(n);   // seeds = outside pixels
    var fIn = new Float64Array(n);    // seeds = inside pixels
    for (i = 0; i < n; i++) {
      if (mask[i]) { fOut[i] = BIG; fIn[i] = 0; }
      else { fOut[i] = 0; fIn[i] = BIG; }
    }
    edt2d(fOut, w, h);
    edt2d(fIn, w, h);
    var D = new Float32Array(n);
    for (i = 0; i < n; i++) {
      D[i] = Math.sqrt(fOut[i] < BIG ? fOut[i] : 0) -
             Math.sqrt(fIn[i] < BIG ? fIn[i] : 0);
    }
    return blurField(D, w, h, 2);
  }

  function sampleField(D, w, h, x, y) {
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > w - 1.001) x = w - 1.001;
    if (y > h - 1.001) y = h - 1.001;
    var x0 = x | 0, y0 = y | 0;
    var fx = x - x0, fy = y - y0;
    var i = y0 * w + x0;
    var a = D[i], b = D[i + 1], c = D[i + w], d = D[i + w + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /* Marching squares, chained into closed contours.

     Every crossed grid edge carries exactly one contour point, so we key the
     chain on edge identity rather than on coordinates \u2014 no floating-point
     endpoint matching, and each edge provably has one outgoing and one
     incoming segment. Segments are emitted with the solid on the right, which
     makes outer contours clockwise and holes counter-clockwise, as a slicer
     would order them. Ambiguous saddles are resolved on the cell average. */
  function traceIso(D, w, h, t) {
    var nE = w * h * 2;
    var nextEdge = new Int32Array(nE);   // 0 = unset, else destination + 1
    var ptIdx = new Int32Array(nE);      // 0 = unset, else point index + 1
    var ptX = [], ptY = [];
    var starts = [];
    var x, y;

    function pointFor(e) {
      if (ptIdx[e]) return;
      var cell = e >> 1, vert = e & 1;
      var cx = cell % w, cy = (cell - cx) / w;
      var v0, v1, tt;
      if (vert) {
        v0 = D[cy * w + cx];
        v1 = D[(cy + 1) * w + cx];
      } else {
        v0 = D[cy * w + cx];
        v1 = D[cy * w + cx + 1];
      }
      tt = (v1 === v0) ? 0.5 : (t - v0) / (v1 - v0);
      if (!(tt >= 0)) tt = 0;
      if (tt > 1) tt = 1;
      ptX.push(vert ? cx : cx + tt);
      ptY.push(vert ? cy + tt : cy);
      ptIdx[e] = ptX.length;
    }

    function link(a, b) {
      if (nextEdge[a]) return;          // defensive: never overwrite a link
      pointFor(a);
      pointFor(b);
      nextEdge[a] = b + 1;
      starts.push(a);
    }

    for (y = 0; y < h - 1; y++) {
      for (x = 0; x < w - 1; x++) {
        var i0 = y * w + x;
        var va = D[i0], vb = D[i0 + 1], vc = D[i0 + w + 1], vd = D[i0 + w];
        var idx = (va >= t ? 1 : 0) | (vb >= t ? 2 : 0) |
                  (vc >= t ? 4 : 0) | (vd >= t ? 8 : 0);
        if (idx === 0 || idx === 15) continue;

        var T = (y * w + x) * 2;             // top    edge, (x,y)-(x+1,y)
        var B = ((y + 1) * w + x) * 2;       // bottom edge, (x,y+1)-(x+1,y+1)
        var L = (y * w + x) * 2 + 1;         // left   edge, (x,y)-(x,y+1)
        var R = (y * w + x + 1) * 2 + 1;     // right  edge, (x+1,y)-(x+1,y+1)

        switch (idx) {
          case 1:  link(T, L); break;
          case 2:  link(R, T); break;
          case 3:  link(R, L); break;
          case 4:  link(B, R); break;
          case 6:  link(B, T); break;
          case 7:  link(B, L); break;
          case 8:  link(L, B); break;
          case 9:  link(T, B); break;
          case 11: link(R, B); break;
          case 12: link(L, R); break;
          case 13: link(T, R); break;
          case 14: link(L, T); break;
          case 5:  /* saddle: solid at top-left + bottom-right */
            if ((va + vb + vc + vd) * 0.25 >= t) { link(T, R); link(B, L); }
            else { link(T, L); link(B, R); }
            break;
          case 10: /* saddle: solid at top-right + bottom-left */
            if ((va + vb + vc + vd) * 0.25 >= t) { link(L, T); link(R, B); }
            else { link(R, T); link(L, B); }
            break;
        }
      }
    }

    var visited = new Uint8Array(nE);
    var polys = [];
    for (var s = 0; s < starts.length; s++) {
      var e = starts[s];
      if (visited[e]) continue;
      var xs = [], ys = [], guard = 0;
      while (e >= 0 && !visited[e] && guard++ <= nE) {
        visited[e] = 1;
        var pi = ptIdx[e] - 1;
        xs.push(ptX[pi]);
        ys.push(ptY[pi]);
        if (!nextEdge[e]) break;
        e = nextEdge[e] - 1;
      }
      if (xs.length >= 3) polys.push({ x: xs, y: ys });
    }
    return polys;
  }

  /* Ramer-Douglas-Peucker over an explicit index list. */
  function rdpRun(px, py, idx, eps) {
    var n = idx.length;
    if (n < 3) return idx.slice();
    var keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    var stack = [0, n - 1];
    var eps2 = eps * eps;
    while (stack.length) {
      var e = stack.pop(), s = stack.pop();
      if (e <= s + 1) continue;
      var x0 = px[idx[s]], y0 = py[idx[s]];
      var dx = px[idx[e]] - x0, dy = py[idx[e]] - y0;
      var len2 = dx * dx + dy * dy;
      var best = -1, bi = -1, i, vx, vy, dd, cr;
      for (i = s + 1; i < e; i++) {
        vx = px[idx[i]] - x0;
        vy = py[idx[i]] - y0;
        if (len2 === 0) {
          dd = vx * vx + vy * vy;
        } else {
          cr = vx * dy - vy * dx;
          dd = cr * cr / len2;
        }
        if (dd > best) { best = dd; bi = i; }
      }
      if (best > eps2 && bi > s) {
        keep[bi] = 1;
        stack.push(s, bi);
        stack.push(bi, e);
      }
    }
    var out = [];
    for (var j = 0; j < n; j++) if (keep[j]) out.push(idx[j]);
    return out;
  }

  /* RDP on a closed ring: split it at the vertex furthest from vertex 0 so
     neither half degenerates, simplify both halves, then stitch. */
  function simplifyRing(poly, eps) {
    var xs = poly.x, ys = poly.y, n = xs.length;
    if (n < 5) return poly;
    var far = 1, fd = -1, i, dx, dy, d2;
    for (i = 1; i < n; i++) {
      dx = xs[i] - xs[0];
      dy = ys[i] - ys[0];
      d2 = dx * dx + dy * dy;
      if (d2 > fd) { fd = d2; far = i; }
    }
    var idxA = [], idxB = [];
    for (i = 0; i <= far; i++) idxA.push(i);
    for (i = far; i < n; i++) idxB.push(i);
    idxB.push(0);

    var a = rdpRun(xs, ys, idxA, eps);
    var b = rdpRun(xs, ys, idxB, eps);

    var out = { x: [], y: [] };
    for (i = 0; i < a.length; i++) { out.x.push(xs[a[i]]); out.y.push(ys[a[i]]); }
    for (i = 1; i < b.length - 1; i++) { out.x.push(xs[b[i]]); out.y.push(ys[b[i]]); }
    return out.x.length >= 3 ? out : poly;
  }

  function simplifyAll(polys, eps) {
    var out = [];
    for (var i = 0; i < polys.length; i++) {
      var p = simplifyRing(polys[i], eps);
      if (p.x.length >= 3) out.push(p);
    }
    return out;
  }

  /* 45-degree infill.

     dir = +1 : hatch runs along (1, 1),  lines parametrised by c = x - y
     dir = -1 : hatch runs along (1, -1), lines parametrised by c = x + y

     Each line is walked in half-pixel steps; sign changes of (D - threshold)
     are refined by linear interpolation to give the entry/exit pairs, i.e.
     a real scanline clip against the letterforms. Alternate lines are walked
     in reverse (boustrophedon), the way a slicer actually fills a region. */
  function makeInfill(D, w, h, thr, dir, gap, minLen) {
    var dc = gap * Math.SQRT2;
    var cMin = dir > 0 ? -(h - 1) : 0;
    var cMax = dir > 0 ? (w - 1) : (w - 1) + (h - 1);
    var step = 0.5;
    var out = [];
    var line = 0;
    var c, t0, t1, tt, x, y, v, pv, pt, inside, entry, f, tx, cross;

    for (c = cMin + dc * 0.5; c <= cMax; c += dc) {
      if (dir > 0) {
        t0 = Math.max(0, c);
        t1 = Math.min(w - 1, c + (h - 1));
      } else {
        t0 = Math.max(0, c - (h - 1));
        t1 = Math.min(w - 1, c);
      }
      if (t1 - t0 < minLen) { line++; continue; }

      var segs = [];
      pv = null;
      pt = t0;
      inside = false;
      entry = t0;

      for (tt = t0; tt <= t1 + 1e-9; tt += step) {
        if (tt > t1) tt = t1;
        x = tt;
        y = dir > 0 ? tt - c : c - tt;
        v = sampleField(D, w, h, x, y) - thr;
        if (pv === null) {
          inside = v >= 0;
          entry = t0;
        } else if (!inside && v >= 0) {
          f = pv === v ? 0 : pv / (pv - v);
          entry = pt + f * (tt - pt);
          inside = true;
        } else if (inside && v < 0) {
          f = pv === v ? 0 : pv / (pv - v);
          cross = pt + f * (tt - pt);
          if (cross - entry >= minLen) segs.push([entry, cross]);
          inside = false;
        }
        pv = v;
        pt = tt;
        if (tt >= t1) break;
      }
      if (inside && t1 - entry >= minLen) segs.push([entry, t1]);

      if (segs.length) {
        if (line & 1) segs.reverse();
        for (var i = 0; i < segs.length; i++) {
          var s0 = segs[i][0], s1 = segs[i][1];
          if (line & 1) { tx = s0; s0 = s1; s1 = tx; }   // walk back the other way
          out.push([
            s0, dir > 0 ? s0 - c : c - s0,
            s1, dir > 0 ? s1 - c : c - s1
          ]);
        }
      }
      line++;
    }
    return out;
  }

  /* Greedy nearest-start ordering, rotating each ring so it begins at the
     vertex closest to where the nozzle already is. Short travels, and the
     nozzle reads left-to-right across the word instead of hopping about. */
  function orderRings(polys, sx, sy) {
    var pending = polys.slice();
    var out = [];
    var cx = sx, cy = sy;
    while (pending.length) {
      var bestP = 0, bestV = 0, bestD = Infinity, i, j, dx, dy, d2;
      for (i = 0; i < pending.length; i++) {
        var p = pending[i];
        for (j = 0; j < p.x.length; j++) {
          dx = p.x[j] - cx;
          dy = p.y[j] - cy;
          d2 = dx * dx + dy * dy;
          if (d2 < bestD) { bestD = d2; bestP = i; bestV = j; }
        }
      }
      var pick = pending.splice(bestP, 1)[0];
      var rx = pick.x.slice(bestV).concat(pick.x.slice(0, bestV));
      var ry = pick.y.slice(bestV).concat(pick.y.slice(0, bestV));
      out.push({ x: rx, y: ry });
      cx = rx[0];
      cy = ry[0];
    }
    return out;
  }

  /* A single move: kind 1 = extrude, 0 = travel. `cum` holds cumulative
     length so a partial move can be drawn without re-measuring. */
  function makeOp(kind, xs, ys) {
    var cum = [0], total = 0, i, dx, dy;
    for (i = 1; i < xs.length; i++) {
      dx = xs[i] - xs[i - 1];
      dy = ys[i] - ys[i - 1];
      total += Math.sqrt(dx * dx + dy * dy);
      cum.push(total);
    }
    return {
      e: kind,
      x: xs,
      y: ys,
      cum: cum,
      len: total,
      cost: total / (kind ? SPEED_EXTRUDE : SPEED_TRAVEL),
      c0: 0
    };
  }

  /* Outer perimeter -> inner perimeter -> infill, with travels in between. */
  function buildToolpath(outer, inner, infill) {
    var ops = [];
    var cur = { x: 0, y: 0 }, started = false;

    function travelTo(x, y) {
      if (started && (Math.abs(x - cur.x) > 1e-6 || Math.abs(y - cur.y) > 1e-6)) {
        ops.push(makeOp(0, [cur.x, x], [cur.y, y]));
      }
      cur.x = x;
      cur.y = y;
      started = true;
    }

    function ring(p) {
      travelTo(p.x[0], p.y[0]);
      var xs = p.x.slice(), ys = p.y.slice();
      xs.push(p.x[0]);
      ys.push(p.y[0]);                       // close the loop
      var op = makeOp(1, xs, ys);
      if (op.len > 0) ops.push(op);
    }

    var i;
    for (i = 0; i < outer.length; i++) ring(outer[i]);
    for (i = 0; i < inner.length; i++) ring(inner[i]);
    for (i = 0; i < infill.length; i++) {
      var s = infill[i];
      travelTo(s[0], s[1]);
      var op = makeOp(1, [s[0], s[2]], [s[1], s[3]]);
      if (op.len > 0) ops.push(op);
      cur.x = s[2];
      cur.y = s[3];
    }

    var total = 0;
    for (i = 0; i < ops.length; i++) {
      ops[i].c0 = total;
      total += ops[i].cost;
    }
    return { ops: ops, cost: total || 1 };
  }

  /* Derive every path we need from one mask. Returns null if the mask is
     empty (font failed to load, empty string, tainted canvas, ...). */
  function buildGeometry(mask, w, h) {
    var i, x, y;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, any = false;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          any = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!any) return null;

    var D = buildSDF(mask, w, h);

    var outer = simplifyAll(traceIso(D, w, h, ISO_OUTER), RDP_EPS);
    var inner = simplifyAll(traceIso(D, w, h, ISO_INNER), RDP_EPS);
    if (!outer.length) return null;

    outer = orderRings(outer, minX, minY);
    inner = orderRings(inner, outer[outer.length - 1].x[0],
                              outer[outer.length - 1].y[0]);

    var fillA = makeInfill(D, w, h, ISO_INFILL, 1, INFILL_GAP, MIN_INFILL);
    var fillB = makeInfill(D, w, h, ISO_INFILL, -1, INFILL_GAP, MIN_INFILL);

    return {
      ink: { x: minX, y: minY, w: (maxX - minX) + 1, h: (maxY - minY) + 1 },
      /* two layer flavours: slicers flip the hatch angle every layer */
      layerA: buildToolpath(outer, inner, fillA),
      layerB: buildToolpath(outer, inner, fillB),
      outer: outer,
      inner: inner
    };
  }

  /* --- ks-wordmark:geometry:end --- */

  /* ---------------------------------------------------------------------------
     Text rasterisation \u2014 the only place the geometry meets the DOM
     --------------------------------------------------------------------------- */

  function fontSpec(px, family) {
    return FONT_WEIGHT + ' ' + px + 'px ' + family;
  }

  function applyTracking(ctx, px) {
    if ('letterSpacing' in ctx) {
      try { ctx.letterSpacing = (TRACK_EM * px).toFixed(2) + 'px'; }
      catch (err) { /* older engines reject the setter \u2014 default tracking */ }
    }
  }

  /* Render the wordmark large, on transparent, and hand back the alpha mask
     plus the exact fillText origin so the on-screen type can be registered
     against the derived geometry. */
  function rasterise(text, family) {
    var probe = document.createElement('canvas');
    probe.width = 8;
    probe.height = 8;
    var pctx = probe.getContext('2d');
    if (!pctx) return null;

    var PROBE = 200;
    pctx.font = fontSpec(PROBE, family);
    applyTracking(pctx, PROBE);
    var probeW = pctx.measureText(text).width;
    if (!probeW || !isFinite(probeW)) return null;

    /* Inter Tight's cap height is ~0.73em; solve for the font size that puts
       the ink height near SAMPLE_INK_H, then let the pixel scan give us the
       true box. Nothing downstream trusts this estimate. */
    var px = clamp(SAMPLE_INK_H / 0.73, 40, 420);

    var canvas = document.createElement('canvas');
    var padPx = 8;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.font = fontSpec(px, family);
    applyTracking(ctx, px);
    var w = ctx.measureText(text).width;
    if (!w || !isFinite(w)) return null;

    canvas.width = Math.ceil(w + px * 0.4) + padPx * 2;
    canvas.height = Math.ceil(px * 1.45) + padPx * 2;

    /* resizing resets the context state */
    ctx.font = fontSpec(px, family);
    applyTracking(ctx, px);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';

    var originX = padPx + px * 0.2;
    var originY = padPx + px * 1.08;
    ctx.fillText(text, originX, originY);

    var data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (err) {
      return null;
    }

    var n = canvas.width * canvas.height;
    var mask = new Uint8Array(n);
    for (var i = 0; i < n; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;

    return {
      mask: mask,
      w: canvas.width,
      h: canvas.height,
      fontPx: px,
      originX: originX,
      originY: originY
    };
  }

  /* =============================================================================
     Instance
     ============================================================================= */

  function mount(root) {
    if (root.__ksWordmark) return;
    root.__ksWordmark = true;

    var text = (root.getAttribute('data-ks-wordmark') || '').trim();
    if (!text) text = (root.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) text = 'Kamil Szwed';

    /* Timing is per instance: two wordmarks on one page must not share it. */
    var printMs = PRINT_MS;
    var durAttr = parseFloat(root.getAttribute('data-ks-wordmark-duration'));
    if (durAttr > 2 && durAttr < 60) {
      printMs = Math.max(1200, Math.round(durAttr * 1000) - DISSOLVE_MS - COOL_MS);
    }
    var totalMs = DISSOLVE_MS + printMs + COOL_MS;

    /* ---- DOM ------------------------------------------------------------- */

    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.add('ks-wordmark');

    var stage = document.createElement('button');
    stage.type = 'button';
    stage.className = 'ks-wordmark-stage';

    var canvas = document.createElement('canvas');
    canvas.className = 'ks-wordmark-canvas';
    canvas.setAttribute('aria-hidden', 'true');   // the name lives in .ks-wordmark-text

    var label = document.createElement('span');
    label.className = 'ks-wordmark-text';
    label.textContent = text;

    stage.appendChild(canvas);
    stage.appendChild(label);

    var meta = document.createElement('p');
    meta.className = 'ks-wordmark-meta';

    var hint = document.createElement('span');
    hint.className = 'ks-wordmark-hint';

    var readout = document.createElement('span');
    readout.className = 'ks-wordmark-readout';
    readout.setAttribute('aria-hidden', 'true');   // telemetry churn, not for AT

    var fields = {};
    var FIELD_DEFS = [
      ['layer', 'LAYER 00/' + pad(LAYERS, 2)],
      ['nozzle', 'NOZZLE 024\u00B0C'],
      ['bed', 'BED 024\u00B0C'],
      ['est', 'EST ' + clock(totalMs / 1000)],
      ['flow', 'FLOW 0.0 mm\u00B3/s']
    ];
    for (var fi = 0; fi < FIELD_DEFS.length; fi++) {
      var cell = document.createElement('span');
      cell.className = 'ks-wordmark-cell ks-wordmark-cell--' + FIELD_DEFS[fi][0];
      if (fi > 0) {
        var sep = document.createElement('span');
        sep.className = 'ks-wordmark-sep';
        sep.textContent = '\u00B7';
        cell.appendChild(sep);
      }
      var val = document.createElement('span');
      val.className = 'ks-wordmark-val';
      val.textContent = FIELD_DEFS[fi][1];
      cell.appendChild(val);
      readout.appendChild(cell);
      fields[FIELD_DEFS[fi][0]] = val;
    }

    meta.appendChild(hint);
    meta.appendChild(readout);

    var status = document.createElement('span');
    status.className = 'ks-wordmark-status';
    status.setAttribute('role', 'status');

    root.appendChild(stage);
    root.appendChild(meta);
    root.appendChild(status);

    /* ---- state ----------------------------------------------------------- */

    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var buffer = document.createElement('canvas');
    var bctx = buffer.getContext('2d');

    var geo = null;              // derived toolpaths
    var raster = null;           // sample-space mask metrics
    var ready = false;
    var family = 'var(--font-sans)';

    var dpr = 1, cssW = 0, cssH = 0;
    var scale = 1, tx = 0, ty = 0;   // sample space -> CSS px
    var displayFontPx = 0, riseStep = 0.5, depth = 0;
    var inkColor = FALLBACK_INK.slice();
    var hotColor = FALLBACK_HOT.slice();
    var liveColor = FALLBACK_HOT.slice();

    var STATE_IDLE = 0, STATE_DISSOLVE = 1, STATE_PRINT = 2,
        STATE_COOL = 3, STATE_CANCEL = 4;
    var state = STATE_IDLE;
    var phaseStart = 0;
    var rafId = null;
    var held = false;
    var visible = true;
    var bakedTo = 0;                 // layers already composited into `buffer`
    /* what to fall back to if the user lets go: either a dissolve progress
       (>= 0, reverse the wipe) or a layer + cost (fade the part out) */
    var frozen = { layer: 0, cost: 0, dissolveK: -1 };
    var lastReadout = -1e9;
    var reducedStep = 0;             // 0..3, the static walk-through

    var mq = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    function isReduced() {
      return (mq && mq.matches) ||
             document.documentElement.classList.contains('no-motion');
    }

    /* ---- colours --------------------------------------------------------- */

    function readColors() {
      var cs = window.getComputedStyle(root);
      inkColor = parseRGB(cs.color, FALLBACK_INK);
      hotColor = parseRGB(
        cs.getPropertyValue('--ks-wordmark-hot'), FALLBACK_HOT);
      liveColor = mixRGB(inkColor, hotColor, 0.85);
    }

    /* ---- layout ---------------------------------------------------------- */

    function layout() {
      if (!raster) return false;
      var availW = stage.clientWidth;
      if (!availW) return false;

      var cssFont = parseFloat(
        window.getComputedStyle(label).fontSize) || 48;
      var maxFont = (availW - HPAD * 2) * raster.fontPx / geo.ink.w;
      displayFontPx = Math.max(12, Math.min(cssFont, maxFont));
      scale = displayFontPx / raster.fontPx;

      var dw = geo.ink.w * scale;
      var dh = geo.ink.h * scale;

      /* Rise per layer. Roughly one device pixel at the sizes this runs at,
         but tied to the ink height so the extruded body stays at about a
         sixth of the cap height instead of swamping the letterforms on a
         small screen or vanishing on a large one. */
      riseStep = clamp(dh * 0.0045, 0.22, 1);
      depth = riseStep * (LAYERS - 1);

      cssW = availW;
      cssH = Math.round(dh + depth + VPAD * 2);
      stage.style.height = cssH + 'px';

      dpr = Math.min(window.devicePixelRatio || 1, 2);
      var bw = Math.max(1, Math.round(cssW * dpr));
      var bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        buffer.width = bw;
        buffer.height = bh;
      }

      var dx = Math.round((cssW - dw) / 2);
      tx = dx - geo.ink.x * scale;
      ty = VPAD - geo.ink.y * scale;
      return true;
    }

    /* ---- drawing primitives --------------------------------------------- */

    function resetCtx(c) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.setLineDash([]);
    }

    /* Put the context into sample space, offset by a layer's rise. */
    function enterGeom(c, offsetY) {
      c.save();
      c.translate(tx, ty + offsetY);
      c.scale(scale, scale);
      c.lineCap = 'round';
      c.lineJoin = 'round';
    }

    function layerOffset(i) {
      return (LAYERS - 1 - i) * riseStep;      // layer 0 sits lowest
    }

    function layerAlpha(i) {
      return 0.045 + 0.17 * Math.pow(i / (LAYERS - 1), 2.2);
    }

    function layerPath(i) {
      return (i & 1) ? geo.layerB : geo.layerA;
    }

    /* Append a move (or the leading fraction of one) to the current path. */
    function appendOp(c, op, frac, out) {
      var target = op.len * frac, j;
      var px = op.x[0], py = op.y[0];
      c.moveTo(px, py);
      for (j = 1; j < op.x.length; j++) {
        if (op.cum[j] <= target) {
          px = op.x[j];
          py = op.y[j];
          c.lineTo(px, py);
        } else {
          var seg = op.cum[j] - op.cum[j - 1];
          var f = seg > 0 ? (target - op.cum[j - 1]) / seg : 0;
          px = op.x[j - 1] + (op.x[j] - op.x[j - 1]) * f;
          py = op.y[j - 1] + (op.y[j] - op.y[j - 1]) * f;
          c.lineTo(px, py);
          break;
        }
      }
      if (out) { out.x = px; out.y = py; }
    }

    /* Draw one layer up to `costTarget`. Extrusions batch into a single path;
       travels are drawn only while fresh, so the preview stays legible. */
    function drawLayer(c, path, costTarget, style, out) {
      var ops = path.ops, i, op, frac;
      var lw = Math.max(LINE_W, 0.9 / scale);

      c.beginPath();
      for (i = 0; i < ops.length; i++) {
        op = ops[i];
        if (op.c0 >= costTarget) break;
        if (!op.e) continue;
        frac = Math.min(1, (costTarget - op.c0) / op.cost);
        appendOp(c, op, frac, null);
      }
      c.lineWidth = lw;
      c.strokeStyle = style.ink;
      c.stroke();

      if (style.travel) {
        var window_ = path.cost * 0.09;
        c.setLineDash([2.4 / scale, 3.2 / scale]);
        c.lineWidth = 0.9 / scale;
        for (i = 0; i < ops.length; i++) {
          op = ops[i];
          if (op.c0 >= costTarget) break;
          if (op.e) continue;
          var age = costTarget - (op.c0 + op.cost);
          if (age > window_) continue;
          frac = Math.min(1, (costTarget - op.c0) / op.cost);
          c.strokeStyle = rgba(style.travelColor,
            (0.3 * (1 - Math.max(0, age) / window_)).toFixed(3));
          c.beginPath();
          appendOp(c, op, frac, null);
          c.stroke();
        }
        c.setLineDash([]);
      }

      if (out) positionAt(path, costTarget, out);
    }

    /* Where the nozzle is at `costTarget`, and whether it is extruding.
       Separate from drawLayer because the cursor can be sitting on a travel
       move, which the extrusion pass skips. */
    function positionAt(path, costTarget, out) {
      var ops = path.ops, i, op = null;
      out.x = null;
      for (i = 0; i < ops.length; i++) {
        op = ops[i];
        if (op.c0 + op.cost >= costTarget) break;
      }
      if (!op) return out;

      var frac = op.cost > 0 ? clamp((costTarget - op.c0) / op.cost, 0, 1) : 1;
      var target = op.len * frac;
      out.e = op.e;
      out.x = op.x[0];
      out.y = op.y[0];
      for (var j = 1; j < op.x.length; j++) {
        if (op.cum[j] <= target) {
          out.x = op.x[j];
          out.y = op.y[j];
        } else {
          var seg = op.cum[j] - op.cum[j - 1];
          var f = seg > 0 ? (target - op.cum[j - 1]) / seg : 0;
          out.x = op.x[j - 1] + (op.x[j] - op.x[j - 1]) * f;
          out.y = op.y[j - 1] + (op.y[j] - op.y[j - 1]) * f;
          break;
        }
      }
      return out;
    }

    /* Composite a finished layer into the accumulation buffer. */
    function bakeLayer(i) {
      resetCtx(bctx);
      bctx.globalAlpha = layerAlpha(i);
      enterGeom(bctx, layerOffset(i));
      var path = layerPath(i);
      drawLayer(bctx, path, path.cost, { ink: rgba(inkColor, 1), travel: false });
      bctx.restore();
      bctx.globalAlpha = 1;
    }

    function drawPlain(alpha) {
      if (!raster) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = rgba(inkColor, 1);
      ctx.font = fontSpec(displayFontPx, family);
      applyTracking(ctx, displayFontPx);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(text, tx + raster.originX * scale, ty + raster.originY * scale);
      ctx.restore();
    }

    function drawNozzle(pos, offsetY) {
      if (pos.x === null) return;
      var x = tx + pos.x * scale;
      var y = ty + pos.y * scale + offsetY;
      var r = Math.max(1.5, LINE_W * scale * 0.6);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * 2.1, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(hotColor, 0.28);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(mixRGB(inkColor, [255, 255, 255], 0.7), 0.95);
      ctx.fill();
      ctx.restore();
    }

    /* Tint whatever ink is already on the canvas -- the cooling shimmer. */
    function warmTint(strength, sweep) {
      if (strength <= 0.002) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      if (sweep !== null && cssW > 0) {
        var band = cssW * 0.45;
        var g = ctx.createLinearGradient(sweep - band, 0, sweep + band, 0);
        g.addColorStop(0, rgba(hotColor, 0));
        g.addColorStop(0.5, rgba(hotColor, strength));
        g.addColorStop(1, rgba(hotColor, 0));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = rgba(hotColor, strength);
      }
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
    }

    /* ---- composed frames ------------------------------------------------- */

    function renderIdle() {
      if (!ready) return;
      resetCtx(ctx);
      ctx.clearRect(0, 0, cssW, cssH);
      drawPlain(1);
    }

    /* The wordmark mid-un-print: a feathered erase sweeping down from above.
       k = 0 leaves it whole, k = 1 clears it. Being a pure function of k, it
       plays backwards just as well -- which is what an early release does. */
    function renderDissolve(k) {
      resetCtx(ctx);
      ctx.clearRect(0, 0, cssW, cssH);
      drawPlain(1);
      if (k <= 0) return;

      var feather = cssH * 0.16;
      var edge = -feather + k * (cssH + feather * 2);
      if (edge <= 0) return;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      var g = ctx.createLinearGradient(0, edge - feather, 0, edge);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cssW, edge);
      ctx.restore();
    }

    /* buffer + the layer in progress, multiplied by `mul`. */
    function renderBuilt(layerIdx, costTarget, mul, nozzle) {
      resetCtx(ctx);
      ctx.clearRect(0, 0, cssW, cssH);
      if (mul <= 0) return;

      ctx.globalAlpha = mul;
      ctx.drawImage(buffer, 0, 0, cssW, cssH);
      ctx.globalAlpha = 1;

      if (layerIdx < LAYERS) {
        var off = layerOffset(layerIdx);
        var pos = { x: null, y: 0, e: 1 };
        ctx.globalAlpha = mul;
        enterGeom(ctx, off);
        drawLayer(ctx, layerPath(layerIdx), costTarget, {
          ink: rgba(liveColor, 0.95),
          travel: true,
          travelColor: inkColor
        }, pos);
        ctx.restore();
        ctx.globalAlpha = 1;
        if (nozzle) drawNozzle(pos, off);
        return pos;
      }
      return null;
    }

    /* ---- readout --------------------------------------------------------- */

    function setReadout(layerIdx, nozzleC, bedC, estSec, flow) {
      fields.layer.textContent =
        'LAYER ' + pad(layerIdx, 2) + '/' + pad(LAYERS, 2);
      fields.nozzle.textContent = 'NOZZLE ' + pad(nozzleC, 3) + '\u00B0C';
      fields.bed.textContent = 'BED ' + pad(bedC, 3) + '\u00B0C';
      fields.est.textContent = 'EST ' + clock(estSec);
      fields.flow.textContent = 'FLOW ' + flow.toFixed(1) + ' mm\u00B3/s';
    }

    function restReadout() {
      setReadout(0, 24, 24, totalMs / 1000, 0);
    }

    /* ---- animation loop -------------------------------------------------- */

    function stopLoop() {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function startLoop() {
      if (rafId === null) rafId = window.requestAnimationFrame(frame);
    }

    function goIdle() {
      state = STATE_IDLE;
      stopLoop();
      renderIdle();
      restReadout();
    }

    function frame() {
      rafId = null;
      if (!ready) return;

      /* the site's motion switch can flip mid-print */
      if (isReduced()) {
        state = STATE_IDLE;
        renderIdle();
        setReadout(LAYERS, 214, 60, 0, 0);
        return;
      }

      /* one clock throughout: phaseStart comes from now(), so read the same
         source here rather than trusting the rAF timestamp to share an origin */
      var t = now();
      var el = t - phaseStart;

      if (state === STATE_DISSOLVE) {
        var k = clamp(el / DISSOLVE_MS, 0, 1);
        renderDissolve(k);
        frozen.dissolveK = k;

        if (readoutDue(t)) {
          setReadout(0, 24 + (214 - 24) * k, 24 + (60 - 24) * k,
                     (totalMs - el) / 1000, 0);
        }
        if (k >= 1) {
          resetCtx(bctx);
          bctx.clearRect(0, 0, cssW, cssH);
          bakedTo = 0;
          state = STATE_PRINT;
          phaseStart = t;
        }
        startLoop();
        return;
      }

      if (state === STATE_PRINT) {
        var p = clamp(el / printMs, 0, 1);
        var fl = p * LAYERS;
        var idx = Math.min(LAYERS - 1, Math.floor(fl));
        var q = fl - idx;

        while (bakedTo < idx) { bakeLayer(bakedTo); bakedTo++; }

        var path = layerPath(idx);
        var pos = renderBuilt(idx, q * path.cost, 1, true);
        frozen.dissolveK = -1;
        frozen.layer = idx;
        frozen.cost = q * path.cost;

        if (readoutDue(t)) {
          var extruding = pos && pos.e === 1;
          setReadout(idx + 1,
                     214 + Math.sin(t * 0.0017) * 0.6,
                     60,
                     (printMs - el + COOL_MS) / 1000,
                     extruding ? 3.9 + Math.sin(t * 0.0031) * 0.35 : 0);
        }

        if (p >= 1) {
          bakeAll();
          state = STATE_COOL;
          phaseStart = t;
        }
        startLoop();
        return;
      }

      if (state === STATE_COOL) {
        var c = clamp(el / COOL_MS, 0, 1);
        resetCtx(ctx);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.globalAlpha = 1 - smoothstep(0.25, 1, c);
        ctx.drawImage(buffer, 0, 0, cssW, cssH);
        ctx.globalAlpha = 1;
        drawPlain(smoothstep(0, 0.8, c));
        warmTint(0.22 * (1 - c), -cssW * 0.3 + c * cssW * 1.6);

        if (readoutDue(t)) {
          setReadout(LAYERS, 214 - 46 * c, 60 - 12 * c, (COOL_MS - el) / 1000, 0);
        }
        if (c >= 1) {
          announce('Wordmark printed.');
          goIdle();
          return;
        }
        startLoop();
        return;
      }

      if (state === STATE_CANCEL) {
        var z = clamp(el / CANCEL_MS, 0, 1);
        if (frozen.dissolveK >= 0) {
          /* released during the wipe: run it back up rather than
             blinking through an empty build plate */
          renderDissolve(frozen.dissolveK * (1 - z));
        } else {
          renderBuilt(frozen.layer, frozen.cost, 1 - z, false);
          drawPlain(z);
        }
        if (readoutDue(t)) {
          setReadout(0, 214 - 190 * z, 60 - 36 * z, totalMs / 1000, 0);
        }
        if (z >= 1) { goIdle(); return; }
        startLoop();
        return;
      }
    }

    function readoutDue(t) {
      if (t - lastReadout < READOUT_MS) return false;
      lastReadout = t;
      return true;
    }

    function bakeAll() {
      while (bakedTo < LAYERS) { bakeLayer(bakedTo); bakedTo++; }
    }

    function announce(msg) {
      status.textContent = msg;
    }

    /* ---- reduced motion: three static steps ------------------------------ */

    function renderStep(step) {
      resetCtx(ctx);
      ctx.clearRect(0, 0, cssW, cssH);
      if (step === 0) {
        drawPlain(1);
        restReadout();
        announce('Wordmark.');
        return;
      }
      if (step === 3) {
        drawPlain(1);
        setReadout(LAYERS, 214, 60, 0, 0);
        announce('Step 3 of 3: print finished.');
        return;
      }

      /* one layer, drawn in full -- no rise, no loop, no timers */
      var path = geo.layerA;
      var cut = step === 1 ? perimeterCost(path) : path.cost;
      enterGeom(ctx, 0);
      drawLayer(ctx, path, cut, { ink: rgba(inkColor, 0.92), travel: false });
      ctx.restore();

      if (step === 1) {
        setReadout(1, 214, 60, totalMs / 1000, 4.1);
        announce('Step 1 of 3: perimeters.');
      } else {
        setReadout(Math.round(LAYERS / 2), 214, 60, printMs / 2000, 4.1);
        announce('Step 2 of 3: infill.');
      }
    }

    /* cost at which the last perimeter ends (perimeters are emitted first) */
    function perimeterCost(path) {
      var rings = geo.outer.length + geo.inner.length;
      var seen = 0, i;
      for (i = 0; i < path.ops.length; i++) {
        if (!path.ops[i].e) continue;
        seen++;
        if (seen >= rings) return path.ops[i].c0 + path.ops[i].cost;
      }
      return path.cost;
    }

    /* ---- interaction ----------------------------------------------------- */

    function press() {
      if (!ready || !visible || !cssW) return;

      if (isReduced()) {
        reducedStep = (reducedStep + 1) % 4;
        renderStep(reducedStep);
        return;
      }
      if (state !== STATE_IDLE) return;

      reducedStep = 0;
      state = STATE_DISSOLVE;
      phaseStart = now();
      lastReadout = -1e9;
      bakedTo = 0;
      frozen.dissolveK = 0;
      frozen.layer = 0;
      frozen.cost = 0;
      resetCtx(bctx);
      bctx.clearRect(0, 0, cssW, cssH);
      announce('Reprinting the wordmark.');
      startLoop();
    }

    /* Early release cancels, per the interaction spec -- but only while the
       part is still going down. Once cooling starts, let it finish. */
    function release(silent) {
      if (state !== STATE_DISSOLVE && state !== STATE_PRINT) return;
      state = STATE_CANCEL;
      phaseStart = now();
      lastReadout = -1e9;
      if (!silent) announce('Reprint cancelled.');
      startLoop();
    }

    function abortHard() {
      held = false;
      stopLoop();
      if (state !== STATE_IDLE) goIdle();
    }

    if (window.PointerEvent) {
      stage.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        held = true;
        if (stage.setPointerCapture) {
          try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        }
        press();
      });
      stage.addEventListener('pointerup', function () {
        if (held) { held = false; release(false); }
      });
      /* a scroll gesture that started here cancels the pointer stream */
      stage.addEventListener('pointercancel', function () {
        if (held) { held = false; release(true); }
      });
      window.addEventListener('pointerup', function () {
        if (held) { held = false; release(false); }
      });
    } else {
      /* Pre-PointerEvent fallback. A touch also emits synthetic mouse events a
         moment later, so the mouse path stands down for half a second after
         any touch or it would press twice. */
      var lastTouch = 0;
      stage.addEventListener('mousedown', function (e) {
        if (e.button) return;
        if (now() - lastTouch < 600) return;
        held = true;
        press();
      });
      window.addEventListener('mouseup', function () {
        if (now() - lastTouch < 600) return;
        if (held) { held = false; release(false); }
      });
      stage.addEventListener('touchstart', function () {
        lastTouch = now();
        held = true;
        press();
      }, false);
      stage.addEventListener('touchend', function () {
        lastTouch = now();
        if (held) { held = false; release(false); }
      });
      stage.addEventListener('touchcancel', function () {
        lastTouch = now();
        if (held) { held = false; release(true); }
      });
    }

    /* Keyboard: Enter/Space starts the same print. It LATCHES rather than
       requiring a physical hold \u2014 key repeat makes a real hold unreliable, and
       WCAG discourages hold-to-operate as the only route. Escape or blur
       cancels, which is the keyboard equivalent of letting go. */
    stage.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Enter' || k === ' ' || k === 'Spacebar' || e.keyCode === 32 ||
          e.keyCode === 13) {
        if (e.repeat) { e.preventDefault(); return; }
        e.preventDefault();
        press();
      } else if (k === 'Escape' || k === 'Esc' || e.keyCode === 27) {
        release(false);
      }
    });
    stage.addEventListener('blur', function () {
      held = false;
      release(true);
    });
    /* the button's click is already handled by keydown/pointerdown */
    stage.addEventListener('click', function (e) { e.preventDefault(); });
    stage.addEventListener('contextmenu', function (e) {
      if (held) e.preventDefault();
    });

    /* ---- labels ---------------------------------------------------------- */

    function syncLabels() {
      var reduced = isReduced();
      stage.setAttribute('aria-label', reduced
        ? text + '. Press to step through a simulated 3D print of the wordmark.'
        : text + '. Press and hold to reprint the wordmark.');
      hint.textContent = reduced
        ? 'PRESS TO STEP \u00B7 SLICER SIMULATION'
        : 'PRESS AND HOLD \u00B7 SLICER SIMULATION';
    }

    /* ---- lifecycle ------------------------------------------------------- */

    if (mq) {
      var onMQ = function () {
        syncLabels();
        reducedStep = 0;
        abortHard();
      };
      if (mq.addEventListener) mq.addEventListener('change', onMQ);
      else if (mq.addListener) mq.addListener(onMQ);
    }

    if (window.IntersectionObserver) {
      var io = new window.IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          visible = entries[i].isIntersecting;
        }
        if (!visible) abortHard();
      }, { rootMargin: '120px' });
      io.observe(root);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) abortHard();
    });

    var resizeTimer = null, lastW = -1, lastFont = -1;
    window.addEventListener('resize', function () {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        resizeTimer = null;
        if (!ready) return;
        var w = stage.clientWidth;
        var f = parseFloat(window.getComputedStyle(label).fontSize) || 0;
        if (w === lastW && Math.abs(f - lastFont) < 0.5) return;
        lastW = w;
        lastFont = f;
        abortHard();
        readColors();
        if (layout()) {
          if (isReduced() && reducedStep) renderStep(reducedStep);
          else renderIdle();
        }
      }, 140);
    });

    /* ---- build ----------------------------------------------------------- */

    function build() {
      /* Resolve the real family name from the CSS so the offscreen render uses
         the same stack the page does. */
      family = window.getComputedStyle(label).fontFamily || 'sans-serif';

      raster = rasterise(text, family);
      if (!raster) return;                 // leave the plain text in place
      geo = buildGeometry(raster.mask, raster.w, raster.h);
      raster.mask = null;                  // release the mask, keep the metrics
      if (!geo) { geo = null; return; }

      readColors();
      ready = true;
      root.classList.add('ks-wordmark-ready');
      if (!layout()) {
        /* zero-width container (hidden tab, late layout) -- retry once */
        window.setTimeout(function () {
          if (layout()) renderIdle();
        }, 250);
        return;
      }
      lastW = stage.clientWidth;
      lastFont = parseFloat(window.getComputedStyle(label).fontSize) || 0;
      renderIdle();
    }

    syncLabels();
    restReadout();

    function schedule() {
      if (window.requestIdleCallback) {
        window.requestIdleCallback(build, { timeout: 1600 });
      } else {
        window.setTimeout(build, 260);
      }
    }

    if (document.fonts && document.fonts.ready) {
      var load = document.fonts.load
        ? document.fonts.load(fontSpec(48, window.getComputedStyle(label).fontFamily), text)
        : null;
      if (load && load.then) load['catch'](function () {});
      document.fonts.ready.then(schedule, schedule);
    } else {
      window.setTimeout(schedule, 400);
    }
  }

  /* =============================================================================
     Boot
     ============================================================================= */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-wordmark]');
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
