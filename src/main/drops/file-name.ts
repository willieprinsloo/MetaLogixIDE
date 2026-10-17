/**
 * Allow-list naming for files staged to the drop directory (spec AC9). The
 * renderer supplies the original name, so it is treated as hostile: only its
 * basename survives, every character outside the allow-list becomes `_`,
 * leading dots go, and the length is capped while keeping the extension.
 * Timestamps are UTC so names are stable regardless of the machine's zone.
 */
import { extname } from 'node:path';

/** Longest staged file name, suffix included (spec AC9). */
export const MAX_NAME_LENGTH = 100;
const DISALLOWED = /[^A-Za-z0-9 ._()+,-]/gu;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]) *(\..*)?$/i;

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** Formats `now` as `YYYYMMDD-HHMMSS-mmm` in UTC. */
export function timestampSlug(now: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${date}-${time}-${pad(now.getUTCMilliseconds(), 3)}`;
}

/** Name for an image pasted from the clipboard: `pasted-<timestamp>.png`. */
export function pastedImageName(now: Date): string {
  return `pasted-${timestampSlug(now)}.png`;
}

/** Maps a MIME type (parameters and case ignored) to the fallback file extension. */
function extensionForMime(mime: string): string {
  const essence = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return EXTENSION_BY_MIME[essence] ?? 'bin';
}

/** Truncates `name` to the length cap, keeping its extension when the extension leaves room for a stem. */
function capLength(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) return name;
  const ext = extname(name);
  if (ext.length === 0 || ext.length >= MAX_NAME_LENGTH) return name.slice(0, MAX_NAME_LENGTH);
  return name.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** On Windows, prefixes `_` to a reserved device stem (CON, NUL, COM1, ...) so `open` never reaches a device. */
function avoidDeviceName(name: string, platform: string): string {
  return platform === 'win32' && WINDOWS_DEVICE_NAME.test(name) ? `_${name}` : name;
}

/**
 * Derives a safe on-disk file name from a renderer-supplied `name`. Only `/`
 * separates path segments; a backslash is just another disallowed character.
 * On `platform` win32, reserved device names are prefixed with `_`. When
 * nothing survives, returns `dropped-<timestamp>.<ext>` with the extension
 * taken from `mime` and the timestamp from `now`.
 */
export function safeFileName(
  name: string,
  mime: string,
  now: Date,
  platform: string = process.platform,
): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const stripped = base.replace(DISALLOWED, '_').replace(/^\.+/, '');
  const cleaned = capLength(avoidDeviceName(stripped, platform));
  return cleaned.length > 0 ? cleaned : `dropped-${timestampSlug(now)}.${extensionForMime(mime)}`;
}
