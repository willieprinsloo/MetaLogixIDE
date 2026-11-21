import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShortcutsHelp } from '@renderer/components/ShortcutsHelp';
import { MODAL_CLASSES, MODAL_TIER_Z, scrimTestId } from '@renderer/modal-glass';
import { ShortcutPlatformContext } from '@renderer/shortcut-platform';

const TEST_ID = 'shortcuts-help';

function render(open = true): string {
  return renderToStaticMarkup(<ShortcutsHelp open={open} onClose={() => undefined} />);
}

const text = (html: string) => html.replace(/<[^>]*>/g, '');

/** Every shortcut row (a dt/dd pair) as its visible label and the kbd texts on that row. */
function rows(html: string): Array<{ label: string; keys: string[] }> {
  return [...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((m) => ({
    label: text(m[1] ?? ''),
    keys: [...(m[2] ?? '').matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((k) => k[1] ?? ''),
  }));
}

function openingTag(html: string, attr: string): string {
  const m = new RegExp(`<\\w+[^>]*${attr}[^>]*>`).exec(html);
  if (!m) throw new Error(`no element with ${attr} in ${html}`);
  return m[0];
}

const classes = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/) ?? [];

describe('ShortcutsHelp', () => {
  it('makes the dialog itself focusable so it can take focus on open (aria-modal)', () => {
    const dialog = openingTag(render(), 'role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain('tabindex="-1"');
  });

  it('renders nothing while closed', () => {
    expect(render(false)).toBe('');
  });

  it('lists ⌘K as "Command palette" with ⌘⇧P as an alternative on the same row (AC19)', () => {
    const palette = rows(render()).filter((r) => r.label === 'Command palette');
    expect(palette).toEqual([{ label: 'Command palette', keys: ['⌘K', '⌘⇧P'] }]);
  });

  it('has no "Project switcher" row and no standalone ⌘⇧P row', () => {
    const all = rows(render());
    expect(all.length).toBeGreaterThan(5);
    expect(all.some((r) => /project switcher/i.test(r.label))).toBe(false);
    expect(all.filter((r) => r.keys.includes('⌘⇧P'))).toHaveLength(1);
    expect(all.filter((r) => r.keys.includes('⌘K'))).toHaveLength(1);
    expect(text(render())).not.toMatch(/project switcher/i);
  });

  it('keeps the other shortcuts', () => {
    const keys = rows(render()).flatMap((r) => r.keys);
    for (const k of ['⌘P', '⌘⇧F', '⌘B', '⌘,', '⌘/', '⌘⇧N', '⌘F', '⌘⇧O', '⌘⇧K', '⌘=', '⌘-', '⌘0']) {
      expect(keys).toContain(k);
    }
  });

  it('renders through ModalFrame: the scrim and the layer are siblings at the modal tier with no fade (AC21)', () => {
    const html = render();
    const scrim = openingTag(html, `data-testid="${scrimTestId(TEST_ID)}"`);
    const layer = openingTag(html, `data-testid="${TEST_ID}"`);
    expect(classes(scrim)).toContain(MODAL_CLASSES.scrim);
    expect(classes(scrim)).not.toContain(MODAL_CLASSES.fadeScrim);
    expect(classes(layer)).toContain(MODAL_CLASSES.layer);
    expect(scrim).toContain(`z-index:${MODAL_TIER_Z.modal[0]}`);
    expect(layer).toContain(`z-index:${MODAL_TIER_Z.modal[1]}`);
    expect(html.startsWith(`${scrim}</div>`)).toBe(true);
  });

  it('puts the dialog on a dialog-radius modal sheet, with muted text from --modal-text-muted', () => {
    const html = render();
    const dialog = openingTag(html, 'role="dialog"');
    expect(classes(dialog)).toContain(MODAL_CLASSES.sheet);
    expect(classes(dialog)).not.toContain(MODAL_CLASSES.sheetCompact);
    expect(dialog).toContain('aria-modal="true"');
    expect(html).toContain('text-[--modal-text-muted]');
    expect(html).not.toContain('text-[--text-muted]');
    expect(html).not.toMatch(/bg-black\/\d+|backdrop-blur|bg-\[--panel-strong\]|shadow-2xl/);
  });

  it('names the dialog by its heading', () => {
    const html = render();
    const id = /aria-labelledby="([^"]+)"/.exec(openingTag(html, 'role="dialog"'))?.[1];
    expect(id).toBeTruthy();
    expect(new RegExp(`<h2 id="${id}"[^>]*>([^<]*)</h2>`).exec(html)?.[1]).toBe('Keyboard shortcuts');
  });
});

describe('ShortcutsHelp on Linux (AC6, AC13)', () => {
  const linux = () => renderToStaticMarkup(
    <ShortcutPlatformContext.Provider value="other">
      <ShortcutsHelp open onClose={() => undefined} />
    </ShortcutPlatformContext.Provider>,
  );

  /** Every row's label and its keys, each flagged when it carries the terminal marker. */
  function linuxRows(html: string): Array<{ label: string; keys: Array<{ key: string; shell: boolean }> }> {
    return [...html.matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((m) => ({
      label: text(m[1] ?? ''),
      keys: [...(m[2] ?? '').matchAll(/(<span data-terminal-shell="true"[^>]*>)?<kbd>([^<]*)<\/kbd>/g)]
        .map((k) => ({ key: k[2] ?? '', shell: k[1] !== undefined })),
    }));
  }

  const note = (html: string) => text(/<p[^>]*data-testid="shortcuts-terminal-note"[^>]*>(.*?)<\/p>/.exec(html)?.[1] ?? '');

  it('labels every row in the Ctrl+ form, keeping the palette alternative on one row', () => {
    const all = linuxRows(linux());
    expect(all.find((r) => r.label === 'Command palette')?.keys.map((k) => k.key)).toEqual(['Ctrl+K', 'Ctrl+Shift+P']);
    expect(all.flatMap((r) => r.keys.map((k) => k.key))).toEqual([
      'Ctrl+K', 'Ctrl+Shift+P', 'Ctrl+P', 'Ctrl+Shift+F', 'Ctrl+B', 'Ctrl+J', 'Ctrl+,', 'Ctrl+/',
      'Ctrl+Shift+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+F', 'Ctrl+Shift+O', 'Ctrl+Shift+K', 'Ctrl+=', 'Ctrl+-', 'Ctrl+0',
    ]);
  });

  it('marks exactly the shortcuts the shell keeps while the terminal is focused', () => {
    const marked = linuxRows(linux()).flatMap((r) => r.keys).filter((k) => k.shell).map((k) => k.key);
    expect(marked.sort()).toEqual(['Ctrl+B', 'Ctrl+P', 'Ctrl+T']);
  });

  it('lists Ctrl+F as "Find in terminal", unmarked', () => {
    const row = linuxRows(linux()).find((r) => r.label === 'Find in terminal');
    expect(row?.keys).toEqual([{ key: 'Ctrl+F', shell: false }]);
  });

  it('gives the sidebar row no Ctrl+\\ alternative', () => {
    expect(linuxRows(linux()).find((r) => r.label === 'Toggle sidebar')?.keys.map((k) => k.key)).toEqual(['Ctrl+B']);
  });

  it('names every shell-owned key, Ctrl+\\ included, and Ctrl+Shift+P as the way to the palette', () => {
    const n = note(linux());
    for (const k of ['Ctrl+P', 'Ctrl+B', 'Ctrl+T', 'Ctrl+\\', 'Ctrl+Shift+P']) expect(n).toContain(k);
    expect(n).not.toMatch(/Ctrl\+K\b/);
  });

  it('gives each marked key a text alternative, not just a glyph', () => {
    const marker = /<span data-terminal-shell="true"[^>]*>.*?<\/span><\/span>/.exec(linux())?.[0] ?? '';
    expect(marker).toMatch(/<span class="sr-only">[^<]+<\/span>/);
    expect(marker).toContain('aria-hidden="true"');
  });

  it('adds neither marker nor terminal note on mac (AC7)', () => {
    const html = render();
    expect(html).not.toContain('data-terminal-shell');
    expect(html).not.toContain('shortcuts-terminal-note');
  });
});
