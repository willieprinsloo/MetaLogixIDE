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
// Optional gate the test can hold to observe the mid-refresh UI
// (progress strip, scanning placeholder, disabled button) before the
// invoke resolves and the event stream clears the refreshing flag.
let refreshHold: Promise<void> | null = null;
let refreshRelease: (() => void) | null = null;
const changeListeners: Array<(ev: { projectId: number; feature: StoryFeature | null }) => void> = [];

function holdRefresh(): () => void {
  refreshHold = new Promise<void>((r) => { refreshRelease = r; });
  return () => { refreshRelease?.(); };
}

function emitChange(ev: { projectId: number; feature: StoryFeature | null }): void {
  for (const l of changeListeners.slice()) l(ev);
}

function makeFeature(overrides: Partial<StoryFeature> = {}): StoryFeature {
  return {
    id: 'aaaaaaa',
    sha: 'a'.repeat(40),
    ts: new Date().toISOString(),
    prNumber: 26,
    title: 'fix(deps): bump majors',
    scope: 'src/main/',
    body: '# Everything installs clean again\n\nWe cleared 70 dep CVEs so new installs start trouble-free.',
    kind: 'feature',
    edited: false,
    ...overrides,
  };
}

// StoryTab reads the metaproject session + assignment for the ticket-chip
// deep link. Tests don't carry a provider, so the optional accessor returns
// null and no assignment lookup fires.
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
      if (ch === 'story:features:repo-url') {
        return { repoUrl: 'https://github.com/owner/repo' };
      }
      if (ch === 'story:features:refresh') {
        if (refreshFails) throw new Error('refresh exploded');
        if (refreshHold) await refreshHold;
        const streamed = makeFeature({ id: 'newest1', sha: 'n'.repeat(40), ts: new Date(Date.now() + 60_000).toISOString(), title: 'feat: new thing', body: '# A new thing shipped\n\nIt works.' });
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
          const updated: StoryFeature = { ...existing, title: r.title ?? existing.title, body: r.body ?? existing.body, edited: true };
          features[idx] = updated;
          emitChange({ projectId: r.projectId, feature: updated });
          return { feature: updated };
        }
      }
      if (ch === 'app:open-external') return { ok: true };
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
  refreshHold = null;
  refreshRelease = null;
  changeListeners.length = 0;
});
afterEach(() => cleanup());

describe('StoryTab (newsfeed)', () => {
  it('shows the empty-state copy when nothing has shipped yet', async () => {
    render(<StoryTab projectId={1} />);
    await screen.findByText(/Nothing to read yet/i);
    expect(screen.getByTestId('story-refresh').textContent).toContain('Refresh');
    // Empty feed doesn't render any day groups.
    expect(screen.queryByTestId('story-day-group')).toBeNull();
  });

  it('renders each feature as its own post with a headline parsed from the body', async () => {
    features = [
      makeFeature({ id: 'one----', title: 'feat: add export', body: '# You can now export projects\n\nClick Settings → Export.' }),
      makeFeature({ id: 'two----', title: 'feat: dark mode', body: '# Dark mode is live\n\nPress ⌘⇧D to toggle.', ts: new Date(Date.now() - 86400_000 * 2).toISOString() }),
    ];
    render(<StoryTab projectId={1} />);
    const headlines = await screen.findAllByTestId('story-post-headline');
    expect(headlines.map((h) => h.textContent)).toEqual([
      'You can now export projects',
      'Dark mode is live',
    ]);
  });

  it('falls back to the commit title as the headline when the body has no `# ` line (legacy entries)', async () => {
    features = [makeFeature({ body: '## What you can now do\nOld-style entry.' })];
    render(<StoryTab projectId={1} />);
    const headline = await screen.findByTestId('story-post-headline');
    expect(headline.textContent).toBe('fix(deps): bump majors');
  });

  it('groups posts by day with "Today" as the first group for entries that shipped now', async () => {
    features = [makeFeature({ ts: new Date().toISOString() })];
    render(<StoryTab projectId={1} />);
    const group = await screen.findByTestId('story-day-group');
    expect(group.textContent).toMatch(/Today/i);
  });

  it('hides maintenance posts by default and reveals them via the toggle', async () => {
    features = [
      makeFeature({ id: 'feat---', title: 'feat: add export', body: '# A feature', kind: 'feature' }),
      makeFeature({ id: 'maint--', title: 'chore: bump prettier', body: '# Internal cleanup', kind: 'maintenance' }),
    ];
    render(<StoryTab projectId={1} />);
    const postsBefore = await screen.findAllByTestId('story-post');
    expect(postsBefore).toHaveLength(1);
    fireEvent.click(screen.getByTestId('story-show-maintenance'));
    const postsAfter = await screen.findAllByTestId('story-post');
    expect(postsAfter).toHaveLength(2);
  });

  it('refresh streams a new post in at the top of the feed and the refresh button re-enables', async () => {
    render(<StoryTab projectId={1} />);
    await screen.findByText(/Nothing to read yet/i);
    fireEvent.click(screen.getByTestId('story-refresh'));
    const headlines = await screen.findAllByTestId('story-post-headline');
    expect(headlines[0]?.textContent).toBe('A new thing shipped');
    await waitFor(() => expect((screen.getByTestId('story-refresh') as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a visible scanning indicator while a refresh is running (progress strip + body placeholder + disabled button)', async () => {
    const release = holdRefresh();
    render(<StoryTab projectId={1} />);
    await screen.findByText(/Nothing to read yet/i);
    fireEvent.click(screen.getByTestId('story-refresh'));
    // While the refresh is held, the user sees a progress strip under
    // the header and a "scanning git history" placeholder in the body,
    // and the refresh button is disabled.
    await screen.findByTestId('story-progress');
    expect(screen.getByTestId('story-scanning')).toBeTruthy();
    expect((screen.getByTestId('story-refresh') as HTMLButtonElement).disabled).toBe(true);
    // Let the refresh complete; the indicators disappear and the new
    // post lands in the feed.
    release();
    const headlines = await screen.findAllByTestId('story-post-headline');
    expect(headlines[0]?.textContent).toBe('A new thing shipped');
    await waitFor(() => expect(screen.queryByTestId('story-progress')).toBeNull());
    await waitFor(() => expect(screen.queryByTestId('story-scanning')).toBeNull());
    await waitFor(() => expect((screen.getByTestId('story-refresh') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a failed refresh shows the error and does not leave the button spinning', async () => {
    refreshFails = true;
    render(<StoryTab projectId={1} />);
    await screen.findByText(/Nothing to read yet/i);
    fireEvent.click(screen.getByTestId('story-refresh'));
    await screen.findByText(/refresh exploded/);
    await waitFor(() => expect((screen.getByTestId('story-refresh') as HTMLButtonElement).disabled).toBe(false));
  });

  it('edit → save rewrites the stored post body so the headline round-trips', async () => {
    features = [makeFeature({ id: 'edit---', body: '# Original headline\n\nShort body.' })];
    render(<StoryTab projectId={1} />);
    await screen.findByText('Original headline');
    fireEvent.click(screen.getByTestId('story-post-edit'));
    const titleInput = await screen.findByTestId('story-post-edit-title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Edited headline' } });
    fireEvent.click(screen.getByTestId('story-post-save'));
    // The streamed `feature-changed` event updates the post in place; the new
    // headline should land on the row.
    await screen.findByText('Edited headline');
    // The "edited" badge appears once the update flows back.
    const edited = await screen.findAllByText(/edited/);
    expect(edited.length).toBeGreaterThan(0);
  });
});
