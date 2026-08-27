/* =============================================================================
   /socials link-hub interaction layer.  No dependencies.

   Adds four things on top of the six anchors already on the grid: a press
   tilt, a tap receipt, an on-scroll lit state for touch (there is no hover
   there), and a per-platform tray in localStorage. All of it is class
   toggles, so with JavaScript off the page is unchanged. Still mode keeps
   every state and drops every transition.
   ========================================================================== */

(function () {
  'use strict';

  var grid = document.querySelector('.link-grid');
  if (!grid) { return; }

  var root = document.documentElement;
  var still = root.classList.contains('no-motion');
  var cards = Array.prototype.slice.call(grid.querySelectorAll('.link-card'));
  var links = cards.filter(function (c) { return c.tagName === 'A' && c.hasAttribute('href'); });
  if (!links.length) { return; }

  var PLATFORMS = ['youtube', 'tiktok', 'instagram', 'linkedin', 'x', 'github'];
  var LABEL = {
    youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram',
    linkedin: 'LinkedIn', x: 'X', github: 'GitHub'
  };
  var FILL = {
    youtube: '#ff6347',
    tiktok: '#d6fff8',
    instagram: 'linear-gradient(135deg,#7a3cff,#ff3f83 55%,#ffad33)',
    linkedin: '#b9d3ff',
    x: '#ffffff',
    github: '#d8ff55'
  };
  var WORD = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];

  function idOf(card) { return card.getAttribute('data-p'); }

  /* ---- announcements ---------------------------------------------------- */
  var sr = document.createElement('div');
  sr.className = 'ks-sr';
  sr.setAttribute('aria-live', 'polite');
  document.body.appendChild(sr);
  function say(msg) { sr.textContent = msg; }

  /* ---- storage, which may simply not exist in a private window ---------- */
  var KEEP = 21 * 24 * 60 * 60 * 1000;
  function read(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* fine */ }
  }

  function opened() {
    var map = read('ks-hub-opened', {}) || {};
    var now = Date.now();
    var out = {};
    /* the tray is a record of recent visits, not a permanent ledger, so a
       stamp older than KEEP is dropped rather than kept forever */
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k) &&
          PLATFORMS.indexOf(k) !== -1 &&
          typeof map[k] === 'number' && now - map[k] < KEEP) {
        out[k] = map[k];
      }
    }
    return out;
  }

  /* =========================================================================
     PRESS
     ====================================================================== */
  var ARM = 60;        /* ms of contact before a press registers, so a flick
                          does not twitch the grid on its way to scrolling */
  var SLOP = 10;       /* px of travel that reclassifies a press as a scroll */
  var TILT = 1.6;      /* deg at the very corner */
  var PUSH = 3;        /* px a neighbour gives way at its closest */

  var armTimer = null;
  var held = null;
  var downX = 0, downY = 0, downPointer = null;

  function clearPress() {
    if (armTimer) { window.clearTimeout(armTimer); armTimer = null; }
    if (!held) { return; }
    held.classList.remove('is-pressed');
    held.style.removeProperty('--tilt-x');
    held.style.removeProperty('--tilt-y');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove('is-flexed');
      cards[i].style.removeProperty('--push-x');
      cards[i].style.removeProperty('--push-y');
    }
    held = null;
    downPointer = null;
  }

  function arm(card, x, y) {
    held = card;
    card.classList.add('is-pressed');
    if (still) { return; }

    var r = card.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    /* normalised contact point, clamped so a press on the very edge does not
       exceed the intended maximum */
    var nx = Math.max(-1, Math.min(1, (x - cx) / (r.width / 2)));
    var ny = Math.max(-1, Math.min(1, (y - cy) / (r.height / 2)));
    /* the contact point goes AWAY from the viewer, because the card is being
       pushed in there, not tipped toward the pointer */
    card.style.setProperty('--tilt-y', (nx * TILT).toFixed(2) + 'deg');
    card.style.setProperty('--tilt-x', (-ny * TILT).toFixed(2) + 'deg');

    for (var i = 0; i < cards.length; i++) {
      var other = cards[i];
      if (other === card) { continue; }
      var o = other.getBoundingClientRect();
      var dx = (o.left + o.width / 2) - cx;
      var dy = (o.top + o.height / 2) - cy;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var mag = PUSH / (1 + d / 320);
      other.classList.add('is-flexed');
      other.style.setProperty('--push-x', ((dx / d) * mag).toFixed(2) + 'px');
      other.style.setProperty('--push-y', ((dy / d) * mag).toFixed(2) + 'px');
    }
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) { return; }
    clearPress();
    var card = e.currentTarget;
    downX = e.clientX;
    downY = e.clientY;
    downPointer = e.pointerId;
    armTimer = window.setTimeout(function () {
      armTimer = null;
      arm(card, downX, downY);
    }, ARM);
  }

  function onMove(e) {
    if (downPointer === null || e.pointerId !== downPointer) { return; }
    if (Math.abs(e.clientX - downX) > SLOP || Math.abs(e.clientY - downY) > SLOP) {
      clearPress();
    }
  }

  links.forEach(function (card) {
    card.addEventListener('pointerdown', onDown);
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', clearPress);
    card.addEventListener('pointercancel', clearPress);
    card.addEventListener('pointerleave', clearPress);
  });
  /* a pointer released outside the card still has to release the card */
  window.addEventListener('pointerup', clearPress);
  window.addEventListener('pointercancel', clearPress);
  window.addEventListener('blur', clearPress);

  /* =========================================================================
     RECEIPT.  click, not pointerup, because Enter on a focused card also
     navigates and deserves the same confirmation.
     ====================================================================== */
  links.forEach(function (card) {
    card.addEventListener('click', function () {
      var id = idOf(card);
      card.classList.add('is-committed');
      window.setTimeout(function () { card.classList.remove('is-committed'); }, 1600);
      if (id) {
        write('ks-hub-pending', { id: id, at: Date.now() });
        say('Opening ' + (LABEL[id] || id) + ' in a new tab.');
      }
    });
  });

  /* =========================================================================
     THUMB LINE
     ====================================================================== */
  (function () {
    var touch = window.matchMedia && window.matchMedia('(hover: none)').matches;
    if (!touch) { return; }
    if (still || !('IntersectionObserver' in window)) {
      /* nothing is moving anyway, so light every live card at once */
      links.forEach(function (c) { c.classList.add('is-lit'); });
      return;
    }
    var pending = new WeakMap();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var t = en.target;
        var queued = pending.get(t);
        if (queued) { window.clearTimeout(queued); pending['delete'](t); }
        if (en.isIntersecting) {
          t.classList.add('is-lit');
        } else {
          /* lazy on the way out only: the iOS address bar resizes the visual
             viewport mid-scroll, and an eager removal flickers cards resting
             near the band's edge */
          pending.set(t, window.setTimeout(function () {
            t.classList.remove('is-lit');
            pending['delete'](t);
          }, 90));
        }
      });
    }, { rootMargin: '-44% 0px -44% 0px', threshold: 0 });
    links.forEach(function (c) { io.observe(c); });
  })();

  /* =========================================================================
     AVAILABILITY PILL.  Prints the current New York time and dims the dot
     outside 07:00 to 23:00. Bails entirely if the build has no tz data,
     rather than silently showing the visitor's own clock.
     ====================================================================== */
  (function () {
    var pill = document.querySelector('.available');
    var where = pill && pill.querySelector('.ks-where');
    if (!pill || !where) { return; }
    if (!window.Intl || !Intl.DateTimeFormat) { return; }

    var clock, hours;
    try {
      clock = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true
      });
      hours = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', hour12: false
      });
      /* a build without tz data silently returns local time, which would be
         a quieter lie than the green dot was */
      if (clock.resolvedOptions().timeZone !== 'America/New_York') { return; }
    } catch (e) { return; }

    function tick() {
      var now = new Date();
      var h = parseInt(hours.format(now), 10) % 24;
      where.textContent = 'New York · ' + clock.format(now);
      /* a judgement, not a fact, so the dim state shows the time and claims
         nothing else. It never says offline or unavailable. */
      pill.classList.toggle('is-asleep', h < 7 || h >= 23);
    }
    tick();
    window.setInterval(tick, 30000);
  })();

  /* =========================================================================
     THE TRAY.  A socket fills when you actually went to the platform, which
     means the only way to fill it is to leave. Kept in this browser, never
     sent anywhere.
     ====================================================================== */
  (function () {
    var note = grid.querySelector('.note-card');
    var label = note && note.querySelector('.note-label');
    if (!note || !label) { return; }

    var tray = document.createElement('div');
    tray.className = 'ks-tray';
    tray.setAttribute('aria-hidden', 'true');
    var sockets = {};
    PLATFORMS.forEach(function (id) {
      var s = document.createElement('span');
      s.className = 'ks-socket';
      s.setAttribute('data-p', id);
      sockets[id] = s;
      tray.appendChild(s);
    });

    var caption = document.createElement('p');
    caption.className = 'ks-tray-note';
    label.insertAdjacentElement('afterend', tray);
    tray.insertAdjacentElement('afterend', caption);

    var allsix = document.createElement('div');
    allsix.className = 'ks-allsix';
    allsix.setAttribute('aria-hidden', 'true');
    var bar = document.createElement('div');
    bar.className = 'ks-allsix-bar';
    PLATFORMS.forEach(function (id) {
      var i = document.createElement('i');
      i.style.background = FILL[id];
      bar.appendChild(i);
    });
    var line = document.createElement('p');
    line.className = 'ks-allsix-line';
    line.textContent = 'All six.';
    var when = document.createElement('p');
    when.className = 'ks-allsix-date';
    allsix.appendChild(bar);
    allsix.appendChild(line);
    allsix.appendChild(when);
    note.appendChild(allsix);

    function paint(animateId) {
      var map = opened();
      var n = 0;
      PLATFORMS.forEach(function (id) {
        var filled = !!map[id];
        if (filled) { n++; }
        sockets[id].classList.toggle('is-filled', filled);
      });
      caption.innerHTML = n === 0
        ? 'Six sockets, one per platform <span>kept in this browser</span>'
        : WORD[n] + ' of six opened <span>kept in this browser</span>';
      if (n === 6) {
        note.classList.add('is-complete');
        var d = new Date();
        when.textContent = d.toLocaleDateString('en-US',
          { year: 'numeric', month: 'long', day: 'numeric' });
      }
      if (animateId) { land(animateId); }
      return n;
    }

    function land(id) {
      var s = sockets[id];
      if (!s || still) { return; }
      s.classList.add('is-landing');
      window.setTimeout(function () { s.classList.remove('is-landing'); }, 320);
    }

    /* --- the marble -----------------------------------------------------
       Gravity, a bounce off the top rim of any card in the way, and a homing
       term that ramps so it always arrives. It settles into the socket and
       stops; nothing loops. */
    function fly(fromCard, id, done) {
      if (still || !fromCard) { done(); return; }
      var a = fromCard.getBoundingClientRect();
      var b = sockets[id].getBoundingClientRect();
      var R = 9;
      var x = a.left + a.width / 2;
      var y = a.top + a.height * 0.62;
      var tx = b.left + b.width / 2;
      var ty = b.top + b.height / 2;

      /* rims worth bouncing off: card tops strictly between here and there */
      var rims = [];
      cards.forEach(function (c) {
        if (c === fromCard) { return; }
        var r = c.getBoundingClientRect();
        if (r.top > y + R && r.top < ty - R) {
          rims.push({ top: r.top, left: r.left, right: r.right });
        }
      });

      var marble = document.createElement('div');
      marble.className = 'ks-marble';
      marble.style.background = FILL[id];
      document.body.appendChild(marble);

      var vx = (tx - x) * 0.004;
      var vy = -1.4;
      var t0 = null;
      var raf = null;
      var finished = false;

      function finish() {
        if (finished) { return; }
        finished = true;
        if (raf) { window.cancelAnimationFrame(raf); raf = null; }
        document.removeEventListener('visibilitychange', bail);
        if (marble.parentNode) { marble.parentNode.removeChild(marble); }
        done();
      }
      /* a backgrounded tab stops painting; do not strand the marble */
      function bail() { if (document.hidden) { finish(); } }
      document.addEventListener('visibilitychange', bail);

      function step(now) {
        if (t0 === null) { t0 = now; }
        var age = now - t0;

        vy += 0.62;
        /* homing ramps in, so the early flight is ballistic and the late
           flight cannot miss */
        var pull = Math.min(1, age / 1200) * 0.011;
        vx += (tx - x) * pull;
        vy += (ty - y) * pull * 0.55;
        vx *= 0.995;

        x += vx;
        y += vy;

        for (var i = 0; i < rims.length; i++) {
          var rim = rims[i];
          if (vy > 0 && y + R > rim.top && y + R < rim.top + Math.abs(vy) + 2 &&
              x > rim.left && x < rim.right) {
            y = rim.top - R;
            vy = -vy * 0.42;
            vx *= 0.86;
          }
        }

        /* the last stretch blends onto the socket so the arrival is exact */
        if (age > 1400) {
          var k = Math.min(1, (age - 1400) / 700);
          x += (tx - x) * k * 0.22;
          y += (ty - y) * k * 0.22;
        }

        marble.style.transform =
          'translate3d(' + (x - R) + 'px,' + (y - R) + 'px,0)';

        var near = Math.abs(x - tx) < 3 && Math.abs(y - ty) < 3;
        if (near || age > 2200) { finish(); return; }
        raf = window.requestAnimationFrame(step);
      }
      raf = window.requestAnimationFrame(step);
    }

    paint(null);

    /* --- coming back ----------------------------------------------------
       Every card is target=_blank, so this page is still sitting here when
       the visitor returns. Some in-app browsers never fire visibilitychange
       for a dismissed sheet and some fire it on any scroll-away, so all
       three signals are listened to and the pending record is what actually
       gates the credit. No pending record, no marble. */
    var settling = false;
    function returned() {
      if (settling || document.hidden) { return; }
      var pending = read('ks-hub-pending', null);
      if (!pending || !pending.id || PLATFORMS.indexOf(pending.id) === -1) { return; }
      /* under a second away is a stray blur, not a visit */
      if (Date.now() - pending.at < 1200) { return; }
      write('ks-hub-pending', null);

      var map = opened();
      if (map[pending.id]) { return; }
      map[pending.id] = Date.now();
      write('ks-hub-opened', map);

      settling = true;
      var card = grid.querySelector('.link-card[data-p="' + pending.id + '"]');
      fly(card, pending.id, function () {
        var n = paint(pending.id);
        settling = false;
        say((LABEL[pending.id] || pending.id) + ' opened. ' +
            WORD[n] + ' of six.' + (n === 6 ? ' All six.' : ''));
      });
    }

    document.addEventListener('visibilitychange', returned);
    window.addEventListener('pageshow', returned);
    window.addEventListener('focus', returned);
  })();
})();
