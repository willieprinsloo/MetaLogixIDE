import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PALETTE_COPY, PALETTE_TESTIDS } from '@renderer/command-palette-contract';
import { ShortcutPlatformContext } from '@renderer/shortcut-platform';
import type { Project } from '@shared/types';

vi.mock('@renderer/api', () => ({ api: { invoke: vi.fn(async () => ({})), on: vi.fn(() => () => undefined) } }));

const { StatusBar, PaletteHint } = await import('@renderer/components/StatusBar');

const project: Project = {
  id: 1, rootId: 1, name: 'demo', path: '/p/demo', config: {},
  metaprojectProjectId: null, linkedChatChannelId: null, lastOpenedAt: null,
  pinned: false, hidden: false, firstLaunchedAt: null,
};

function render(p: Project | null = project): string {
  return renderToStaticMarkup(<StatusBar project={p} aliveCount={2} onOpenPalette={() => undefined} />);
}

function hintButton(html: string): string {
  const m = new RegExp(`<button[^>]*data-testid="${PALETTE_TESTIDS.statusHint}"[^>]*>(.*?)</button>`).exec(html);
  if (!m) throw new Error(`no palette hint button in ${html}`);
  return m[0];
}

const text = (html: string) => html.replace(/<[^>]*>/g, '');

describe('StatusBar palette hint', () => {
  it.each([project, null])('shows exactly one kbd, reading ⌘K, inside the hint button (project=%#)', (p) => {
    const html = render(p);
    const kbds = html.match(/<kbd\b[^>]*>[^<]*<\/kbd>/g) ?? [];
    expect(kbds).toEqual([`<kbd>${PALETTE_COPY.statusHintKey}</kbd>`]);
    expect(hintButton(html)).toContain(kbds[0]);
  });

  it('reads "⌘K command palette" with the accessible name "Open command palette (⌘K)"', () => {
    const button = hintButton(render());
    expect(text(button)).toBe('⌘K command palette');
    expect(button).toContain('aria-label="Open command palette (⌘K)"');
    expect(button).toContain('type="button"');
  });

  it('drops the five old hints', () => {
    const plain = text(render());
    for (const old of ['⌘K project', '⌘P file', '⌘⇧F search', '⌘B sidebar', '⌘, settings', '⌘P', '⌘⇧F', '⌘B', '⌘,']) {
      expect(plain).not.toContain(old);
    }
  });

  it('sits in the right-hand group, after the shells chip', () => {
    const html = render();
    const group = /<span class="ml-auto[^"]*">(.*)<\/span><\/div>$/.exec(html);
    expect(group?.[1]).toContain(`data-testid="${PALETTE_TESTIDS.statusHint}"`);
    expect(html.indexOf(PALETTE_TESTIDS.statusHint)).toBeGreaterThan(html.indexOf('data-testid="shells-chip"'));
  });

  it('opens the palette on click', () => {
    const onOpen = vi.fn();
    const el = PaletteHint({ onOpen });
    expect(isValidElement(el)).toBe(true);
    const { onClick } = (el as ReactElement<{ onClick?: () => void }>).props;
    expect(onClick).toBeTypeOf('function');
    onClick?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('StatusBar palette hint on Linux (AC6)', () => {
  function renderLinux(): string {
    return renderToStaticMarkup(
      <ShortcutPlatformContext.Provider value="linux">
        <StatusBar project={project} aliveCount={2} onOpenPalette={() => undefined} />
      </ShortcutPlatformContext.Provider>,
    );
  }

  it('reads "Ctrl+K command palette" with the accessible name "Open command palette (Ctrl+K)"', () => {
    const button = hintButton(renderLinux());
    expect(text(button)).toBe('Ctrl+K command palette');
    expect(button).toContain('aria-label="Open command palette (Ctrl+K)"');
    expect(button).not.toMatch(/[⌘⇧⌥⌃↩⏎]/);
  });
});
