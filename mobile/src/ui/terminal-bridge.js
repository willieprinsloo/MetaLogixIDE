/* Runs inside the terminal WebView. Talks to React Native through postMessage / window.__term. */
(function () {
  var post = function (m) { window.ReactNativeWebView.postMessage(JSON.stringify(m)); };
  var el = document.getElementById('t');
  var term = new Terminal({
    fontSize: 12,
    fontFamily: 'Menlo, "SF Mono", "Roboto Mono", ui-monospace, monospace',
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: {
      background: '#0d1014', foreground: '#d6dde6', cursor: '#d6dde6', cursorAccent: '#0d1014',
      selectionBackground: '#2f4a6b',
      black: '#1b2028', red: '#f47067', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#b7c0cc',
      brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#e6edf3'
    }
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  var lastCols = 0, lastRows = 0;
  function refit() {
    if (!el.clientWidth || !el.clientHeight) return;
    try { fit.fit(); } catch (e) { /* not laid out yet */ }
    if (term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols; lastRows = term.rows;
      post({ t: 'size', cols: term.cols, rows: term.rows });
    }
  }
  var pending = 0;
  function scheduleFit() { clearTimeout(pending); pending = setTimeout(refit, 60); }
  if (window.ResizeObserver) new ResizeObserver(scheduleFit).observe(el);
  window.addEventListener('resize', scheduleFit);

  // Touch scrolling. xterm's own gesture handling does not scroll inside this WebView, so a vertical drag
  // is turned into scrolling here: through the scrollback on the normal screen, and as wheel events on the
  // alternate screen, where xterm passes them to the full-screen program (or sends arrow keys for it).
  var DRAG_START_PX = 8;
  var drag = null;      // { y, t, moved, x }
  var carry = 0;        // sub-line remainder, in pixels
  var velocity = 0;     // px per ms, positive = finger moving down
  var glide = 0;

  function cellHeight() {
    var rows = el.querySelector('.xterm-rows');
    var h = rows && term.rows ? rows.getBoundingClientRect().height / term.rows : 0;
    return h > 4 ? h : 15;
  }
  function scrollPixels(px, x, y) {
    carry += px;
    var h = cellHeight();
    var lines = carry > 0 ? Math.floor(carry / h) : Math.ceil(carry / h);
    if (!lines) return;
    carry -= lines * h;
    if (term.buffer.active.type === 'alternate') {
      var target = el.querySelector('.xterm-screen') || el;
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: -lines * h, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    } else {
      term.scrollLines(-lines); // dragging down shows earlier output
    }
  }
  function stopGlide() { if (glide) { cancelAnimationFrame(glide); glide = 0; } }

  el.addEventListener('touchstart', function (e) {
    stopGlide();
    if (e.touches.length !== 1) { drag = null; return; }
    var t = e.touches[0];
    drag = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
    carry = 0;
    velocity = 0;
  }, { passive: true });

  el.addEventListener('touchmove', function (e) {
    if (!drag || e.touches.length !== 1) return;
    var t = e.touches[0];
    var dy = t.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) < DRAG_START_PX) return; // still a tap: leave it to xterm, which focuses on tap
      drag.moved = true;
      dy = dy > 0 ? dy - DRAG_START_PX : dy + DRAG_START_PX;
    }
    // This drag is a scroll: keep the page and xterm's gesture layer out of it.
    e.preventDefault();
    e.stopPropagation();
    var now = Date.now();
    var dt = Math.max(1, now - drag.t);
    velocity = 0.7 * (dy / dt) + 0.3 * velocity;
    drag.y = t.clientY;
    drag.t = now;
    scrollPixels(dy, t.clientX, t.clientY);
  }, { passive: false });

  function endDrag(e) {
    var d = drag;
    drag = null;
    if (!d || !d.moved) return;
    if (e && e.cancelable) e.preventDefault(); // a scroll must not end in a click that moves the cursor
    if (Date.now() - d.t > 80 || Math.abs(velocity) < 0.3) return; // the finger had stopped: no glide
    var v = velocity, last = Date.now(), x = d.x, y = d.y;
    var step = function () {
      var now = Date.now();
      var dt = Math.min(48, now - last);
      last = now;
      scrollPixels(v * dt, x, y);
      v *= Math.pow(0.996, dt);
      glide = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
    };
    glide = requestAnimationFrame(step);
  }
  el.addEventListener('touchend', endDrag, { passive: false });
  el.addEventListener('touchcancel', function () { drag = null; }, { passive: true });

  // Sticky Ctrl from the key bar: applies to the next single key typed on the soft keyboard.
  var ctrl = false;
  term.onData(function (d) {
    stopGlide();
    if (ctrl && d.length === 1) {
      var c = d.toUpperCase().charCodeAt(0);
      if (c >= 63 && c <= 95) d = String.fromCharCode(c === 63 ? 127 : c & 31);
      else if (d === ' ') d = '\x00';
      ctrl = false;
      post({ t: 'ctrl', on: false });
    }
    post({ t: 'in', d: d });
  });

  var KEYS = {
    esc: '\x1b', tab: '\t', enter: '\r', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'shift-tab': '\x1b[Z',
    home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~'
  };
  var ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };

  window.__term = {
    write: function (s) { term.write(s); },
    reset: function () { term.reset(); },
    focus: function () { term.focus(); },
    blur: function () { term.blur(); },
    refit: function () { lastCols = 0; refit(); },
    setCtrl: function (on) { ctrl = !!on; },
    setFontSize: function (n) { term.options.fontSize = n; lastCols = 0; refit(); },
    key: function (name) {
      var seq = KEYS[name];
      // Full-screen programs switch the arrows to application mode (ESC O x).
      if (ARROWS[name]) seq = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROWS[name];
      if (seq) post({ t: 'in', d: seq });
    },
    paste: function (s) { term.paste(s); }
  };

  refit();
  post({ t: 'ready' });
})();
