import { useCallback, useEffect, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  timeoutMs: number;
}

interface Listener { (toasts: Toast[]): void }

// Small singleton so any component (main-process events, IPC handlers,
// deep components) can push a toast without prop-drilling.
class ToastBus {
  private next = 1;
  private items: Toast[] = [];
  private listeners = new Set<Listener>();

  emit(): void { for (const l of this.listeners) l(this.items.slice()); }

  push(t: Omit<Toast, 'id'>): number {
    const id = this.next++;
    const full: Toast = { id, ...t };
    this.items = [full, ...this.items].slice(0, 6);
    this.emit();
    if (t.timeoutMs > 0) setTimeout(() => this.dismiss(id), t.timeoutMs);
    return id;
  }

  dismiss(id: number): void {
    const before = this.items.length;
    this.items = this.items.filter((t) => t.id !== id);
    if (this.items.length !== before) this.emit();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.items.slice());
    return () => { this.listeners.delete(l); };
  }
}

export const toastBus = new ToastBus();

export function toast(title: string, opts: Partial<Omit<Toast, 'id' | 'title'>> = {}): number {
  return toastBus.push({
    kind: opts.kind ?? 'info',
    title,
    detail: opts.detail,
    timeoutMs: opts.timeoutMs ?? 3500,
  });
}

export function useToasts(): { toasts: Toast[]; dismiss: (id: number) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => toastBus.subscribe(setToasts), []);
  const dismiss = useCallback((id: number) => toastBus.dismiss(id), []);
  return { toasts, dismiss };
}
