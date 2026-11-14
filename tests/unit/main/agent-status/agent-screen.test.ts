import { describe, expect, it } from 'vitest';
import { classifyAgentScreen } from '@main/agent-status/agent-screen';

describe('classifyAgentScreen — Codex', () => {
  it('reads the working status line as busy', () => {
    expect(classifyAgentScreen('codex', ['› fix the tests', '', '• Working (12s • esc to interrupt)', '› ', '  100% context left'])).toBe('busy');
  });
  it('reads an approval modal as blocked', () => {
    const rows = [
      'Would you like to run the following command?',
      '  $ pnpm test',
      '› 1. Yes, proceed (y)',
      '  2. No, and tell Codex what to do differently (esc)',
      'Press enter to confirm or esc to cancel',
    ];
    expect(classifyAgentScreen('codex', rows)).toBe('blocked');
  });
  it('treats a quiet prompt as idle, and ignores markers scrolled into history', () => {
    expect(classifyAgentScreen('codex', ['› ', '  100% context left'])).toBe('idle');
    const old = ['• Working (3s • esc to interrupt)', ...Array.from({ length: 20 }, (_, i) => `line ${i}`), '› '];
    expect(classifyAgentScreen('codex', old)).toBe('idle');
  });
  it('a question without answer choices is not blocked', () => {
    expect(classifyAgentScreen('codex', ['Would you like to run the following command? (approved)'])).toBe('idle');
  });
});

describe('classifyAgentScreen — opencode', () => {
  it('reads the interrupt footer as busy', () => {
    expect(classifyAgentScreen('opencode', ['  Build  claude-sonnet', '  ⠋ esc interrupt'])).toBe('busy');
    expect(classifyAgentScreen('opencode', ['  esc again to interrupt'])).toBe('busy');
  });
  it('reads a permission prompt as blocked', () => {
    expect(classifyAgentScreen('opencode', ['△ Permission required', '  $ rm -rf build', '  Allow once   Always allow   Reject'])).toBe('blocked');
  });
  it('is idle otherwise', () => {
    expect(classifyAgentScreen('opencode', ['  Ask anything…', '  tab agents  ctrl+p commands'])).toBe('idle');
  });
});

describe('classifyAgentScreen — Claude', () => {
  it('delegates to the Claude classifier', () => {
    expect(classifyAgentScreen('claude', ['✻ Thinking…', 'esc to interrupt'])).toBe('busy');
  });
});
