import { describe, it, expect } from 'vitest';
import { interpolateArgv, interpolateEnv } from '@shared/interpolate';

const ctx = { home: '/Users/w', projectPath: '/r/p', projectName: 'p', env: { FOO: 'bar' } };

describe('interpolateArgv', () => {
  it('substitutes HOME, PROJECT_PATH, PROJECT_NAME', () => {
    expect(interpolateArgv(['${HOME}/x', '--path=${PROJECT_PATH}', '--name=${PROJECT_NAME}'], ctx))
      .toEqual(['/Users/w/x', '--path=/r/p', '--name=p']);
  });
  it('substitutes ${env.X}', () => {
    expect(interpolateArgv(['--foo=${env.FOO}'], ctx)).toEqual(['--foo=bar']);
  });
  it('missing env var interpolates to empty string', () => {
    expect(interpolateArgv(['${env.MISSING}'], ctx)).toEqual(['']);
  });
  it('never splits into new argv elements even if substitution contains spaces', () => {
    const c = { ...ctx, env: { PATH: 'a b c' } };
    expect(interpolateArgv(['${env.PATH}'], c)).toEqual(['a b c']);
    expect(interpolateArgv(['${env.PATH}'], c)).toHaveLength(1);
  });
});

describe('interpolateEnv', () => {
  it('substitutes recursively but keeps keys intact', () => {
    expect(interpolateEnv({ CFG: '${HOME}/.cfg' }, ctx)).toEqual({ CFG: '/Users/w/.cfg' });
  });
});
