import { describe, it, expect } from 'vitest';
import { isMainTab } from '@renderer/main-tab';

describe('isMainTab', () => {
  it.each(['shell', 'files', 'diff', 'settings', 'activity'])('accepts the persisted tab %j', (tab) => {
    expect(isMainTab(tab)).toBe(true);
  });

  it.each([['bogus'], [null], [1], [undefined], ['Env'], ['Diff'], [['env']], ['env']])('rejects %j', (value) => {
    expect(isMainTab(value)).toBe(false);
  });
});
