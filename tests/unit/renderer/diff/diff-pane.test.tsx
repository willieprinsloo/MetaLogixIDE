// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// api.ts reads window.api at module load; stub it for SSR tests.
vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn(), on: vi.fn().mockReturnValue(() => {}) } }));

import { DiffPane } from '@renderer/components/DiffPane';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import type { DiffEntry } from '@renderer/diff/diff-selection';
import type { DiffSidesState } from '@renderer/diff/diff-load-state';

const entry: DiffEntry = { group: 'unstaged', path: 'a.ts', status: 'M' };
const KEY = 'unstaged:a.ts';
const OTHER = 'staged:a.ts';
const diff =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const oldValue = 1;\n+const newValue = 2;\n';

const ok = (key: string): DiffSidesState => ({
  status: 'ok',
  key,
  diff,
  diffHash: 'h',
  oldSide: { text: 'const oldValue = 1;\n' },
  newSide: { text: 'const newValue = 2;\n' },
});

function render(sides: DiffSidesState, shown: DiffEntry | null = entry): string {
  return renderToStaticMarkup(<DiffPane entry={shown} sides={sides} projectId={1} />);
}

const loading = `<p role="status">${DIFF_COPY.loadingDiff}</p>`;

describe('DiffPane for the selected entry', () => {
  it('renders nothing when no entry is selected', () => {
    expect(render(ok(KEY), null)).toBe('');
  });

  it('shows loading while the entry loads', () => {
    expect(render({ status: 'loading', key: KEY })).toContain(loading);
  });

  it('shows loading before any state arrives', () => {
    expect(render({ status: 'idle' })).toContain(loading);
  });

  it('shows the too-large message', () => {
    const html = render({ status: 'too-large', key: KEY });
    expect(html).toContain(`<p>${DIFF_COPY.tooLarge}</p>`);
    expect(html).not.toContain(DIFF_COPY.loadingDiff);
  });

  it('shows the error text as an alert', () => {
    const html = render({ status: 'error', key: KEY, message: 'EACCES: permission denied' });
    expect(html).toMatch(/<p role="alert"[^>]*>EACCES: permission denied<\/p>/);
  });

  it('shows the side-by-side diff for an ok state', () => {
    const html = render(ok(KEY));
    expect(html).toContain(`data-testid="${DIFF_TESTIDS.sideOld}"`);
    expect(html).toContain(`data-testid="${DIFF_TESTIDS.sideNew}"`);
    expect(html).toContain('oldValue');
    expect(html).toContain('newValue');
    expect(html).not.toContain(DIFF_COPY.loadingDiff);
  });

  it('highlights the left side by the old path and the right side by the new path of a rename', () => {
    const renamed: DiffEntry = {
      group: 'staged',
      path: 'notes.txt',
      status: 'R',
      origPath: 'code.ts',
    };
    const html = render(ok('staged:notes.txt'), renamed);
    const [left = '', right = ''] = html.split(`data-testid="${DIFF_TESTIDS.sideNew}"`);
    expect(left).toContain('hljs-keyword');
    expect(right).not.toContain('hljs-');
  });
});

describe('DiffPane with state for another entry', () => {
  it.each<[string, DiffSidesState]>([
    ['loading', { status: 'loading', key: OTHER }],
    ['too-large', { status: 'too-large', key: OTHER }],
    ['error', { status: 'error', key: OTHER, message: 'boom' }],
    ['ok', ok(OTHER)],
  ])("shows loading, not the other entry's %s state", (_name, sides) => {
    const html = render(sides);
    expect(html).toContain(loading);
    expect(html).not.toContain(DIFF_COPY.tooLarge);
    expect(html).not.toContain('boom');
    expect(html).not.toContain(DIFF_TESTIDS.sideOld);
  });
});
