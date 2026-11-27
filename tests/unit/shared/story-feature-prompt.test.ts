import { describe, expect, it } from 'vitest';
import {
  buildFeaturePrompt,
  extractKindAndBody,
  FEATURE_SECTIONS,
  KIND_LABEL_FEATURE,
  KIND_LABEL_MAINTENANCE,
} from '@shared/story-feature-prompt';

describe('buildFeaturePrompt', () => {
  it('names the project, labels the PR, and lists all three mandated sections', () => {
    const prompt = buildFeaturePrompt({
      projectName: 'metaIDE',
      prNumber: 26,
      title: 'fix(deps): bump majors',
      body: 'Closes a clutch of CVEs.',
      files: ['package.json', 'pnpm-lock.yaml'],
      lines: { added: 1081, removed: 831 },
    });
    expect(prompt).toContain('metaIDE');
    expect(prompt).toContain('PR #26');
    for (const heading of FEATURE_SECTIONS) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('package.json');
    expect(prompt).toContain('+1081 / -831');
  });

  it('labels a direct commit as "direct commit on main" when no PR number', () => {
    const prompt = buildFeaturePrompt({
      projectName: 'demo',
      prNumber: null,
      title: 'feat: add export',
      body: '',
      files: ['src/export.ts'],
      lines: { added: 12, removed: 0 },
    });
    expect(prompt).toContain('direct commit on main');
    expect(prompt).not.toContain('PR #null');
  });

  it('caps the file list to keep the prompt bounded even on huge PRs', () => {
    const files = Array.from({ length: 80 }, (_, i) => `src/dir/file-${i}.ts`);
    const prompt = buildFeaturePrompt({
      projectName: 'demo',
      prNumber: 1,
      title: 't',
      body: '',
      files,
      lines: { added: 1, removed: 0 },
    });
    // 30 cap — the 31st file must not appear verbatim.
    expect(prompt).toContain('file-29.ts');
    expect(prompt).not.toContain('file-30.ts');
  });
});

describe('extractKindAndBody', () => {
  it('tags the entry as MAINTENANCE and strips the trailer', () => {
    const raw = ['## What you can now do', 'No user-visible change.', '', KIND_LABEL_MAINTENANCE].join('\n');
    const { kind, body } = extractKindAndBody(raw);
    expect(kind).toBe('maintenance');
    expect(body).not.toContain('KIND:');
    expect(body).toContain('No user-visible change.');
  });

  it('tags the entry as FEATURE and strips the trailer', () => {
    const raw = ['## What you can now do', 'You can now X.', '', KIND_LABEL_FEATURE].join('\n');
    const { kind, body } = extractKindAndBody(raw);
    expect(kind).toBe('feature');
    expect(body).not.toContain('KIND:');
    expect(body).toContain('You can now X.');
  });

  it('defaults to feature when the model forgot the label — a missing trailer must not drop the entry', () => {
    const raw = '## What you can now do\nYou can now X.';
    const { kind, body } = extractKindAndBody(raw);
    expect(kind).toBe('feature');
    expect(body).toBe('## What you can now do\nYou can now X.');
  });
});
