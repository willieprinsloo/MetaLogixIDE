import { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { useShellStream } from '@renderer/hooks/useShellStream';

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function buildTheme(): ITheme {
  return {
    background: 'rgba(0,0,0,0)',
    foreground: readVar('--term-fg',        '#e6edf3'),
    cursor:     readVar('--term-cursor',    '#e6edf3'),
    selectionBackground: readVar('--term-selection', 'rgba(255,255,255,0.2)'),
  };
}

export function ShellTab({ projectId, shellIndex }: { projectId: number; shellIndex: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!termHostRef.current) return;
    const term = new Terminal({
      scrollback: 10000,
      // Explicit SF Mono stack — first match wins. Falls back through
      // common developer monospace fonts. `ui-monospace` alone can pick
      // Menlo bitmap fallback on some setups and looks pixelated.
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: buildTheme(),
      allowProposedApi: true,
      screenReaderMode: true,
      // Explicit — don't let xterm try to boost contrast (blurs rendering).
      minimumContrastRatio: 1,
      // Skip WebGL: on macOS with translucent backgrounds and retina it
      // sometimes rasterises to a half-DPR buffer and looks pixelated.
      // The canvas renderer (default) is subpixel-crisp here.
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon((_ev: MouseEvent, url: string) => {
      void api.invoke('app:open-external', { url }).catch((e) => console.error(e));
    }));
    term.loadAddon(new SearchAddon());

    term.open(termHostRef.current);
    term.onData((data) => { void api.invoke('shells:write', { projectId, shellIndex, data }); });
    termRef.current = term;

    function syncSize() {
      try {
        fit.fit();
        void api.invoke('shells:resize', { projectId, shellIndex, cols: term.cols, rows: term.rows });
      } catch { /* container might be zero-sized during transitions */ }
    }

    // Fit once after mount (allow font metrics to settle), then on resize.
    requestAnimationFrame(() => {
      requestAnimationFrame(syncSize);
    });

    const ro = new ResizeObserver(syncSize);
    if (containerRef.current) ro.observe(containerRef.current);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => { term.options.theme = buildTheme(); };
    media.addEventListener('change', onScheme);

    return () => {
      ro.disconnect();
      media.removeEventListener('change', onScheme);
      term.dispose();
      termRef.current = null;
    };
  }, [projectId, shellIndex]);

  useShellStream(
    projectId,
    shellIndex,
    (data) => termRef.current?.write(data),
    () => { termRef.current?.write('\r\n[shell exited]\r\n'); },
  );

  // Outer div = padding + background. Inner div = pure terminal viewport,
  // so xterm's own geometry math sees an element with no padding or extra chrome.
  return (
    <div
      ref={containerRef}
      data-testid="shell-tab"
      className="w-full h-full px-3 pt-2 pb-3 bg-transparent"
    >
      <div ref={termHostRef} className="w-full h-full" />
    </div>
  );
}
