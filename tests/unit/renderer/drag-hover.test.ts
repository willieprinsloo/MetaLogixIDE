import { describe, it, expect } from 'vitest';
import { createDragHover, dropKindFor } from '@renderer/drag-hover';
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

describe('createDragHover (AC19)', () => {
  it('is visible after the first enter', () => {
    expect(createDragHover().enter()).toBe(true);
  });

  it('stays visible across nested enter/leave pairs on child elements', () => {
    const hover = createDragHover();
    hover.enter();
    expect(hover.enter()).toBe(true);
    expect(hover.leave()).toBe(true);
    expect(hover.enter()).toBe(true);
    expect(hover.leave()).toBe(true);
  });

  it('hides once every enter has been matched by a leave', () => {
    const hover = createDragHover();
    hover.enter();
    hover.enter();
    hover.leave();
    expect(hover.leave()).toBe(false);
  });

  it('never goes negative on a stray leave, so a later nested drag still counts correctly', () => {
    const hover = createDragHover();
    expect(hover.leave()).toBe(false);
    expect(hover.leave()).toBe(false);
    expect(hover.enter()).toBe(true);
    expect(hover.enter()).toBe(true);
    expect(hover.leave()).toBe(true);
    expect(hover.leave()).toBe(false);
  });

  it('reset() on drop or dragend hides regardless of depth', () => {
    const hover = createDragHover();
    hover.enter();
    hover.enter();
    hover.enter();
    hover.reset();
    expect(hover.leave()).toBe(false);
    expect(hover.enter()).toBe(true);
    expect(hover.leave()).toBe(false);
  });
});

describe('dropKindFor (AC20)', () => {
  it('reads Files as a path drop', () => {
    expect(dropKindFor(['Files'])).toBe('path');
  });

  it('reads the Files-tree type as a path drop', () => {
    expect(dropKindFor([APP_FILE_DRAG_TYPE, 'text/plain'])).toBe('path');
  });

  it('reads Files with text as a path drop', () => {
    expect(dropKindFor(['text/plain', 'Files'])).toBe('path');
  });

  it('reads text/plain alone as a text drop', () => {
    expect(dropKindFor(['text/plain'])).toBe('text');
  });

  it('reads text/plain alongside non-file types as a text drop', () => {
    expect(dropKindFor(['text/uri-list', 'text/plain', 'text/html'])).toBe('text');
  });

  it.each([[['text/uri-list']], [['text/html']], [[]]])('does not accept %j', (types) => {
    expect(dropKindFor(types)).toBeNull();
  });
});
