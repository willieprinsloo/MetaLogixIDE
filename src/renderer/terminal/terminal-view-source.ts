import { api } from '@renderer/api';
import { openRemoteShell, type RemoteShellHandle } from '@renderer/p2p/remoteShellBridge';
import type { IpcRequest } from '@shared/ipc-contract';
import { openLocalTerminalStream } from './local-terminal-source';

interface Source {
  readonly snapshot: Promise<string>;
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface SourceOptions {
  readonly target: IpcRequest<'shells:snapshot'>;
  readonly remoteDeviceId: string | null;
  readonly remoteHandlers: (remote: RemoteShellHandle) => void;
  readonly data: (text: string) => void;
  readonly exit: (code: number | null) => void;
}

/** One stream per view opening; renderer creation and replacement never acquire it. */
export function openTerminalViewSource({ target, remoteDeviceId, remoteHandlers, data, exit }: SourceOptions): Source {
  if (remoteDeviceId) {
    const remote = openRemoteShell(remoteDeviceId, target.projectId, target.shellIndex);
    remoteHandlers(remote);
    // The peer replays into onData; there is no separate wire snapshot.
    return {
      snapshot: Promise.resolve(''),
      send: (bytes) => remote.send(bytes),
      resize: (cols, rows) => remote.resize(cols, rows),
      close: () => remote.close(),
    };
  }
  const local = openLocalTerminalStream(target, { data, exit });
  return {
    snapshot: local.snapshot,
    send: (bytes) => { void api.invoke('shells:write', { ...target, data: bytes }); },
    resize: (cols, rows) => { void api.invoke('shells:resize', { ...target, cols, rows }); },
    close: () => local.close(),
  };
}
