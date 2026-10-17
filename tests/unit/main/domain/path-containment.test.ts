import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { isInsideRoot, resolveInsideRoot } from '@main/domain/path-containment';

const root = resolve(sep, 'proj');

describe('isInsideRoot', () => {
  it('rejects a parent-relative escape', () => {
    expect(isInsideRoot(root, resolve(root, '../x'))).toBe(false);
  });

  it('rejects the parent directory itself', () => {
    expect(isInsideRoot(root, resolve(root, '..'))).toBe(false);
  });

  it('rejects a sibling whose name shares the root as a string prefix', () => {
    expect(isInsideRoot(root, resolve(sep, 'proj-evil', 'x'))).toBe(false);
    expect(isInsideRoot(root, `${root}evil`)).toBe(false);
  });

  it('keeps a child whose name merely starts with dots', () => {
    expect(isInsideRoot(root, join(root, '..config'))).toBe(true);
    expect(isInsideRoot(root, join(root, '...'))).toBe(true);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isInsideRoot(root, resolve(sep, 'etc', 'passwd'))).toBe(false);
  });

  it('accepts an absolute path below the root', () => {
    expect(isInsideRoot(root, join(root, 'src', 'a.ts'))).toBe(true);
  });

  it('counts the root itself as inside, with or without a trailing separator', () => {
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot(`${root}${sep}`, root)).toBe(true);
  });

  it('normalises an unresolved root and candidate before comparing', () => {
    expect(isInsideRoot(join(root, 'a', '..'), join(root, 'b'))).toBe(true);
    expect(isInsideRoot(root, join(root, 'a', '..', '..', 'proj-evil'))).toBe(false);
  });
});

describe('resolveInsideRoot', () => {
  it('returns the absolute path for a relative path inside the root', () => {
    expect(resolveInsideRoot(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
  });

  it('returns the root for an empty relative path', () => {
    expect(resolveInsideRoot(root, '')).toBe(root);
  });

  it('allows an absolute path that lies inside the root', () => {
    expect(resolveInsideRoot(root, join(root, 'x'))).toBe(join(root, 'x'));
  });

  it('allows a dotted child name', () => {
    expect(resolveInsideRoot(root, '..config')).toBe(join(root, '..config'));
  });

  it.each([['../x'], ['..'], ['../proj-evil/x'], ['../..']])(
    'throws "path escapes project root" for %s',
    (rel) => {
      expect(() => resolveInsideRoot(root, rel)).toThrow('path escapes project root');
    },
  );

  it('throws for an absolute path outside the root', () => {
    expect(() => resolveInsideRoot(root, resolve(sep, 'proj-evil', 'x'))).toThrow(
      'path escapes project root',
    );
  });
});
