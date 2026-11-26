/** A renderer may return focus only if its old surface owned it and no newer interaction intervened. */
export function captureTerminalFocusHandoff(host: HTMLElement, signal: AbortSignal): () => boolean {
  const doc = host.ownerDocument;
  if (!doc.hasFocus() || !host.contains(doc.activeElement) || signal.aborted) return () => false;
  const intent = new AbortController();
  const observe = { capture: true, signal: AbortSignal.any([signal, intent.signal]) };
  const revoke = () => intent.abort();
  doc.addEventListener('focusin', revoke, observe);
  doc.addEventListener('pointerdown', revoke, observe);
  doc.defaultView?.addEventListener('blur', revoke, { signal: observe.signal });
  return () => {
    const canRestore = !observe.signal.aborted && doc.hasFocus();
    revoke();
    return canRestore;
  };
}
