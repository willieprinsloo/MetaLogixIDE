import type { AgentState } from '../core/schemas';

export const C = {
  bg: '#0d1014',
  card: '#161b22',
  cardPressed: '#1c232c',
  border: '#262d36',
  text: '#e6edf3',
  dim: '#8b949e',
  faint: '#5c6570',
  accent: '#58a6ff',
  green: '#3fb950',
  amber: '#d29922',
  red: '#f85149',
} as const;

export const AGENT: Record<AgentState, { label: string; color: string }> = {
  blocked: { label: 'Needs input', color: C.amber },
  busy: { label: 'Working', color: C.accent },
  idle: { label: 'Idle', color: C.dim },
};

/** Reason codes from the relay, the desktop and the link layer, in words a person can act on. */
export function explain(reason: string | null): string {
  switch (reason) {
    case null: return '';
    case 'invalid_code': return 'That does not look like a pair code.';
    case 'handshake_failed': return 'The code was not accepted. Open "Pair a new machine" on the desktop and enter the code it shows.';
    case 'handshake_timeout':
    case 'negotiation_timeout':
    case 'negotiation_failed':
    case 'transport_closed': return 'Could not open a direct connection to that machine.';
    case 'relay_unreachable': return 'Could not reach the relay. Check your connection.';
    case 'pairing_exchange_timeout': return 'The machine stopped answering during pairing. Try again.';
    case 'untrusted_device':
    case 'revoked':
    case 'trust_failed': return 'That machine no longer trusts this phone. Pair again.';
    case 'link_lost': return 'Connection lost.';
    case 'busy': return 'That machine is busy pairing another device. Try again.';
    case 'attempts_exceeded':
    case 'code_expired':
    case 'code_consumed': return 'That pair code is no longer valid. Generate a new one on the desktop.';
    default: return /offline|not_found|unknown|no_host|denied/.test(reason) ? 'That machine is not reachable right now.' : `Failed: ${reason}`;
  }
}

export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}
