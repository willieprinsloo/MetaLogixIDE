import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '@shared/types';
import { UNLOAD_SESSION_COPY as COPY, UNLOAD_SESSION_TESTIDS as IDS } from '@renderer/unload-session-copy';
import { useShellAgentState } from '@renderer/hooks/useAgentStates';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { useUnloadSessionWorkflow, type UnloadSessionState } from '@renderer/hooks/useUnloadSessionWorkflow';
import type { SessionRisk } from '@renderer/unload-session';
import { ModalFrame } from './ModalFrame';

type Target = Pick<Project, 'id' | 'name'>;

interface ViewProps {
  readonly name: string;
  readonly state: UnloadSessionState;
  readonly risk: SessionRisk;
  readonly onKeep: () => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly panelRef: React.RefObject<HTMLElement>;
  readonly keepRef: React.RefObject<HTMLButtonElement>;
}

/** Modal content names the exact local target, protects the safe exit, and announces changed risk. */
export function UnloadSessionDialogView({ name, state, risk, onKeep, onConfirm, onRetry, onKeyDown, panelRef, keepRef }: ViewProps): React.JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const button = 'min-h-11 px-4 rounded-lg text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent]';
  const error = state.kind === 'error' ? state.message : state.kind === 'ready' ? state.error : null;
  return (
    <ModalFrame testId={IDS.dialog} tier="modal" motion="none" layerClassName="flex items-center justify-center p-4" onDismiss={state.kind === 'pending' ? undefined : onKeep}>
      <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
        aria-busy={state.kind === 'pending'} tabIndex={-1} onKeyDown={onKeyDown}
        className="modal-sheet w-full min-w-0 max-w-md max-h-full overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-[--accent] p-5 space-y-4 text-base text-[--text]">
        <h2 id={titleId} className="font-semibold">{COPY.title}</h2>
        <p id={descriptionId} data-testid={IDS.description} className="break-words">{COPY.consequence(name)} Only shell 0 will stop.</p>
        {(risk.work || risk.visible) && <div role="alert" data-testid={IDS.warning} className="text-[--danger] space-y-2">
          {risk.work && <p>{risk.input ? COPY.inputWarning : COPY.workWarning}</p>}
          {risk.visible && <p>{COPY.visibleWarning}</p>}
        </div>}
        {state.kind === 'gone' && <p role="status" data-testid={IDS.error}>{COPY.ended}</p>}
        {state.kind === 'replaced' && <p role="alert" data-testid={IDS.error}>{COPY.replaced}</p>}
        {error && <p role="alert" data-testid={IDS.error} className="text-[--danger]">{error}</p>}
        {state.kind === 'loading' && <p role="status">Checking session…</p>}
        {state.kind === 'pending' && <p role="status">Unloading session…</p>}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {(state.kind === 'error' || state.kind === 'replaced') && <button type="button" data-testid={IDS.retry} onClick={onRetry} className={button}>Retry</button>}
          {(state.kind === 'ready' || state.kind === 'pending') && <button type="button" data-testid={IDS.unload} onClick={onConfirm}
            disabled={state.kind === 'pending'} className={`${button} text-[--danger] disabled:opacity-50`}>{COPY.unload}</button>}
          <button ref={keepRef} type="button" data-testid={IDS.keep} onClick={onKeep} disabled={state.kind === 'pending'}
            className={`${button} bg-[--panel-strong] disabled:opacity-50`}>{COPY.keep}</button>
        </div>
      </section>
    </ModalFrame>
  );
}

interface Props {
  readonly project: Target;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onStopped: () => void;
}

/** Accessible confirmation for exactly one local project's existing shell-zero launch. */
export function UnloadSessionDialog({ project, visible, onClose, onStopped }: Props): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const trapFocus = useDialogFocus(panelRef);
  const signal = useShellAgentState(project.id, 0).state;
  const workflow = useUnloadSessionWorkflow(project, visible, signal, onClose, onStopped);
  useEffect(() => {
    const background = document.querySelector<HTMLElement>('[data-chrome-root]');
    const wasInert = background?.inert;
    if (background) background.inert = true;
    keepRef.current?.focus();
    return () => { if (background) background.inert = wasInert ?? false; };
  }, []);
  useEffect(() => {
    if (workflow.state.kind === 'pending') panelRef.current?.focus();
  }, [workflow.state.kind]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    trapFocus(event);
    if (event.key === 'Escape' && workflow.state.kind !== 'pending') { event.stopPropagation(); onClose(); }
  };
  return createPortal(<UnloadSessionDialogView name={project.name} state={workflow.state} risk={workflow.risk}
    onKeep={onClose} onConfirm={() => { void workflow.confirm(); }} onRetry={() => { void workflow.retry(); }}
    onKeyDown={onKeyDown} panelRef={panelRef} keepRef={keepRef} />, document.body);
}
