import { describe, expect, it } from 'vitest';
import {
  STORED_SECRET_PREFIX,
  decodeStoredSecret,
  encodeStoredSecret,
} from '@main/credential-encoding';

const SAFE = /^b64v1:[A-Za-z0-9+/=]*$/;

/** Mimics plaintext gnome-keyring: written raw, read back through g_key_file_get_string's unescape. */
function gnomeRoundTrip(value: string): string {
  return value.replace(/\\([nrts\\])/g, (_match, code: string) =>
    code === 'n' ? '\n' : code === 'r' ? '\r' : code === 't' ? '\t' : code === 's' ? ' ' : '\\',
  );
}

describe('stored secret encoding', () => {
  const samples = [
    '',
    'plain',
    'pass\\word\\n',
    'line\nbreak\r\n\ttab',
    JSON.stringify({ cert: '-----BEGIN-----\nAAA\n-----END-----\n', key: 'k\n' }),
    'ünïcödé 🔑 \u0000 \u001f',
  ];

  it('round-trips arbitrary text, including backslashes, control characters and unicode', () => {
    for (const text of samples) {
      const stored = encodeStoredSecret(text);
      expect(decodeStoredSecret(stored), JSON.stringify(text)).toEqual({ text, legacy: false });
    }
  });

  it('produces only the prefix and base64 characters, so the gnome-keyring round-trip is lossless', () => {
    for (const text of samples) {
      const stored = encodeStoredSecret(text);
      expect(stored).toMatch(SAFE);
      expect(stored.startsWith(STORED_SECRET_PREFIX)).toBe(true);
      expect(gnomeRoundTrip(stored)).toBe(stored);
      expect(decodeStoredSecret(gnomeRoundTrip(stored)).text).toBe(text);
    }
  });

  it('encodes as the prefix followed by standard base64 of the UTF-8 bytes', () => {
    expect(encodeStoredSecret('hunter2')).toBe(
      `${STORED_SECRET_PREFIX}${Buffer.from('hunter2', 'utf8').toString('base64')}`,
    );
  });

  it('passes unprefixed values through unchanged as legacy', () => {
    for (const legacy of [
      'hunter2',
      'pass\\word',
      '{"cert":"a\nb"}',
      '',
      'B64V1:aGk=',
      ' b64v1:aGk=',
    ]) {
      expect(decodeStoredSecret(legacy), legacy).toEqual({ text: legacy, legacy: true });
    }
  });

  it('throws on a prefixed value whose payload is not canonical base64', () => {
    const hostile = [
      'b64v1:!!!!',
      'b64v1:aGk',
      'b64v1:aGk=\n',
      'b64v1: aGk=',
      'b64v1:aGk=aGk=',
      'b64v1:aGl=',
      'b64v1:a===',
      'b64v1:aGVsbG8-',
      'b64v1:aGVsbG8_',
      'b64v1:=aGk',
      'b64v1:\\naGk=',
    ];
    for (const value of hostile) expect(() => decodeStoredSecret(value), value).toThrow();
  });

  it('throws on a prefixed value that decodes to invalid UTF-8', () => {
    const invalid = `${STORED_SECRET_PREFIX}${Buffer.from([0xff, 0xfe, 0xc3]).toString('base64')}`;
    expect(() => decodeStoredSecret(invalid)).toThrow();
  });

  it('never echoes the stored payload in its error message', () => {
    const value = 'b64v1:c2VjcmV0!';
    const error = (() => {
      try {
        decodeStoredSecret(value);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('c2VjcmV0');
  });
});
