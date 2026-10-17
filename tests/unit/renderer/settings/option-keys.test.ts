import { describe, it, expect } from 'vitest';
import { nextOptionIndex } from '@renderer/components/settings/option-keys';

describe('nextOptionIndex', () => {
  it.each([
    [0, 'ArrowRight', 1],
    [1, 'ArrowRight', 2],
    [2, 'ArrowRight', 0],
    [0, 'ArrowDown', 1],
    [2, 'ArrowDown', 0],
  ])('index %i + %s advances to %i, wrapping at the end', (current, key, next) => {
    expect(nextOptionIndex(current, 3, key)).toBe(next);
  });

  it.each([
    [2, 'ArrowLeft', 1],
    [1, 'ArrowLeft', 0],
    [0, 'ArrowLeft', 2],
    [1, 'ArrowUp', 0],
    [0, 'ArrowUp', 2],
  ])('index %i + %s retreats to %i, wrapping at the start', (current, key, next) => {
    expect(nextOptionIndex(current, 3, key)).toBe(next);
  });

  it.each(['Enter', ' ', 'Tab', 'Home', 'a', 'arrowright'])('%j is not a move', (key) => {
    expect(nextOptionIndex(0, 4, key)).toBeNull();
  });

  it('wraps correctly for a 4-option group', () => {
    expect(nextOptionIndex(3, 4, 'ArrowRight')).toBe(0);
    expect(nextOptionIndex(0, 4, 'ArrowLeft')).toBe(3);
  });
});
