import { describe, it, expect, vi } from 'vitest';
import { openSafeHyperlink } from '@renderer/terminal-hyperlinks';

describe('openSafeHyperlink', () => {
  it('invokes app:open-external for http and https URLs', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    expect(openSafeHyperlink('https://example.com/a?b=1', invoke)).toBe(true);
    expect(openSafeHyperlink('http://localhost:3000', invoke)).toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(1, 'https://example.com/a?b=1');
    expect(invoke).toHaveBeenNthCalledWith(2, 'http://localhost:3000');
  });

  it('invokes for mailto: and file: (same allowlist as app:open-external)', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    expect(openSafeHyperlink('mailto:a@b.com', invoke)).toBe(true);
    expect(openSafeHyperlink('file:///tmp/x.pdf', invoke)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rejects javascript: and other unsafe schemes — never reaches IPC', () => {
    // Agents can emit arbitrary OSC-8 URLs, so the renderer must drop
    // non-allowlisted schemes before they even hit app:open-external.
    const invoke = vi.fn().mockResolvedValue(undefined);
    expect(openSafeHyperlink('javascript:alert(1)', invoke)).toBe(false);
    expect(openSafeHyperlink('data:text/html,<script>', invoke)).toBe(false);
    expect(openSafeHyperlink('vbscript:msgbox', invoke)).toBe(false);
    expect(openSafeHyperlink('', invoke)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a rejected invoke promise is logged, not thrown', async () => {
    const err = new Error('nope');
    const invoke = vi.fn().mockRejectedValue(err);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Returns synchronously even though invoke rejects in the background.
      expect(openSafeHyperlink('https://x.com', invoke)).toBe(true);
      // Flush the microtask so the .catch has a chance to run.
      await Promise.resolve();
      await Promise.resolve();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
