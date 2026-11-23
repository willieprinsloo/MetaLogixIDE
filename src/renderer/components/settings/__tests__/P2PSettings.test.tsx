// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@renderer/api', () => ({ api: { invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} } }));

import { P2PSettings } from '../P2PSettings';

const SETTINGS = {
  relayUrl: 'relay.example.com', relayPort: 7001, deviceName: 'My Laptop', serveEnabled: true,
  deviceFingerprint: 'one two three four five six',
};
const FLEET = [
  { deviceId: 'self-device-id', name: 'My Laptop', online: true, lastSeenAt: 1, self: true },
  { deviceId: 'tower-device-id-0123456789', name: 'Tower', online: false, lastSeenAt: null, workspaceAccess: false },
];

beforeEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockImplementation(async (ch: string) => {
    if (ch === 'p2p:settings-get') return SETTINGS;
    if (ch === 'p2p:fleet-list') return { fleet: FLEET };
    if (ch === 'p2p:pair-generate-code') return { code: 'alpha bravo charlie delta echo foxtrot', expiresAt: Date.now() + 120_000 };
    return { ok: true };
  });
});

describe('P2PSettings', () => {
  test('initial render shows device name, relay URL + port, Serve toggle', async () => {
    render(<P2PSettings />);
    expect(await screen.findByDisplayValue('My Laptop')).toBeTruthy();
    expect(screen.getByDisplayValue('relay.example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('7001')).toBeTruthy();
    expect(screen.getByText('one two three four five six')).toBeTruthy();
    expect((screen.getByRole('switch', { name: /Serve this machine/i }) as HTMLInputElement).checked).toBe(true);
  });

  test('toggling Serve this machine calls p2p:settings-set with serveEnabled false', async () => {
    render(<P2PSettings />);
    const sw = await screen.findByRole('switch', { name: /Serve this machine/i });
    await waitFor(() => expect((sw as HTMLInputElement).checked).toBe(true));
    fireEvent.click(sw);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('p2p:settings-set', { serveEnabled: false }));
  });

  test('grants and revokes access for an undialable desktop, but never shows a switch for mobile', async () => {
    const deviceId = 'offline-desktop';
    let workspaceAccess = false;
    invoke.mockImplementation(async (ch: string, req?: { deviceId: string; allowed: boolean }) => {
      if (ch === 'p2p:settings-get') return { ...SETTINGS, serveEnabled: false };
      if (ch === 'p2p:fleet-list') return {
        fleet: [
          ...FLEET,
          { deviceId, name: 'Offline Desktop', online: false, lastSeenAt: null, viewer: true, workspaceAccess },
          { deviceId: 'phone', name: 'Phone', online: false, lastSeenAt: null, viewer: true },
        ],
      };
      if (ch === 'p2p:set-workspace-access' && req?.deviceId === deviceId) workspaceAccess = req.allowed;
      return { ok: true };
    });

    render(<P2PSettings />);
    const sw = await screen.findByRole<HTMLInputElement>('switch', { name: 'Allow workspace access for Offline Desktop' });
    expect(sw.checked).toBe(false);
    expect(sw.disabled).toBe(false);
    expect(screen.queryByRole('switch', { name: 'Allow workspace access for Phone' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke Phone' })).toBeTruthy();
    fireEvent.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    await waitFor(() => expect(sw.disabled).toBe(false));
    expect(invoke).toHaveBeenCalledWith('p2p:set-workspace-access', { deviceId, allowed: true });

    fireEvent.click(sw);
    await waitFor(() => expect(sw.checked).toBe(false));
    expect(invoke).toHaveBeenCalledWith('p2p:set-workspace-access', { deviceId, allowed: false });
    expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Allow workspace access for Tower' }).checked).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('p2p:settings-set', expect.anything());
  });

  test('a permission change rejected by the host leaves the switch unchanged', async () => {
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'p2p:settings-get') return SETTINGS;
      if (ch === 'p2p:fleet-list') return { fleet: FLEET };
      throw new Error('Could not store workspace access');
    });
    render(<P2PSettings />);
    const sw = await screen.findByRole<HTMLInputElement>('switch', { name: 'Allow workspace access for Tower' });
    fireEvent.click(sw);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not store workspace access');
    expect(sw.checked).toBe(false);
    expect(sw.disabled).toBe(false);
  });

  test('saves device name on blur', async () => {
    render(<P2PSettings />);
    const input = await screen.findByDisplayValue('My Laptop');
    fireEvent.change(input, { target: { value: 'Desk' } });
    fireEvent.blur(input);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('p2p:settings-set', { deviceName: 'Desk' }));
  });

  test('Pair a new machine opens a modal with the 6-word enrollment code', async () => {
    render(<P2PSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /Pair a new machine/i }));
    expect(await screen.findByText(/alpha bravo charlie delta echo foxtrot/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('the pair modal shows a QR code carrying the code and this machine\'s relay, for the mobile app', async () => {
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'p2p:settings-get') return SETTINGS;
      if (ch === 'p2p:fleet-list') return { fleet: FLEET };
      if (ch === 'p2p:pair-generate-code') return { code: '921782718', expiresAt: Date.now() + 120_000 };
      return { ok: true };
    });
    render(<P2PSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a new machine' }));
    const qr = await screen.findByRole('img', { name: 'QR code for pairing the mobile app' });
    await waitFor(() => expect(qr.getAttribute('data-value')).toBe('metaide://pair?code=921782718&relay=relay.example.com&port=7001'));
    // A real symbol: square, dark modules on a white field with a quiet zone.
    const [, , w, h] = qr.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(21 + 8);
    expect(qr.querySelector('rect')!.getAttribute('fill')).toBe('#ffffff');
    expect(qr.querySelector('path')!.getAttribute('d')!.length).toBeGreaterThan(200);
  });

  test('an expired pair code shows no QR code', async () => {
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'p2p:settings-get') return SETTINGS;
      if (ch === 'p2p:fleet-list') return { fleet: FLEET };
      if (ch === 'p2p:pair-generate-code') return { code: '921782718', expiresAt: Date.now() - 1 };
      return { ok: true };
    });
    render(<P2PSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pair a new machine' }));
    expect(await screen.findByText(/Code expired/)).toBeTruthy();
    expect(screen.queryByTestId('p2p-pair-qr')).toBeNull();
  });

  test('Revoke next to a fleet member calls p2p:revoke-device (self is not listed)', async () => {
    render(<P2PSettings />);
    const btn = await screen.findByRole('button', { name: /Revoke Tower/i });
    expect(screen.queryByRole('button', { name: /Revoke My Laptop/i })).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(btn);
    expect(confirm).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('p2p:revoke-device', expect.anything());
    confirm.mockReturnValue(true);
    fireEvent.click(btn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('p2p:revoke-device', { deviceId: 'tower-device-id-0123456789' }));
    confirm.mockRestore();
  });

  test('saving the port then reverting it saves again', async () => {
    render(<P2PSettings />);
    const port = await screen.findByDisplayValue('7001');
    fireEvent.change(port, { target: { value: '7002' } });
    fireEvent.blur(port);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('p2p:settings-set', { relayPort: 7002 }));
    fireEvent.change(port, { target: { value: '7001' } });
    fireEvent.blur(port);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('p2p:settings-set', { relayPort: 7001 }));
  });

  test('whitespace-only device name is rejected and restored', async () => {
    render(<P2PSettings />);
    const input = await screen.findByDisplayValue('My Laptop');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe('My Laptop');
    expect(invoke).not.toHaveBeenCalledWith('p2p:settings-set', expect.anything());
  });

  test('shows a fleet error instead of the empty state', async () => {
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'p2p:settings-get') return SETTINGS;
      throw new Error('relay down');
    });
    render(<P2PSettings />);
    expect(await screen.findByText(/Fleet unavailable: relay down/)).toBeTruthy();
  });
});
