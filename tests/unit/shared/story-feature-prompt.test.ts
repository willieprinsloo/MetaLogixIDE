import { describe, expect, it } from 'vitest';
import {
  buildFeaturePrompt,
  extractKindAndBody,
  KIND_LABEL_FEATURE,
  KIND_LABEL_MAINTENANCE,
  splitHeadlineAndBody,
} from '@shared/story-feature-prompt';

describe('buildFeaturePrompt (newsfeed voice)', () => {
  it('names the project, labels the PR, and mandates a `# headline` plus one-paragraph body', () => {
    const prompt = buildFeaturePrompt({
      projectName: 'metaIDE',
      prNumber: 26,
      title: 'fix(deps): bump majors',
      body: 'Closes a clutch of CVEs.',
      files: ['package.json', 'pnpm-lock.yaml'],
      lines: { added: 1081, removed: 831 },
    });
    expect(prompt).toContain("metaIDE's feature newsfeed");
    expect(prompt).toContain('PR #26');
    // The prompt must specify the exact output shape — `# <headline>`
    // + a body paragraph + the kind trailer. A reader looking at the
    // prompt should see each of those three pieces named.
    expect(prompt).toContain('# <headline>');
    expect(prompt).toContain('KIND: FEATURE');
    // Changed-files are embedded so the model can hint at one path
    // without inventing one.
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
    expect(prompt).toContain('file-29.ts');
    expect(prompt).not.toContain('file-30.ts');
  });
});

describe('extractKindAndBody', () => {
  it('tags the entry as MAINTENANCE and strips the trailer', () => {
    const raw = ['# Internal cleanup: lint sweep', '', 'Removed a stray console.log.', '', KIND_LABEL_MAINTENANCE].join('\n');
    const { kind, body } = extractKindAndBody(raw);
    expect(kind).toBe('maintenance');
    expect(body).not.toContain('KIND:');
    expect(body).toContain('# Internal cleanup');
  });

  it('tags the entry as FEATURE and strips the trailer', () => {
    const raw = ['# Pressing ⌘K opens the palette', '', 'One-step fuzzy open.', '', KIND_LABEL_FEATURE].join('\n');
    const { kind, body } = extractKindAndBody(raw);
    expect(kind).toBe('feature');
    expect(body).not.toContain('KIND:');
    expect(body).toContain('Pressing ⌘K');
  });

  it('defaults to feature when the model forgot the label — a missing trailer must not drop the entry', () => {
    const raw = '# Headline\n\nBody.';
    const { kind, body } = extractKindAndBody(raw);
    expect(kind).toBe('feature');
    expect(body).toBe('# Headline\n\nBody.');
  });
});

describe('splitHeadlineAndBody', () => {
  it('pulls the first `# ` line out as the headline and returns the rest as body', () => {
    const { headline, body } = splitHeadlineAndBody('# The chip now links to the board\n\nShort post body.');
    expect(headline).toBe('The chip now links to the board');
    expect(body).toBe('Short post body.');
  });

  it('skips a blank line between heading and body cleanly', () => {
    const { headline, body } = splitHeadlineAndBody('# Headline\n\n\nMultiline\nbody text.');
    expect(headline).toBe('Headline');
    expect(body).toContain('Multiline\nbody text.');
  });

  it('returns null headline + full body when the entry has no `# ` heading (older format)', () => {
    const { headline, body } = splitHeadlineAndBody('## What you can now do\nYou can now X.');
    expect(headline).toBeNull();
    expect(body).toContain('## What you can now do');
  });

  it('is robust to blank input', () => {
    const { headline, body } = splitHeadlineAndBody('');
    expect(headline).toBeNull();
    expect(body).toBe('');
  });
});
