import { describe, it, expect } from 'vitest';
import {
  createExternalDragGuard,
  installExternalDragGuard,
} from '@renderer/hooks/useExternalDragGuard';

const isCapture = (options?: boolean | { capture?: boolean }): boolean =>
  typeof options === 'boolean' ? options : options?.capture === true;

describe('createExternalDragGuard (AC22)', () => {
  it('swallows dragover and drop for a drag that did not start in this window', () => {
    const guard = createExternalDragGuard();
    expect(guard.dragOver()).toBe(true);
    expect(guard.drop()).toBe(true);
  });

  it('lets an in-app drag keep its native default on dragover and drop', () => {
    const guard = createExternalDragGuard();
    guard.dragStart();
    expect(guard.dragOver()).toBe(false);
    expect(guard.dragOver()).toBe(false);
    expect(guard.drop()).toBe(false);
  });

  it('swallows the next external drag after an in-app drag ends with dragend', () => {
    const guard = createExternalDragGuard();
    guard.dragStart();
    guard.dragEnd();
    expect(guard.dragOver()).toBe(true);
    expect(guard.drop()).toBe(true);
  });

  it('clears the in-app flag on drop, so a missed dragend cannot leak into the next drag', () => {
    const guard = createExternalDragGuard();
    guard.dragStart();
    expect(guard.drop()).toBe(false);
    expect(guard.dragOver()).toBe(true);
    expect(guard.drop()).toBe(true);
  });

  it('self-heals on a pointer move with no buttons held, which cannot happen mid-drag', () => {
    const guard = createExternalDragGuard();
    guard.dragStart();
    guard.pointerMove(0);
    expect(guard.dragOver()).toBe(true);
  });

  it('stays in-app on a pointer move with a button held', () => {
    const guard = createExternalDragGuard();
    guard.dragStart();
    guard.pointerMove(1);
    expect(guard.dragOver()).toBe(false);
  });

  it('self-heals on pointerdown, which cannot happen mid-drag', () => {
    const guard = createExternalDragGuard();
    guard.dragStart();
    guard.pointerDown();
    expect(guard.dragOver()).toBe(true);
  });
});

function fire(target: EventTarget, type: string, init: { buttons?: number } = {}): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), init);
  target.dispatchEvent(event);
  return event;
}

describe('installExternalDragGuard (AC22, popout and main window)', () => {
  it('cancels dragover and drop of an external drag', () => {
    const target = new EventTarget();
    installExternalDragGuard(target);
    expect(fire(target, 'dragover').defaultPrevented).toBe(true);
    expect(fire(target, 'drop').defaultPrevented).toBe(true);
  });

  it('leaves dragover and drop of an in-app drag alone', () => {
    const target = new EventTarget();
    installExternalDragGuard(target);
    fire(target, 'dragstart');
    expect(fire(target, 'dragover').defaultPrevented).toBe(false);
    expect(fire(target, 'drop').defaultPrevented).toBe(false);
  });

  it('swallows again after dragend', () => {
    const target = new EventTarget();
    installExternalDragGuard(target);
    fire(target, 'dragstart');
    fire(target, 'dragend');
    expect(fire(target, 'dragover').defaultPrevented).toBe(true);
  });

  it('self-heals a stuck in-app flag on mousemove with no buttons (M4)', () => {
    const target = new EventTarget();
    installExternalDragGuard(target);
    fire(target, 'dragstart');
    fire(target, 'mousemove', { buttons: 1 });
    expect(fire(target, 'dragover').defaultPrevented).toBe(false);
    fire(target, 'mousemove', { buttons: 0 });
    expect(fire(target, 'dragover').defaultPrevented).toBe(true);
  });

  it('treats a mousemove that reports no buttons field as button-free', () => {
    const target = new EventTarget();
    installExternalDragGuard(target);
    fire(target, 'dragstart');
    fire(target, 'mousemove');
    expect(fire(target, 'dragover').defaultPrevented).toBe(true);
  });

  it('self-heals a stuck in-app flag on pointerdown (M4)', () => {
    const target = new EventTarget();
    installExternalDragGuard(target);
    fire(target, 'dragstart');
    fire(target, 'pointerdown', { buttons: 1 });
    expect(fire(target, 'dragover').defaultPrevented).toBe(true);
  });

  it('removes every listener when disposed', () => {
    const target = new EventTarget();
    const dispose = installExternalDragGuard(target);
    fire(target, 'dragstart');
    dispose();
    fire(target, 'pointerdown');
    expect(fire(target, 'dragover').defaultPrevented).toBe(false);
    expect(fire(target, 'drop').defaultPrevented).toBe(false);
  });

  it('leaves no listener registered on the window after dispose', () => {
    const live = new Set<string>();
    const key = (type: string, capture: unknown) => `${type}:${capture === true}`;
    class CountingTarget extends EventTarget {
      override addEventListener(
        type: string,
        fn: EventListener,
        options?: boolean | { capture?: boolean },
      ): void {
        live.add(key(type, isCapture(options)));
        super.addEventListener(type, fn, options);
      }
      override removeEventListener(
        type: string,
        fn: EventListener,
        options?: boolean | { capture?: boolean },
      ): void {
        live.delete(key(type, isCapture(options)));
        super.removeEventListener(type, fn, options);
      }
    }
    const dispose = installExternalDragGuard(new CountingTarget());
    expect(live.size).toBeGreaterThan(0);
    dispose();
    expect([...live]).toEqual([]);
  });
});
