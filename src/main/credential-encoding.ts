/**
 * Encoding for values stored in the OS credential store through keytar.
 *
 * Plaintext gnome-keyring writes a secret raw but unescapes `\n` and `\\` when it
 * reads it back, so any stored value containing a backslash or control character
 * does not round-trip and can break the keyring file. Stored values are therefore
 * base64 behind a version prefix.
 */

/** Prefix that marks a value written by {@link encodeStoredSecret}. */
export const STORED_SECRET_PREFIX = 'b64v1:';

/** Result of decoding a stored value; `legacy` is true when the value predates the encoding. */
export interface DecodedStoredSecret {
  readonly text: string;
  readonly legacy: boolean;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Encodes text into a form containing only the prefix and base64 characters. */
export function encodeStoredSecret(text: string): string {
  return `${STORED_SECRET_PREFIX}${Buffer.from(text, 'utf8').toString('base64')}`;
}

/**
 * Decodes a stored value; unprefixed values pass through as legacy. A prefixed value
 * whose payload is not canonical base64 of valid UTF-8 throws, without echoing the payload.
 */
export function decodeStoredSecret(stored: string): DecodedStoredSecret {
  if (!stored.startsWith(STORED_SECRET_PREFIX)) return { text: stored, legacy: true };
  const payload = stored.slice(STORED_SECRET_PREFIX.length);
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.toString('base64') !== payload) throw new Error('Stored secret is not valid base64');
  try {
    return { text: UTF8.decode(bytes), legacy: false };
  } catch (cause) {
    throw new Error('Stored secret is not valid UTF-8', { cause });
  }
}
