import { describe, expect, test } from 'vitest';
import { buildPairLink } from '../../../src/shared/pair-link';

describe('buildPairLink', () => {
  test('carries the code and the relay', () => {
    expect(buildPairLink({ code: '921782718', relayUrl: 'remote.metalogix.solutions', relayPort: 7100 }))
      .toBe('metaide://pair?code=921782718&relay=remote.metalogix.solutions&port=7100');
  });
  test('trims and escapes, and leaves out a relay it was not given or a port that is not one', () => {
    expect(buildPairLink({ code: ' ABCD-1234 ' })).toBe('metaide://pair?code=ABCD-1234');
    expect(buildPairLink({ code: 'a b&c', relayUrl: ' my relay ', relayPort: 70000 })).toBe('metaide://pair?code=a%20b%26c&relay=my%20relay');
    expect(buildPairLink({ code: 'x', relayUrl: '  ', relayPort: 7100.5 })).toBe('metaide://pair?code=x');
  });
});
