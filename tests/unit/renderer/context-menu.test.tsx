import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextMenu, nextEnabledIndex, type ContextMenuItem } from '@renderer/components/ContextMenu';

const noop = () => undefined;

function render(items: ContextMenuItem[], autoFocus?: boolean): string {
  return renderToStaticMarkup(<ContextMenu x={10} y={20} items={items} onClose={noop} autoFocus={autoFocus} />);
}

const legacyItems: ContextMenuItem[] = [
  { label: 'Open', onClick: noop, separatorAfter: true },
  { label: 'Locked', onClick: noop, disabled: true },
  { label: 'Delete', onClick: noop, danger: true },
];

describe('ContextMenu item extensions', () => {
  it('renders an item hint as text after the label', () => {
    const html = render([{ label: 'New project…', hint: '⌘⇧N', onClick: noop }]);
    expect(html).toMatch(/<span>New project…<\/span><span[^>]*>⌘⇧N<\/span><\/button>/);
  });

  it('renders testId as data-testid on the item button', () => {
    const html = render([{ label: 'Add', testId: 'add-item', onClick: noop }]);
    expect(html).toMatch(/<button[^>]*data-testid="add-item"[^>]*>/);
  });

  it('renders existing callers exactly as before', () => {
    expect(render(legacyItems)).toMatchInlineSnapshot(`"<div class="fixed inset-0 z-40"></div><div class="fixed z-50 min-w-[200px] rounded-md border border-[--border] bg-[--panel-strong] shadow-xl backdrop-blur-md py-1 text-sm" role="menu" data-overlay="true" data-testid="context-menu" style="left:10px;top:20px;transform-origin:0px 0px;opacity:0;transform:scale(0.97)"><div><button class="w-full text-left px-3 py-1 flex items-center justify-between gap-3 text-[--text] hover:bg-[--panel]" role="menuitem"><span>Open</span></button><div class="my-1 h-px bg-[--border]"></div></div><div><button disabled="" class="w-full text-left px-3 py-1 flex items-center justify-between gap-3 text-[--text-muted] cursor-not-allowed opacity-60" role="menuitem"><span>Locked</span></button></div><div><button class="w-full text-left px-3 py-1 flex items-center justify-between gap-3 text-[--danger] hover:bg-[--danger]/15" role="menuitem"><span>Delete</span></button></div></div>"`);
  });

  it('renders the same markup when autoFocus is set', () => {
    expect(render(legacyItems, true)).toBe(render(legacyItems));
  });
});

describe('nextEnabledIndex', () => {
  const items = (flags: boolean[]): ContextMenuItem[] =>
    flags.map((disabled, i) => ({ label: `i${i}`, onClick: noop, disabled }));

  it('moves down and up by one between enabled items', () => {
    const list = items([false, false, false]);
    expect(nextEnabledIndex(list, 0, 1)).toBe(1);
    expect(nextEnabledIndex(list, 2, -1)).toBe(1);
  });

  it('wraps past either end', () => {
    const list = items([false, false, false]);
    expect(nextEnabledIndex(list, 2, 1)).toBe(0);
    expect(nextEnabledIndex(list, 0, -1)).toBe(2);
  });

  it('skips disabled items, including across the wrap', () => {
    const list = items([true, false, true, false, true]);
    expect(nextEnabledIndex(list, 1, 1)).toBe(3);
    expect(nextEnabledIndex(list, 3, 1)).toBe(1);
    expect(nextEnabledIndex(list, 1, -1)).toBe(3);
  });

  it('finds the first enabled item when starting before the list', () => {
    expect(nextEnabledIndex(items([true, true, false]), -1, 1)).toBe(2);
  });

  it('stays on the only enabled item', () => {
    expect(nextEnabledIndex(items([true, false, true]), 1, 1)).toBe(1);
  });

  it('returns -1 when every item is disabled or the list is empty', () => {
    expect(nextEnabledIndex(items([true, true]), 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
  });
});
