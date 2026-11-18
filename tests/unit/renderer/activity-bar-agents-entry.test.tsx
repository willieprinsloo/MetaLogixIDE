// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityBar } from '@renderer/components/ActivityBar';

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
});
