import { describe, it, expect, vi } from 'vitest';
import { sayToGroup, clampRounds } from '@renderer/group-chat/group-actions';

const fakeApi = () => ({ invoke: vi.fn(async (_ch: string, _req: unknown) => ({ group: { id: 'g' } })) });

describe('sayToGroup', () => {
  it('sends the typed message with groups:say, trimmed', async () => {
    const api = fakeApi();
    expect(await sayToGroup(api, 'g', '  hello group \n')).toBe(true);
    expect(api.invoke).toHaveBeenCalledWith('groups:say', { id: 'g', text: 'hello group' });
  });

  it('sends nothing for an empty message', async () => {
    const api = fakeApi();
    expect(await sayToGroup(api, 'g', '  \n ')).toBe(false);
    expect(api.invoke).not.toHaveBeenCalled();
  });
});

describe('clampRounds', () => {
  it('keeps rounds within 1–10 and whole', () => {
    expect(clampRounds('4')).toBe(4);
    expect(clampRounds('0')).toBe(1);
    expect(clampRounds('99')).toBe(10);
    expect(clampRounds('2.6')).toBe(3);
    expect(clampRounds('abc')).toBeNull();
  });
});
