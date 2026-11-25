// @vitest-environment jsdom
/**
 * The Git panel no longer renders a tiny inline diff per row. Clicking a row
 * must call onOpenInDiff with the entry key the Diff tab expects
 * (`${group}:${path}`), and the Diff tab's focusRequest must pre-select that
 * row even before the user clicks in the list.
 *
 * This is the only unit test that proves the single-diff-surface wiring; the
 * two places the diff used to live now share one component, and this test is
 * the regression net.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { entryKey } from '@renderer/diff/diff-selection';

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockImplementation((channel: string) => {
      if (channel === 'git:panel-status') {
        return Promise.resolve({
          isRepo: true,
          branch: 'main',
          ahead: 0,
          behind: 0,
          staged: [{ path: 'staged.ts', status: 'M' }],
          unstaged: [{ path: 'changed.ts', status: 'M' }],
          untracked: ['new.ts'],
        });
      }
      return Promise.resolve({});
    }),
    on: vi.fn().mockReturnValue(() => {}),
  },
}));
vi.mock('@renderer/hooks/useToasts', () => ({
  toast: vi.fn(),
  useToasts: () => ({ toasts: [], dismiss: vi.fn() }),
}));
vi.mock('@renderer/shortcut-platform', () => ({
  useShortcutPlatform: () => 'mac',
}));

afterEach(() => cleanup());

describe('GitPanel row → Diff tab wiring', () => {
  it('clicking a row calls onOpenInDiff with the correct entry key per group', async () => {
    const { GitPanel } = await import('@renderer/components/GitPanel');
    const onOpen = vi.fn();
    render(<GitPanel projectId={1} onOpenInDiff={onOpen} />);
    // Wait for panel-status to resolve + the three rows to render.
    const stagedRow = await screen.findByTestId('git-row-staged.ts');
    fireEvent.click(stagedRow);
    const changedRow = screen.getByTestId('git-row-changed.ts');
    fireEvent.click(changedRow);
    const newRow = screen.getByTestId('git-row-new.ts');
    fireEvent.click(newRow);

    expect(onOpen).toHaveBeenNthCalledWith(1, 'staged:staged.ts');
    expect(onOpen).toHaveBeenNthCalledWith(2, 'unstaged:changed.ts');
    expect(onOpen).toHaveBeenNthCalledWith(3, 'untracked:new.ts');
  });

  it('the entry key format matches what diff-selection.entryKey produces', () => {
    expect(entryKey({ group: 'staged', path: 'a.ts', status: 'M' })).toBe('staged:a.ts');
    expect(entryKey({ group: 'unstaged', path: 'b.ts', status: 'M' })).toBe('unstaged:b.ts');
    expect(entryKey({ group: 'untracked', path: 'c.ts', status: '?' })).toBe('untracked:c.ts');
  });

  it('a row with no onOpenInDiff prop is disabled (defensive: never leaves the user clicking into nothing)', async () => {
    const { GitPanel } = await import('@renderer/components/GitPanel');
    render(<GitPanel projectId={1} />);
    const row = await screen.findByTestId('git-row-staged.ts');
    expect((row as HTMLButtonElement).disabled).toBe(true);
  });
});
