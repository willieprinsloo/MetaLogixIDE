import type { GitFileStatus } from '@shared/ipc-contract';

const STATUS_TEXT_CLASS: Partial<Record<GitFileStatus, string>> = {
  M: 'text-[color:var(--git-modified,#fbbf24)]',
  A: 'text-[color:var(--git-added,#34d399)]',
  D: 'text-[color:var(--git-deleted,#fb7185)]',
  '?': 'text-[color:var(--git-untracked,#38bdf8)]',
};

/** Tailwind text colour for a one-letter git status, shared by the Git panel and the Diff tab so a status looks the same in both (spec AC8). Each hue is the Tailwind -400 colour unless a `--git-*` token overrides it; only the macOS chrome sets those, lifting the Git panel letters to 4.5:1 over the frosted material (frosted-chrome D16). */
export function gitStatusTextClass(status: GitFileStatus): string {
  return STATUS_TEXT_CLASS[status] ?? 'text-[--text-muted]';
}
