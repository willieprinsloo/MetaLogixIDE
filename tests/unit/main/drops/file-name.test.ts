import { describe, it, expect } from 'vitest';
import { safeFileName, pastedImageName, timestampSlug } from '@main/drops/file-name';

const NOW = new Date(Date.UTC(2026, 9, 17, 9, 5, 7, 42));

describe('safeFileName — spec AC9 examples', () => {
  it('keeps only the basename of a traversal name', () => {
    expect(safeFileName('../../etc/passwd', 'text/plain', NOW)).toBe('passwd');
  });

  it('replaces characters outside the allow-list with underscores', () => {
    expect(safeFileName('a<b>|c.png', 'image/png', NOW)).toBe('a_b__c.png');
  });

  it('strips leading dots', () => {
    expect(safeFileName('.hidden.png', 'image/png', NOW)).toBe('hidden.png');
    expect(safeFileName('...x.png', 'image/png', NOW)).toBe('x.png');
  });

  it('caps a 300-character name at exactly 100 characters, keeping the extension', () => {
    const out = safeFileName(`${'a'.repeat(296)}.png`, 'image/png', NOW);
    expect(out).toHaveLength(100);
    expect(out.endsWith('.png')).toBe(true);
    expect(out).toBe(`${'a'.repeat(96)}.png`);
  });
});

describe('safeFileName — further allow-list rules', () => {
  it('treats a backslash as an ordinary disallowed character', () => {
    expect(safeFileName('a\\b', 'text/plain', NOW)).toBe('a_b');
  });

  it('replaces NUL and other control characters', () => {
    expect(safeFileName('a\u0000b\u001fc\u007fd\ne.txt', 'text/plain', NOW)).toBe('a_b_c_d_e.txt');
  });

  it('keeps every allow-listed character untouched', () => {
    const allowed = 'Az09 ._()+,-.png';
    expect(safeFileName(allowed, 'image/png', NOW)).toBe(allowed);
  });

  it('replaces each non-ASCII code point with a single underscore', () => {
    expect(safeFileName('café😀.png', 'image/png', NOW)).toBe('caf__.png');
  });

  it('a name whose extension is as long as the cap is truncated, never longer than 100', () => {
    const out = safeFileName(`a.${'b'.repeat(200)}`, 'text/plain', NOW);
    expect(out).toHaveLength(100);
    expect(out.startsWith('a.')).toBe(true);
  });

  it('a name of exactly 100 characters is left unchanged', () => {
    const name = `${'n'.repeat(96)}.png`;
    expect(safeFileName(name, 'image/png', NOW)).toBe(name);
  });
});

describe('safeFileName — empty-result fallback', () => {
  const cases: Array<[string, string]> = [
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg'],
    ['application/pdf', 'pdf'],
    ['text/plain', 'txt'],
    ['application/x-unknown', 'bin'],
    ['', 'bin'],
  ];

  it.each(cases)('an empty name with MIME %s gets the .%s extension', (mime, ext) => {
    expect(safeFileName('', mime, NOW)).toBe(`dropped-20261017-090507-042.${ext}`);
  });

  it('ignores MIME parameters and case', () => {
    expect(safeFileName('', 'Text/Plain; charset=utf-8', NOW)).toBe(
      'dropped-20261017-090507-042.txt',
    );
  });

  it('a name that is only dots or ends in a separator falls back', () => {
    expect(safeFileName('...', 'image/png', NOW)).toBe('dropped-20261017-090507-042.png');
    expect(safeFileName('dir/', 'image/png', NOW)).toBe('dropped-20261017-090507-042.png');
  });

  it('the timestamp comes from the injected clock', () => {
    const other = new Date(Date.UTC(1999, 0, 2, 23, 59, 58, 7));
    expect(safeFileName('', 'image/png', other)).toBe('dropped-19990102-235958-007.png');
  });
});

describe('timestampSlug and pastedImageName', () => {
  it('formats YYYYMMDD-HHMMSS-mmm in UTC', () => {
    expect(timestampSlug(NOW)).toBe('20261017-090507-042');
  });

  it('names a pasted clipboard image pasted-<ts>.png', () => {
    expect(pastedImageName(NOW)).toBe('pasted-20261017-090507-042.png');
  });
});

describe('safeFileName — Windows reserved device names', () => {
  const reserved = [
    'CON',
    'prn',
    'Aux',
    'NUL',
    'COM0',
    'com9',
    'LPT0',
    'lpt9',
    'nul.txt',
    'CON.tar.gz',
    'Com1.png',
  ];

  it.each(reserved)('prefixes %s with an underscore on win32', (name) => {
    expect(safeFileName(name, 'text/plain', NOW, 'win32')).toBe(`_${name}`);
  });

  it.each(['CONSOLE', 'nullable.txt', 'COM10', 'LPT', 'xCON', 'AUXx.png'])(
    'leaves the non-reserved name %s alone on win32',
    (name) => {
      expect(safeFileName(name, 'text/plain', NOW, 'win32')).toBe(name);
    },
  );

  it('leaves reserved names alone on POSIX', () => {
    expect(safeFileName('NUL.txt', 'text/plain', NOW, 'darwin')).toBe('NUL.txt');
    expect(safeFileName('con', 'text/plain', NOW, 'linux')).toBe('con');
  });

  it('applies the prefix after sanitising, so a traversal name is caught too', () => {
    expect(safeFileName('..\\x/../.aux.log', 'text/plain', NOW, 'win32')).toBe('_aux.log');
  });

  it('still caps a prefixed reserved name at 100 characters, keeping the extension', () => {
    const out = safeFileName(`CON.${'e'.repeat(120)}`, 'text/plain', NOW, 'win32');
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.startsWith('_CON.')).toBe(true);
  });
});
