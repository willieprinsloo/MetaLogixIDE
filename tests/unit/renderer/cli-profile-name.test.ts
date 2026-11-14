import { describe, expect, it } from 'vitest';
import { deriveProfileName } from '@renderer/cli-profile-name';

describe('deriveProfileName', () => {
  it('derives from the first token', () => {
    expect(deriveProfileName('ollama launch claude --model x', [])).toBe('ollama');
  });
  it('takes the basename of a path-like first token', () => {
    expect(deriveProfileName('/usr/local/bin/llama chat', [])).toBe('llama');
  });
  it('dedupes against existing profile names', () => {
    expect(deriveProfileName('ollama launch', ['ollama', 'ollama-2'])).toBe('ollama-3');
  });
  it('falls back to cmd for empty input', () => {
    expect(deriveProfileName('   ', [])).toBe('cmd');
  });
});
