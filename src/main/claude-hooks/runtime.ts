/**
 * Lifecycle of the hook transport: start the receiver, then write this
 * instance's port-keyed settings file for its URL; on stop, remove that
 * file and stop the receiver. The settings path is non-null only while
 * both start steps succeeded, which is what the launch decorator keys
 * injection on (AC22). A file left behind by a crash is inert.
 */
import { hookSettingsPath, removeHookSettings, writeHookSettings } from './settings-file';

/** Collaborators; the file writer/remover default to the real ones. */
export interface HookRuntimeDeps {
  receiver: { start(): Promise<number>; stop(): Promise<void>; url(): string | null };
  homeDir: string;
  writeSettings?: (path: string, url: string) => void;
  removeSettings?: (path: string) => void;
}

/** Owns receiver start/stop and the per-instance settings file handed to Claude spawns. */
export class ClaudeHookRuntime {
  private path: string | null = null;
  private readonly writeSettings: (path: string, url: string) => void;
  private readonly removeSettings: (path: string) => void;

  constructor(private readonly deps: HookRuntimeDeps) {
    this.writeSettings = deps.writeSettings ?? writeHookSettings;
    this.removeSettings = deps.removeSettings ?? removeHookSettings;
  }

  /** Starts the receiver and writes its settings file; rejects (receiver stopped again) when either fails. */
  async start(): Promise<void> {
    const port = await this.deps.receiver.start();
    const path = hookSettingsPath(this.deps.homeDir, port);
    try {
      this.writeSettings(path, this.deps.receiver.url()!);
    } catch (err) {
      await this.deps.receiver.stop();
      throw err;
    }
    this.path = path;
  }

  /** Path of this instance's settings file, or null while hooks are unavailable. */
  settingsPath(): string | null {
    return this.path;
  }

  /** Stops injecting into new spawns, removes this instance's settings file, then stops the receiver. */
  async stop(): Promise<void> {
    const path = this.path;
    this.path = null;
    if (path !== null) this.removeOwnFile(path);
    await this.deps.receiver.stop();
  }

  private removeOwnFile(path: string): void {
    try {
      this.removeSettings(path);
    } catch (err) {
      console.warn('[claude-hooks] could not remove hook settings file', { path, cause: err });
    }
  }
}
