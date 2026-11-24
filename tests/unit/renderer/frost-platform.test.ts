import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function loadModule(platform: string | undefined) {
  vi.resetModules();
  vi.stubGlobal('window', { api: { platform } });
  return import('@renderer/frost-platform');
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('RUNTIME_FROST_PLATFORM', () => {
  it.each([
    ['darwin', 'mac'],
    ['linux', 'linux'],
    ['win32', null],
    ['freebsd', null],
    [undefined, null],
  ])('maps bridge platform %s to %s', async (platform, expected) => {
    const mod = await loadModule(platform as string | undefined);
    expect(mod.RUNTIME_FROST_PLATFORM).toBe(expected);
  });

  it('is null when there is no window bridge at all', async () => {
    vi.resetModules();
    vi.stubGlobal('window', undefined);
    const mod = await import('@renderer/frost-platform');
    expect(mod.RUNTIME_FROST_PLATFORM).toBeNull();
  });
});

describe('FrostPlatformContext and useFrostPlatform', () => {
  function Probe({ useIt }: { useIt: () => unknown }) {
    return createElement('span', null, String(useIt()));
  }

  it('defaults to the runtime value', async () => {
    const mod = await loadModule('linux');
    const html = renderToStaticMarkup(createElement(Probe, { useIt: mod.useFrostPlatform }));
    expect(html).toBe('<span>linux</span>');
  });

  it('reads the provider value, including an explicit null over a mac default', async () => {
    const mod = await loadModule('darwin');
    const render = (value: 'mac' | 'linux' | null) =>
      renderToStaticMarkup(
        createElement(mod.FrostPlatformContext.Provider, { value }, createElement(Probe, { useIt: mod.useFrostPlatform })),
      );
    expect(render('linux')).toBe('<span>linux</span>');
    expect(render(null)).toBe('<span>null</span>');
  });
});
