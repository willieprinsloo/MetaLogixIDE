/** StatusBar port chips follow the "Show ports in the status bar" setting; GeneralPanel loads it with default ON. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project } from '@shared/types';

const mocks = vi.hoisted(() => ({
  show: true,
  settings: {} as Record<string, unknown>,
  usePorts: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn(async (_c: string, req?: { key?: string }) => ({ value: req?.key ? mocks.settings[req.key] : undefined })),
    on: vi.fn(() => () => undefined),
  },
}));
vi.mock('@renderer/hooks/useShowStatusBarPorts', () => ({ useShowStatusBarPorts: () => mocks.show }));
vi.mock('@renderer/hooks/usePorts', () => ({
  usePorts: (id: number | null, enabled: boolean) => { mocks.usePorts(id, enabled); return enabled ? [3000, 5173] : []; },
}));

const { StatusBar } = await import('@renderer/components/StatusBar');
const { loadBoard } = await import('@renderer/components/settings/GeneralPanel');

const project: Project = {
  id: 7, rootId: 1, name: 'demo', path: '/p/demo', config: {},
  metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null,
  pinned: false, hidden: false, firstLaunchedAt: null,
};
const render = () => renderToStaticMarkup(<StatusBar project={project} aliveCount={0} onOpenPalette={() => undefined} />);

beforeEach(() => { mocks.show = true; mocks.settings = {}; mocks.usePorts.mockClear(); });

describe('StatusBar ports setting', () => {
  it('renders a chip per port when the setting is on', () => {
    const html = render();
    expect(html).toContain('data-testid="port-chip-3000"');
    expect(html).toContain('data-testid="port-chip-5173"');
    expect(mocks.usePorts).toHaveBeenCalledWith(7, true);
  });

  it('renders no chips and disables port polling when the setting is off', () => {
    mocks.show = false;
    const html = render();
    expect(html).not.toContain('port-chip-');
    expect(html).not.toContain('>ports<');
    expect(mocks.usePorts).toHaveBeenCalledWith(7, false);
  });
});

describe('GeneralPanel board load of show_status_bar_ports', () => {
  it('defaults to on when unset', async () => {
    expect((await loadBoard()).showPorts).toBe(true);
  });
  it('reads a stored false', async () => {
    mocks.settings = { show_status_bar_ports: false };
    expect((await loadBoard()).showPorts).toBe(false);
  });
});
