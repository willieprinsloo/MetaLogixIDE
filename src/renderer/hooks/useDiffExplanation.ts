/**
 * On-demand AI explanation for one Diff tab entry. The hook never fires a
 * request on its own — the user clicks "Explain changes" and the Diff pane
 * calls `request()`. Results are cached per (projectId, diffHash) so switching
 * away and back is instant. The main-side also caches by the same key, so a
 * second session after a reload also returns fast.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';

export type ExplainState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; text: string }
  | { status: 'error'; message: string };

interface Args {
  projectId: number;
  diff: string;
  diffHash: string;
  newPath: string;
  oldPath: string;
}

export function useDiffExplanation(args: Args | null): { state: ExplainState; request: () => void; reset: () => void } {
  const [state, setState] = useState<ExplainState>({ status: 'idle' });
  const inFlightKeyRef = useRef<string | null>(null);

  // Any change to the file (different hash or different key) resets the panel
  // back to idle so a stale explanation never appears next to a fresh diff.
  const key = args ? `${args.projectId}|${args.diffHash}|${args.newPath}` : null;
  useEffect(() => {
    setState({ status: 'idle' });
  }, [key]);

  const request = useCallback(() => {
    if (!args) return;
    const myKey = key!;
    inFlightKeyRef.current = myKey;
    setState({ status: 'loading' });
    void api.invoke('diff:explain', {
      projectId: args.projectId,
      kind: 'explain',
      diff: args.diff,
      newPath: args.newPath,
      oldPath: args.oldPath,
      cacheHash: args.diffHash,
    }).then((r) => {
      // A slow answer from the previous file must never land on the current one.
      if (inFlightKeyRef.current !== myKey) return;
      if (r.status === 'ok') setState({ status: 'ok', text: r.text });
      else setState({ status: 'error', message: r.message });
    }).catch((e: unknown) => {
      if (inFlightKeyRef.current !== myKey) return;
      setState({ status: 'error', message: `Could not reach Claude: ${String((e as Error)?.message ?? e)}` });
    });
  }, [args, key]);

  const reset = useCallback(() => {
    inFlightKeyRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, request, reset };
}
