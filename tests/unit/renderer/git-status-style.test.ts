import { describe, it, expect } from 'vitest';
import type { GitFileStatus } from '@shared/ipc-contract';
import { gitStatusTextClass } from '@renderer/git-status-style';

describe('gitStatusTextClass', () => {
  it.each<[GitFileStatus, string]>([
    ['M', 'text-[color:var(--git-modified,#fbbf24)]'],
    ['A', 'text-[color:var(--git-added,#34d399)]'],
    ['D', 'text-[color:var(--git-deleted,#fb7185)]'],
    ['?', 'text-[color:var(--git-untracked,#38bdf8)]'],
    ['R', 'text-[--text-muted]'],
    ['U', 'text-[--text-muted]'],
    ['!', 'text-[--text-muted]'],
  ])('gives %s the Git panel colour %s', (status, cls) => {
    expect(gitStatusTextClass(status)).toBe(cls);
  });
});
