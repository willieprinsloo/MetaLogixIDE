import { describe, expect, it } from 'vitest';
import { classifyClaudeScreen, claudeInputHasDraft } from '@main/agent-status/claude-screen';

describe('Claude live-screen authority', () => {
  it('recognizes only a current known approval or question at the bottom', () => {
    expect(classifyClaudeScreen(['╭─ Claude Code', 'Allow Bash to run this command?', '❯ 1. Yes', '  2. No'])).toBe('blocked');
    expect(classifyClaudeScreen(['Claude', 'What would you like to do?', '❯ 1. Continue', '  2. Stop'])).toBe('blocked');
    expect(classifyClaudeScreen(['Allow Bash to run this command?', '❯ 1. Yes', '❯ Ready for another task'])).toBe('idle');
    expect(classifyClaudeScreen(['Allow Bash to run this command?', '❯ 1. Yes', 'unrelated shell prompt $'])).toBe('idle');
  });

  it('treats ready and ambiguous content as idle, known working UI as busy', () => {
    expect(classifyClaudeScreen(['❯ '])).toBe('idle');
    expect(classifyClaudeScreen(['✳ Thinking…', 'esc to interrupt'])).toBe('busy');
    expect(classifyClaudeScreen(['some log', 'spinner', 'what should I do?'])).toBe('idle');
    expect(classifyClaudeScreen([])).toBe('idle');
  });
  it('uses Claude title activity when live content has no working line', () => {
    expect(classifyClaudeScreen(['❯ '], '◐ Claude Code')).toBe('busy');
    expect(classifyClaudeScreen(['❯ '], '⠋ Claude Code')).toBe('busy');
    expect(classifyClaudeScreen(['❯ '], '✳ Claude Code')).toBe('idle');
  });

  it('recognizes current Claude activity before its persistent input box', () => {
    expect(classifyClaudeScreen(['✢ Reading files… (3s · ↓ 120 tokens)', '────────', '❯ '])).toBe('busy');
    expect(classifyClaudeScreen(['✢ Waiting for 2 background agents to finish', '────────', '❯ '])).toBe('busy');
    expect(classifyClaudeScreen(['❯ ', 'previous ✢ Reading files… (3s · ↓ 120 tokens)'])).toBe('idle');
  });

  it('prioritizes a live confirmation form over a working terminal title', () => {
    expect(classifyClaudeScreen(
      ['────────', 'Select permission mode', '❯ 1. Default', 'Enter to select · ↑↓ to navigate · Esc to cancel'],
      '◐ Claude Code',
    )).toBe('blocked');
  });
});

describe('claudeInputHasDraft', () => {
  it('an empty input box is not a draft', () => {
    expect(claudeInputHasDraft(['some reply', '────────', '❯ ', '────────', '  ? for shortcuts'])).toBe(false);
    expect(claudeInputHasDraft(['╭──────────╮', '│ >        │', '╰──────────╯'])).toBe(false);
  });

  it('text after the prompt marker is a draft', () => {
    expect(claudeInputHasDraft(['────────', '❯ fix the tests', '────────'])).toBe(true);
    expect(claudeInputHasDraft(['╭──────────╮', '│ > fix the tests │', '╰──────────╯'])).toBe(true);
  });

  it('the placeholder hint is not a draft', () => {
    expect(claudeInputHasDraft(['────────', '❯ Try "refactor foo.ts"', '────────'])).toBe(false);
    expect(claudeInputHasDraft(['│ > Try "refactor foo.ts" │'])).toBe(false);
  });

  it('uses the last prompt row, not an earlier prompt echoed in the history', () => {
    expect(claudeInputHasDraft(['> my earlier question', 'Claude answered', '────────', '❯ ', '────────'])).toBe(false);
  });

  it('an unknown screen is not a draft', () => {
    expect(claudeInputHasDraft([])).toBe(false);
    expect(claudeInputHasDraft(['just output', 'more output'])).toBe(false);
  });
});
