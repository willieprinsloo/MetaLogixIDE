/** AC8: the remote pane draws no sheet of its own; only the standalone inline tabs round the terminal's bottom corners. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../../../src/renderer/styles.css'), 'utf8');
const squash = (text: string): string => text.replace(/\s+/g, ' ');
const sheet = squash(css);

describe('remote pane stylesheet rules (AC8)', () => {
  it.each([
    ['(a) the header-row border workaround', '.workspace-header-row:has(> .shell-tabs-bar) + .workspace-sheet:has([data-testid="remote-project-pane"] [data-sheet-content="shell"])'],
    ['(b) the header-row radius workaround', '.workspace-header-row:has(> .shell-tabs-bar) + .workspace-sheet [data-testid="remote-project-pane"] [data-sheet-content="shell"]'],
  ])('does not contain %s', (_label, selector) => {
    expect(sheet).not.toContain(selector);
  });

  it('does not contain the bare pane radius rule', () => {
    expect(sheet).not.toMatch(/(^|[}\s])\[data-testid="remote-project-pane"\]\s*\{\s*--terminal-pane-radius:\s*0 0 13px 13px;\s*\}/);
  });

  it('contains the standalone inline-tabs rule', () => {
    expect(sheet).toContain('[data-testid="remote-project-pane"] [data-testid="remote-shell-tabs"] + * { --terminal-pane-radius: 0 0 13px 13px; }');
  });
});
