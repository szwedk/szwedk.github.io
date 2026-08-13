/* ============================================================
   Field sub-pages - smooth scroll + reveals, nothing heavier.
   Respects prefers-reduced-motion by skipping all of it.
   ============================================================ */

/* ------------------------------------------------------------
   Lazy feature loading.

   Every feature bundle is 30 to 50 KB and every one of them sits
   below the fold, so a visitor who reads the hero and leaves was
   paying for demos they never saw. Each mount names its own script
   in data-ks-lazy and gets it only when it is about to scroll into
   view. A full viewport of rootMargin is roughly a second of scroll
   at reading speed, so it has arrived before you have. Mounts that
   sit high on a page, like the brief, are inside that margin at
   load and fetch immediately, which is the right answer for them.

   This sits in its own IIFE, above the motion block, because the
   block below returns early in still mode and the features must
   load either way.
   ------------------------------------------------------------ */
(function () {
  'use strict';

  var mounts = document.querySelectorAll('[data-ks-lazy]');
  if (!mounts.length) { return; }

  function load(el) {
    var src = el.getAttribute('data-ks-lazy');
    if (!src || el.getAttribute('data-ks-lazy-done')) { return; }
    el.setAttribute('data-ks-lazy-done', '1');
    var s = document.createElement('script');
    s.src = src;
    document.body.appendChild(s);
  }

  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(mounts, load);
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) { return; }
      io.unobserve(entry.target);
      load(entry.target);
    });
  }, { rootMargin: '100% 0px' });

  Array.prototype.forEach.call(mounts, function (m) { io.observe(m); });
})();

(function () {
  'use strict';

  /* The home page switch writes ks-motion. Honour it here too, so turning
     motion on there does not silently revert the moment someone opens a
     field page. An explicit choice outranks the OS preference either way. */
  var stored = null;
  try { stored = window.localStorage.getItem('ks-motion'); } catch (e) { stored = null; }
  var reduced = stored
    ? stored === 'off'
    : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof gsap === 'undefined') return;

  gsap.registerPlugin(ScrollTrigger);

  var lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
  gsap.ticker.lagSmoothing(0);

  /* hero intro */
  gsap.fromTo('.back-link, .page-hero .eyebrow, .page-hero h1, .page-intro, .page-chips li',
    { y: 30, autoAlpha: 0 },
    { y: 0, autoAlpha: 1, duration: 0.9, ease: 'power3.out', stagger: 0.05, delay: 0.1 });
  gsap.fromTo('.brand, .site-chrome',
    { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8, ease: 'power2.out', delay: 0.4 });

  /* project reveals */
  gsap.utils.toArray('.project, .projects-head').forEach(function (el) {
    gsap.fromTo(el, { y: 40, autoAlpha: 0 }, {
      y: 0, autoAlpha: 1, duration: 0.9, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%' }
    });
  });
  gsap.fromTo('.page-foot h2, .page-foot-links', { y: 34, autoAlpha: 0 }, {
    y: 0, autoAlpha: 1, duration: 0.9, ease: 'power3.out', stagger: 0.08,
    scrollTrigger: { trigger: '.page-foot', start: 'top 78%' }
  });
})();
