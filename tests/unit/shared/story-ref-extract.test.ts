import { describe, expect, it } from 'vitest';
import { extractTicketRefs, githubPrUrl, parseGithubRepoUrl } from '@shared/story-ref-extract';

describe('extractTicketRefs', () => {
  it('pulls a metaproject-style ref out of a PR title', () => {
    expect(extractTicketRefs('fix(terminal): Ctrl+V on Windows (METAI-7)')).toEqual(['METAI-7']);
  });

  it('is case-insensitive on input and normalises output to upper', () => {
    expect(extractTicketRefs('closes metai-7 and metAI-8')).toEqual(['METAI-7', 'METAI-8']);
  });

  it('deduplicates repeats and preserves first-seen order', () => {
    expect(extractTicketRefs('METAI-9 extends METAI-7; see METAI-9 and METAI-8')).toEqual(['METAI-9', 'METAI-7', 'METAI-8']);
  });

  it('respects the identifier shape: 2-10 alnum starting with a letter, 1-6 digit tail', () => {
    // AB-1 passes (2 letters). 1-2 fails (digit start). A-3 fails (1 letter).
    // TOOLONGIDENT-9 fails (12 letters > 10 max). ABCDEFGHIJ-7 passes (10 letters,
    // exactly at the boundary). PROJ99-123 passes (letters + digits mix).
    expect(extractTicketRefs('AB-1 ok, 1-2 not, A-3 not, TOOLONGIDENT-9 not, ABCDEFGHIJ-7 ok, PROJ99-123 ok')).toEqual([
      'AB-1',
      'ABCDEFGHIJ-7',
      'PROJ99-123',
    ]);
  });

  it('ignores refs inside words, so `aMETAI-7b` doesn\'t match', () => {
    expect(extractTicketRefs('aMETAI-7b and METAI-7 alone')).toEqual(['METAI-7']);
  });

  it('returns an empty array for null/undefined/empty — safe to fan into optional fields', () => {
    expect(extractTicketRefs(null)).toEqual([]);
    expect(extractTicketRefs(undefined)).toEqual([]);
    expect(extractTicketRefs('')).toEqual([]);
  });
});

describe('parseGithubRepoUrl', () => {
  it('converts the ssh remote to the HTTPS web URL', () => {
    expect(parseGithubRepoUrl('git@github.com:double-eye-za/MetaLogixIDE.git')).toBe('https://github.com/double-eye-za/MetaLogixIDE');
  });

  it('strips an http(s):// remote with or without the .git tail', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo');
    expect(parseGithubRepoUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
    expect(parseGithubRepoUrl('http://github.com/owner/repo')).toBe('https://github.com/owner/repo');
  });

  it('returns null for non-github remotes (self-hosted forges, missing values)', () => {
    expect(parseGithubRepoUrl(null)).toBeNull();
    expect(parseGithubRepoUrl(undefined)).toBeNull();
    expect(parseGithubRepoUrl('')).toBeNull();
    expect(parseGithubRepoUrl('git@gitlab.com:owner/repo.git')).toBeNull();
    expect(parseGithubRepoUrl('weird')).toBeNull();
  });
});

describe('githubPrUrl', () => {
  it('composes the PR deep link when both repoUrl and prNumber are known', () => {
    expect(githubPrUrl('https://github.com/owner/repo', 42)).toBe('https://github.com/owner/repo/pull/42');
  });

  it('is null when either piece is missing — callers can hide the link on a bare check', () => {
    expect(githubPrUrl(null, 42)).toBeNull();
    expect(githubPrUrl('https://github.com/owner/repo', null)).toBeNull();
  });
});
