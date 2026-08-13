/* =============================================================================
   THE BRIEF  ·  [data-ks-brief]
   -----------------------------------------------------------------------------
   A guided five-question intake for brief.html. Replaces the static fallback
   copy with one question at a time, a numbered progress rail, and a finale
   that composes the whole thing as a plain-text email.

   There is no backend. The primary action is a mailto: link, the secondary a
   clipboard copy. Answers live in this page only; nothing is stored and
   nothing leaves until the visitor sends it themselves.

   No dependencies. GSAP / Lenis are not used or required.
   ========================================================================== */

(function () {
  'use strict';

  if (window.__ksBriefLoaded) { return; }
  window.__ksBriefLoaded = true;

  var EMAIL = 'kamilmax06@gmail.com';
  var HREF_MAX = 1800;    /* mail clients truncate long mailto urls           */
  var EXISTS_CAP = 600;   /* starting cap for the long answer inside the body */

  /* The five questions. Chip values are stored in sentence case; the css
     uppercases them for display, so the composed email reads like prose. */
  var STEPS = [
    { key: 'making', q: 'What are we making?', type: 'chips',
      opts: ['Robot deployment', 'Website', 'App or software', 'Photography',
             'Brand or campaign', 'Custom hardware', 'Something else'] },
    { key: 'timeline', q: 'When does it need to exist?', type: 'chips',
      opts: ['This month', 'This quarter', 'This year', 'No date yet'] },
    { key: 'exists', q: 'What already exists?', type: 'text',
      ph: 'Sketches, a repo, a half-built prototype, a brand book, or ' +
          'nothing at all. All fine.' },
    { key: 'mode', q: 'How do you want to work?', type: 'chips',
      opts: ['One deliverable and out', 'Build then support it', 'Not sure yet'] },
    { key: 'who', q: 'Who are you?', type: 'who' }
  ];

  /* Review field labels, paired with how each value is resolved below. */
  var FIELDS = [
    ['making', 'Making'], ['timeline', 'Timeline'], ['exists', 'Exists today'],
    ['mode', 'Working mode'], ['from', 'From']
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
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

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  var uid = 0;

  /* ===========================================================================
     Instance
     ======================================================================== */

  function mount(root) {
    if (root.__ksBrief) { return; }
    root.__ksBrief = true;
    uid++;
    var ns = 'ks-brief-' + uid;

    /* ---- state: in-page only, by design ------------------------------- */
    var answers = { making: null, timeline: null, exists: '', mode: null,
                    name: '', extra: '' };
    var REVIEW = STEPS.length;
    var current = 0;

    /* ---- shell --------------------------------------------------------- */
    while (root.firstChild) { root.removeChild(root.firstChild); }
    root.classList.add('ks-brief');

    var head = el('div', 'ks-brief-head');
    head.appendChild(el('p', 'ks-brief-eyebrow',
      'Start a project · five questions'));
    head.appendChild(el('p', 'ks-brief-credit',
      'About two minutes · no account · nothing stored'));
    root.appendChild(head);

    var body = el('div', 'ks-brief-body');

    /* ---- progress rail -------------------------------------------------- */
    var rail = el('nav', 'ks-brief-rail');
    rail.setAttribute('aria-label', 'Brief progress');
    var railList = el('ol', 'ks-brief-rail-list');
    var railBtns = [];
    for (var ri = 0; ri < STEPS.length; ri++) {
      (function (i) {
        var li = el('li', 'ks-brief-rail-item');
        var btn = el('button', 'ks-brief-rail-btn');
        btn.type = 'button';
        btn.appendChild(el('span', 'ks-brief-rail-num', pad2(i + 1)));
        var tick = el('span', 'ks-brief-rail-tick', '✓');
        tick.setAttribute('aria-hidden', 'true');
        btn.appendChild(tick);
        btn.addEventListener('click', function () { goTo(i); });
        li.appendChild(btn);
        railList.appendChild(li);
        railBtns.push(btn);
      }(ri));
    }
    rail.appendChild(railList);
    body.appendChild(rail);

    /* ---- stage + panels -------------------------------------------------- */
    var stage = el('div', 'ks-brief-stage');
    var panels = [];

    function buildNav(panel, index) {
      var row = el('div', 'ks-brief-nav');
      var back = el('button',
        'ks-brief-btn ks-brief-btn-ghost' + (index === 0 ? ' is-hidden' : ''),
        'Back');
      back.type = 'button';
      if (index === 0) { back.tabIndex = -1; back.setAttribute('aria-hidden', 'true'); }
      back.addEventListener('click', function () { goTo(index - 1); });
      var hint = el('p', 'ks-brief-skip', 'Blank is fine · next skips');
      var next = el('button', 'ks-brief-btn ks-brief-btn-solid',
        index === STEPS.length - 1 ? 'Review' : 'Next');
      next.type = 'button';
      next.addEventListener('click', function () { goTo(index + 1); });
      row.appendChild(back);
      row.appendChild(hint);
      row.appendChild(next);
      panel.appendChild(row);
    }

    function buildChips(step, panel) {
      var wrap = el('div', 'ks-brief-chips');
      var group = [];
      for (var i = 0; i < step.opts.length; i++) {
        (function (val) {
          var b = el('button', 'ks-brief-chip', val);
          b.type = 'button';
          b.setAttribute('aria-pressed', 'false');
          /* keepOn: enter-to-advance selects but never deselects */
          b.__ksBriefPick = function (keepOn) {
            var on = b.getAttribute('aria-pressed') === 'true';
            if (on && !keepOn) {
              b.setAttribute('aria-pressed', 'false');
              answers[step.key] = null;
            } else {
              for (var j = 0; j < group.length; j++) {
                group[j].setAttribute('aria-pressed', 'false');
              }
              b.setAttribute('aria-pressed', 'true');
              answers[step.key] = val;
            }
            syncRail();
          };
          b.addEventListener('click', function () { b.__ksBriefPick(false); });
          group.push(b);
          wrap.appendChild(b);
        }(step.opts[i]));
      }
      panel.appendChild(wrap);
    }

    function buildText(step, panel) {
      var lab = el('label', 'ks-brief-sr', step.q);
      lab.htmlFor = ns + '-exists';
      var ta = el('textarea', 'ks-brief-textarea');
      ta.id = ns + '-exists';
      ta.rows = 5;
      ta.maxLength = 2000;
      ta.placeholder = step.ph;
      ta.addEventListener('input', function () {
        answers.exists = ta.value;
        syncRail();
      });
      panel.appendChild(lab);
      panel.appendChild(ta);
    }

    function buildWho(step, panel) {
      var wrap = el('div', 'ks-brief-who');
      function field(key, labelText, max, ac) {
        var f = el('div', 'ks-brief-field');
        var lab = el('label', 'ks-brief-fieldlab', labelText);
        lab.htmlFor = ns + '-' + key;
        var input = el('input', 'ks-brief-input');
        input.type = 'text';
        input.id = ns + '-' + key;
        input.maxLength = max;
        if (ac) { input.autocomplete = ac; }
        input.addEventListener('input', function () {
          answers[key] = input.value;
          syncRail();
        });
        f.appendChild(lab);
        f.appendChild(input);
        wrap.appendChild(f);
      }
      field('name', 'Name · optional', 80, 'name');
      field('extra', 'Anything else worth knowing · optional', 140, null);
      panel.appendChild(wrap);
    }

    for (var pi = 0; pi < STEPS.length; pi++) {
      (function (step, index) {
        var panel = el('section', 'ks-brief-step');
        panel.tabIndex = -1;
        panel.hidden = index !== 0;
        panel.setAttribute('aria-label',
          'Step ' + (index + 1) + ' of 5 · ' + step.q);
        panel.appendChild(el('p', 'ks-brief-qnum',
          'Step ' + pad2(index + 1) + ' of 05'));
        /* h2, not h3: the questions sit directly under the page h1, so an
           h3 here leaves a hole in the outline. The class carries the size. */
        panel.appendChild(el('h2', 'ks-brief-qtitle', step.q));
        if (step.type === 'chips') { buildChips(step, panel); }
        else if (step.type === 'text') { buildText(step, panel); }
        else { buildWho(step, panel); }
        buildNav(panel, index);
        panel.addEventListener('animationend', function () {
          panel.classList.remove('ks-brief-anim-fwd', 'ks-brief-anim-back');
        });
        stage.appendChild(panel);
        panels.push(panel);
      }(STEPS[pi], pi));
    }

    /* ---- review panel ---------------------------------------------------- */
    var review = el('section', 'ks-brief-step ks-brief-review');
    review.tabIndex = -1;
    review.hidden = true;
    review.setAttribute('aria-label', 'The brief, as it will arrive');

    var rhead = el('div', 'ks-brief-rhead');
    rhead.appendChild(el('p', 'ks-brief-qnum', 'The brief, as it will arrive'));
    var edit = el('button', 'ks-brief-edit', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', function () { goTo(0); });
    rhead.appendChild(edit);
    review.appendChild(rhead);

    var sheet = el('div', 'ks-brief-sheet');
    var valueNodes = {};
    for (var fi = 0; fi < FIELDS.length; fi++) {
      var frow = el('div', 'ks-brief-frow');
      frow.appendChild(el('p', 'ks-brief-fkey', FIELDS[fi][1]));
      var fval = el('p', 'ks-brief-fval');
      frow.appendChild(fval);
      sheet.appendChild(frow);
      valueNodes[FIELDS[fi][0]] = fval;
    }
    review.appendChild(sheet);

    var acts = el('div', 'ks-brief-actions');
    var mailA = el('a', 'ks-brief-btn ks-brief-btn-solid', 'Open in your mail app');
    mailA.href = 'mailto:' + EMAIL;
    var copyB = el('button', 'ks-brief-btn ks-brief-btn-ghost', 'Copy the brief');
    copyB.type = 'button';
    acts.appendChild(mailA);
    acts.appendChild(copyB);
    review.appendChild(acts);

    var quiet = el('p', 'ks-brief-quiet', 'or just write me: ');
    var plain = el('a', null, EMAIL);
    plain.href = 'mailto:' + EMAIL;
    quiet.appendChild(plain);
    review.appendChild(quiet);

    review.addEventListener('animationend', function () {
      review.classList.remove('ks-brief-anim-fwd', 'ks-brief-anim-back');
    });
    stage.appendChild(review);
    panels.push(review);

    body.appendChild(stage);
    root.appendChild(body);

    /* step changes are announced here; the visible panels churn too much
       structure for a screen reader to follow on their own */
    var live = el('p', 'ks-brief-sr');
    live.setAttribute('aria-live', 'polite');
    root.appendChild(live);

    /* offscreen but selectable, for the execCommand copy fallback */
    var copyTa = el('textarea', 'ks-brief-copyta');
    copyTa.setAttribute('aria-hidden', 'true');
    copyTa.tabIndex = -1;
    copyTa.readOnly = true;
    root.appendChild(copyTa);

    /* ===========================================================================
       Composition
       ======================================================================== */

    function fromLine() {
      var n = answers.name.trim();
      var x = answers.extra.trim();
      if (n && x) { return n + ' · ' + x; }
      return n || x;
    }

    function fields(cap) {
      var ex = answers.exists.trim();
      if (ex && cap > 0 && ex.length > cap) { ex = ex.slice(0, cap) + '…'; }
      return [
        answers.making || '', answers.timeline || '', ex,
        answers.mode || '', fromLine()
      ];
    }

    function briefText(cap) {
      var v = fields(cap);
      var out = [];
      for (var i = 0; i < FIELDS.length; i++) {
        out.push(FIELDS[i][1].toUpperCase() + '\n' + (v[i] || 'left blank'));
      }
      return out.join('\n\n') +
        '\n\nComposed at kamilszwed.com · the five-question brief';
    }

    function subject() {
      return 'Project brief · ' + (answers.making || 'new project');
    }

    function buildHref(cap) {
      return 'mailto:' + EMAIL +
        '?subject=' + encodeURIComponent(subject()) +
        '&body=' + encodeURIComponent(briefText(cap));
    }

    var copyText = '';

    /* the pane shows exactly what the email will carry, so the truncation cap
       is settled first and reused for the display and the copy */
    function syncReview() {
      var cap = EXISTS_CAP;
      var href = buildHref(cap);
      while (href.length > HREF_MAX && cap > 40) {
        cap -= 80;
        href = buildHref(cap);
      }
      mailA.href = href;
      copyText = briefText(cap);
      var v = fields(cap);
      for (var i = 0; i < FIELDS.length; i++) {
        var node = valueNodes[FIELDS[i][0]];
        if (v[i]) {
          node.textContent = v[i];
          node.classList.remove('ks-brief-blank');
        } else {
          node.textContent = 'left blank';
          node.classList.add('ks-brief-blank');
        }
      }
    }

    /* ===========================================================================
       Copy
       ======================================================================== */

    var copyTimer = null;
    function flashCopied() {
      copyB.textContent = 'Copied';
      copyB.classList.add('is-flash');
      live.textContent = 'Brief copied to the clipboard.';
      if (copyTimer) { window.clearTimeout(copyTimer); }
      copyTimer = window.setTimeout(function () {
        copyTimer = null;
        copyB.textContent = 'Copy the brief';
        copyB.classList.remove('is-flash');
      }, 1600);
    }

    function copyFallback() {
      var ok = false;
      try {
        copyTa.value = copyText;
        copyTa.focus();
        copyTa.select();
        copyTa.setSelectionRange(0, copyText.length);
        ok = !!(document.execCommand && document.execCommand('copy'));
      } catch (e) { ok = false; }
      try { copyB.focus(); } catch (e2) { /* focus is best-effort */ }
      if (ok) { flashCopied(); }
    }

    copyB.addEventListener('click', function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(copyText)
            .then(flashCopied, copyFallback);
          return;
        }
      } catch (e) { /* fall through to the textarea path */ }
      copyFallback();
    });

    /* ===========================================================================
       Navigation
       ======================================================================== */

    function answered(i) {
      var k = STEPS[i].key;
      if (k === 'exists') { return answers.exists.trim() !== ''; }
      if (k === 'who') { return !!(answers.name.trim() || answers.extra.trim()); }
      return !!answers[k];
    }

    function syncRail() {
      for (var i = 0; i < railBtns.length; i++) {
        var b = railBtns[i];
        var done = answered(i);
        b.classList.toggle('is-done', done);
        b.classList.toggle('is-current', i === current);
        if (i === current) { b.setAttribute('aria-current', 'step'); }
        else { b.removeAttribute('aria-current'); }
        b.setAttribute('aria-label', 'Step ' + (i + 1) + ' · ' + STEPS[i].q +
          (done ? ' · answered' : ''));
      }
    }

    function announce() {
      live.textContent = current === REVIEW
        ? 'The brief, ready to send.'
        : 'Step ' + (current + 1) + ' of 5 · ' + STEPS[current].q;
    }

    function goTo(next) {
      if (next < 0) { next = 0; }
      if (next > REVIEW) { next = REVIEW; }
      if (next === current) { return; }
      var fwd = next > current;
      var out = panels[current];
      var inn = panels[next];
      current = next;
      out.hidden = true;
      out.classList.remove('ks-brief-anim-fwd', 'ks-brief-anim-back');
      if (next === REVIEW) { syncReview(); }
      inn.hidden = false;
      inn.classList.remove('ks-brief-anim-fwd', 'ks-brief-anim-back');
      if (!isStill()) {
        void inn.offsetWidth;   /* restart the css animation */
        inn.classList.add(fwd ? 'ks-brief-anim-fwd' : 'ks-brief-anim-back');
      }
      syncRail();
      announce();
      try { inn.focus({ preventScroll: true }); }
      catch (e) { try { inn.focus(); } catch (e2) { /* focus is best-effort */ } }
    }

    /* Enter advances. Textareas keep enter for new lines (ctrl or cmd + enter
       advances there); on a chip, enter selects it and moves on; every other
       button and link keeps its native activation. */
    root.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.keyCode !== 13) { return; }
      if (current === REVIEW) { return; }
      var t = ev.target;
      var tag = t && t.tagName;
      if (tag === 'TEXTAREA') {
        if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); goTo(current + 1); }
        return;
      }
      if (tag === 'BUTTON') {
        if (t.__ksBriefPick) {
          ev.preventDefault();
          t.__ksBriefPick(true);
          goTo(current + 1);
        }
        return;
      }
      if (tag === 'A') { return; }
      ev.preventDefault();
      goTo(current + 1);
    });

    syncRail();
  }

  /* ===========================================================================
     Boot
     ======================================================================== */

  function boot() {
    var nodes = document.querySelectorAll('[data-ks-brief]');
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
