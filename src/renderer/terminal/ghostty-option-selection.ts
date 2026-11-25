import type { PointerInput } from '@gespenst/core';
import type { TerminalRenderer } from './terminal-engine-recovery';

interface SelectionPort {
  readonly element: HTMLElement;
  readonly geometry: { readonly widthPx: number; readonly heightPx: number };
  focus(): void;
  sendPointer(input: PointerInput): void;
}

interface Gesture {
  readonly id: number;
  readonly listeners: AbortController;
  last: PointerInput;
  selecting: boolean;
}

function consume(event: PointerEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Route a trusted macOS Option-drag to Ghostty selection instead of the shell. */
export function enableGhosttyOptionSelection(port: SelectionPort, onFault: () => void): TerminalRenderer {
  const { element } = port;
  const lifecycle = new AbortController();
  let gesture: Gesture | undefined;

  function sample(event: PointerEvent, action: PointerInput['action']): PointerInput {
    const bounds = element.getBoundingClientRect();
    const scale = element.ownerDocument.defaultView?.devicePixelRatio || 1;
    return {
      action, button: 'left', forceSelection: true, anyButtonPressed: action !== 'release',
      x: Math.max(0, Math.min(port.geometry.widthPx - 1, (event.clientX - bounds.left) * scale)),
      y: Math.max(0, Math.min(port.geometry.heightPx - 1, (event.clientY - bounds.top) * scale)),
      timeMs: event.timeStamp,
    };
  }

  function send(input: PointerInput): void {
    try { port.sendPointer(input); } catch { onFault(); }
  }

  function finish(state: Gesture): void {
    gesture = undefined;
    state.listeners.abort();
    if (element.hasPointerCapture(state.id)) element.releasePointerCapture(state.id);
  }

  function route(event: PointerEvent): void {
    const state = gesture;
    if (!state || !event.isTrusted || event.pointerId !== state.id) return;
    if (event.type === 'pointermove' && !state.selecting && (event.buttons & 1) === 0) {
      finish(state);
      return;
    }
    consume(event);
    if (event.type === 'pointermove') {
      if (state.selecting) {
        state.last = sample(event, 'motion');
        send(state.last);
      }
      return;
    }
    if (state.selecting) {
      state.selecting = false;
      send(event.type === 'pointerup' ? sample(event, 'release') : { ...state.last, action: 'release', anyButtonPressed: false });
    }
    // Capture loss can precede pointerup; suppress the unmatched mouse release.
    if (event.type !== 'lostpointercapture') finish(state);
  }

  function start(event: PointerEvent): void {
    if (!event.isTrusted || !event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0) return;
    if (gesture) finish(gesture);
    if (!event.altKey) return;
    consume(event);
    port.focus();
    const state = { id: event.pointerId, listeners: new AbortController(), last: sample(event, 'press'), selecting: true };
    gesture = state;
    const options = { capture: true, signal: state.listeners.signal };
    for (const type of ['pointermove', 'pointerup', 'pointercancel'] as const) element.ownerDocument.addEventListener(type, route, options);
    element.addEventListener('lostpointercapture', route, options);
    element.setPointerCapture(state.id);
    send(state.last);
  }

  element.addEventListener('pointerdown', start, { capture: true, signal: lifecycle.signal });
  return { dispose() { lifecycle.abort(); if (gesture) finish(gesture); } };
}
