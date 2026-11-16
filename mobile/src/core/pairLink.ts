/** Reads what a pairing QR code holds: the desktop's `metaide://pair?code=…&relay=…&port=…` link, or a bare pair code. */
export type PairLink = { code: string; relayHost?: string; relayPort?: number };

const CONNECT_CODE_RE = /^[A-Za-z0-9-]{4,32}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:]+\]$/;

function decode(v: string): string {
  try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return ''; }
}

export function parsePairLink(text: string): PairLink | null {
  const s = text.trim();
  if (CONNECT_CODE_RE.test(s)) return { code: s };
  const m = /^metaide:\/\/pair\/?\?([^#]*)/i.exec(s);
  if (!m) return null;
  const q = new Map<string, string>();
  for (const part of m[1]!.split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && !q.has(part.slice(0, i))) q.set(part.slice(0, i), decode(part.slice(i + 1)));
  }
  const code = (q.get('code') ?? '').trim();
  if (!CONNECT_CODE_RE.test(code)) return null;
  const out: PairLink = { code };
  const host = (q.get('relay') ?? '').trim();
  if (HOST_RE.test(host)) out.relayHost = host;
  const port = Number(q.get('port'));
  if (/^\d{1,5}$/.test(q.get('port') ?? '') && port > 0 && port < 65536) out.relayPort = port;
  return out;
}
