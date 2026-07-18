import { describe, it, expect } from 'vitest';

// Mirrors both the projects:create handler and NewProjectDialog's isValidName.
function isValidName(n: string): boolean {
  return /^[A-Za-z0-9._-][A-Za-z0-9._ -]*$/.test(n) && n !== '.' && n !== '..';
}

describe('project name validation', () => {
  it('accepts normal identifiers', () => {
    expect(isValidName('metaide')).toBe(true);
    expect(isValidName('MetaIDE')).toBe(true);
    expect(isValidName('my-project')).toBe(true);
    expect(isValidName('my_project')).toBe(true);
    expect(isValidName('MyProject.v2')).toBe(true);
    expect(isValidName('project 1')).toBe(true);
    expect(isValidName('a')).toBe(true);
    expect(isValidName('1')).toBe(true);
  });

  it('rejects paths with slashes', () => {
    expect(isValidName('foo/bar')).toBe(false);
    expect(isValidName('..')).toBe(false);
    expect(isValidName('./x')).toBe(false);
    expect(isValidName('a/../b')).toBe(false);
  });

  it('rejects names starting with space or symbol', () => {
    expect(isValidName(' foo')).toBe(false);
    expect(isValidName('-hidden')).toBe(true); // hyphen start allowed (common for CLIs)
    expect(isValidName('.hidden')).toBe(true); // dotfile-style — allowed
    expect(isValidName('!bang')).toBe(false);
    expect(isValidName('@scope')).toBe(false);
  });

  it('rejects empty strings and shell-y tricks', () => {
    expect(isValidName('')).toBe(false);
    expect(isValidName('foo;rm -rf /')).toBe(false);
    expect(isValidName('foo && bar')).toBe(false);
    expect(isValidName('foo$(whoami)')).toBe(false);
  });

  it('rejects non-ASCII (keeps filesystem paths portable)', () => {
    expect(isValidName('café')).toBe(false);
    expect(isValidName('プロジェクト')).toBe(false);
  });
});
