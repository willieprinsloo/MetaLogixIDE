// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoryChunk } from '@shared/story';

/**
 * Mutable per-test state so one test can seed a chunk list, another can
 * stage an error, and `story:changed` subscribers see fresh values when
 * the component re-fetches.
 */
let chunks: StoryChunk[] = [];
let chunkHtmlById: Record<string, string | null> = {};
let generateFails = false;
const changedListeners: Array<(ev: { projectId: number }) => void> = [];

const SAMPLE_HTML = '<!doctype html><html><head><title>t</title></head><body><h1>Spike</h1><p>Nice</p></body></html>';

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockImplementation(async (ch: string, req: unknown) => {
      if (ch === 'story:list') return { chunks };
      if (ch === 'story:read') {
        const r = req as { file: string };
        return { html: chunkHtmlById[r.file] ?? SAMPLE_HTML };
      }
      if (ch === 'story:generate') {
        if (generateFails) throw new Error('generator exploded');
        const chunk: StoryChunk = {
          file: 'generated.html',
          ts: '2026-11-24T14:15:00.000Z',
          title: 'Generated chunk',
          blurb: 'just now',
        };
        chunks = [chunk, ...chunks];
        chunkHtmlById[chunk.file] = SAMPLE_HTML;
        return { chunk };
      }
      return {};
    }),
    on: vi.fn().mockImplementation((ch: string, cb: (ev: { projectId: number }) => void) => {
      if (ch === 'story:changed') changedListeners.push(cb);
      return () => { /* noop */ };
    }),
  },
}));

// The theme hook reads from localStorage + sets a data attribute on
// <html>; stub it to return 'dark' consistently so the srcDoc
// theme-injection check is deterministic.
vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'dark', palette: 'default', effective: 'dark', setMode: () => {}, setPalette: () => {}, cycle: () => {} }),
}));

// Dynamic import so the mocks above are in place before React resolves
// the component tree.
async function mount(projectId = 42) {
  const { StoryTab } = await import('@renderer/components/StoryTab');
  return render(<StoryTab projectId={projectId} />);
}

beforeEach(() => {
  chunks = [];
  chunkHtmlById = {};
  generateFails = false;
  changedListeners.length = 0;
});
afterEach(() => { cleanup(); });

describe('StoryTab', () => {
  it('shows the empty-state copy when the project has no chunks yet', async () => {
    await mount();
    await waitFor(() => {
      expect(screen.getByText(/Nothing to read yet/i)).toBeTruthy();
    });
  });

  it('lists past chunks and auto-selects the newest on mount', async () => {
    chunks = [
      { file: 'b.html', ts: '2026-11-24T14:10:00Z', title: 'Newer chunk', blurb: 'now' },
      { file: 'a.html', ts: '2026-11-24T13:00:00Z', title: 'Older chunk', blurb: 'before' },
    ];
    chunkHtmlById['b.html'] = SAMPLE_HTML;
    await mount();
    await waitFor(() => {
      expect(screen.getByText('Newer chunk')).toBeTruthy();
      expect(screen.getByText('Older chunk')).toBeTruthy();
    });
    // The reader iframe should have rendered the auto-selected chunk's html.
    const frame = await waitFor(() => screen.getByTestId('story-frame') as HTMLIFrameElement);
    expect(frame.getAttribute('srcDoc')?.includes('Spike')).toBe(true);
  });

  it('stamps data-theme on the iframe srcdoc so the reader matches the IDE theme', async () => {
    chunks = [{ file: 'a.html', ts: '2026-11-24T14:00:00Z', title: 'A', blurb: 'now' }];
    chunkHtmlById['a.html'] = SAMPLE_HTML;
    await mount();
    const frame = await waitFor(() => screen.getByTestId('story-frame') as HTMLIFrameElement);
    const srcDoc = frame.getAttribute('srcDoc') ?? '';
    // The transformer stamps the current theme on <html>.
    expect(srcDoc).toMatch(/<html[^>]*data-theme="dark"/);
    // And injects a last-wins :root override so old chunks respect the theme
    // without needing to be regenerated.
    expect(srcDoc).toContain('data-ide-theme-override="1"');
  });

  it('calls story:generate when the "Catch me up" button is pressed and shows the new chunk', async () => {
    await mount();
    const btn = await waitFor(() => screen.getByTestId('story-catch-up'));
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText('Generated chunk')).toBeTruthy();
    });
  });

  it('shows an error line when generation fails and does not crash', async () => {
    generateFails = true;
    await mount();
    const btn = await waitFor(() => screen.getByTestId('story-catch-up'));
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/generator exploded/i)).toBeTruthy();
    });
  });

  it('refreshes the list when story:changed fires for this project', async () => {
    await mount(7);
    // Before — empty list, "Nothing to read yet".
    await waitFor(() => screen.getByText(/Nothing to read yet/i));
    // Simulate an external chunk write (another window generated).
    chunks = [{ file: 'from-elsewhere.html', ts: '2026-11-24T14:20:00Z', title: 'Elsewhere', blurb: '' }];
    chunkHtmlById['from-elsewhere.html'] = SAMPLE_HTML;
    for (const l of changedListeners) l({ projectId: 7 });
    await waitFor(() => {
      expect(screen.getByText('Elsewhere')).toBeTruthy();
    });
  });

  it('ignores story:changed events for a different project', async () => {
    await mount(7);
    await waitFor(() => screen.getByText(/Nothing to read yet/i));
    chunks = [{ file: 'elsewhere.html', ts: '2026-11-24T14:20:00Z', title: 'Elsewhere', blurb: '' }];
    for (const l of changedListeners) l({ projectId: 999 });
    // Give any accidental refresh a tick to resolve.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });

  it('clears the selected chunk when the projectId changes', async () => {
    // Project A has chunks; auto-select picks the newest.
    chunks = [{ file: 'a.html', ts: '2026-11-24T14:00:00Z', title: 'A chunk', blurb: 'now' }];
    chunkHtmlById['a.html'] = SAMPLE_HTML;
    const { rerender } = await mount(1);
    await waitFor(() => screen.getByText('A chunk'));

    // Switch to project B — stash a new list before the re-render.
    chunks = [{ file: 'b.html', ts: '2026-11-24T14:30:00Z', title: 'B chunk', blurb: 'now' }];
    chunkHtmlById['b.html'] = SAMPLE_HTML;
    const { StoryTab } = await import('@renderer/components/StoryTab');
    rerender(<StoryTab projectId={2} />);

    // The new chunk must show; the stale "A chunk" from project 1 must be gone.
    await waitFor(() => {
      expect(screen.getByText('B chunk')).toBeTruthy();
      expect(screen.queryByText('A chunk')).toBeNull();
    });
  });

  it('clears the error banner when a later chunk reads successfully', async () => {
    chunks = [
      { file: 'bad.html', ts: '2026-11-24T14:00:00Z', title: 'Bad', blurb: '' },
      { file: 'good.html', ts: '2026-11-24T13:00:00Z', title: 'Good', blurb: '' },
    ];
    chunkHtmlById['bad.html'] = null;
    chunkHtmlById['good.html'] = SAMPLE_HTML;
    // story:read returns `html: null` when the file is missing — that's not
    // an exception, but the empty-right-pane shows and no error. We need an
    // ACTUAL throw to stage the sticky-error scenario, so stub one chunk to
    // reject via the invoke mock on the first call only.
    const api = (await import('@renderer/api')).api as unknown as { invoke: ReturnType<typeof vi.fn> };
    const original = api.invoke.getMockImplementation()!;
    let firstReadFailed = false;
    api.invoke.mockImplementation(async (ch: string, req: unknown) => {
      if (ch === 'story:read' && (req as { file: string }).file === 'bad.html' && !firstReadFailed) {
        firstReadFailed = true;
        throw new Error('corrupt chunk');
      }
      return original(ch, req);
    });

    await mount();
    // "Bad" auto-selected, read throws → error banner visible.
    await waitFor(() => expect(screen.getByText(/corrupt chunk/)).toBeTruthy());

    // Click "Good" — read succeeds, the banner must clear.
    fireEvent.click(screen.getByText('Good'));
    await waitFor(() => expect(screen.queryByText(/corrupt chunk/)).toBeNull());

    // Restore.
    api.invoke.mockImplementation(original);
  });

  it('isolates the chunk via iframe sandbox so page scripts cannot escape', async () => {
    chunks = [{ file: 'a.html', ts: '2026-11-24T14:00:00Z', title: 'A', blurb: '' }];
    chunkHtmlById['a.html'] = SAMPLE_HTML;
    await mount();
    const frame = await waitFor(() => screen.getByTestId('story-frame') as HTMLIFrameElement);
    const sandbox = frame.getAttribute('sandbox') ?? '';
    // same-origin is needed for in-document scrolling / anchors; scripts
    // are NOT in the allow-list, so inline script tags in a chunk cannot run.
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
  });
});
