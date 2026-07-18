import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';

interface Options { cap: number }

export class RootWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private cap: number;
  constructor(opts: Options) { super(); this.cap = opts.cap; }

  getCap(): number { return this.cap; }
  setCap(n: number): void { this.cap = n; }
  getWatchedCount(): number { return this.watchers.size; }

  watch(rootPath: string): boolean {
    if (this.watchers.has(rootPath)) return true;
    if (this.watchers.size >= this.cap) return false;
    const w = chokidar.watch(rootPath, { depth: 1, ignoreInitial: true, persistent: true });
    w.on('addDir',    (p: string) => this.emit('add', p));
    w.on('unlinkDir', (p: string) => this.emit('remove', p));
    this.watchers.set(rootPath, w);
    return true;
  }

  async unwatch(rootPath: string): Promise<void> {
    const w = this.watchers.get(rootPath);
    if (!w) return;
    await w.close();
    this.watchers.delete(rootPath);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.watchers.values()].map(w => w.close()));
    this.watchers.clear();
  }
}
