import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffFileList } from '@renderer/components/DiffFileList';
import { DIFF_COPY, DIFF_TESTIDS } from '@renderer/diff-tab-copy';
import { groupChanges } from '@renderer/diff/diff-selection';

const groups = groupChanges({
  staged: [
    { path: 'new.ts', status: 'R', origPath: 'old.ts' },
    { path: 'added.ts', status: 'A' },
  ],
  unstaged: [
    { path: 'edited.ts', status: 'M' },
    { path: 'gone.ts', status: 'D' },
    { path: 'added.ts', status: 'M' },
  ],
  untracked: ['fresh.txt'],
});

function render(selectedKey: string | null): string {
  return renderToStaticMarkup(
    <DiffFileList groups={groups} selectedKey={selectedKey} onSelect={() => undefined} />,
  );
}

function rowTag(html: string, group: string, path: string): string {
  const match = new RegExp(`<button[^>]*data-path="${path}" data-group="${group}"[^>]*>`).exec(
    html,
  );
  if (!match) throw new Error(`no row ${group}:${path}`);
  return match[0];
}

function rowStatusClass(html: string, group: string, path: string): string {
  const re = new RegExp(
    `data-path="${path}" data-group="${group}"[^>]*><span class="([^"]*)" data-testid="${DIFF_TESTIDS.rowStatus}">([^<])<`,
  );
  const match = re.exec(html);
  if (!match?.[1]) throw new Error(`no status for ${group}:${path}`);
  return match[1];
}

describe('DiffFileList', () => {
  it('shows the groups in Staged, Changes, Untracked order with their counts', () => {
    const html = render(null);
    const headings = [
      ...html.matchAll(/<h3[^>]*>([^<]+) <span class="opacity-60">\((\d+)\)<\/span><\/h3>/g),
    ].map((m) => `${m[1]} ${m[2]}`);
    expect(headings).toEqual([
      `${DIFF_COPY.group.staged} 2`,
      `${DIFF_COPY.group.unstaged} 3`,
      `${DIFF_COPY.group.untracked} 1`,
    ]);
  });

  it('lists the rows in group order, keeping the same path in two groups as two rows', () => {
    const rows = [...render(null).matchAll(/data-path="([^"]+)" data-group="(\w+)"/g)].map(
      (m) => `${m[2]}:${m[1]}`,
    );
    expect(rows).toEqual([
      'staged:new.ts',
      'staged:added.ts',
      'unstaged:edited.ts',
      'unstaged:gone.ts',
      'unstaged:added.ts',
      'untracked:fresh.txt',
    ]);
  });

  it('marks only the selected group-and-path row with aria-current', () => {
    const html = render('unstaged:added.ts');
    expect(html.split('aria-current="true"').length - 1).toBe(1);
    expect(rowTag(html, 'unstaged', 'added.ts')).toContain('aria-current="true"');
    expect(rowTag(html, 'staged', 'added.ts')).not.toContain('aria-current');
  });

  it('marks no row when nothing is selected', () => {
    expect(render(null)).not.toContain('aria-current');
  });

  it('titles a renamed row with its path and where it was renamed from', () => {
    expect(rowTag(render(null), 'staged', 'new.ts')).toContain(
      `title="new.ts\n${DIFF_COPY.renamedFrom('old.ts')}"`,
    );
  });

  it('titles a plain row with its path only', () => {
    expect(rowTag(render(null), 'unstaged', 'edited.ts')).toContain('title="edited.ts"');
  });

  it('shows each status letter in the Git panel colour', () => {
    const html = render(null);
    expect(rowStatusClass(html, 'unstaged', 'edited.ts')).toContain('text-[color:var(--git-modified,#fbbf24)]');
    expect(rowStatusClass(html, 'staged', 'added.ts')).toContain('text-[color:var(--git-added,#34d399)]');
    expect(rowStatusClass(html, 'unstaged', 'gone.ts')).toContain('text-[color:var(--git-deleted,#fb7185)]');
    expect(rowStatusClass(html, 'untracked', 'fresh.txt')).toContain('text-[color:var(--git-untracked,#38bdf8)]');
    expect(rowStatusClass(html, 'staged', 'new.ts')).toContain('text-[--text-muted]');
  });

  it('renders every row as a button labelled by its path', () => {
    const html = render(null);
    expect(html.split(`data-testid="${DIFF_TESTIDS.row}"`).length - 1).toBe(6);
    expect(html).toMatch(
      /<button type="button"[^>]*data-path="fresh.txt"[^>]*>.*<span class="truncate min-w-0">fresh.txt<\/span><\/button>/,
    );
  });
});
