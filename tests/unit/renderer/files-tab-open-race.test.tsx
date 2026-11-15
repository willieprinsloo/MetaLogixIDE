// @vitest-environment jsdom
/**
 * FilesTab open-request consumption: a re-fired consume effect (App re-render
 * with a fresh onOpenRelPathConsumed arrow, or openPath identity churn) must
 * never open the same file twice. Reproduces the peek duplicate-tab race the
 * e2e suite catches at peek-click-routing.spec.ts:239.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const reads = vi.hoisted(() => ({
  // Resolves only when the test releases the gate, so two opens can race
  // with uncommitted state — exactly what the real app does.
  gate: [] as Array<() => void>,
  count: 0,
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: async (channel: string, payload: { relPath?: string }) => {
      if (channel === 'files:tree') return { entries: [] };
      if (channel === 'git:status') return { staged: [], unstaged: [], untracked: [] };
      if (channel === 'files:read') {
        reads.count += 1;
        await new Promise<void>((resolve) => { reads.gate.push(resolve); });
        return { content: `content of ${payload.relPath}`, kind: 'text' as const, sizeBytes: 10 };
      }
      return undefined; // any other channel the mounted tree touches
    },
  },
}));

import { FilesTab } from '@renderer/components/FilesTab';

const release = () => { for (const r of reads.gate.splice(0)) r(); };

describe('FilesTab open-request consumption', () => {
  it('racing re-fires of the consume effect never duplicate the file tab', async () => {
    reads.count = 0; reads.gate.length = 0;
    const consumedA = vi.fn();
    const consumedB = vi.fn();

    // Mount with an open request; the files:read calls hang on the gate.
    // The effect may fire once or twice (env-dependent); the outcome must be
    // the same either way, which is the point of the fix.
    const view = render(
      <FilesTab projectId={1} openRelPath="src/here.ts" openLine={null} onOpenRelPathConsumed={consumedA} />,
    );
    await waitFor(() => expect(reads.count).toBeGreaterThan(0));

    // App re-renders with a NEW inline arrow (same openRelPath value) while
    // the reads are still gated — the effect re-fires openPath again.
    view.rerender(
      <FilesTab projectId={1} openRelPath="src/here.ts" openLine={null} onOpenRelPathConsumed={consumedB} />,
    );
    await waitFor(() => expect(reads.count).toBeGreaterThan(1), { timeout: 3000 });

    release(); // every in-flight read resolves; every append commits
    await waitFor(() => expect(view.getAllByTestId('file-tab').length).toBeGreaterThan(0), { timeout: 3000 });
    const tabs = view.getAllByTestId('file-tab');
    expect(tabs.length, 'one tab per file no matter how many opens raced').toBe(1);
    view.unmount();
  });
});
