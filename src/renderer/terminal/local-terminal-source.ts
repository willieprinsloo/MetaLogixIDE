import { api } from '@renderer/api';
import type { IpcEvents, IpcRequest } from '@shared/ipc-contract';

interface LocalTerminalStream {
  readonly snapshot: Promise<string>;
  close(): void;
}

interface StreamHandlers {
  readonly data: (text: string) => void;
  readonly exit: (code: number | null) => void;
}

type Chunk = IpcEvents['pty:data'];
type ReplayState =
  | { kind: 'pending'; chunks: Chunk[] }
  | { kind: 'live'; cut: number | null }
  | { kind: 'closed' };

/** Subscribes before capture and forwards only output beyond a valid desktop snapshot's position. */
export function openLocalTerminalStream(target: IpcRequest<'shells:snapshot'>, handlers: StreamHandlers): LocalTerminalStream {
  let state: ReplayState = { kind: 'pending', chunks: [] };
  const { promise: snapshot, resolve } = Promise.withResolvers<string>();

  function forward(chunk: Chunk, cut: number | null): void {
    if (cut === null || chunk.replayPosition > cut) handlers.data(chunk.data);
  }

  function complete(output: string, cut: number | null): void {
    if (state.kind !== 'pending') return;
    const { chunks } = state;
    state = { kind: 'live', cut };
    for (const chunk of chunks) forward(chunk, cut);
    resolve(output);
  }

  const offData = api.on('pty:data', (chunk) => {
    if (chunk.projectId !== target.projectId || chunk.shellIndex !== target.shellIndex) return;
    if (state.kind === 'pending') state.chunks.push(chunk);
    else if (state.kind === 'live') forward(chunk, state.cut);
  });
  const offExit = api.on('pty:exit', (event) => {
    if (state.kind === 'closed' || event.projectId !== target.projectId || event.shellIndex !== target.shellIndex) return;
    complete('', null);
    handlers.exit(event.code);
  });

  void api.invoke('shells:snapshot', target).then(
    ({ output, alive, replayPosition }) => {
      if (alive) complete(output, replayPosition);
      else complete('', null);
    },
    () => complete('', null),
  );

  function close(): void {
    if (state.kind === 'closed') return;
    state = { kind: 'closed' };
    offData();
    offExit();
    resolve('');
  }

  return { snapshot, close };
}
