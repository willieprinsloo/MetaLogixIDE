import { describe, expect, it, vi } from 'vitest';
import { keepAwakeHandlers as h } from '@main/keep-awake/handlers';
import type { Services } from '@main/services';

function withCtl() {
  const ctl = {
    get: vi.fn(() => ({ active: false as const })),
    start: vi.fn((endsAt: number) => ({ ok: true as const, state: { active: true as const, endsAt } })),
    stop: vi.fn(() => ({ active: false as const })),
    darkenNow: vi.fn(() => ({ ok: true as const })),
    dispose: vi.fn(),
  };
  return { ctl, s: { keepAwake: ctl } as unknown as Services };
}
const none = { keepAwake: null } as unknown as Services;

describe('keepAwakeHandlers', () => {
  it('delegates to the controller', async () => {
    const { ctl, s } = withCtl();
    expect(await h['keep-awake:start'](s, { endsAt: 123 })).toEqual({ ok: true, state: { active: true, endsAt: 123 } });
    expect(ctl.start).toHaveBeenCalledWith(123);
    expect(await h['keep-awake:get'](s, undefined)).toEqual({ active: false });
    expect(await h['keep-awake:stop'](s, undefined)).toEqual({ active: false });
    expect(await h['keep-awake:darken'](s, undefined)).toEqual({ ok: true });
  });

  it.each([
    ['float', { endsAt: 1.5 }],
    ['NaN', { endsAt: Number.NaN }],
    ['Infinity', { endsAt: Number.POSITIVE_INFINITY }],
    ['string', { endsAt: '123' }],
    ['missing', {}],
    ['null', null],
    ['undefined', undefined],
    ['number', 5],
  ])('start rejects %s as invalid without calling the controller', async (_n, req) => {
    const { ctl, s } = withCtl();
    expect(await h['keep-awake:start'](s, req as { endsAt: number })).toEqual({ ok: false, error: 'invalid' });
    expect(ctl.start).not.toHaveBeenCalled();
  });

  it('answers unsupported / inactive when the controller is null', async () => {
    expect(await h['keep-awake:start'](none, { endsAt: 5 })).toEqual({ ok: false, error: 'unsupported' });
    expect(await h['keep-awake:start'](none, {} as { endsAt: number })).toEqual({ ok: false, error: 'unsupported' });
    expect(await h['keep-awake:get'](none, undefined)).toEqual({ active: false });
    expect(await h['keep-awake:stop'](none, undefined)).toEqual({ active: false });
    expect(await h['keep-awake:darken'](none, undefined)).toEqual({ ok: false, error: 'unsupported' });
  });
});
