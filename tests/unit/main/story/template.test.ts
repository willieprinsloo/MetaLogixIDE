import { describe, expect, it } from 'vitest';
import { renderStoryHtml, type StoryTemplate } from '@main/story/template';

const base: StoryTemplate = {
  title: 'Worked on the login bug',
  subtitle: '14:00–14:15 · 15 min · 12 events · 0 chat',
  project: 'metaIDE',
  paragraphs: [
    'In this window, one agent edited 3 files and ran tests twice.',
    'Shell #0 said it was "fixing the login redirect", did 11 actions.',
  ],
  timeline: [
    { time: '14:00:01', kind: 'edit', who: 'claude#0', text: 'Write · auth.ts' },
    { time: '14:05:22', kind: 'test', who: 'claude#0', text: 'Bash · pnpm test' },
  ],
};

describe('renderStoryHtml', () => {
  it('produces a complete HTML document', () => {
    const html = renderStoryHtml(base);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('puts the title into <h1> and <title>', () => {
    const html = renderStoryHtml(base);
    expect(html).toMatch(/<title>Worked on the login bug<\/title>/);
    expect(html).toMatch(/<h1>Worked on the login bug<\/h1>/);
  });

  it('renders every paragraph as its own <p>', () => {
    const html = renderStoryHtml(base);
    expect(html).toMatch(/<p>In this window, one agent edited 3 files and ran tests twice\.<\/p>/);
    expect(html).toContain('Shell #0 said it was &quot;fixing the login redirect&quot;');
  });

  it('encloses the timeline in <details> with event count', () => {
    const html = renderStoryHtml(base);
    expect(html).toContain('<details>');
    expect(html).toContain('Timeline · 2 events');
    expect(html).toContain('Write · auth.ts');
  });

  it('colour-codes a timeline row by kind via a CSS class', () => {
    const html = renderStoryHtml(base);
    expect(html).toContain('class="k k-edit"');
    expect(html).toContain('class="k k-test"');
  });

  it('shows an empty-state message when there are no paragraphs', () => {
    const html = renderStoryHtml({ ...base, paragraphs: [] });
    expect(html).toContain('Nothing happened in this window.');
  });

  it('omits the timeline block when there are no rows', () => {
    const html = renderStoryHtml({ ...base, timeline: [] });
    expect(html).not.toContain('<details>');
    expect(html).not.toContain('Timeline');
  });

  it('escapes HTML in title, paragraphs, and timeline text', () => {
    const risky = renderStoryHtml({
      ...base,
      title: '<script>alert(1)</script>',
      paragraphs: ['A & B <b>bold</b>'],
      timeline: [{ time: 't', kind: 'tool', who: 'w', text: 'rm -rf <everything>' }],
    });
    expect(risky).not.toContain('<script>alert');
    expect(risky).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(risky).toContain('A &amp; B &lt;b&gt;bold&lt;/b&gt;');
    expect(risky).toContain('rm -rf &lt;everything&gt;');
  });

  it('declares both prefers-color-scheme and explicit data-theme dark overrides', () => {
    const html = renderStoryHtml(base);
    // When the system is dark, the chunk defaults to dark unless the IDE
    // has stamped data-theme="light" on <html>.
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain(':root:not([data-theme="light"])');
    // The IDE can override explicitly by stamping data-theme on <html>.
    expect(html).toContain(':root[data-theme="dark"]');
  });

  it('is self-contained — no external scripts or stylesheets', () => {
    const html = renderStoryHtml(base);
    expect(html).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i);
    expect(html).not.toMatch(/<script\b[^>]*src=/i);
  });
});
