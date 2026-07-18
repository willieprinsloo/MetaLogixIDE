import { describe, it, expectTypeOf } from 'vitest';
import type { IpcContract, IpcChannelName } from '@shared/ipc-contract';

describe('IpcContract', () => {
  it('exposes named channels with request/response shapes', () => {
    expectTypeOf<IpcChannelName>().toMatchTypeOf<string>();
  });

  it('contains projects:list channel with expected response', () => {
    type ListReq = IpcContract['projects:list']['request'];
    type ListRes = IpcContract['projects:list']['response'];
    expectTypeOf<ListReq>().toEqualTypeOf<undefined>();
    expectTypeOf<ListRes>().toMatchTypeOf<{ projects: unknown[] }>();
  });
});
