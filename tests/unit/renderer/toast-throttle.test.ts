import { describe, test, expect } from 'vitest';
import { createToastThrottle } from '@renderer/toast-throttle';

describe('createToastThrottle', () => {
  test('first call allowed, repeat within window suppressed, allowed after window, other key independent', () => {
    let t = 1000;
    const th = createToastThrottle({ windowMs: 5000, now: () => t });
    expect(th.shouldShow('a')).toBe(true);
    t += 4999;
    expect(th.shouldShow('a')).toBe(false);
    expect(th.shouldShow('b')).toBe(true);
    t += 1;
    expect(th.shouldShow('a')).toBe(true);
  });
  test('a suppressed call does not extend the window', () => {
    let t = 0;
    const th = createToastThrottle({ windowMs: 5000, now: () => t });
    th.shouldShow('a');
    t = 3000; th.shouldShow('a');
    t = 5000;
    expect(th.shouldShow('a')).toBe(true);
  });
});
