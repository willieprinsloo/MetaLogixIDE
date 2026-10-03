import { describe, it, expect } from 'vitest';
import { isMainTab } from '@renderer/main-tab';

describe('isMainTab', () => {
  it.each(['shell', 'files', 'env'])('accepts the persisted tab %j', (tab) => {
    expect(isMainTab(tab)).toBe(true);
  });

  it.each([['bogus'], [null], [1], [undefined], ['Env'], [['env']]])('rejects %j', (value) => {
    expect(isMainTab(value)).toBe(false);
  });
});
