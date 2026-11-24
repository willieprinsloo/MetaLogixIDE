// @vitest-environment jsdom
/** Rendered HTML preview: sandboxed metafile:// iframe when viewing, source editor when editing. */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@renderer/api', () => ({ api: { invoke: async () => ({ entries: [] }) } }));

import { FilePreview } from '@renderer/components/FilesTab';
import type { OpenFile } from '@renderer/components/FilesTab';

const htmlFile = (editing: boolean): OpenFile => ({
  relPath: 'docs/my report.html', content: '<p>hi</p>', buffer: '<p>hi</p>', kind: 'text', editing,
});

const render = (file: OpenFile) =>
  renderToStaticMarkup(
    <FilePreview
      projectId={7} file={file} scrollToLine={null}
      onScrolled={() => {}} onChange={() => {}} onToggleEdit={() => {}}
      onSave={() => {}} dirty={false} isFullscreen={false} onFullscreenToggle={() => {}}
    />,
  );

describe('FilePreview html rendering', () => {
  it('renders a sandboxed metafile iframe when not editing', () => {
    const html = render(htmlFile(false));
    const iframe = /<iframe\b[^>]*>/.exec(html)?.[0] ?? '';
    expect(iframe).toContain('src="metafile://p/7/docs/my%20report.html"');
    expect(iframe).toContain('sandbox=""');
  });

  it('shows source (no iframe) when editing', () => {
    const html = render(htmlFile(true));
    expect(html).not.toContain('<iframe');
    expect(html).toContain('data-testid="file-edit-toggle"');
    expect(html).toContain('Preview');
  });
});
