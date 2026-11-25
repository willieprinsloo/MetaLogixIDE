// @vitest-environment jsdom
/**
 * Regression test for the "no projects" confusion we hit on 2026-11-25: when
 * the sidebar was collapsed and no project was selected, the main pane said
 * "Pick one from the sidebar" with no way to actually get to the sidebar —
 * so the app read as "there are no projects". The EmptyState now branches
 * on sidebar visibility and surfaces a one-click "Show sidebar" button.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Stubs for modules App.tsx pulls in that need a live window / IPC.
vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn(), on: vi.fn().mockReturnValue(() => {}) } }));
vi.mock('@renderer/hooks/useRoots', () => ({
  // One root present — otherwise EmptyState renders the WelcomeOnboarding
  // card instead of the project-picker hint.
  useRoots: () => ({ roots: [{ id: 1, path: '/tmp/root', name: 'root' }], refresh: () => Promise.resolve() }),
}));

import { EmptyState } from '@renderer/App';

describe('EmptyState — sidebar visibility branch', () => {
  it('shows the open-sidebar CTA when the sidebar is closed', () => {
    const html = renderToStaticMarkup(
      <EmptyState sidebarOpen={false} onOpenSidebar={() => {}} />,
    );
    expect(html).toContain("sidebar");
    expect(html).toContain("hidden right now");
    expect(html).toContain("Show sidebar");
    // The ambiguous older copy should not appear in the closed-sidebar branch.
    expect(html).not.toContain('Pick one from the sidebar');
  });

  it('shows the plain "pick one from the sidebar" hint when the sidebar is open', () => {
    const html = renderToStaticMarkup(
      <EmptyState sidebarOpen={true} onOpenSidebar={() => {}} />,
    );
    expect(html).toContain('No project selected');
    expect(html).toContain('Pick one from the sidebar');
    expect(html).not.toContain('Show sidebar');
    expect(html).not.toContain('hidden right now');
  });

  it('includes the ⌘B / Ctrl+B shortcut text in the closed-sidebar branch', () => {
    const html = renderToStaticMarkup(
      <EmptyState sidebarOpen={false} onOpenSidebar={() => {}} />,
    );
    // Either the mac glyph or the plain text form — we don't care which;
    // we only care that the shortcut is surfaced so the user has an alternative.
    expect(html).toMatch(/⌘|Ctrl\+/);
  });
});
