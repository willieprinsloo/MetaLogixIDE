/**
 * Ollama: local models as a chat (no access to files). The app keeps the member's conversation and
 * sends it with every turn (item.history); Ollama itself remembers nothing between calls.
 * POST <base>/api/chat { model, messages, stream: true } answers one JSON object per line:
 *   { message: { content: '<next piece>' }, done: false } … { done: true, prompt_eval_count, eval_count }
 * Ported from BotOffice windows/engines/ollama.js.
 */
import type { TurnItem, TurnResult } from './types';

export const OLLAMA_BASE = 'http://127.0.0.1:11434';
export const NOT_RUNNING = 'Ollama isn’t running — start it (the Ollama app, or `ollama serve`)';
const STOPPED: TurnResult = { ok: false, reply: '', error: 'stopped' };

export async function runOllama(
  item: TurnItem & { model: string },
  { base = OLLAMA_BASE, signal, fetch: fetchFn = fetch }: { base?: string; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<TurnResult> {
  const messages = [...(item.history ?? []), { role: 'user', content: item.text || '' }];
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: item.model, messages, stream: true }),
      signal,
    });
  } catch {
    return signal?.aborted ? STOPPED : { ok: false, reply: '', error: NOT_RUNNING };
  }
  if (!res.ok) {
    let msg = '';
    try { msg = String(((await res.json()) as { error?: unknown }).error || ''); } catch { /* no JSON body */ }
    if (res.status === 404 && /not found/i.test(msg)) return { ok: false, reply: '', error: `model ${item.model} isn’t installed — run: ollama pull ${item.model}` };
    return { ok: false, reply: '', error: `Ollama answered HTTP ${res.status}${msg ? `: ${msg}` : ''}` };
  }
  let text = '';
  let finished = false; // Ollama ends a whole reply with done:true; without it the reply was cut off
  let pending = '';
  const decoder = new TextDecoder();
  const take = (l: string): string | null => {
    if (!l.trim()) return null;
    let o: { error?: unknown; message?: { content?: string }; done?: boolean };
    try { o = JSON.parse(l); } catch { return null; }
    if (o.error) return String(o.error);
    if (o.message?.content) text += o.message.content;
    if (o.done) finished = true;
    return null;
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) { const err = take(l); if (err) return { ok: false, reply: text, error: `Ollama: ${err}` }; }
    }
    const err = take(pending);
    if (err) return { ok: false, reply: text, error: `Ollama: ${err}` };
  } catch (e) {
    if (signal?.aborted) return STOPPED;
    return { ok: false, reply: text, error: `Ollama stopped answering: ${(e as Error).message}` };
  }
  if (!finished) return { ok: false, reply: text, error: 'Ollama stopped mid-reply (did it run out of memory or restart?)' };
  return { ok: true, reply: text };
}
