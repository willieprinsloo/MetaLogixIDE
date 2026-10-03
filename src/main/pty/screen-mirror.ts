/**
 * Authoritative per-PTY terminal state held in main. A headless xterm is fed
 * every output byte, so a remounting viewport can replay a serialized picture
 * of the whole screen and scrollback instead of a truncated raw-byte tail,
 * which loses cells a TUI drew once and never redrew.
 */
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/** Scrollback lines kept by each headless terminal. */
export const MIRROR_SCROLLBACK_LINES = 5000;

/**
 * Headless terminal mirroring one PTY. Writes are queued and parsed off the
 * caller's stack by xterm's write buffer; `snapshot` waits for that queue to
 * drain first. Every method is a safe no-op once disposed.
 */
export class ScreenMirror {
  private readonly term: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly pending = new Set<(value: string) => void>();
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: MIRROR_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.serializer);
  }

  /** Queue PTY output for parsing; returns without parsing it. */
  write(data: string): void {
    if (this.disposed) return;
    this.term.write(data);
  }

  /** Resize the headless terminal to match the live PTY. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.term.resize(cols, rows);
  }

  /**
   * Serialized screen plus scrollback, with SGR state, modes and cursor
   * position, after every write queued so far has been parsed. Resolves ''
   * if the mirror is, or becomes, disposed.
   */
  snapshot(): Promise<string> {
    if (this.disposed) return Promise.resolve('');
    return new Promise<string>((resolve) => {
      this.pending.add(resolve);
      this.term.write('', () => {
        if (!this.pending.delete(resolve)) return;
        resolve(this.serializer.serialize());
      });
    });
  }

  /** Release the headless terminal and settle any in-flight snapshot with ''. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resolve of this.pending) resolve('');
    this.pending.clear();
    this.term.dispose();
  }
}
