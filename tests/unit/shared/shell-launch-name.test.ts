import { describe, expect, test } from 'vitest';
import { shellLaunchName, shellTabName } from '../../../src/shared/shell-launch-name';

describe('shellLaunchName', () => {
  test.each([
    [['/usr/local/bin/claude', '--continue'], 0, 'Claude'],
    [['opencode'], 1, 'Opencode'],
    [['$SHELL'], 1, 'Terminal'],
    [['/bin/zsh', '-l'], 2, 'Terminal'],
    [['fish'], 2, 'Terminal'],
    [[], 4, 'Shell 4'],
    [null, 5, 'Shell 5'],
    [undefined, 6, 'Shell 6'],
  ] as const)('%j at %i is "%s"', (argv, index, label) => {
    expect(shellLaunchName(argv, index)).toBe(label);
  });
});

describe('shellTabName', () => {
  test('an agent started by hand in a terminal names the tab', () => {
    expect(shellTabName(['$SHELL'], 1, 'opencode')).toBe('opencode');
    expect(shellTabName(['/bin/zsh'], 1, 'claude')).toBe('Claude');
  });
  test('a shell launched as the agent it runs keeps its launch name', () => {
    expect(shellTabName(['opencode'], 1, 'opencode')).toBe('Opencode');
    expect(shellTabName(['/opt/bin/claude'], 0, 'claude')).toBe('Claude');
  });
  test('no detected agent leaves the launch name', () => {
    expect(shellTabName(['$SHELL'], 1, null)).toBe('Terminal');
    expect(shellTabName(['mytool'], 1, undefined)).toBe('Mytool');
  });
});
