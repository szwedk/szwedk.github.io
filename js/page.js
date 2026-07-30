/* ============================================================
   Field sub-pages — smooth scroll + reveals, nothing heavier.
   Respects prefers-reduced-motion by skipping all of it.
   ============================================================ */

(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
