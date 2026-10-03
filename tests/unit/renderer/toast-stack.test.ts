import { describe, it, expect } from 'vitest';
import { mergeToasts } from '@renderer/components/ToastStack';
import type { Toast } from '@renderer/hooks/useToasts';

const t = (id: number): Toast => ({ id, kind: 'info', title: `t${id}`, timeoutMs: 0 });

describe('mergeToasts', () => {
  it('adds new toasts in front, not leaving', () => {
    const out = mergeToasts([{ toast: t(1), leaving: false }], [t(2), t(1)]);
    expect(out.map((e) => [e.toast.id, e.leaving])).toEqual([[2, false], [1, false]]);
  });

  it('keeps a dismissed toast in place, marked leaving', () => {
    const rendered = [t(3), t(2), t(1)].map((toast) => ({ toast, leaving: false }));
    const out = mergeToasts(rendered, [t(3), t(1)]);
    expect(out.map((e) => [e.toast.id, e.leaving])).toEqual([[3, false], [2, true], [1, false]]);
  });

  it('leaves an already-leaving entry untouched', () => {
    const leaving = { toast: t(1), leaving: true };
    expect(mergeToasts([leaving], [])[0]).toBe(leaving);
  });

  it('returns nothing for an empty stack', () => {
    expect(mergeToasts([], [])).toEqual([]);
  });
});
