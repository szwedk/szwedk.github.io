/* ============================================================
   Kamil Szwed - portfolio
   Lenis smooth scroll + GSAP ScrollTrigger + canvas particle hero
   ============================================================ */

(function () {
  'use strict';

  gsap.registerPlugin(ScrollTrigger);

  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var motionOn = !prefersReduced;

  /* The scroll reveals animate autoAlpha, which parks everything below the
     hero at `visibility: hidden`. That is fine for a mouse, but it strands a
     keyboard: nothing past the header is focusable, so Tab can never scroll
     far enough to trigger the reveal that would make it focusable. The first
     Tab press flips a flag that CSS uses to restore visibility while leaving
     the opacity animation alone, so tabbing scrolls each section into view
     and it fades in as it arrives. */
  window.addEventListener('keydown', function onFirstTab(e) {
    if (e.key !== 'Tab') return;
    document.documentElement.classList.add('kb-nav');
    window.removeEventListener('keydown', onFirstTab);
  });

  /* ---------- deterministic rng ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function smoothstep(e0, e1, x) {
    var t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  /* ============================================================
     Particle hero
     ============================================================ */
  /* Dissolve geometry. Particle activation threshold is
       a0(nx) = A0_BASE + ((1-nx)*0.62 + rand*0.38) * 0.5
     so the mean activation front sweeps right-to-left as
       a0_mean(nx) = A0_MID + (1-nx) * A0_SPAN
     The photo is erased along that same front, which is what produces the
     intact-face-with-a-dissolving-edge frame instead of a plain crossfade. */
  var A0_BASE = 0.14;
  var A0_MID = A0_BASE + 0.19 * 0.5;   // 0.235 - front at the right edge
  var A0_SPAN = 0.62 * 0.5;            // 0.31  - front travel to the left edge

  var heroFX = (function () {
    var canvas = document.getElementById('heroCanvas');
    var ctx = canvas.getContext('2d');
    var img = new Image();
    var imgReady = false;
    var particles = null;
    var count = 0;
    var draw = { x: 0, y: 0, w: 0, h: 0 };
    var DPR = 1;
    var targetP = 0, curP = 0;
    var mouseX = 0, mouseY = 0, parX = 0, parY = 0; // parallax (-1..1)
    var mcx = -9999, mcy = -9999;                    // cursor in canvas coords
    var pulse = { v: 0 };                            // easter-egg dissolve pulse
    var rafId = null;
    var staticMode = false;
    var heroVisible = true;
    var dirty = true;
    var viewH = 0;
    var frameNo = 0;
    var fps = 0, fpsFrames = 0, fpsLast = 0;

    var hudP = document.getElementById('hudP');
    var hudPtr = document.getElementById('hudPtr');
    var hudFps = document.getElementById('hudFps');
    var hudSys = document.getElementById('hudSys');

    img.onload = function () { imgReady = true; resize(); };
    img.src = 'assets/portrait.jpg';

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      var W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      viewH = H;
      if (!imgReady) return;

      var scale = Math.min((H * 0.82) / img.height, (W * 0.92) / img.width);
      draw.w = img.width * scale;
      draw.h = img.height * scale;
      draw.x = (W - draw.w) / 2;
      draw.y = (H - draw.h) / 2;
      buildParticles();
      dirty = true;
    }

    function buildParticles() {
      var isMobile = window.innerWidth < 700;
      var targetCols = isMobile ? 80 : 120;
      var sw = targetCols;
      var sh = Math.round(targetCols * (img.height / img.width));
      var off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      var octx = off.getContext('2d', { willReadFrequently: true });
      octx.drawImage(img, 0, 0, sw, sh);
      var data;
      try {
        data = octx.getImageData(0, 0, sw, sh).data;
      } catch (e) { particles = null; return; }

      var px = [], py = [], ps = [], seeds = [], col = [];
      var stepX = draw.w / sw, stepY = draw.h / sh;
      for (var j = 0; j < sh; j++) {
        for (var i = 0; i < sw; i++) {
          var k = (j * sw + i) * 4;
          var r = data[k], g = data[k + 1], b = data[k + 2];
          var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (lum < 9) continue;
          px.push(draw.x + i * stepX + stepX / 2);
          py.push(draw.y + j * stepY + stepY / 2);
          col.push('rgb(' + r + ',' + g + ',' + b + ')');
          ps.push(Math.max(1, (0.55 + (lum / 255) * 0.9) * stepX * 0.62));
          seeds.push(j * sw + i);
        }
      }
      count = px.length;
      particles = {
        x: new Float32Array(px), y: new Float32Array(py),
        col: col,
        s: new Float32Array(ps),
        ang: new Float32Array(count), dist: new Float32Array(count),
        cosA: new Float32Array(count), sinA: new Float32Array(count),
        a0: new Float32Array(count), drip: new Float32Array(count),
        wob: new Float32Array(count), phase: new Float32Array(count)
      };
      var cx = draw.x + draw.w / 2, cy = draw.y + draw.h * 0.42;
      for (var n = 0; n < count; n++) {
        var rng = mulberry32(seeds[n] * 2654435761);
        var nx = (particles.x[n] - draw.x) / draw.w;
        var base = Math.atan2(particles.y[n] - cy, particles.x[n] - cx);
        var ang = base + (rng() - 0.5) * 1.6;
        particles.ang[n] = ang;
        particles.cosA[n] = Math.cos(ang);
        particles.sinA[n] = Math.sin(ang);
        particles.dist[n] = (40 + rng() * 210) * (0.6 + rng() * 0.8);
        particles.a0[n] = A0_BASE + ((1 - nx) * 0.62 + rng() * 0.38) * 0.5;
        particles.drip[n] = rng() < 0.18 ? 0.5 + rng() * 1.3 : rng() * 0.25;
        particles.wob[n] = 6 + rng() * 22;
        particles.phase[n] = rng() * Math.PI * 2;
      }
    }

    function render(t) {
      var W = canvas.width, H = canvas.height;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);

      if (!imgReady) return;

      var p = staticMode ? 0 : Math.min(1, curP + pulse.v);
      var ox = parX, oy = parY;

      /* The photo, wiped away along the particle activation front so the
         un-dissolved side stays photographic instead of fading to black. */
      if (p < 0.70) {
        ctx.globalAlpha = 1;
        ctx.drawImage(img, draw.x + ox, draw.y + oy, draw.w, draw.h);
        if (p > A0_MID - 0.10) {
          var frontNx = 1 - (p - A0_MID) / A0_SPAN;
          var fx = draw.x + ox + draw.w * frontNx;
          var feather = draw.w * 0.17;
          var grd = ctx.createLinearGradient(fx - feather, 0, fx + feather * 0.45, 0);
          grd.addColorStop(0, 'rgba(0,0,0,0)');
          grd.addColorStop(1, 'rgba(0,0,0,1)');
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = grd;
          ctx.fillRect(draw.x + ox - 2, draw.y + oy - 2, draw.w + 4, draw.h + 4);
          ctx.globalCompositeOperation = 'source-over';
        }
      }

      if (particles && !staticMode) {
        var time = t * 0.001;
        var meltT = Math.max(0, p - 0.62);
        var melt = meltT * meltT;
        var vh = viewH;
        // cursor disturbance is strongest while the photo is intact, fades as
        // the scroll dissolve takes over
        var proxScale = 1 - smoothstep(0.30, 0.5, p);
        var R = 130, R2 = R * R;          // disturbance radius (photo intact)
        var RR = 170, RR2 = RR * RR;      // repulsion radius (scattered cloud)
        for (var n = 0; n < count; n++) {
          var act = smoothstep(particles.a0[n], particles.a0[n] + 0.17, p);
          var hx = particles.x[n], hy = particles.y[n];
          var ddx = hx - mcx, ddy = hy - mcy;
          var d2 = ddx * ddx + ddy * ddy;
          var prox = 0;
          if (proxScale > 0.01 && d2 < R2) {
            var dd = Math.sqrt(d2) || 1;
            prox = (1 - dd / R);
            prox = prox * prox * proxScale;
          }
          if (act <= 0.001 && prox <= 0.001) continue;

          var ease = act * act;
          var d = particles.dist[n] * ease;
          var x = hx + particles.cosA[n] * d + ox;
          var y = hy + particles.sinA[n] * d * 0.7 + oy;
          x += Math.sin(time * 0.9 + particles.phase[n]) * particles.wob[n] * act;
          y += Math.cos(time * 0.7 + particles.phase[n] * 1.3) * particles.wob[n] * 0.6 * act;

          // cursor disturbance while the portrait is whole: dust lifts off
          // the surface and drifts away from the pointer
          if (prox > 0.001) {
            var pd = Math.sqrt(d2) || 1;
            x += (ddx / pd) * prox * 46;
            y += (ddy / pd) * prox * 46 - prox * 14;
          }

          // cursor repulsion on the scattered cloud
          if (act > 0.01 && p > 0.2) {
            var rdx = x - mcx, rdy = y - mcy;
            var rd2 = rdx * rdx + rdy * rdy;
            if (rd2 < RR2) {
              var rd = Math.sqrt(rd2) || 1;
              var push = (1 - rd / RR);
              push = push * push * 52;
              x += (rdx / rd) * push;
              y += (rdy / rd) * push;
            }
          }

          var dripAmt = melt * particles.drip[n] * vh * 1.05;
          y += dripAmt;
          var sz = particles.s[n] * (0.8 + Math.max(act, prox) * 0.5);
          var stretch = 1 + melt * particles.drip[n] * 26;
          if (y > vh || y + sz * stretch < 0) continue;   // offscreen cull
          ctx.globalAlpha = Math.max(act * (1 - melt * 0.55), prox * 0.9);
          ctx.fillStyle = particles.col[n];
          ctx.fillRect(x, y, sz, sz * stretch);
        }
      }
      ctx.globalAlpha = 1;
    }

    function updateHud(t) {
      if (!hudP || staticMode || !heroVisible) return;
      fpsFrames++;
      if (t - fpsLast > 500) {
        fps = Math.round(fpsFrames * 1000 / (t - fpsLast));
        fpsFrames = 0; fpsLast = t;
        hudFps.textContent = String(fps);
      }
      hudP.textContent = Math.round(Math.min(1, curP + pulse.v) * 100) + '%';
      if (mcx > -9000) hudPtr.textContent = Math.round(mcx) + ',' + Math.round(mcy);
    }

    function frame(t) {
      rafId = requestAnimationFrame(frame);
      frameNo++;
      if (!heroVisible && !dirty) return;
      var p = Math.min(1, curP + pulse.v);
      var animating = !staticMode && (p > 0.02 || mcx > -9000) && p < 1;
      curP += (targetP - curP) * 0.14;
      if (Math.abs(targetP - curP) < 0.0004) curP = targetP;
      parX += ((mouseX * 16) - parX) * 0.05;
      parY += ((mouseY * 10) - parY) * 0.05;
      var parMoving = Math.abs(mouseX * 16 - parX) > 0.1 || Math.abs(mouseY * 10 - parY) > 0.1;
      var scrubbing = Math.abs(targetP - curP) > 0.0004;
      if (!(dirty || animating || scrubbing || parMoving)) return;
      // when the only reason to draw is the slow ambient wobble, halve the
      // rate - imperceptible on a 6-28px sine, but half the idle CPU
      if (!dirty && !scrubbing && !parMoving && (frameNo & 1)) return;
      render(t);
      updateHud(t);
      dirty = false;
    }

    window.addEventListener('resize', function () {
      clearTimeout(resize._t);
      resize._t = setTimeout(resize, 150);
    });
    window.addEventListener('mousemove', function (e) {
      if (staticMode) return;
      mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
      var rect = canvas.getBoundingClientRect();
      mcx = e.clientX - rect.left;
      mcy = e.clientY - rect.top;
      // don't wake the renderer for a canvas that is scrolled out of view;
      // setVisible(true) re-marks dirty when the hero comes back
      if (heroVisible) dirty = true;
    });
    // hidden: press "g" for a dissolve pulse
    window.addEventListener('keydown', function (e) {
      if (staticMode) return;
      if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        var tgt = e.target;
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
        gsap.to(pulse, { v: 0.5, duration: 0.7, ease: 'power2.out' });
        gsap.to(pulse, { v: 0, duration: 1.1, ease: 'power2.inOut', delay: 0.75 });
      }
    });

    resize();
    rafId = requestAnimationFrame(frame);

    return {
      setProgress: function (p) { targetP = p; },
      setVisible: function (v) { heroVisible = v; dirty = dirty || v; },
      setStatic: function (s) {
        staticMode = s;
        if (s) {
          targetP = 0; curP = 0; pulse.v = 0;
          if (hudSys) hudSys.textContent = 'STATIC';
          if (hudP) hudP.textContent = '0%';
          if (hudFps) hudFps.textContent = '··';
        } else if (hudSys) {
          hudSys.textContent = 'ONLINE';
        }
        dirty = true;
      }
    };
  })();

  /* ============================================================
     Word splitting for the manifesto
     ============================================================ */
  var manifestoWords = (function () {
    var el = document.getElementById('manifestoText');
    // per-word inline-block spans make screen readers announce the paragraph
    // word-by-word, so keep one readable copy and hide the fragments from AT
    var plain = el.textContent.replace(/\s+/g, ' ').trim();
    var nodes = Array.prototype.slice.call(el.childNodes);
    var frag = document.createDocumentFragment();
    nodes.forEach(function (node) {
      if (node.nodeType === 3) {
        node.textContent.split(/\s+/).filter(Boolean).forEach(function (w) {
          var s = document.createElement('span');
          s.className = 'word';
          s.textContent = w;
          frag.appendChild(s);
          frag.appendChild(document.createTextNode(' '));
        });
      } else if (node.nodeType === 1) {
        var s2 = document.createElement('span');
        s2.className = 'word';
        s2.appendChild(node.cloneNode(true));
        frag.appendChild(s2);
        frag.appendChild(document.createTextNode(' '));
      }
    });
    el.innerHTML = '';
    el.appendChild(frag);
    var words = Array.prototype.slice.call(el.querySelectorAll('.word'));
    words.forEach(function (w) { w.setAttribute('aria-hidden', 'true'); });
    var sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = plain;
    el.appendChild(sr);
    return words;
  })();

  /* ---------- progress line for the path timeline ---------- */
  var pathLine = (function () {
    var list = document.querySelector('.path-track');
    if (!list) return null;
    var line = document.createElement('span');
    line.className = 'path-progress';
    list.appendChild(line);
    return line;
  })();

  /* ============================================================
     Motion context - everything revertable lives in here
     ============================================================ */
  var lenis = null;
  var ctx = null;
  var introPlayed = false;
  var snapLock = false;
  var snapTimer = null;

  function initMotion() {
    document.documentElement.classList.remove('no-motion');
    heroFX.setStatic(false);

    lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);

    /* ----- section magnet: The Path and What I Do settle into place.
       Two triggers, one action: engage as the scroll slows inside the
       zone (felt immediately on wheel/trackpad), or on the settle
       fallback once events stop (jumps, scrollbar, keyboard). Fires
       once per approach and re-arms only after leaving the zone, so it
       never traps the user. ----- */
    var snapEls = ['.path', '.work'].map(function (sel) {
      return document.querySelector(sel);
    }).filter(Boolean);
    var snapArmed = snapEls.map(function () { return true; });
    function engageSnap(requireSlow) {
      if (snapLock || !lenis) return;
      var vh = window.innerHeight;
      var v = Math.abs(lenis.velocity || 0);
      for (var i = 0; i < snapEls.length; i++) {
        var top = snapEls[i].getBoundingClientRect().top;
        var inZone = top > vh * 0.02 && top < vh * 0.72;
        if (!inZone) { snapArmed[i] = true; continue; }
        if (!snapArmed[i]) continue;
        if (requireSlow && v >= 2.2) continue;
        snapArmed[i] = false;
        snapLock = true;
        lenis.scrollTo(snapEls[i], {
          offset: -Math.round(vh * 0.08),
          duration: 0.9,
          easing: function (t) { return 1 - Math.pow(1 - t, 3); }
        });
        setTimeout(function () { snapLock = false; }, 1000);
        break;
      }
    }
    window.__dbg = { lenis: lenis, engage: engageSnap, events: 0 };
    lenis.on('scroll', function () {
      window.__dbg.events++;
      if (snapLock) return;
      engageSnap(true);
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(function () { engageSnap(false); }, 160);
    });

    gsap.ticker.add(tickLenis);
    gsap.ticker.lagSmoothing(0);

    ctx = gsap.context(function () {

      /* ----- hero: canvas progress + headline crossfades ----- */
      ScrollTrigger.create({
        trigger: '.hero',
        start: 'top top',
        end: 'bottom bottom',
        scrub: true,
        onUpdate: function (self) { heroFX.setProgress(self.progress); },
        onToggle: function (self) { heroFX.setVisible(self.isActive); }
      });

      var h = function (i) { return '.hero-headline[data-headline="' + i + '"]'; };
      gsap.set(h(1), { yPercent: -50 });
      gsap.set(h(2), { yPercent: -50 });

      var tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: '.hero',
          start: 'top top',
          end: 'bottom bottom',
          scrub: true
        }
      });
      tl.to(h(0), { autoAlpha: 0, y: -70, filter: 'blur(9px)', duration: 9 }, 21)
        .fromTo(h(1), { autoAlpha: 0, y: 70, filter: 'blur(9px)' },
                      { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 9 }, 30)
        .to(h(1), { autoAlpha: 0, y: -70, filter: 'blur(9px)', duration: 9 }, 55)
        .fromTo(h(2), { autoAlpha: 0, y: 70, filter: 'blur(9px)' },
                      { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 9 }, 64)
        .to({}, { duration: 27 }, 73);

      /* ----- manifesto: scattered words assemble ----- */
      var vw = window.innerWidth, vh2 = window.innerHeight;
      manifestoWords.forEach(function (w, i) {
        var rng = mulberry32((i + 7) * 1013904223);
        gsap.set(w, {
          x: (rng() - 0.5) * vw * 0.85,
          y: (rng() - 0.5) * vh2 * 0.8,
          rotation: (rng() - 0.5) * 36,
          opacity: 0.14,
          filter: 'blur(7px)'
        });
      });
      var mtl = gsap.timeline({
        scrollTrigger: {
          trigger: '.manifesto',
          start: 'top top',
          end: 'bottom bottom',
          scrub: true
        }
      });
      mtl.to(manifestoWords, {
        x: 0, y: 0, rotation: 0, opacity: 1, filter: 'blur(0px)',
        ease: 'power2.out',
        duration: 62,
        stagger: { each: 26 / manifestoWords.length, from: 'random' }
      }, 0)
      .to({}, { duration: 26 }, 74);

      /* ----- rails: only over the hero -----
         Driven by a class rather than a tween on autoAlpha. The intro
         timeline also animates .rail, so scrolling out of the hero while
         that intro is still running used to leave the rails lit, and
         .rail-mid-right then sat on top of the work row tags. A class the
         CSS marks !important cannot be undone by a later inline tween. */
      var railEls = document.querySelectorAll(
        '.rail-top-right, .rail-mid-right, .rail-bottom-right');
      function setRails(hidden) {
        railEls.forEach(function (el) { el.classList.toggle('is-past-hero', hidden); });
      }
      ScrollTrigger.create({
        trigger: '.manifesto',
        start: 'top 65%',
        onEnter: function () { setRails(true); },
        onLeaveBack: function () { setRails(false); }
      });

      /* ----- path timeline ----- */
      if (pathLine) {
        /* horizontal on desktop, vertical once the rail collapses */
        var vertRail = window.matchMedia('(max-width: 900px)').matches;
        var from = vertRail ? { scaleY: 0 } : { scaleX: 0 };
        var to = vertRail ? { scaleY: 1 } : { scaleX: 1 };
        to.ease = 'none';
        gsap.fromTo(pathLine, from, {
          scaleX: to.scaleX, scaleY: to.scaleY, ease: 'none',
          scrollTrigger: {
            trigger: '.path-track',
            start: 'top 75%',
            end: 'bottom 55%',
            scrub: true
          }
        });
      }
      gsap.utils.toArray('.path-stop').forEach(function (item) {
        gsap.fromTo(item, { x: -34, autoAlpha: 0 }, {
          x: 0, autoAlpha: 1, duration: 0.8, ease: 'power3.out',
          scrollTrigger: { trigger: item, start: 'top 82%' }
        });
      });
      gsap.fromTo('.path-head', { y: 40, autoAlpha: 0 }, {
        y: 0, autoAlpha: 1, duration: 0.9, ease: 'power3.out',
        scrollTrigger: { trigger: '.path-head', start: 'top 85%' }
      });

      /* ----- work rows ----- */
      gsap.utils.toArray('.work-row').forEach(function (row) {
        gsap.fromTo(row, { y: 46, autoAlpha: 0 }, {
          y: 0, autoAlpha: 1, duration: 0.9, ease: 'power3.out',
          scrollTrigger: { trigger: row, start: 'top 88%' }
        });
      });
      gsap.fromTo('.work-head', { y: 40, autoAlpha: 0 }, {
        y: 0, autoAlpha: 1, duration: 0.9, ease: 'power3.out',
        scrollTrigger: { trigger: '.work-head', start: 'top 85%' }
      });

      /* ----- platforms ----- */
      gsap.utils.toArray('.platform-card').forEach(function (card, i) {
        gsap.fromTo(card, { y: 36, autoAlpha: 0 }, {
          y: 0, autoAlpha: 1, duration: 0.8, ease: 'power3.out', delay: (i % 4) * 0.07,
          scrollTrigger: { trigger: card, start: 'top 90%' }
        });
      });

      /* ----- contact reveal ----- */
      gsap.fromTo('.contact-title, .contact-email, .contact-links',
        { y: 44, autoAlpha: 0 },
        {
          y: 0, autoAlpha: 1, duration: 1, ease: 'power3.out', stagger: 0.08,
          scrollTrigger: { trigger: '.contact', start: 'top 70%' }
        });

      /* ----- intro reveal (once per page load, at the top) ----- */
      if (!introPlayed && window.scrollY < 40) {
        introPlayed = true;
        var intro = gsap.timeline({ delay: 0.15 });
        intro.fromTo('#heroCanvas', { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.4, ease: 'power2.out' }, 0)
          .fromTo('.hero-headline[data-headline="0"] .eyebrow, .hero-headline[data-headline="0"] h1, .hero-headline[data-headline="0"] .hero-sub',
            { y: 42, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 1, ease: 'power3.out', stagger: 0.1 }, 0.2)
          .fromTo('.rail, .hero-foot, .site-chrome, .brand, .motion-toggle, .hud',
            { autoAlpha: 0 },
            { autoAlpha: 1, duration: 0.9, ease: 'power2.out', stagger: 0.06 }, 0.5)
          .call(function () {
            var sys = document.getElementById('hudSys');
            if (sys) sys.textContent = 'ONLINE';
          }, null, 1.1);
      } else {
        introPlayed = true;
        var sys = document.getElementById('hudSys');
        if (sys) sys.textContent = 'ONLINE';
      }
    });

    ScrollTrigger.refresh();
  }

  function tickLenis(time) {
    if (lenis) lenis.raf(time * 1000);
  }

  function teardownMotion() {
    if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
    snapLock = false;
    if (ctx) { ctx.revert(); ctx = null; }
    if (lenis) { lenis.destroy(); lenis = null; }
    gsap.ticker.remove(tickLenis);
    document.documentElement.classList.add('no-motion');
    heroFX.setStatic(true);
    gsap.set('.hero-headline[data-headline="0"]', { clearProps: 'all' });
  }

  /* ============================================================
     Motion toggle (the pill, like the reference)
     ============================================================ */
  var toggle = document.getElementById('motionToggle');
  function applyMotionState() {
    toggle.setAttribute('aria-checked', motionOn ? 'true' : 'false');
    if (motionOn) initMotion(); else teardownMotion();
  }
  toggle.addEventListener('click', function () {
    motionOn = !motionOn;
    applyMotionState();
  });

  /* ============================================================
     Nav - active states + anchored scrolling
     ============================================================ */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.pill-nav a'));
  function setActive(hash) {
    navLinks.forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('href') === hash);
    });
  }
  [['#top', '.hero'], ['#about', '.manifesto'], ['#work', '.work'], ['#contact', '.contact']]
    .forEach(function (pair) {
      ScrollTrigger.create({
        trigger: pair[1],
        start: 'top 45%',
        end: 'bottom 45%',
        onToggle: function (self) { if (self.isActive) setActive(pair[0]); }
      });
    });

  document.querySelectorAll('[data-nav]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var hash = a.getAttribute('href');
      var target = document.querySelector(hash);
      // with motion off, let native fragment navigation handle scroll,
      // history and focus - it does all three correctly
      if (!lenis || !target) return;
      e.preventDefault();
      if (history.pushState) history.pushState(null, '', hash);
      lenis.scrollTo(hash === '#top' ? 0 : target, { duration: 1.4 });
      // move the sequential reading position too, so Tab continues from here
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
  });

  /* ============================================================
     Work accordion - plain class toggle; CSS animates the height.
     Row heights change the page length, so scroll positions are
     re-measured once the transition settles.
     ============================================================ */
  document.querySelectorAll('.work-row').forEach(function (row) {
    var btn = row.querySelector('.work-summary');
    if (!btn) return;
    var detail = row.querySelector('.work-detail');
    var inner = row.querySelector('.work-detail-inner');

    /* A collapsed panel is only visually clipped by overflow, so its links
       stay in the tab order and focus scrolls to something nobody can see.
       `inert` takes the whole subtree out until the row is actually open. */
    function syncInert(open) {
      if (!inner) return;
      if (open) { inner.removeAttribute('inert'); }
      else { inner.setAttribute('inert', ''); }
    }
    syncInert(row.classList.contains('is-open'));

    btn.addEventListener('click', function () {
      var open = row.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      syncInert(open);
    });

    if (detail) {
      detail.addEventListener('transitionend', function (e) {
        if (e.propertyName === 'grid-template-rows') ScrollTrigger.refresh();
      });
    }
  });

  /* ============================================================
     Boot
     ============================================================ */
  applyMotionState();
})();
