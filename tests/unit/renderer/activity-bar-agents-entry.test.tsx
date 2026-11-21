// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ActivityBar } from '@renderer/components/ActivityBar';

afterEach(() => { cleanup(); });

describe('ActivityBar: Agents entry', () => {
  it('selecting the Agents icon fires onSelect("agents")', () => {
    const onSelect = vi.fn();
    render(
      <ActivityBar
        active="projects"
        onSelect={onSelect}
        onToggleSidebar={() => {}}
        sidebarOpen={true}
      />,
    );
    fireEvent.click(screen.getByTestId('ab-agents'));
    expect(onSelect).toHaveBeenCalledWith('agents');
  });

  it('agentsOpen controls the Agents button pressed state independently of active', () => {
    // When the Agents DOCK is open on the right but the left sidebar shows
    // the project list, the Agents button must read as pressed (the dock
    // is what it opens) while active is "projects". Without this, the
    // only way to show the Agents icon pressed was to set active="agents",
    // which swapped the left sheet and hid the project tree.
    const { rerender } = render(
      <ActivityBar
        active="projects"
        agentsOpen={false}
        onSelect={() => {}}
        onToggleSidebar={() => {}}
        sidebarOpen={true}
      />,
    );
    const btn = screen.getByTestId('ab-agents');
    expect(btn.getAttribute('aria-current')).toBeNull();

    rerender(
      <ActivityBar
        active="projects"
        agentsOpen={true}
        onSelect={() => {}}
        onToggleSidebar={() => {}}
        sidebarOpen={true}
      />,
    );
    expect(btn.getAttribute('aria-current')).toBe('page');
  });

  it('agentsOpen suppresses the unread badge (the dock is already in view)', () => {
    const { rerender } = render(
      <ActivityBar
        active="projects"
        agentsOpen={false}
        agentsUnread={3}
        onSelect={() => {}}
        onToggleSidebar={() => {}}
        sidebarOpen={true}
      />,
    );
    expect(screen.getByTestId('ab-agents').textContent).toContain('3');

    rerender(
      <ActivityBar
        active="projects"
        agentsOpen={true}
        agentsUnread={3}
        onSelect={() => {}}
        onToggleSidebar={() => {}}
        sidebarOpen={true}
      />,
    );
    expect(screen.getByTestId('ab-agents').textContent).not.toContain('3');
  });
});
