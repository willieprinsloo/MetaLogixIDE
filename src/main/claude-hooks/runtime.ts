import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENDPOINT_ENV, EXECUTABLE_ENV, FORWARDER_ENV } from './protocol';
import { hookSettingsPath, removeHookSettings, writeHookSettings } from './settings-file';

export interface HookEndpoint {
  readonly path: string;
  remove(): void;
}

/** Allocates a fresh endpoint; Windows uses an unguessable named pipe. */
export function allocateHookEndpoint(platform: NodeJS.Platform, id: string): HookEndpoint {
  if (platform === 'win32') return { path: `\\\\.\\pipe\\metaide-claude-hook-${id}`, remove() {} };
  const dir = mkdtempSync(join(tmpdir(), 'metaide-hook-'));
  return { path: join(dir, 'hook.sock'), remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface HookRuntimeDeps {
  receiver: { start(endpoint: string): Promise<void>; stop(): Promise<void> };
  homeDir: string;
  forwarderPath: string;
  platform?: NodeJS.Platform;
  executable?: string;
  instanceId?: () => string;
  allocateEndpoint?: typeof allocateHookEndpoint;
  writeSettings?: typeof writeHookSettings;
  removeSettings?: typeof removeHookSettings;
}

/** Publishes launch settings only while the originating receiver is available. */
export class ClaudeHookRuntime {
  private active: { path: string; endpoint: HookEndpoint } | null = null;

  constructor(private readonly deps: HookRuntimeDeps) {}

  async start(): Promise<void> {
    if (this.active) return;
    const platform = this.deps.platform ?? process.platform;
    const id = (this.deps.instanceId ?? randomUUID)();
    const endpoint = (this.deps.allocateEndpoint ?? allocateHookEndpoint)(platform, id);
    const path = hookSettingsPath(this.deps.homeDir, id);
    try {
      await this.deps.receiver.start(endpoint.path);
      (this.deps.writeSettings ?? writeHookSettings)(path, platform);
      this.active = { path, endpoint };
    } catch (error) {
      try { await this.deps.receiver.stop(); } finally { this.cleanUp(() => endpoint.remove()); }
      throw error;
    }
  }

  settingsPath(): string | null {
    return this.active?.path ?? null;
  }

  forwarderEnv(): Readonly<Record<string, string>> {
    if (!this.active) return {};
    return {
      [ENDPOINT_ENV]: this.active.endpoint.path,
      [FORWARDER_ENV]: this.deps.forwarderPath,
      [EXECUTABLE_ENV]: this.deps.executable ?? process.execPath,
    };
  }

  async stop(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active) this.cleanUp(() => (this.deps.removeSettings ?? removeHookSettings)(active.path));
    try { await this.deps.receiver.stop(); }
    finally { if (active) this.cleanUp(() => active.endpoint.remove()); }
  }

  private cleanUp(remove: () => void): void {
    try { remove(); }
    catch { console.warn('[claude-hooks] could not remove instance files'); }
  }
}
