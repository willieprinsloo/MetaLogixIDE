import { useEffect, useRef } from 'react';
import { api } from '@renderer/api';
import { viewedShellsFor, type ViewedShellsInput } from '@renderer/viewed-shells';

/**
 * Reports which shells are currently visible to the main process, so it can
 * suppress Claude notifications for shells the user is already looking at
 * (spec AC15-AC17). Sends `notifications:viewed-shells` once on mount and
 * again only when the derived list changes; a failed send is logged with its
 * cause and otherwise ignored — there is no toast and no retry, since the
 * worst case is a spurious notification, not a lost one.
 */
export function useReportViewedShells(input: ViewedShellsInput): void {
  const shells = viewedShellsFor(input);
  const key = JSON.stringify(shells);
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const lastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    api.invoke('notifications:viewed-shells', { shells: shellsRef.current }).catch((err) => {
      console.warn('[metaide] failed to report viewed shells', err);
    });
  }, [key]);
}
