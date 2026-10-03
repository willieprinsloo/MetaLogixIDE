import { describe, it, expect } from 'vitest';
import { viewedShellsFor, type ViewedShellsInput } from '@renderer/viewed-shells';

const base: ViewedShellsInput = {
  selectedProjectId: 1,
  mainTab: 'shell',
  activeShellIndex: 0,
  rightShellIndex: null,
};

describe('viewedShellsFor', () => {
  it('returns empty when no project is selected', () => {
    expect(viewedShellsFor({ ...base, selectedProjectId: null })).toEqual([]);
  });

  it('returns empty when the Files tab is showing', () => {
    expect(viewedShellsFor({ ...base, mainTab: 'files' })).toEqual([]);
  });

  it('returns empty when the Env tab is showing', () => {
    expect(viewedShellsFor({ ...base, mainTab: 'env', rightShellIndex: 2 })).toEqual([]);
  });

  it('returns the active shell when no split is open', () => {
    expect(viewedShellsFor(base)).toEqual([{ projectId: 1, shellIndex: 0 }]);
  });

  it('returns the active shell plus the right split pane', () => {
    expect(viewedShellsFor({ ...base, activeShellIndex: 0, rightShellIndex: 2 })).toEqual([
      { projectId: 1, shellIndex: 0 },
      { projectId: 1, shellIndex: 2 },
    ]);
  });

  it('dedupes when the right pane equals the active shell', () => {
    expect(viewedShellsFor({ ...base, activeShellIndex: 1, rightShellIndex: 1 })).toEqual([
      { projectId: 1, shellIndex: 1 },
    ]);
  });
});
