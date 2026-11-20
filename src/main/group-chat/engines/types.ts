/** One headless turn's input and result, shared by every engine adapter. */
export interface TurnItem {
  text: string;
  model?: string | null;
  /** Codex thread id / Gemini session id to resume; null starts a new conversation. */
  engineSession?: string | null;
  /** Ollama only: the member's earlier conversation, sent with every turn. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface TurnResult {
  ok: boolean;
  reply: string;
  error?: string;
  engineSession?: string;
}

/** Reads a CLI's stdout one line at a time; `feed` returns whether anything visible changed. */
export interface Progress {
  feed(line: string): boolean;
}
