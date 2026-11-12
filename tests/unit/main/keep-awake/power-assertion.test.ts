import { describe, expect, it, vi } from 'vitest';
import { createPowerAssertion } from '@main/keep-awake/power-assertion';

function setup() {
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
  return { blocker, a: createPowerAssertion(blocker) };
}

describe('createPowerAssertion', () => {
  it('holds prevent-app-suspension once, never display sleep', () => {
    const { blocker, a } = setup();
    a.hold();
    a.hold();
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
  });
  it('releases the held id exactly once', () => {
    const { blocker, a } = setup();
    a.hold();
    a.release();
    a.release();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.stop).toHaveBeenCalledWith(7);
  });
  it('release without hold does nothing; hold works again after release', () => {
    const { blocker, a } = setup();
    a.release();
    expect(blocker.stop).not.toHaveBeenCalled();
    a.hold();
    a.release();
    a.hold();
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
