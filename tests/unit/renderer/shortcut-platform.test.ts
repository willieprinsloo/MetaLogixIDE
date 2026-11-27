import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toShortcutPlatform } from '@renderer/shortcut-platform';

describe('toShortcutPlatform', () => {
  it.each([
    ['darwin', 'mac'],
    ['linux', 'linux'],
    ['win32', 'win'],
    ['freebsd', 'linux'],
    [undefined, 'mac'],
  ] as const)('maps %s to %s', (node, expected) => {
    expect(toShortcutPlatform(node)).toBe(expected);
  });
});

describe('runtime platform from the preload bridge (AC8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('labels the very first render for Linux when the bridge reports linux, with no provider and no re-render', async () => {
    vi.stubGlobal('window', { api: { platform: 'linux' } });
    vi.resetModules();
    const { RUNTIME_SHORTCUT_PLATFORM } = await import('@renderer/shortcut-platform');
    const { ShortcutsHelp } = await import('@renderer/components/ShortcutsHelp');
    expect(RUNTIME_SHORTCUT_PLATFORM).toBe('linux');
    const html = renderToStaticMarkup(
      createElement(ShortcutsHelp, { open: true, onClose: () => undefined }),
    );
    expect(html).toContain('<kbd>Ctrl+K</kbd>');
    expect(html).not.toContain('⌘');
  });

  it('keeps mac glyphs on the first render when the bridge reports darwin', async () => {
    vi.stubGlobal('window', { api: { platform: 'darwin' } });
    vi.resetModules();
    const { RUNTIME_SHORTCUT_PLATFORM } = await import('@renderer/shortcut-platform');
    const { ShortcutsHelp } = await import('@renderer/components/ShortcutsHelp');
    expect(RUNTIME_SHORTCUT_PLATFORM).toBe('mac');
    const html = renderToStaticMarkup(
      createElement(ShortcutsHelp, { open: true, onClose: () => undefined }),
    );
    expect(html).toContain('<kbd>⌘K</kbd>');
  });

  it('falls back to mac when there is no bridge (node tests)', async () => {
    vi.resetModules();
    const { RUNTIME_SHORTCUT_PLATFORM } = await import('@renderer/shortcut-platform');
    expect(RUNTIME_SHORTCUT_PLATFORM).toBe('mac');
  });
});
