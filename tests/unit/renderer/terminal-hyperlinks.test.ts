import { describe, it, expect, vi } from 'vitest';
import { openSafeHyperlink, type HyperlinkRouter } from '@renderer/terminal-hyperlinks';

function makeRouter(partial: Partial<HyperlinkRouter> = {}): HyperlinkRouter & {
  invokeOpenExternal: ReturnType<typeof vi.fn>;
  invokeResolveLocal: ReturnType<typeof vi.fn>;
  openInIde: ReturnType<typeof vi.fn>;
} {
  return {
    invokeOpenExternal: vi.fn().mockResolvedValue(undefined),
    invokeResolveLocal: vi.fn().mockResolvedValue({ match: null }),
    openInIde: vi.fn(),
    ...partial,
  } as HyperlinkRouter & {
    invokeOpenExternal: ReturnType<typeof vi.fn>;
    invokeResolveLocal: ReturnType<typeof vi.fn>;
    openInIde: ReturnType<typeof vi.fn>;
  };
}

describe('openSafeHyperlink', () => {
  it('invokes app:open-external for http and https URLs — never tries the local resolver for them', async () => {
    const router = makeRouter();
    await expect(openSafeHyperlink('https://example.com/a?b=1', router)).resolves.toBe(true);
    await expect(openSafeHyperlink('http://localhost:3000', router)).resolves.toBe(true);
    expect(router.invokeOpenExternal).toHaveBeenNthCalledWith(1, 'https://example.com/a?b=1');
    expect(router.invokeOpenExternal).toHaveBeenNthCalledWith(2, 'http://localhost:3000');
    expect(router.invokeResolveLocal).not.toHaveBeenCalled();
  });

  it('invokes for mailto: (allowed), still falls through open-external', async () => {
    const router = makeRouter();
    await expect(openSafeHyperlink('mailto:a@b.com', router)).resolves.toBe(true);
    expect(router.invokeOpenExternal).toHaveBeenCalledWith('mailto:a@b.com');
  });

  it('local file: URL that resolves to a project opens in the IDE Files tab and does NOT hit open-external', async () => {
    const router = makeRouter({
      invokeResolveLocal: vi.fn().mockResolvedValue({ match: { projectId: 7, relPath: 'docs/Review.html' } }),
    });
    await expect(openSafeHyperlink('file:///Users/me/projects/foo/docs/Review.html', router)).resolves.toBe(true);
    expect(router.openInIde).toHaveBeenCalledWith(7, 'docs/Review.html');
    expect(router.invokeOpenExternal).not.toHaveBeenCalled();
  });

  it('local file: URL outside every project falls back to the OS browser', async () => {
    const router = makeRouter();
    await expect(openSafeHyperlink('file:///tmp/x.pdf', router)).resolves.toBe(true);
    expect(router.invokeResolveLocal).toHaveBeenCalled();
    expect(router.openInIde).not.toHaveBeenCalled();
    expect(router.invokeOpenExternal).toHaveBeenCalledWith('file:///tmp/x.pdf');
  });

  it('bare absolute path inside a project opens in the IDE Files tab', async () => {
    const router = makeRouter({
      invokeResolveLocal: vi.fn().mockResolvedValue({ match: { projectId: 3, relPath: 'README.md' } }),
    });
    await expect(openSafeHyperlink('/Users/me/projects/foo/README.md', router)).resolves.toBe(true);
    expect(router.openInIde).toHaveBeenCalledWith(3, 'README.md');
  });

  it('rejects javascript: and other unsafe schemes — never reaches the router', async () => {
    const router = makeRouter();
    await expect(openSafeHyperlink('javascript:alert(1)', router)).resolves.toBe(false);
    await expect(openSafeHyperlink('data:text/html,<script>', router)).resolves.toBe(false);
    await expect(openSafeHyperlink('vbscript:msgbox', router)).resolves.toBe(false);
    await expect(openSafeHyperlink('', router)).resolves.toBe(false);
    expect(router.invokeOpenExternal).not.toHaveBeenCalled();
    expect(router.invokeResolveLocal).not.toHaveBeenCalled();
    expect(router.openInIde).not.toHaveBeenCalled();
  });

  it('a rejected open-external promise is logged, not thrown', async () => {
    const err = new Error('nope');
    const router = makeRouter({ invokeOpenExternal: vi.fn().mockRejectedValue(err) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(openSafeHyperlink('https://x.com', router)).resolves.toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('local-resolver failure (IPC rejected) falls through to open-external instead of throwing', async () => {
    const router = makeRouter({
      invokeResolveLocal: vi.fn().mockRejectedValue(new Error('no projects loaded')),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(openSafeHyperlink('file:///tmp/x.pdf', router)).resolves.toBe(true);
      expect(router.openInIde).not.toHaveBeenCalled();
      expect(router.invokeOpenExternal).toHaveBeenCalledWith('file:///tmp/x.pdf');
    } finally {
      consoleError.mockRestore();
    }
  });
});
