/**
 * Contract tests for `testModeDropDir`: the E2E-only drop directory override
 * that keeps test launches out of the real per-user drop directory.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { testModeDropDir } from '@main/drops/staging';

const userData = '/isolated/user-data';

describe('testModeDropDir', () => {
  it('returns METAIDE_DROP_DIR in test mode when it is set', () => {
    const env = { METAIDE_TEST_MODE: '1', METAIDE_DROP_DIR: '/custom/drops' };
    expect(testModeDropDir(env, userData)).toBe('/custom/drops');
  });

  it('falls back to <userData>/drops in test mode when METAIDE_DROP_DIR is unset', () => {
    expect(testModeDropDir({ METAIDE_TEST_MODE: '1' }, userData)).toBe(join(userData, 'drops'));
  });

  it('treats an empty METAIDE_DROP_DIR as unset in test mode', () => {
    const env = { METAIDE_TEST_MODE: '1', METAIDE_DROP_DIR: '' };
    expect(testModeDropDir(env, userData)).toBe(join(userData, 'drops'));
  });

  it('returns undefined outside test mode even when METAIDE_DROP_DIR is set', () => {
    expect(testModeDropDir({ METAIDE_DROP_DIR: '/custom/drops' }, userData)).toBeUndefined();
  });

  it('returns undefined for an empty environment', () => {
    expect(testModeDropDir({}, userData)).toBeUndefined();
  });

  it.each(['0', 'true', 'yes', '', ' 1'])('treats METAIDE_TEST_MODE=%j as not test mode', (value) => {
    const env = { METAIDE_TEST_MODE: value, METAIDE_DROP_DIR: '/custom/drops' };
    expect(testModeDropDir(env, userData)).toBeUndefined();
  });
});
