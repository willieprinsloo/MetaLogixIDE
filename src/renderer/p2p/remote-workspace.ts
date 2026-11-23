import { WorkspaceMethods } from '@shared/p2p-workspace-contract';
import type { Params, Result } from '@shared/p2p-contract';
import { api } from '@renderer/api';

type WorkspaceMethod = keyof typeof WorkspaceMethods;

/** Data source permanently bound to one paired machine. Each operation still names its project. */
export interface RemoteWorkspace {
  call<M extends WorkspaceMethod>(method: M, params: Params<M>): Promise<Result<M>>;
}

/** Parse responses at the renderer IPC boundary instead of trusting an untyped result. */
export function remoteWorkspace(deviceId: string): RemoteWorkspace {
  return {
    async call<M extends WorkspaceMethod>(method: M, params: Params<M>): Promise<Result<M>> {
      const { result } = await api.invoke('p2p:rpc-call', { deviceId, method, params });
      // The key selects the same schema that defines Result<M>; TS widens indexed generic unions.
      return WorkspaceMethods[method].result.parse(result) as Result<M>;
    },
  };
}
