// @vitest-environment jsdom
/**
 * Icon-tooltip sweep: every icon-only button we wrapped must still have an
 * accessible name. These tests spot-check the key icon-only buttons across
 * the app by rendering their component (or stubbing just enough to let it
 * mount) and asserting the aria-label survived the Tooltip wrapping. If
 * one of these fails, a Tooltip refactor stripped a label that a screen
 * reader relied on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ShellTabsBarItem } from '@renderer/components/ShellTabsBar';
import { ShellTabsBar } from '@renderer/components/ShellTabsBar';

// Gives api.invoke a benign stub; the bar doesn't need the IPC answer to
// render — it only calls it on user action.
vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockResolvedValue({}),
    on: vi.fn().mockReturnValue(() => {}),
  },
}));
vi.mock('@renderer/hooks/useToasts', () => ({
  toast: vi.fn(),
  useToasts: () => ({ toasts: [], dismiss: vi.fn() }),
}));

function shell(ix: number, name: string): ShellTabsBarItem {
  return {
    projectId: 1,
    shellIndex: ix,
    pinned: false,
    startedAt: null,
    lastActiveAt: null,
    launchName: name,
    agent: null,
    state: 'idle',
  };
}

afterEach(() => cleanup());

describe('ShellTabsBar icon-only buttons have accessible names', () => {
  it('close × on a shell tab exposes aria-label and lives inside a Tooltip span', () => {
    render(
      <ShellTabsBar
        projectId={1}
        shells={[shell(0, 'Claude'), shell(1, 'Codex')]}
        active={0}
        onSelect={() => {}}
        onClose={() => {}}
        defaultCliName={null}
        onLaunchProfile={() => {}}
        onLaunchPlainTab={() => {}}
        onLaunchCustom={() => {}}
      />,
    );
    // There is one close button per chip, each labelled "Close <launchName>".
    const closeBtns = screen.getAllByRole('button', { name: /^Close / });
    expect(closeBtns.length).toBeGreaterThanOrEqual(2);
    // Every close button is wrapped in a Tooltip <span class="inline-flex ...">
    for (const btn of closeBtns) {
      const parent = btn.parentElement;
      expect(parent?.tagName).toBe('SPAN');
      expect(parent?.className).toContain('inline-flex');
    }
  });
});
