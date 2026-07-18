import { describe, it, expect } from 'vitest';
import { parseArgv } from '@shared/parse-argv';

describe('parseArgv', () => {
  it('splits on whitespace', () => {
    expect(parseArgv('claude --skip-perm')).toEqual(['claude', '--skip-perm']);
  });

  it('collapses multiple spaces and tabs', () => {
    expect(parseArgv('  claude   --a\t--b  ')).toEqual(['claude', '--a', '--b']);
  });

  it('respects double quotes', () => {
    expect(parseArgv('run "hello world"')).toEqual(['run', 'hello world']);
  });

  it('respects single quotes', () => {
    expect(parseArgv("run 'hello world'")).toEqual(['run', 'hello world']);
  });

  it('mixes quoted and unquoted args', () => {
    expect(parseArgv('run "a b" c "d e"')).toEqual(['run', 'a b', 'c', 'd e']);
  });

  it('preserves interpolation tokens verbatim', () => {
    expect(parseArgv('claude --cwd ${PROJECT_PATH}')).toEqual(['claude', '--cwd', '${PROJECT_PATH}']);
  });

  it('tolerates unbalanced quotes (literal tail)', () => {
    expect(parseArgv('run "unterminated')).toEqual(['run', 'unterminated']);
  });

  it('returns empty array for empty input', () => {
    expect(parseArgv('')).toEqual([]);
    expect(parseArgv('   ')).toEqual([]);
  });

  it('does not interpret env expansion (no shell semantics)', () => {
    // These stay literal — no $VAR expansion, no `command`, no globs.
    expect(parseArgv('echo $HOME')).toEqual(['echo', '$HOME']);
    expect(parseArgv('ls *.md')).toEqual(['ls', '*.md']);
  });

  it('handles adjacent quoted+unquoted segments', () => {
    // Concatenation isn't supported (would need shell-like behavior);
    // token boundaries are: whitespace between argv elements.
    // Our simplified parser treats "ab""cd" as two tokens joined into
    // the current buffer without whitespace — this locks in that behavior.
    expect(parseArgv('"ab""cd"')).toEqual(['abcd']);
  });
});
