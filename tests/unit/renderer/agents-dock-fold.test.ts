/** The Agents dock fold's pure state machine: which setting and context changes slide (docs/specs/agents-dock-slide.md). */
import { describe, expect, it } from 'vitest';
import {
  completeDockFold,
  dockFoldCustom,
  initialDockFold,
  stepDockFold,
  type DockFoldState,
  type DockToggleSource,
} from '@renderer/agents-dock-fold';
import { paneFoldTarget } from '@renderer/pane-fold';
import { PANE_EASE, PANE_ENTER_S, PANE_EXIT_S, REDUCED_FADE_S } from '@renderer/motion-tokens';

const closed = (context = true): DockFoldState => initialDockFold({ setting: false, context });
const flip = (prev: DockFoldState, source: DockToggleSource): DockFoldState =>
  stepDockFold(prev, { setting: !prev.setting, context: prev.context, source });

describe('stepDockFold', () => {
  it('slides a pointer open and a pointer close, holding while it folds (AC1, AC2)', () => {
    const opened = flip(closed(), 'pointer');
    expect(opened).toEqual({ setting: true, context: true, animate: true, folding: true });
    const settled = completeDockFold(opened);
    expect(flip(settled, 'pointer')).toEqual({ setting: false, context: true, animate: true, folding: true });
  });

  it.each<DockToggleSource>(['shortcut', 'migration'])('switches a %s flip in one step, with no hold (AC9, AC10, AC16)', (source) => {
    expect(flip(closed(), source)).toEqual({ setting: true, context: true, animate: false, folding: false });
  });

  it('ends a pointer slide in one step when a shortcut flips it mid-fold, holding until the fold completes (AC11, AC13)', () => {
    const ended = flip(flip(closed(), 'pointer'), 'shortcut');
    expect(ended).toEqual({ setting: false, context: true, animate: false, folding: true });
    expect(stepDockFold(ended, { setting: false, context: true, source: 'shortcut' })).toBe(ended);
    expect(completeDockFold(ended)).toEqual({ setting: false, context: true, animate: false, folding: false });
  });

  it('keeps folding when a second pointer flip reverses the slide (AC6)', () => {
    const reversed = flip(flip(closed(), 'pointer'), 'pointer');
    expect(reversed).toEqual({ setting: false, context: true, animate: true, folding: true });
  });

  it('switches in one step and drops the hold when the context changes alone (AC18, AC20, AC22)', () => {
    const sliding = flip(closed(), 'pointer');
    const hidden = stepDockFold(sliding, { setting: true, context: false, source: 'pointer' });
    expect(hidden).toEqual({ setting: true, context: false, animate: false, folding: false });
    expect(stepDockFold(hidden, { setting: true, context: true, source: 'pointer' }))
      .toEqual({ setting: true, context: true, animate: false, folding: false });
  });

  it('switches in one step when the context and the setting change together (AC21, AC22)', () => {
    const sliding = flip(closed(), 'pointer');
    expect(stepDockFold(sliding, { setting: false, context: false, source: 'pointer' }))
      .toEqual({ setting: false, context: false, animate: false, folding: false });
  });

  it('does not slide a pointer flip while the context hides the dock (AC21)', () => {
    expect(flip(closed(false), 'pointer')).toEqual({ setting: true, context: false, animate: false, folding: false });
  });

  it.each<DockToggleSource>(['shortcut', 'migration'])('snaps a pointer slide to its end in one step when a %s leaves the setting as it is, holding until the fold completes (AC11, AC13)', (source) => {
    const sliding = flip(closed(), 'pointer');
    const snapped = stepDockFold(sliding, { setting: true, context: true, source });
    expect(snapped).toEqual({ setting: true, context: true, animate: false, folding: true });
    expect(stepDockFold(snapped, { setting: true, context: true, source })).toBe(snapped);
  });

  it('returns the same state when neither input changed and nothing is folding, whatever the source (AC24)', () => {
    const sliding = flip(closed(), 'pointer');
    expect(stepDockFold(sliding, { setting: true, context: true, source: 'pointer' })).toBe(sliding);
    const rest = completeDockFold(sliding);
    expect(stepDockFold(rest, { setting: true, context: true, source: 'pointer' })).toBe(rest);
    expect(stepDockFold(rest, { setting: true, context: true, source: 'shortcut' })).toBe(rest);
  });
});

describe('completeDockFold', () => {
  it('clears folding and keeps the rest (AC13)', () => {
    expect(completeDockFold(flip(closed(), 'pointer'))).toEqual({ setting: true, context: true, animate: true, folding: false });
  });

  it('returns the same state when nothing is folding, so a one-step completion re-renders nothing', () => {
    const rest = closed();
    expect(completeDockFold(rest)).toBe(rest);
  });
});

describe('dockFoldCustom', () => {
  it('resolves a pointer slide to the shared fold durations and easing (AC3)', () => {
    const custom = dockFoldCustom(flip(closed(), 'pointer'), false);
    expect(custom).toEqual({ instant: false, reduced: false });
    expect(paneFoldTarget('enter', custom).transition).toEqual({ duration: PANE_ENTER_S, ease: PANE_EASE });
    expect(paneFoldTarget('exit', custom).transition).toEqual({ duration: PANE_EXIT_S, ease: PANE_EASE });
  });

  it('resolves a reduced-motion pointer slide to the shared fade (AC12)', () => {
    const custom = dockFoldCustom(flip(closed(), 'pointer'), true);
    expect(custom).toEqual({ instant: false, reduced: true });
    const enter = paneFoldTarget('enter', custom).transition as { opacity: { duration: number } };
    expect(enter.opacity.duration).toBe(REDUCED_FADE_S);
  });

  it('resolves a shortcut or context switch to one step, even under reduced motion (AC9, AC12, AC18)', () => {
    expect(dockFoldCustom(flip(closed(), 'shortcut'), true)).toEqual({ instant: true, reduced: true });
    expect(paneFoldTarget('enter', dockFoldCustom(closed(), false)).transition).toEqual({ duration: 0 });
  });
});
