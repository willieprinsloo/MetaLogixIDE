/** Group-chat types shared by the main process and the renderer (no Node or DOM imports). */

/** Whether a headless engine can run right now, and if not, why and how to fix it. */
export type EngineStatus =
  | { ready: true; version?: string; models?: string[] }
  | { ready: false; why: string; version?: string };

export type HeadlessEngine = 'codex' | 'gemini' | 'ollama';
