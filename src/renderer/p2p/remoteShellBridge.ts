import { api } from '../api';
import { errMessage } from './err-message';
import { createInputQueue, type InputError } from './input-queue';

/** Handle for one attached remote shell. Mirrors what ShellTab needs from the local IPC path. */
export interface RemoteShellHandle {
  onData(cb: (data: string) => void): void;
  /** The remote PTY exited (`{kind:'exit'}` from the hub); a `closed` event normally follows. */
  onExit(cb: (code: number | null) => void): void;
  /** Stream ended: `'closed'` (local close()), the server's reason (e.g. `'remote_ended'`), `'reconnecting'` when the link dropped, or `'attach_failed: ...'`. */
  onClose(cb: (reason: string) => void): void;
  /** Input or resize delivery failed (including input typed after the stream ended, unless `close()` was called) or a paste was refused as too large. Never fires after `close()`. */
  onInputError(cb: (e: InputError) => void): void;
  send(bytes: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** UTF-8 -> base64 (the wire carries `bytes` as base64; btoa alone rejects non-Latin1). */
function toBase64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

interface RpcEvent { deviceId: string; streamId: number; data?: unknown; closed?: true; reason?: string }

/**
 * Attach to a shell on a paired device. The hub replays buffered scrollback as the first `out`
 * events of the stream, so callers get it through `onData` with no special handling.
 */
export function openRemoteShell(deviceId: string, projectId: number, shellIndex: number): RemoteShellHandle {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  const inputErrCbs: Array<(e: InputError) => void> = [];
  const reportInputError = (e: InputError) => { if (closeRequested) return; for (const cb of inputErrCbs) cb(e); };
  let streamId: number | null = null;
  let finished = false;
  let endReason = 'closed';
  let closeRequested = false;
  // Events can land before the attach response resolves; hold them until the stream id is known.
  let early: RpcEvent[] = [];

  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    endReason = reason;
    off();
    early = [];
    for (const cb of closeCbs) cb(reason);
  };

  const handle = (e: RpcEvent) => {
    if (finished) return;
    if (e.closed) { finish(e.reason ?? 'closed'); return; }
    const d = e.data as { kind?: string; bytes?: unknown; code?: number | null } | undefined;
    if (!d) return;
    if (d.kind === 'out' && typeof d.bytes === 'string') for (const cb of dataCbs) cb(d.bytes);
    else if (d.kind === 'exit') for (const cb of exitCbs) cb(d.code ?? null);
  };

  const off = api.on('p2p:rpc-event', (e: RpcEvent) => {
    if (e.deviceId !== deviceId) return;
    if (streamId === null) { early.push(e); return; }
    if (e.streamId === streamId) handle(e);
  });

  const ready: Promise<number | null> = api
    .invoke('p2p:rpc-call', { deviceId, method: 'shells.attach', params: { projectId, shellIndex } })
    .then((res) => {
      const id = (res.result as { streamId: number }).streamId;
      streamId = id;
      const pending = early; early = [];
      for (const e of pending) if (e.streamId === id) handle(e);
      return id;
    })
    .catch((err: unknown) => {
      finish(`attach_failed: ${errMessage(err)}`);
      return null;
    });

  const call = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    ready.then((id) => {
      if (closeRequested) return undefined;
      if (id === null || finished) throw new Error(`remote shell is not connected (${endReason})`);
      return api.invoke('p2p:rpc-call', { deviceId, method, params: { stream: id, ...params } });
    });

  const inputQueue = createInputQueue({
    send: (text) => call('shells.input', { bytes: toBase64(text) }),
    onError: reportInputError,
  });

  return {
    onData: (cb) => { dataCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    onClose: (cb) => { closeCbs.push(cb); },
    onInputError: (cb) => { inputErrCbs.push(cb); },
    send: (bytes) => inputQueue.push(bytes),
    resize: (cols, rows) => {
      call('shells.resize', { cols, rows }).catch((err: unknown) => {
        reportInputError({ kind: 'failed', message: errMessage(err) });
      });
    },
    close: () => {
      if (closeRequested) return;
      closeRequested = true;
      void ready.then((id) => {
        if (id !== null) void api.invoke('p2p:rpc-close-stream', { streamId: id }).catch(() => {});
      });
      finish('closed');
    },
  };
}
