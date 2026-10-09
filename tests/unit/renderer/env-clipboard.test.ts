import { describe, expect, it, vi } from 'vitest';
import { copyEnvValue } from '@renderer/env-clipboard';
import { ENV_COPY } from '@renderer/project-env-copy';

describe('copyEnvValue', () => {
  it('writes the exact raw value, with ${…} tokens literal, and notifies success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const ok = await copyEnvValue('${HOME}/secret', { writeText }, notify);
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('${HOME}/secret');
    expect(notify).toHaveBeenCalledWith('success', ENV_COPY.copied);
  });

  it('notifies error with no detail when the write rejects, and never the value or name', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    const notify = vi.fn();
    const ok = await copyEnvValue('super-secret-value', { writeText }, notify);
    expect(ok).toBe(false);
    expect(notify).toHaveBeenCalledWith('error', ENV_COPY.copyFailed);
    expect(notify).toHaveBeenCalledTimes(1);
    const [, title] = notify.mock.calls[0] as [string, string];
    expect(title).not.toContain('super-secret-value');
  });

  it('never calls notify with the value appended to the title', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    await copyEnvValue('the-value', { writeText }, notify);
    for (const call of notify.mock.calls) {
      expect(call[1]).not.toContain('the-value');
    }
  });
});
