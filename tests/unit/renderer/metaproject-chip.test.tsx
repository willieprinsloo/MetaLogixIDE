// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MetaprojectAssignment } from '@shared/metaproject-contract';

/**
 * Mutable per-test state. The chip reads assignment via `useAssignment`,
 * which calls `api.invoke('metaproject:assignment-get', …)` and
 * subscribes to `metaproject:assignment-changed`. Mocking the api is the
 * tightest seam without pulling in the whole session provider.
 */
let assignment: MetaprojectAssignment | null = null;
let openExternalUrl: string | null = null;

vi.mock('@renderer/api', () => ({
  api: {
    invoke: vi.fn().mockImplementation(async (ch: string, req: unknown) => {
      if (ch === 'metaproject:assignment-get') {
        if (assignment === null) return { ok: false, reason: 'signed-out' };
        return { ok: true, value: assignment };
      }
      if (ch === 'app:open-external') {
        openExternalUrl = (req as { url: string }).url;
        return {};
      }
      return {};
    }),
    on: vi.fn().mockReturnValue(() => {}),
  },
}));

// The session hook is pulled in transitively; stub it to a signed-in
// snapshot so `useAssignment`'s epoch key stays stable, and expose the
// optional variant too (the chip consults it to short-circuit when no
// provider is mounted — in these tests we DO want it to render, so we
// return a truthy stub).
vi.mock('@renderer/metaproject/session', () => {
  const session = {
    snapshot: { phase: 'signed-in', epoch: 1, origin: 'https://projects.metalogix.solutions', configuredOrigin: 'https://projects.metalogix.solutions' },
    current: () => ({ epoch: 1 }),
  };
  return {
    useMetaprojectSession: () => session,
    useOptionalMetaprojectSession: () => session,
    useSignInIntent: () => () => {},
    AccountStatus: () => null,
  };
});

const { MetaprojectChip } = await import('@renderer/components/MetaprojectChip');

// The real `MetaprojectAssignment` is branded (remoteId, origin, revision);
// the chip never recomputes any of that, it just reads it. Cast via unknown
// so tests don't need to construct brand-typed values.
function linked(remoteId: number): MetaprojectAssignment {
  return {
    kind: 'linked',
    projectId: 1,
    localName: 'metaIDE',
    localPath: '/tmp/metaIDE',
    remoteId,
    origin: 'https://projects.metalogix.solutions',
    revision: '1',
  } as unknown as MetaprojectAssignment;
}

function unlinked(): MetaprojectAssignment {
  return {
    kind: 'unlinked',
    projectId: 1,
    localName: 'metaIDE',
    localPath: '/tmp/metaIDE',
    revision: '1',
  } as unknown as MetaprojectAssignment;
}

beforeEach(() => {
  assignment = null;
  openExternalUrl = null;
});
afterEach(() => cleanup());

describe('MetaprojectChip', () => {
  it('renders nothing when there is no project selected', () => {
    render(<MetaprojectChip projectId={null} onOpenAssignment={() => {}} />);
    expect(screen.queryByTestId('metaproject-chip-linked')).toBeNull();
    expect(screen.queryByTestId('metaproject-chip-unlinked')).toBeNull();
  });

  it('shows the remote id when linked and opens the kanban URL on click', async () => {
    assignment = linked(129);
    render(<MetaprojectChip projectId={1} onOpenAssignment={() => {}} />);
    const chip = await screen.findByTestId('metaproject-chip-linked');
    expect(chip.getAttribute('data-remote-id')).toBe('129');
    expect(chip.textContent).toContain('#129');
    fireEvent.click(chip);
    await waitFor(() => expect(openExternalUrl).toBe('https://projects.metalogix.solutions/projects/129/kanban'));
  });

  it('shows a Bind chip when unlinked and calls onOpenAssignment on click', async () => {
    assignment = unlinked();
    const onOpen = vi.fn();
    render(<MetaprojectChip projectId={1} onOpenAssignment={onOpen} />);
    const chip = await screen.findByTestId('metaproject-chip-unlinked');
    expect(chip.getAttribute('data-kind')).toBe('unlinked');
    fireEvent.click(chip);
    expect(onOpen).toHaveBeenCalled();
  });

  it('hides the unlinked chip entirely when no onOpenAssignment is provided — a dead control is worse than no control', async () => {
    assignment = unlinked();
    render(<MetaprojectChip projectId={1} onOpenAssignment={null} />);
    // Give useAssignment a tick to settle.
    await Promise.resolve();
    expect(screen.queryByTestId('metaproject-chip-unlinked')).toBeNull();
  });
});
