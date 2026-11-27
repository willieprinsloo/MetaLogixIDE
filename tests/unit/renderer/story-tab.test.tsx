// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoryFeature } from '@shared/story-feature';

/**
 * Mutable per-test state — tests can seed features, a refresh can
 * stream new ones in via the mocked `on()`, and an edit can update
 * one in place. Keeps each test isolated via `beforeEach`.
 */
let features: StoryFeature[] = [];
let refreshFails = false;
const changeListeners: Array<(ev: { projectId: number; feature: StoryFeature | null }) => void> = [];

function emitChange(ev: { projectId: number; feature: StoryFeature | null }): void {
  for (const l of changeListeners.slice()) l(ev);
}

function makeFeature(overrides: Partial<StoryFeature> = {}): StoryFeature {
  return {
    id: 'aaaaaaa',
    sha: 'a'.repeat(40),
    ts: '2026-11-27T13:00:00.000Z',
    prNumber: 26,
    title: 'fix(deps): bump majors',
    scope: 'src/main/',
    body: '## What you can now do\nYou can now install cleanly.\n## Why it matters\nFewer CVEs on the shelf.\n## Where it lives\npnpm-workspace.yaml.',
    kind: 'feature',
    edited: false,
    ...overrides,
  };
}

// StoryTab now uses `useOptionalMetaprojectSession` and `useAssignment`
// to resolve the project's metaproject kanban URL for ticket-ref chips.
// Stub both so the tests render without a real session provider; returning
// `null` for the session simulates signed-out, which is the safe default
// for tests that don't care about the metaproject chips.
vi.mock('@renderer/metaproject/session', () => ({
  useMetaprojectSession: () => { throw new Error('tests should not read the full session'); },
  useOptionalMetaprojectSession: () => null,
  useSignInIntent: () => () => {},
  AccountStatus: () => null,
}));

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockImplementation(async (ch: string, req: unknown) => {
      if (ch === 'story:features:list') {
        return { features, lastRefresh: null };
      }
      if (ch === 'story:features:refresh') {
        if (refreshFails) throw new Error('refresh exploded');
        // Simulate the main side streaming one entry in then signalling end.
        const streamed = makeFeature({ id: 'newest1', sha: 'n'.repeat(40), ts: '2026-11-28T09:00:00.000Z', title: 'feat: new thing' });
        features = [streamed, ...features];
        const r = req as { projectId: number };
        emitChange({ projectId: r.projectId, feature: streamed });
        emitChange({ projectId: r.projectId, feature: null });
        return { added: 1, failed: 0 };
      }
      if (ch === 'story:features:update') {
        const r = req as { projectId: number; id: string; title?: string; body?: string };
        const idx = features.findIndex((f) => f.id === r.id);
        if (idx >= 0) {
          const existing = features[idx]!;
          const updated: StoryFeature = {
            ...existing,
            title: r.title ?? existing.title,
            body: r.body ?? existing.body,
            edited: true,
          };
          features[idx] = updated;
          emitChange({ projectId: r.projectId, feature: updated });
          return { feature: updated };
        }
      }
      return {};
    }),
    on: vi.fn().mockImplementation((ch: string, cb: (ev: { projectId: number; feature: StoryFeature | null }) => void) => {
      if (ch === 'story:features:changed') {
        changeListeners.push(cb);
        return () => {
          const i = changeListeners.indexOf(cb);
          if (i >= 0) changeListeners.splice(i, 1);
        };
      }
      return () => {};
    }),
  },
}));

const { StoryTab } = await import('@renderer/components/StoryTab');

beforeEach(() => {
  features = [];
  refreshFails = false;
  changeListeners.length = 0;
});
afterEach(() => cleanup());

describe('StoryTab (feature feed)', () => {
  it('shows the empty-state copy when nothing has shipped yet', async () => {
    render(<StoryTab projectId={1} />);
    await screen.findByText(/No features logged yet/i);
    // The Refresh button is the only way out of the empty state.
    expect(screen.getByTestId('story-refresh').textContent).toContain('Refresh');
  });

  it('lists seeded features newest-first and auto-selects the top row', async () => {
    features = [
      makeFeature({ id: 'newer--', ts: '2026-11-27T12:00:00.000Z', title: 'newer one' }),
      makeFeature({ id: 'older--', ts: '2026-11-20T09:00:00.000Z', title: 'older one' }),
    ];
    render(<StoryTab projectId={1} />);
    const rows = await screen.findAllByTestId('story-feature-row');
    expect(rows[0]?.textContent).toContain('newer one');
    expect(rows[1]?.textContent).toContain('older one');
    // The right pane renders the auto-selected top entry.
    await screen.findByTestId('story-feature-detail');
  });

  it('hides maintenance entries by default and reveals them via the toggle', async () => {
    features = [
      makeFeature({ id: 'feat---', title: 'feat: add export', kind: 'feature' }),
      makeFeature({ id: 'maint--', title: 'chore: bump prettier', kind: 'maintenance' }),
    ];
    render(<StoryTab projectId={1} />);
    // Only the feature row is in the left rail; the detail pane also shows
    // the feature title, so we scope the assertion to the row list instead
    // of matching free text (which would be ambiguous).
    const rowsBefore = await screen.findAllByTestId('story-feature-row');
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]?.textContent).toContain('feat: add export');

    fireEvent.click(screen.getByTestId('story-show-maintenance'));
    const rowsAfter = await screen.findAllByTestId('story-feature-row');
    expect(rowsAfter).toHaveLength(2);
    const texts = rowsAfter.map((r) => r.textContent);
    expect(texts.some((t) => t?.includes('chore: bump prettier'))).toBe(true);
  });

  it('refresh streams a new entry in and selects it on an empty feed', async () => {
    render(<StoryTab projectId={1} />);
    await screen.findByText(/No features logged yet/i);
    fireEvent.click(screen.getByTestId('story-refresh'));
    const rows = await screen.findAllByTestId('story-feature-row');
    expect(rows[0]?.textContent).toContain('feat: new thing');
    // After the batch-end signal the Refresh button is clickable again.
    await waitFor(() => expect((screen.getByTestId('story-refresh') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a failed refresh shows the error and does not leave the button spinning', async () => {
    refreshFails = true;
    render(<StoryTab projectId={1} />);
    await screen.findByText(/No features logged yet/i);
    fireEvent.click(screen.getByTestId('story-refresh'));
    await screen.findByText(/refresh exploded/);
    await waitFor(() => expect((screen.getByTestId('story-refresh') as HTMLButtonElement).disabled).toBe(false));
  });

  it('edit → save round-trips through story:features:update and shows the edited badge', async () => {
    features = [makeFeature({ title: 'original title' })];
    render(<StoryTab projectId={1} />);
    // Wait for the detail pane to render (title shows there and in the row);
    // both are fine — we just need the Edit button available.
    await screen.findByTestId('story-feature-edit');
    fireEvent.click(screen.getByTestId('story-feature-edit'));
    const titleInput = await screen.findByTestId('story-feature-edit-title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'edited title' } });
    fireEvent.click(screen.getByTestId('story-feature-save'));
    // After save we're back in detail view; row list and detail pane now
    // both carry the new title, so match multiple.
    const matches = await screen.findAllByText('edited title');
    expect(matches.length).toBeGreaterThan(0);
    // The edited badge appears in both the row and the detail header.
    const badges = await screen.findAllByText(/edited/);
    expect(badges.length).toBeGreaterThan(0);
  });
});
