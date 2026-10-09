/** Coordinates in-place xterm font changes with bounded readiness and geometry updates. */
import { TERMINAL_FONT_FALLBACK, TERMINAL_SYMBOL_FONT, type FontFamilyPreference } from '@shared/font-settings';
import { buildFontFamilyStack, serializeFontFamily } from '@renderer/fonts/font-family';
import { TERMINAL_FONT_SIZE } from '@shared/terminal-font-size';

const MIN_HOST_SIZE = 20;

export interface TerminalFontUpdatePort {
  readonly options: {
    fontFamily?: string;
    fontSize?: number;
  };
  readonly cols: number;
  readonly rows: number;
  clearTextureAtlas(): void;
  refresh(start: number, end: number): void;
}

export interface TerminalGeometryOptions {
  readonly clearGlyphCache?: boolean;
  readonly forceResize?: boolean;
}

export type TerminalGeometrySynchronizer = (options?: TerminalGeometryOptions) => void;

export interface TerminalFontUpdater {
  apply(family: FontFamilyPreference): Promise<void>;
  dispose(): void;
}

interface TerminalGeometryDependencies {
  readonly terminal: TerminalFontUpdatePort;
  readonly fit: { fit(): void };
  readonly dimensions: () => { readonly width: number; readonly height: number } | null;
  readonly resize: (cols: number, rows: number) => void;
}

interface TerminalFontUpdaterDependencies {
  readonly terminal: TerminalFontUpdatePort;
  readonly synchronize: TerminalGeometrySynchronizer;
  readonly loadFont?: (specification: string, text?: string) => Promise<unknown>;
  readonly timeoutMs: number;
}

function waitForFont(
  loadFont: (specification: string, text?: string) => Promise<unknown>,
  specification: string,
  timeoutMs: number,
  text?: string,
): Promise<void> {
  // ES2022 and Electron's Node 20 runtime do not provide Promise.withResolvers().
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = setTimeout(finish, Math.max(0, timeoutMs));
    try {
      void loadFont(specification, text).then(finish, finish);
    } catch {
      finish();
    }
  });
}

/** Creates a shared fit, repaint, and PTY-resize operation for terminal metric changes. */
export function createTerminalGeometrySynchronizer(
  dependencies: TerminalGeometryDependencies,
): TerminalGeometrySynchronizer {
  let lastCols = -1;
  let lastRows = -1;
  return (options = {}): void => {
    const dimensions = dependencies.dimensions();
    if (
      dimensions === null
      || dimensions.width < MIN_HOST_SIZE
      || dimensions.height < MIN_HOST_SIZE
    ) return;

    try {
      dependencies.fit.fit();
    } catch {
      return;
    }
    if (options.clearGlyphCache) {
      try {
        dependencies.terminal.clearTextureAtlas();
      } catch {
        // A renderer can disappear during WebGL-to-DOM fallback; repaint still recovers it.
      }
    }
    try {
      dependencies.terminal.refresh(0, Math.max(0, dependencies.terminal.rows - 1));
    } catch {
      // A resize can race renderer replacement; PTY geometry must still be synchronized.
    }

    const { cols, rows } = dependencies.terminal;
    if (!options.forceResize && cols === lastCols && rows === lastRows) return;
    lastCols = cols;
    lastRows = rows;
    dependencies.resize(cols, rows);
  };
}

/** Creates a generation-guarded updater that preserves the terminal while changing its font. */
export function createTerminalFontUpdater(
  dependencies: TerminalFontUpdaterDependencies,
): TerminalFontUpdater {
  let generation = 0;
  let disposed = false;

  return {
    async apply(family): Promise<void> {
      if (disposed) return;
      const updateGeneration = ++generation;
      dependencies.terminal.options.fontFamily = buildFontFamilyStack(
        family,
        TERMINAL_FONT_FALLBACK,
      );

      if (dependencies.loadFont) {
        const fontSize = dependencies.terminal.options.fontSize || TERMINAL_FONT_SIZE.default;
        const pendingFonts = [
          waitForFont(
            dependencies.loadFont,
            `${fontSize}px ${serializeFontFamily(TERMINAL_SYMBOL_FONT)}`,
            dependencies.timeoutMs,
            '\ue0b0\uf000\udb80\udc00',
          ),
        ];
        if (family !== null) {
          pendingFonts.push(waitForFont(
            dependencies.loadFont,
            `${fontSize}px ${serializeFontFamily(family)}`,
            dependencies.timeoutMs,
          ));
        }
        await Promise.all(pendingFonts);
      }
      if (disposed || generation !== updateGeneration) return;
      dependencies.synchronize({ clearGlyphCache: true, forceResize: true });
    },
    dispose(): void {
      disposed = true;
      generation += 1;
    },
  };
}
