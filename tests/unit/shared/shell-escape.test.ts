import { describe, it, expect } from 'vitest';
import { escapePath, joinEscapedPaths, pathStyleFor } from '@shared/shell-escape';

const POSIX_SPECIAL = [
  '\\',
  ' ',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  '"',
  "'",
  '`',
  '!',
  '#',
  '$',
  '&',
  ';',
  '|',
  '*',
  '?',
];

describe('escapePath posix (AC3)', () => {
  it.each(POSIX_SPECIAL)('backslash-escapes %j', (ch) => {
    expect(escapePath(`/a/x${ch}y`, 'posix')).toBe(`/a/x\\${ch}y`);
  });

  it('escapes the spec example with spaces and parentheses', () => {
    expect(escapePath('/a/My Screen (1).png', 'posix')).toBe('/a/My\\ Screen\\ \\(1\\).png');
  });

  it("escapes a single quote as \\'", () => {
    expect(escapePath("it's", 'posix')).toBe("it\\'s");
  });

  it('leaves ordinary path characters bare', () => {
    expect(escapePath('/Users/me/src/app-1_2.ts~', 'posix')).toBe('/Users/me/src/app-1_2.ts~');
  });

  it('escapes every occurrence, including repeated specials', () => {
    expect(escapePath('a  b', 'posix')).toBe('a\\ \\ b');
  });
});

describe('escapePath control characters (AC3a)', () => {
  it('turns an LF inside a path into an escaped space, never a newline', () => {
    const out = escapePath('/a/x\nrm -rf ~.png', 'posix');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('/a/x\\ rm\\ -rf\\ ~.png');
  });

  it('turns CR into an escaped space', () => {
    expect(escapePath('/a/x\ry', 'posix')).toBe('/a/x\\ y');
  });

  it.each([0x00, 0x01, 0x09, 0x1b, 0x1f, 0x7f])('neutralises 0x%s before escaping', (code) => {
    const out = escapePath(`/a/x${String.fromCharCode(code)}y`, 'posix');
    expect(out).toBe('/a/x\\ y');
  });

  it.each(['0080', '009b', '009d', '009f'])(
    'neutralises C1 control U+%s before escaping',
    (hex) => {
      const code = parseInt(hex, 16);
      expect(escapePath(`/a/x${String.fromCharCode(code)}y`, 'posix')).toBe('/a/x\\ y');
    },
  );

  it('keeps NBSP and other non-ASCII characters in a path', () => {
    expect(escapePath('/a/\u00a0\u00e9\u65e5', 'posix')).toBe('/a/\u00a0\u00e9\u65e5');
  });

  it('neutralises control characters in Windows paths too', () => {
    const out = escapePath('C:\\a\nb', 'windows');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('"C:\\a b"');
  });
});

describe('escapePath windows (AC5)', () => {
  it.each([' ', '&', '(', ')', '^', ';', ',', '='])('double-quotes a path containing %j', (ch) => {
    expect(escapePath(`C:\\a\\x${ch}y.png`, 'windows')).toBe(`"C:\\a\\x${ch}y.png"`);
  });

  it('inserts a path with no special characters bare and never escapes backslashes', () => {
    expect(escapePath('C:\\Users\\me\\shot.png', 'windows')).toBe('C:\\Users\\me\\shot.png');
  });

  it('does not backslash-escape POSIX specials on Windows', () => {
    expect(escapePath("C:\\it's[1]", 'windows')).toBe("C:\\it's[1]");
  });
});

describe('pathStyleFor', () => {
  it('maps win32 to windows', () => {
    expect(pathStyleFor('win32')).toBe('windows');
  });

  it.each(['darwin', 'linux', 'freebsd', ''])('maps %j to posix', (platform) => {
    expect(pathStyleFor(platform)).toBe('posix');
  });
});

describe('joinEscapedPaths (AC4)', () => {
  it('escapes each path and joins with exactly one space', () => {
    expect(joinEscapedPaths(['/a b', '/c', '/d(e)'], 'posix')).toBe('/a\\ b /c /d\\(e\\)');
  });

  it('has no leading or trailing space for a single path', () => {
    expect(joinEscapedPaths(['/a'], 'posix')).toBe('/a');
  });

  it('returns an empty string for an empty list', () => {
    expect(joinEscapedPaths([], 'posix')).toBe('');
  });

  it('applies the requested style', () => {
    expect(joinEscapedPaths(['C:\\a b', 'C:\\c'], 'windows')).toBe('"C:\\a b" C:\\c');
  });
});
