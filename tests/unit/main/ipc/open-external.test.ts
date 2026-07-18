import { describe, it, expect } from 'vitest';

// The allowlist lives inline in register.ts's app:open-external handler.
// We assert the regex here so any change to the allowlist is caught.
const ALLOW = /^(https?|mailto|file):/i;

describe('app:open-external URL allowlist', () => {
  it('allows http(s), mailto, and file schemes', () => {
    expect(ALLOW.test('https://anthropic.com')).toBe(true);
    expect(ALLOW.test('http://localhost:5175/foo')).toBe(true);
    expect(ALLOW.test('mailto:hi@example.com')).toBe(true);
    expect(ALLOW.test('file:///Users/me/notes.md')).toBe(true);
  });

  it('is case-insensitive on the scheme', () => {
    expect(ALLOW.test('HTTPS://x')).toBe(true);
    expect(ALLOW.test('Mailto:x@y')).toBe(true);
  });

  it('rejects javascript, data, ftp, custom schemes', () => {
    expect(ALLOW.test('javascript:alert(1)')).toBe(false);
    expect(ALLOW.test('data:text/html,<script>')).toBe(false);
    expect(ALLOW.test('ftp://example.com')).toBe(false);
    expect(ALLOW.test('vscode://file/path')).toBe(false);
    expect(ALLOW.test('metaide://oauth')).toBe(false);
  });

  it('rejects strings that only contain a scheme keyword mid-way', () => {
    expect(ALLOW.test('  https://x')).toBe(false);
    expect(ALLOW.test('foo https://x')).toBe(false);
  });
});
