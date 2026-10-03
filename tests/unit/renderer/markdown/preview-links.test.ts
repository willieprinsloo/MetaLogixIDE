import { describe, expect, it } from 'vitest';
import { resolvePreviewLink } from '@renderer/markdown/previewLinks';

describe('resolvePreviewLink', () => {
  it.each([
    'http://example.com/a',
    'https://example.com/a?b=1#c',
    'HTTPS://EXAMPLE.COM',
    'mailto:someone@example.com',
    'file:///Users/me/notes.md',
  ])('opens %s externally when outside a diagram', (href) => {
    expect(resolvePreviewLink(href, false)).toEqual({ kind: 'external', url: href });
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:window.__pwned=1',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'ftp://example.com',
    './other.md',
    'other.md',
    '/abs/path',
    '#heading',
    '',
    'xhttps://example.com',
  ])('ignores %j outside a diagram', (href) => {
    expect(resolvePreviewLink(href, false)).toEqual({ kind: 'ignore' });
  });

  it('ignores a missing href', () => {
    expect(resolvePreviewLink(null, false)).toEqual({ kind: 'ignore' });
    expect(resolvePreviewLink(null, true)).toEqual({ kind: 'ignore' });
  });

  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:a@b.c',
    'file:///etc/passwd',
    'javascript:window.__pwned=1',
    '#frag',
  ])('ignores %s inside a diagram', (href) => {
    expect(resolvePreviewLink(href, true)).toEqual({ kind: 'ignore' });
  });
});
