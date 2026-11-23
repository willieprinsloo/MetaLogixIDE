import type { IDisposable, Terminal } from '@xterm/xterm';

type TerminalGrid = Pick<Terminal, 'buffer' | 'cols' | 'rows'>;
type PaintBackdrop = (color: string | undefined) => void;
type PaletteReader = (index: number) => number | undefined | Promise<number | undefined>;
type EdgeColor = { readonly kind: 'rgb' | 'palette'; readonly value: number };
interface BackdropOptions {
  readonly resolvePalette?: PaletteReader;
  readonly intervalMs?: number;
}

/** Reads a common explicit background at the corners and midpoints of an alternate screen. */
export function terminalBackdrop({ buffer, cols, rows }: TerminalGrid): EdgeColor | undefined {
  const { active } = buffer;
  if (active.type !== 'alternate' || rows < 1 || cols < 1) return;

  const top = active.viewportY;
  const bottom = top + rows - 1;
  const middle = top + Math.floor(rows / 2);
  const right = cols - 1;
  const center = Math.floor(cols / 2);
  const sample = (row: number, col: number): EdgeColor | undefined => {
    const cell = active.getLine(row)?.getCell(col);
    if (!cell || cell.isInverse()) return;
    const value = cell.getBgColor();
    if (cell.isBgRGB()) return { kind: 'rgb', value };
    if (cell.isBgPalette() && value >= 16 && value <= 255) return { kind: 'palette', value };
  };
  const color = sample(top, 0);
  if (!color) return;
  if ([sample(top, center), sample(top, right), sample(middle, 0), sample(middle, right),
    sample(bottom, 0), sample(bottom, center), sample(bottom, right)].some(edge => !sameColor(edge, color))) return;
  return color;
}

function sameColor(a: EdgeColor | undefined, b: EdgeColor | undefined): boolean {
  return a?.kind === b?.kind && a?.value === b?.value;
}

/** Maps the xterm-256 color cube and grayscale ramp. */
function xtermExtendedAnsiRgb(index: number): number {
  if (index >= 232) return (8 + (index - 232) * 10) * 0x010101;
  const cube = index - 16;
  const level = (channel: number) => channel === 0 ? 0 : 55 + channel * 40;
  return (level(Math.floor(cube / 36)) << 16) | (level(Math.floor(cube / 6) % 6) << 8) | level(cube % 6);
}

function cssColor(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `#${value.toString(16).padStart(6, '0')}`;
}

/** Repaints the inset only when the active renderer's sampled background changes. */
export function watchTerminalBackdrop(terminal: TerminalGrid & Pick<Terminal, 'onRender'>, paint: PaintBackdrop,
  { resolvePalette = xtermExtendedAnsiRgb, intervalMs = 0 }: BackdropOptions = {}): IDisposable {
  let previous: EdgeColor | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function paintPalette(color: EdgeColor) {
    try {
      const value = await resolvePalette(color.value);
      if (previous === color) paint(cssColor(value));
    } catch {
      // The terminal can be disposed while a viewport read is pending.
      if (previous === color) paint(undefined);
    }
  }
  function refresh() {
    const color = terminalBackdrop(terminal);
    if (sameColor(color, previous)) return;
    previous = color;
    if (color?.kind === 'palette') void paintPalette(color);
    else paint(cssColor(color?.value));
  }
  function cancelSample() {
    clearTimeout(timer);
    timer = undefined;
  }
  function scheduleSample() {
    if (terminal.buffer.active.type !== 'alternate' || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; refresh(); }, intervalMs);
  }
  const render = terminal.onRender(intervalMs > 0 ? scheduleSample : refresh);
  const buffer = terminal.buffer.onBufferChange(() => { cancelSample(); refresh(); });
  refresh();
  return { dispose() { cancelSample(); previous = undefined; render.dispose(); buffer.dispose(); paint(undefined); } };
}
