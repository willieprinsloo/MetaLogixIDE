import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { api } from '@renderer/api';
import { useShellStream } from '@renderer/hooks/useShellStream';

export function ShellTab({ projectId, shellIndex }: { projectId: number; shellIndex: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      scrollback: 10000,
      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      fontSize: 13,
      theme: { background: 'rgba(0,0,0,0)' },
      // allowProposedApi is required for Unicode11Addon and screenReaderMode.
      allowProposedApi: true,
      // screenReaderMode enables the .xterm-accessibility DOM layer which
      // mirrors terminal output as text, required for E2E assertions.
      screenReaderMode: true,
    });
    try { term.loadAddon(new WebglAddon()); } catch { /* fallback to canvas */ }
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.open(hostRef.current);
    term.onData((data) => { void api.invoke('shells:write', { projectId, shellIndex, data }); });
    termRef.current = term;

    // Initial resize.
    const cols = Math.max(20, Math.floor(hostRef.current.clientWidth / 8));
    const rows = Math.max(5, Math.floor(hostRef.current.clientHeight / 17));
    term.resize(cols, rows);
    void api.invoke('shells:resize', { projectId, shellIndex, cols, rows });

    const ro = new ResizeObserver(() => {
      if (!hostRef.current) return;
      const c = Math.max(20, Math.floor(hostRef.current.clientWidth / 8));
      const r = Math.max(5, Math.floor(hostRef.current.clientHeight / 17));
      term.resize(c, r);
      void api.invoke('shells:resize', { projectId, shellIndex, cols: c, rows: r });
    });
    ro.observe(hostRef.current);

    return () => { ro.disconnect(); term.dispose(); termRef.current = null; };
  }, [projectId, shellIndex]);

  useShellStream(
    projectId,
    shellIndex,
    (data) => termRef.current?.write(data),
    () => { termRef.current?.write('\r\n[shell exited]\r\n'); },
  );

  return <div ref={hostRef} data-testid="shell-tab" className="w-full h-full p-2" />;
}
