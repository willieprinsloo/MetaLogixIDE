import { describe, it, expect } from 'vitest';
import { buildRoster } from '@main/chat/roster';
import type { AliveShellSummary } from '@shared/types';

const localRow = (shellIndex: number, overrides: Partial<AliveShellSummary> = {}): AliveShellSummary => ({
  projectId: 1,
  shellIndex,
  model: null,
  launchArgv: [],
  startedAt: '',
  lastActiveAt: '',
  pinned: false,
  projectName: 'p',
  projectPath: '/p',
  ...overrides,
});

describe('buildRoster', () => {
  it('self first, then alphabetical device', () => {
    const r = buildRoster({
      local: [localRow(1), localRow(2)],
      remote: [
        { device: 'zeta', shells: [{ projectId: 1, shellIndex: 1, agentState: 'idle', agent: 'claude' }] },
        { device: 'alpha', shells: [{ projectId: 1, shellIndex: 1, agentState: 'busy', agent: 'codex' }] },
      ],
      agentLabels: { 1: 'claude', 2: 'codex' },
      agentStates: { 1: 'idle', 2: 'busy' },
      selfDevice: 'laptop',
    });
    expect(r.map((x) => `${x.device}#${x.shell}`)).toEqual(['laptop#1', 'laptop#2', 'alpha#1', 'zeta#1']);
  });

  it('omits shells with no agent label', () => {
    const r = buildRoster({
      local: [localRow(3)],
      remote: [],
      agentLabels: {},
      agentStates: {},
      selfDevice: 'x',
    });
    expect(r).toHaveLength(0);
  });

  it('mention is shell-qualified when the same agent appears twice on one device', () => {
    const r = buildRoster({
      local: [localRow(1), localRow(2)],
      remote: [],
      agentLabels: { 1: 'claude', 2: 'claude' },
      agentStates: {},
      selfDevice: 'x',
    });
    expect(r.map((x) => x.mention)).toEqual(['@claude#1', '@claude#2']);
  });

  it('mention is bare agent when it is unique on its device; remote appends @device', () => {
    const r = buildRoster({
      local: [localRow(1)],
      remote: [{ device: 'laptop', shells: [{ projectId: 1, shellIndex: 5, agentState: null, agent: 'codex' }] }],
      agentLabels: { 1: 'claude' },
      agentStates: {},
      selfDevice: 'self',
    });
    expect(r.map((x) => x.mention)).toEqual(['@claude', '@codex@laptop']);
  });
});
