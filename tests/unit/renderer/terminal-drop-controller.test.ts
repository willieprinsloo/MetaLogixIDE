import { describe, it, expect, vi } from 'vitest';
import {
  createTerminalDropController,
  type DropEventLike,
  type TerminalDropControllerDeps,
} from '@renderer/terminal-drop-controller';
import type { DropFile, DropSnapshot } from '@renderer/terminal-drop';
import type { DropKind } from '@renderer/drag-hover';
import { APP_FILE_DRAG_TYPE } from '@shared/terminal-drop-contract';

const blob: DropFile = {
  name: 'a.png',
  type: 'image/png',
  size: 1,
  arrayBuffer: async () => new ArrayBuffer(1),
};

function dragEvent(types: string[], data: Record<string, string> = {}, files: DropFile[] = []) {
  const event = {
    dataTransfer: {
      types,
      files,
      dropEffect: 'none',
      getData: vi.fn((type: string) => data[type] ?? ''),
    },
    preventDefault: vi.fn(),
  } satisfies DropEventLike<DropFile>;
  return event;
}

function setup(overrides: Partial<TerminalDropControllerDeps<DropFile>> = {}) {
  const overlay: (DropKind | null)[] = [];
  const deps = {
    plan: vi.fn<(s: DropSnapshot<DropFile>) => Promise<string | null>>(async () => '/a/b'),
    paste: vi.fn<(text: string) => void>(),
    isExited: vi.fn(() => false),
    setOverlay: vi.fn((kind: DropKind | null) => {
      overlay.push(kind);
    }),
    onError: vi.fn<(err: unknown) => void>(),
    ...overrides,
  };
  const controller = createTerminalDropController(deps);
  const current = () => overlay[overlay.length - 1] ?? null;
  return { controller, deps, current };
}

describe('dragOver (behaviour 1)', () => {
  it.each([[['Files']], [[APP_FILE_DRAG_TYPE]], [['text/plain']]])(
    'accepts %j: preventDefault and dropEffect copy',
    (types) => {
      const { controller } = setup();
      const e = dragEvent(types);
      controller.dragOver(e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
      expect(e.dataTransfer.dropEffect).toBe('copy');
    },
  );

  it('leaves a drag it does not accept untouched', () => {
    const { controller } = setup();
    const e = dragEvent(['text/uri-list']);
    controller.dragOver(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.dataTransfer.dropEffect).toBe('none');
  });
});

describe('drop of an unaccepted kind (behaviour 2)', () => {
  it('does not preventDefault, plan or paste, but still resets the overlay', async () => {
    const { controller, deps, current } = setup();
    controller.dragEnter(dragEvent(['Files']));
    await controller.drop(dragEvent(['text/uri-list']));
    expect(deps.plan).not.toHaveBeenCalled();
    expect(deps.paste).not.toHaveBeenCalled();
    expect(current()).toBeNull();
  });

  it('does not cancel the browser default', async () => {
    const { controller } = setup();
    const e = dragEvent(['text/uri-list']);
    await controller.drop(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('drop of an accepted kind', () => {
  it('cancels the default, snapshots the transfer and pastes the planned payload', async () => {
    const { controller, deps } = setup();
    const e = dragEvent(['Files', 'text/plain'], { 'text/plain': 'txt' }, [blob]);
    await controller.drop(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.plan).toHaveBeenCalledWith({ appFile: '', files: [blob], text: 'txt' });
    expect(deps.paste).toHaveBeenCalledWith('/a/b');
  });

  it('reads the Files-tree payload', async () => {
    const { controller, deps } = setup();
    const raw = JSON.stringify({ projectId: 1, relPath: 'a' });
    await controller.drop(dragEvent([APP_FILE_DRAG_TYPE], { [APP_FILE_DRAG_TYPE]: raw }));
    expect(deps.plan).toHaveBeenCalledWith({ appFile: raw, files: [], text: '' });
  });

  it('snapshots files into an array the planner can keep after the event', async () => {
    const plan = vi.fn<(s: DropSnapshot<DropFile>) => Promise<string | null>>(async () => null);
    const { controller } = setup({ plan });
    const fileList = { 0: blob, length: 1 } as unknown as DropFile[];
    await controller.drop(dragEvent(['Files'], {}, fileList));
    const snapshot = plan.mock.calls[0]?.[0];
    expect(Array.isArray(snapshot?.files)).toBe(true);
    expect(snapshot?.files).toEqual([blob]);
  });

  it('resets the overlay on drop', async () => {
    const { controller, current } = setup();
    controller.dragEnter(dragEvent(['Files']));
    await controller.drop(dragEvent(['Files']));
    expect(current()).toBeNull();
  });
});

describe('exited shell (behaviours 3 and 4, AC16)', () => {
  it('never plans a drop onto an exited shell, but still cancels the navigation default', async () => {
    const { controller, deps } = setup({ isExited: () => true });
    const e = dragEvent(['Files']);
    await controller.drop(e);
    expect(deps.plan).not.toHaveBeenCalled();
    expect(deps.paste).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('pastes nothing when the shell exits while the plan is in flight', async () => {
    let exited = false;
    const { controller, deps } = setup({
      isExited: () => exited,
      plan: async () => {
        exited = true;
        return '/a/b';
      },
    });
    await controller.drop(dragEvent(['Files']));
    expect(deps.paste).not.toHaveBeenCalled();
  });
});

describe('null payload (behaviour 5)', () => {
  it('never calls paste, so term.paste never sees an empty string', async () => {
    const { controller, deps } = setup({ plan: async () => null });
    await controller.drop(dragEvent(['Files']));
    expect(deps.paste).not.toHaveBeenCalled();
  });

  it('reports a planner rejection instead of throwing', async () => {
    const err = new Error('boom');
    const { controller, deps } = setup({ plan: async () => Promise.reject(err) });
    await expect(controller.drop(dragEvent(['Files']))).resolves.toBeUndefined();
    expect(deps.onError).toHaveBeenCalledWith(err);
    expect(deps.paste).not.toHaveBeenCalled();
  });

  it('reports a paste failure instead of throwing', async () => {
    const err = new Error('disposed');
    const paste = vi.fn(() => {
      throw err;
    });
    const { controller, deps } = setup({ paste });
    await expect(controller.drop(dragEvent(['Files']))).resolves.toBeUndefined();
    expect(deps.onError).toHaveBeenCalledWith(err);
  });
});

describe('overlay (behaviour 6, AC19, AC20)', () => {
  it('shows the kind on enter and keeps it across a nested enter/leave', () => {
    const { controller, current } = setup();
    controller.dragEnter(dragEvent(['Files']));
    expect(current()).toBe('path');
    controller.dragEnter(dragEvent(['Files']));
    controller.dragLeave();
    expect(current()).toBe('path');
    controller.dragLeave();
    expect(current()).toBeNull();
  });

  it('shows text for a text-only drag and nothing for an unaccepted one', () => {
    const { controller, current } = setup();
    controller.dragEnter(dragEvent(['text/plain']));
    expect(current()).toBe('text');
    controller.dragLeave();
    controller.dragEnter(dragEvent(['text/uri-list']));
    expect(current()).toBeNull();
  });

  it('enter, leave, enter shows the overlay again', () => {
    const { controller, current } = setup();
    controller.dragEnter(dragEvent(['Files']));
    controller.dragLeave();
    controller.dragEnter(dragEvent(['text/plain']));
    expect(current()).toBe('text');
  });

  it.each(['dragend', 'drop'])('a window %s resets the overlay and the depth', (type) => {
    const { controller, current } = setup();
    const target = new EventTarget();
    controller.attach(target);
    controller.dragEnter(dragEvent(['Files']));
    controller.dragEnter(dragEvent(['Files']));
    target.dispatchEvent(new Event(type));
    expect(current()).toBeNull();
    controller.dragEnter(dragEvent(['Files']));
    controller.dragLeave();
    expect(current()).toBeNull();
  });

  it('removes the window listeners on dispose', () => {
    const { controller, current } = setup();
    const target = new EventTarget();
    const dispose = controller.attach(target);
    dispose();
    controller.dragEnter(dragEvent(['Files']));
    target.dispatchEvent(new Event('dragend'));
    target.dispatchEvent(new Event('drop'));
    expect(current()).toBe('path');
  });
});
