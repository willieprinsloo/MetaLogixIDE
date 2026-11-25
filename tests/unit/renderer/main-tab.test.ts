import { describe, it, expect } from 'vitest';
import { isMainTab, visibleMainTab, MAIN_TABS } from '@renderer/main-tab';

describe('isMainTab', () => {
  it.each(['shell', 'files', 'diff', 'settings', 'activity'])('accepts the persisted tab %j', (tab) => {
    expect(isMainTab(tab)).toBe(true);
  });

  it.each([['bogus'], [null], [1], [undefined], ['Env'], ['Diff'], [['env']], ['env']])('rejects %j', (value) => {
    expect(isMainTab(value)).toBe(false);
  });
});

describe('visibleMainTab (AC9, AC10)', () => {
  it('falls back from activity to shell when the log is off', () => {
    expect(visibleMainTab('activity', false)).toBe('shell');
  });
  it('keeps activity when the log is on', () => {
    expect(visibleMainTab('activity', true)).toBe('activity');
  });
  it.each(MAIN_TABS.filter((t) => t !== 'activity'))('is the identity for %s whether on or off', (tab) => {
    expect(visibleMainTab(tab, true)).toBe(tab);
    expect(visibleMainTab(tab, false)).toBe(tab);
  });
});
