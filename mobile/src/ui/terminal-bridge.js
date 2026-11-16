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

  // Sticky Ctrl from the key bar: applies to the next single key typed on the soft keyboard.
  var ctrl = false;
  term.onData(function (d) {
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
