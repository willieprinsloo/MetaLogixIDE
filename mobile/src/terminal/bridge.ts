/**
 * Runs inside the terminal WebView: xterm.js, sized to the view, talking to React Native through
 * postMessage and `window.__term` (see ./protocol). Bundled into one script by
 * scripts/build-terminal-html.mts; it shares nothing with the app at runtime.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { KeyName, PageMessage, TerminalApi } from './protocol';

declare global {
  interface Window {
    ReactNativeWebView: { postMessage(message: string): void };
    __term: TerminalApi;
  }
}

const post = (m: PageMessage): void => window.ReactNativeWebView.postMessage(JSON.stringify(m));
const el = document.getElementById('t') as HTMLDivElement;

const term = new Terminal({
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
    brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#6bc46d', brightYellow: '#daaa3f', brightBlue: '#6cb6ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#e6edf3',
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(el);

// ---- sizing ----

let lastCols = 0;
let lastRows = 0;
function refit(): void {
  if (!el.clientWidth || !el.clientHeight) return;
  try { fit.fit(); } catch { /* not laid out yet */ }
  if (term.cols !== lastCols || term.rows !== lastRows) {
    lastCols = term.cols;
    lastRows = term.rows;
    post({ t: 'size', cols: term.cols, rows: term.rows });
  }
}
let pendingFit: ReturnType<typeof setTimeout> | undefined;
const scheduleFit = (): void => { clearTimeout(pendingFit); pendingFit = setTimeout(refit, 60); };
if ('ResizeObserver' in window) new ResizeObserver(scheduleFit).observe(el);
window.addEventListener('resize', scheduleFit);

// ---- touch scrolling ----
// xterm's own gesture handling does not scroll inside this WebView, so a vertical drag is turned into
// scrolling here: through the scrollback on the normal screen, and as wheel events on the alternate
// screen, where xterm passes them to the full-screen program (or sends arrow keys for it).

const DRAG_START_PX = 8;
let drag: { x: number; y: number; t: number; moved: boolean } | null = null;
let carry = 0;    // sub-line remainder, in pixels
let velocity = 0; // px per ms, positive = finger moving down
let glide = 0;

function cellHeight(): number {
  const rows = el.querySelector('.xterm-rows');
  const h = rows && term.rows ? rows.getBoundingClientRect().height / term.rows : 0;
  return h > 4 ? h : 15;
}

function scrollPixels(px: number, x: number, y: number): void {
  carry += px;
  const h = cellHeight();
  const lines = carry > 0 ? Math.floor(carry / h) : Math.ceil(carry / h);
  if (!lines) return;
  carry -= lines * h;
  if (term.buffer.active.type === 'alternate') {
    const target = el.querySelector('.xterm-screen') ?? el;
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: -lines * h, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  } else {
    term.scrollLines(-lines); // dragging down shows earlier output
  }
}

const stopGlide = (): void => { if (glide) { cancelAnimationFrame(glide); glide = 0; } };

el.addEventListener('touchstart', (e) => {
  stopGlide();
  const t = e.touches.length === 1 ? e.touches[0] : undefined;
  if (!t) { drag = null; return; }
  drag = { x: t.clientX, y: t.clientY, t: Date.now(), moved: false };
  carry = 0;
  velocity = 0;
}, { passive: true });

el.addEventListener('touchmove', (e) => {
  const t = e.touches.length === 1 ? e.touches[0] : undefined;
  if (!drag || !t) return;
  let dy = t.clientY - drag.y;
  if (!drag.moved) {
    if (Math.abs(dy) < DRAG_START_PX) return; // still a tap: leave it to xterm, which focuses on tap
    drag.moved = true;
    dy = dy > 0 ? dy - DRAG_START_PX : dy + DRAG_START_PX;
  }
  // This drag is a scroll: keep the page and xterm's gesture layer out of it.
  e.preventDefault();
  e.stopPropagation();
  const now = Date.now();
  velocity = 0.7 * (dy / Math.max(1, now - drag.t)) + 0.3 * velocity;
  drag.y = t.clientY;
  drag.t = now;
  scrollPixels(dy, t.clientX, t.clientY);
}, { passive: false });

el.addEventListener('touchend', (e) => {
  const d = drag;
  drag = null;
  if (!d || !d.moved) return;
  if (e.cancelable) e.preventDefault(); // a scroll must not end in a click that moves the cursor
  if (Date.now() - d.t > 80 || Math.abs(velocity) < 0.3) return; // the finger had stopped: no glide
  let v = velocity;
  let last = Date.now();
  const step = (): void => {
    const now = Date.now();
    const dt = Math.min(48, now - last);
    last = now;
    scrollPixels(v * dt, d.x, d.y);
    v *= Math.pow(0.996, dt);
    glide = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
  };
  glide = requestAnimationFrame(step);
}, { passive: false });

el.addEventListener('touchcancel', () => { drag = null; }, { passive: true });

// ---- input ----

// Sticky Ctrl from the key bar: applies to the next single key typed on the soft keyboard.
let ctrl = false;
term.onData((data) => {
  stopGlide();
  let d = data;
  if (ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 63 && c <= 95) d = String.fromCharCode(c === 63 ? 127 : c & 31);
    else if (d === ' ') d = '\x00';
    ctrl = false;
    post({ t: 'ctrl', on: false });
  }
  post({ t: 'in', d });
});

const KEYS: Partial<Record<KeyName, string>> = {
  esc: '\x1b', tab: '\t', enter: '\r', 'ctrl-c': '\x03', 'ctrl-d': '\x04', 'shift-tab': '\x1b[Z',
  home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
};
const ARROWS: Partial<Record<KeyName, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

window.__term = {
  write: (text) => term.write(text),
  reset: () => term.reset(),
  focus: () => term.focus(),
  blur: () => term.blur(),
  refit: () => { lastCols = 0; refit(); },
  setCtrl: (on) => { ctrl = on; },
  setFontSize: (px) => { term.options.fontSize = px; lastCols = 0; refit(); },
  key: (name) => {
    const arrow = ARROWS[name];
    // Full-screen programs switch the arrows to application mode (ESC O x).
    const seq = arrow ? (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrow : KEYS[name];
    if (seq) post({ t: 'in', d: seq });
  },
  paste: (text) => term.paste(text),
};

refit();
post({ t: 'ready' });
