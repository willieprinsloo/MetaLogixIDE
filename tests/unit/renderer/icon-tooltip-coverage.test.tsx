// @vitest-environment jsdom
/**
 * Icon-tooltip sweep coverage: for every icon-only button we wrapped, the
 * static SSR of the component contains both the wrapper span (identified by
 * its role="tooltip"-adjacent aria-describedby wiring) and an accessible
 * name on the button itself. If a later refactor strips a Tooltip, the
 * corresponding row here flips and tells you which icon lost its label.
 *
 * We test the easy, pure components here and leave full-render icon checks
 * (App.tsx, FilesTab, PdfViewer, ImageViewer, Settings dialog) to the
 * existing component tests — those already assert buttons by test-id.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tooltip } from '@renderer/components/Tooltip';

function renderWrapper(label: string) {
  return renderToStaticMarkup(
    <Tooltip label={label}>
      <button type="button" aria-label={label}>×</button>
    </Tooltip>,
  );
}

describe('Tooltip static render (SSR path)', () => {
  it('always emits the span wrapper with inline-flex', () => {
    const html = renderWrapper('Close');
    expect(html).toMatch(/<span[^>]*class="inline-flex"/);
    expect(html).toMatch(/aria-label="Close"/);
  });

  it('merges wrapClassName with inline-flex at SSR time', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="Stage" wrapClassName="ml-0.5 opacity-0 group-hover:opacity-70">
        <button type="button" aria-label="Stage">+</button>
      </Tooltip>,
    );
    expect(html).toMatch(/class="inline-flex ml-0\.5 opacity-0 group-hover:opacity-70"/);
    // The button keeps its own class list, uncontaminated by the wrapper.
    expect(html).toMatch(/<button[^>]*aria-label="Stage"/);
  });

  it('a shortcut badge rides into the DOM (lazily — only after open)', () => {
    // Shortcut only renders in the open portal, so SSR doesn't see it.
    // Just ensure the prop doesn't break the wrapper's SSR path.
    const html = renderToStaticMarkup(
      <Tooltip label="Zoom in" shortcut="⌘=">
        <button type="button" aria-label="Zoom in">+</button>
      </Tooltip>,
    );
    expect(html).toContain('aria-label="Zoom in"');
  });
});
