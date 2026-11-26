/**
 * The link a pairing QR code carries, read by the mobile app (`mobile/src/core/pairLink.ts`):
 *
 *   metaide://pair?code=<connect code>&relay=<relay host>&port=<relay port>
 *
 * It holds nothing the pairing window does not already show: the code is this machine's public
 * connect code, valid for pairing only while the window is open.
 */
export const PAIR_LINK_BASE = 'metaide://pair';

export function buildPairLink(p: { code: string; relayUrl?: string; relayPort?: number }): string {
  const q = [`code=${encodeURIComponent(p.code.trim())}`];
  if (p.relayUrl?.trim()) q.push(`relay=${encodeURIComponent(p.relayUrl.trim())}`);
  if (p.relayPort !== undefined && Number.isInteger(p.relayPort) && p.relayPort > 0 && p.relayPort < 65536) q.push(`port=${p.relayPort}`);
  return `${PAIR_LINK_BASE}?${q.join('&')}`;
}
