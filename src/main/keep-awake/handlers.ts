/**
 * IPC handlers for the macOS keep-awake timer. The request shape is checked
 * by hand (finite integer `endsAt`); the range check lives in the service.
 * Expected failures come back as result values, and a null controller
 * (non-darwin) answers `unsupported` or inactive.
 */
import type { Handler } from '@main/ipc/register';
import type { KeepAwakeState } from '@shared/keep-awake-contract';

type KeepAwakeChannel = 'keep-awake:get' | 'keep-awake:start' | 'keep-awake:stop' | 'keep-awake:darken';

const INACTIVE: KeepAwakeState = { active: false };

function hasEndsAt(req: unknown): req is { endsAt: number } {
  return typeof req === 'object' && req !== null && Number.isSafeInteger((req as { endsAt?: unknown }).endsAt);
}

/** IPC handlers for the keep-awake timer. */
export const keepAwakeHandlers: { [C in KeepAwakeChannel]: Handler<C> } = {
  'keep-awake:get': async (s) => s.keepAwake?.get() ?? INACTIVE,
  'keep-awake:start': async (s, req) => {
    if (!s.keepAwake) return { ok: false, error: 'unsupported' };
    if (!hasEndsAt(req)) return { ok: false, error: 'invalid' };
    return s.keepAwake.start(req.endsAt);
  },
  'keep-awake:stop': async (s) => s.keepAwake?.stop() ?? INACTIVE,
  'keep-awake:darken': async (s) => s.keepAwake?.darkenNow() ?? { ok: false, error: 'unsupported' },
};
