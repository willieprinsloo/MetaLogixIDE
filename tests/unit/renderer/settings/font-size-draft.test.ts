import { describe, it, expect } from 'vitest';
import { initialDraft, onCommit, onExternalUpdate, onInput, onStep } from '@renderer/components/settings/font-size-draft';

describe('onInput', () => {
  it.each(['16', '1', '40', ''])(
    'typed text %s never saves while typing, and marks the field as holding an uncommitted edit',
    (raw) => {
      const result = onInput(raw);
      expect(result.commit).toBeNull();
      expect(result.state.draft).toBe(raw);
      expect(result.state.editing).toBe(true);
    },
  );
});

describe('onCommit', () => {
  it.each([
    ['40', 14, 28],
    ['0', 14, 9],
    ['-3', 14, 9],
  ])('blur/Enter on out-of-range %s (saved %d) clamps and commits %d', (raw, saved, commit) => {
    const result = onCommit(raw, saved);
    expect(result.commit).toBe(commit);
    expect(result.state.draft).toBe(String(commit));
    expect(result.state.editing).toBe(false);
  });

  it.each(['', 'abc', '16.5'])('blur/Enter on invalid draft %s reverts with no save', (raw) => {
    const result = onCommit(raw, 20);
    expect(result.commit).toBeNull();
    expect(result.state.draft).toBe('20');
    expect(result.state.editing).toBe(false);
  });

  it('blur/Enter on the already-saved value does not save', () => {
    const result = onCommit('16', 16);
    expect(result.commit).toBeNull();
    expect(result.state.draft).toBe('16');
    expect(result.state.editing).toBe(false);
  });

  it('resolves the edit (editing becomes false) even for an in-range change, so it no longer blocks an external update', () => {
    const result = onCommit('16', 14);
    expect(result.commit).toBe(16);
    expect(result.state.editing).toBe(false);
  });
});

describe('onStep', () => {
  it('increments the saved size and commits immediately when the field holds no unsaved edit', () => {
    const result = onStep(initialDraft(14), 14, 'in');
    expect(result.commit).toBe(15);
    expect(result.state).toEqual({ draft: '15', editing: false });
  });

  it('decrements the saved size and commits immediately when the field holds no unsaved edit', () => {
    const result = onStep(initialDraft(14), 14, 'out');
    expect(result.commit).toBe(13);
    expect(result.state).toEqual({ draft: '13', editing: false });
  });

  it('is a no-op with no commit at the maximum bound', () => {
    const result = onStep(initialDraft(28), 28, 'in');
    expect(result.commit).toBeNull();
    expect(result.state).toEqual({ draft: '28', editing: false });
  });

  it('is a no-op with no commit at the minimum bound', () => {
    const result = onStep(initialDraft(9), 9, 'out');
    expect(result.commit).toBeNull();
    expect(result.state).toEqual({ draft: '9', editing: false });
  });

  it('steps from the unsaved typed draft, not the stale saved size, when the draft is a valid whole number (gate 7b Low)', () => {
    const editing = onInput('20').state;
    const result = onStep(editing, 14, 'in');
    expect(result.commit).toBe(21);
    expect(result.state).toEqual({ draft: '21', editing: false });
  });

  it('clamps an out-of-range unsaved draft before stepping from it', () => {
    const editing = onInput('40').state;
    const result = onStep(editing, 14, 'out');
    expect(result.commit).toBe(27);
    expect(result.state).toEqual({ draft: '27', editing: false });
  });

  it('ignores an invalid unsaved draft and steps from the saved size instead', () => {
    const editing = onInput('abc').state;
    const result = onStep(editing, 14, 'in');
    expect(result.commit).toBe(15);
    expect(result.state).toEqual({ draft: '15', editing: false });
  });

  it('ignores a draft left over from before the field was focused (editing false) and steps from the saved size', () => {
    const result = onStep({ draft: '20', editing: false }, 14, 'in');
    expect(result.commit).toBe(15);
    expect(result.state).toEqual({ draft: '15', editing: false });
  });
});

describe('onExternalUpdate', () => {
  it('replaces the draft when the field is not being edited', () => {
    const state = { draft: '14', editing: false };
    expect(onExternalUpdate(state, 18)).toEqual({ draft: '18', editing: false });
  });

  it('keeps the uncommitted typed draft when the field is being edited', () => {
    const state = { draft: '1', editing: true };
    expect(onExternalUpdate(state, 18)).toEqual(state);
  });

  it('a revert after a failed save is not blocked by a value the field already resolved via commit or step', () => {
    const resolvedByCommit = onCommit('16', 14).state;
    expect(onExternalUpdate(resolvedByCommit, 14)).toEqual({ draft: '14', editing: false });
  });
});

describe('initialDraft', () => {
  it('starts from the saved value, not editing', () => {
    expect(initialDraft(14)).toEqual({ draft: '14', editing: false });
  });
});
