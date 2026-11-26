/**
 * OSC 52 (xterm "Manipulate Selection Data") parsing. `parseOsc52(data)` takes the payload xterm
 * hands an OSC 52 handler (`Pc;Pd`, terminator already stripped) and returns a clipboard write or
 * an ignore. Reads (`Pd = ?`), clears, malformed base64, invalid UTF-8 and anything over 1 MiB
 * decoded are ignored; the base64 length is checked before any decoding. `registerClipboardOsc`
 * wires the parser into an xterm parser: it always consumes the sequence, never answers a read,
 * and passes clipboard rejections to `onError`.
 */
export const OSC52_MAX_BYTES = 1024 * 1024;
const MAX_B64_CHARS = Math.ceil(OSC52_MAX_BYTES / 3) * 4;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type Osc52Result = { kind: 'write'; text: string } | { kind: 'ignore' };
const IGNORE: Osc52Result = { kind: 'ignore' };

export function parseOsc52(data: string): Osc52Result {
  const i = data.indexOf(';');
  if (i < 0) return IGNORE;
  const pc = data.slice(0, i);
  const pd = data.slice(i + 1);
  if (pc !== '' && !/[cps]/.test(pc)) return IGNORE;
  if (pd === '' || pd === '?' || pd.length > MAX_B64_CHARS || !B64.test(pd)) return IGNORE;
  try {
    const bin = atob(pd);
    if (bin.length > OSC52_MAX_BYTES) return IGNORE;
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { kind: 'write', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return IGNORE;
  }
}

export interface ClipboardOscTerm {
  parser: { registerOscHandler(ident: number, cb: (data: string) => boolean): { dispose(): void } };
}

export interface ClipboardOscDeps {
  writeText: (text: string) => Promise<void>;
  onError: (err: unknown) => void;
}

export function registerClipboardOsc(term: ClipboardOscTerm, deps: ClipboardOscDeps): { dispose(): void } {
  return term.parser.registerOscHandler(52, (data) => {
    const parsed = parseOsc52(data);
    if (parsed.kind === 'write') deps.writeText(parsed.text).catch(deps.onError);
    return true;
  });
}
