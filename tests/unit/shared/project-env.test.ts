import { describe, it, expect } from 'vitest';
import {
  envNameProblem,
  envValueProblem,
  parseProjectEnv,
  parseAppEnv,
  MAX_ENV_NAME_LENGTH,
} from '@shared/project-env';

describe('envNameProblem', () => {
  it.each([
    '_A',
    'a1',
    'A',
    '_',
    'API_URL',
    'PATH',
    'x'.repeat(MAX_ENV_NAME_LENGTH),
    'METAIDE',
    'XMETAIDE_A',
  ])('accepts %j', (name) => {
    expect(envNameProblem(name)).toBeNull();
  });

  it.each(['1FOO', 'MY-VAR', '', ' A', 'A ', 'A=B', 'A.B', 'ÄB', 'A\nB', 'A\0'])(
    'rejects %j as invalid',
    (name) => {
      expect(envNameProblem(name)).toBe('invalid');
    },
  );

  it('accepts exactly 255 characters and rejects 256 as too-long', () => {
    expect(MAX_ENV_NAME_LENGTH).toBe(255);
    expect(envNameProblem('A'.repeat(255))).toBeNull();
    expect(envNameProblem('A'.repeat(256))).toBe('too-long');
  });

  it.each([
    'METAIDE_X',
    'METAIDE_',
    'metaide_hook_token',
    'MetaIde_Hook_Shell',
    'METAIDE_HOOK_TOKEN',
    '__proto__',
  ])('rejects %j as reserved', (name) => {
    expect(envNameProblem(name)).toBe('reserved');
  });

  it.each(['__PROTO__', '__Proto__', '__proto', 'proto__', '__proto___', 'constructor'])(
    'accepts %j (only the exact __proto__ is reserved)',
    (name) => {
      expect(envNameProblem(name)).toBeNull();
    },
  );
});

describe('envValueProblem', () => {
  it.each(['', 'plain', 'with space', '${env.PATH}:x', 'ünïcode', 'line\nbreak'])(
    'accepts %j',
    (value) => {
      expect(envValueProblem(value)).toBeNull();
    },
  );

  it.each(['\0', 'a\0b', 'trailing\0'])('rejects %j as nul', (value) => {
    expect(envValueProblem(value)).toBe('nul');
  });
});

describe('parseProjectEnv', () => {
  it('accepts a valid map and returns it with insertion order', () => {
    const res = parseProjectEnv({ B: '2', A: '', _C: '${env.PATH}' });
    expect(res).toEqual({ ok: true, env: { B: '2', A: '', _C: '${env.PATH}' } });
    expect(res.ok && Object.keys(res.env)).toEqual(['B', 'A', '_C']);
  });

  it('accepts an empty map', () => {
    expect(parseProjectEnv({})).toEqual({ ok: true, env: {} });
  });

  it('returns a copy, not the caller object', () => {
    const input = { A: '1' };
    const res = parseProjectEnv(input);
    expect(res.ok && res.env).not.toBe(input);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'A=1'],
    ['a number', 42],
    ['an array', [['A', '1']]],
    ['an empty array', []],
    ['a function', () => ({})],
    ['a Map', new Map([['A', '1']])],
    ['a Date', new Date()],
  ])('rejects %s', (_label, input) => {
    const res = parseProjectEnv(input);
    expect(res.ok).toBe(false);
  });

  it.each([
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', { v: 'x' }],
    ['an array', ['x']],
    ['a boolean', true],
  ])('rejects a value that is %s and names the key', (_label, value) => {
    const res = parseProjectEnv({ GOOD: 'ok', BAD_KEY: value });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('BAD_KEY');
  });

  it.each([
    ['invalid', 'MY-VAR'],
    ['leading digit', '1FOO'],
    ['reserved', 'metaide_hook_token'],
    ['too long', 'A'.repeat(256)],
  ])('rejects a %s name and names the key', (_label, name) => {
    const res = parseProjectEnv({ [name]: 'S3CRET' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(name);
  });

  it('rejects an empty-string key', () => {
    expect(parseProjectEnv({ '': 'x' }).ok).toBe(false);
  });

  it('rejects a value containing NUL and names the key', () => {
    const res = parseProjectEnv({ TOKEN: 'S3CRET\0tail' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('TOKEN');
  });

  it.each([
    ['bad name', { 'MY-VAR': 'S3CRET-VALUE' }],
    ['reserved name', { METAIDE_HOOK_TOKEN: 'S3CRET-VALUE' }],
    ['NUL value', { TOKEN: 'S3CRET-VALUE\0' }],
    ['non-string value', { TOKEN: { nested: 'S3CRET-VALUE' } }],
    ['non-string array value', { TOKEN: ['S3CRET-VALUE'] }],
  ])('AC17 — error for a %s never contains the value', (_label, input) => {
    const res = parseProjectEnv(input);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).not.toContain('S3CRET');
  });

  it('reports the first offending key when several are bad', () => {
    const res = parseProjectEnv({ OK: '1', 'FIRST-BAD': '2', 'SECOND-BAD': '3' });
    expect(!res.ok && res.error).toContain('FIRST-BAD');
  });

  it('rejects an object with a custom prototype', () => {
    const input = Object.create({ A: 'x' }) as Record<string, string>;
    input.B = '1';
    expect(parseProjectEnv(input).ok).toBe(false);
  });

  it('accepts a null-prototype object', () => {
    const input = Object.create(null) as Record<string, string>;
    input.A = '1';
    expect(parseProjectEnv(input)).toEqual({ ok: true, env: { A: '1' } });
  });

  it('rejects an own __proto__ key as reserved, naming the key and never the value', () => {
    const res = parseProjectEnv(JSON.parse('{"__proto__": "S3CRET", "A": "1"}') as unknown);
    expect(res.ok).toBe(false);
    const error = res.ok ? '' : res.error;
    expect(error).toContain('__proto__');
    expect(error).toContain('reserved');
    expect(error).not.toContain('S3CRET');
  });
});

describe('parseAppEnv', () => {
  it('accepts a valid map and returns it with insertion order', () => {
    const res = parseAppEnv({ B: '2', A: '', _C: '${env.PATH}' });
    expect(res).toEqual({ ok: true, env: { B: '2', A: '', _C: '${env.PATH}' } });
    expect(res.ok && Object.keys(res.env)).toEqual(['B', 'A', '_C']);
  });

  it('accepts an empty map', () => {
    expect(parseAppEnv({})).toEqual({ ok: true, env: {} });
  });

  it('rejects a non-object input, naming it an app environment', () => {
    const res = parseAppEnv(null);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toBe(
      'App environment must be an object of name/value strings',
    );
  });

  it.each([
    ['invalid', 'MY-VAR'],
    ['leading digit', '1FOO'],
    ['reserved', 'metaide_hook_token'],
    ['reserved __proto__', '__proto__'],
    ['too long', 'A'.repeat(256)],
  ])('rejects a %s name, naming the key as an app environment variable', (_label, name) => {
    const res = parseAppEnv({ [name]: 'S3CRET' });
    expect(res.ok).toBe(false);
    const error = !res.ok ? res.error : '';
    expect(error).toContain('Invalid app environment variable');
    expect(error).toContain(name);
    expect(error).not.toContain('S3CRET');
  });

  it('rejects a NUL value and names the key, never the value', () => {
    const res = parseAppEnv({ TOKEN: 'S3CRET\0tail' });
    expect(res.ok).toBe(false);
    const error = !res.ok ? res.error : '';
    expect(error).toContain('TOKEN');
    expect(error).not.toContain('S3CRET');
  });

  it('rejects a non-string value', () => {
    const res = parseAppEnv({ GOOD: 'ok', BAD_KEY: { nested: 'x' } });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('BAD_KEY');
  });

  it('rejects an array input', () => {
    expect(parseAppEnv(['A', '1']).ok).toBe(false);
  });

  it('rejects an object with a custom prototype', () => {
    const input = Object.create({ A: 'x' }) as Record<string, string>;
    input.B = '1';
    expect(parseAppEnv(input).ok).toBe(false);
  });

  it('accepts a null-prototype object', () => {
    const input = Object.create(null) as Record<string, string>;
    input.A = '1';
    expect(parseAppEnv(input)).toEqual({ ok: true, env: { A: '1' } });
  });

  it('message text differs from parseProjectEnv for the same bad input', () => {
    const project = parseProjectEnv({ 'MY-VAR': 'x' });
    const app = parseAppEnv({ 'MY-VAR': 'x' });
    expect(project.ok).toBe(false);
    expect(app.ok).toBe(false);
    expect(!project.ok && project.error).toContain('project environment variable');
    expect(!app.ok && app.error).toContain('app environment variable');
    expect(!project.ok && project.error).not.toBe(!app.ok && app.error);
  });
});
