/**
 * Keeps a terminal path's hover preview open while the pointer travels from the path onto the card. xterm reports
 * leaving the path when the pointer moves onto the card (it sits outside the terminal screen), so the close is delayed
 * and cancelled by the card's own pointer enter. Pure apart from injectable timers.
 */

/** How long the preview stays up after the pointer leaves the path or the card, so it can cross the gap between them. */
export const PEEK_CLOSE_DELAY_MS = 200;

/**
 * How long the pointer must REST on a path before the preview opens. The
 * card is pointer-events-auto and sits next to the cursor, so an
 * instantly-opening card would block mouse selection of the terminal text
 * it covers — the dwell means moving the mouse across output never pops a
 * card, and only a deliberate rest opens one.
 */
export const PEEK_OPEN_DWELL_MS = 350;

/** Timer functions {@link createHoverHold} schedules with; injectable so the hold is tested without real time. */
export interface HoldTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Keeps the preview open while the pointer is on the path or the card; `dispose` drops any pending close and resets both. */
export interface HoverHold {
  linkEnter: (open: () => void) => void;
  linkLeave: () => void;
  cardEnter: () => void;
  cardLeave: () => void;
  dispose: () => void;
}

/**
 * Creates the hold that closes the preview only once the pointer is on neither the path nor the card: `close` runs
 * `delayMs` after the pointer leaves the last of them, and entering either cancels it. `linkEnter(open)` schedules
 * `open` after {@link PEEK_OPEN_DWELL_MS} of rest on the path; leaving the path or disposing cancels it. Tracking
 * both surfaces separately keeps the card open whatever order the browser fires the card's pointerenter and xterm's
 * mouseleave-driven link leave.
 */
export function createHoverHold(
  close: () => void,
  delayMs: number = PEEK_CLOSE_DELAY_MS,
  timers: HoldTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
): HoverHold {
  let pendingClose: ReturnType<typeof setTimeout> | null = null;
  let pendingOpen: ReturnType<typeof setTimeout> | null = null;
  let overLink = false;
  let overCard = false;
  const cancelClose = () => {
    if (pendingClose !== null) timers.clear(pendingClose);
    pendingClose = null;
  };
  const cancelOpen = () => {
    if (pendingOpen !== null) timers.clear(pendingOpen);
    pendingOpen = null;
  };
  const update = () => {
    cancelClose();
    if (overLink || overCard) return;
    pendingClose = timers.set(() => { pendingClose = null; close(); }, delayMs);
  };
  return {
    linkEnter: (open: () => void) => {
      overLink = true;
      cancelOpen();
      pendingOpen = timers.set(() => { pendingOpen = null; open(); }, PEEK_OPEN_DWELL_MS);
      update();
    },
    linkLeave: () => { overLink = false; cancelOpen(); update(); },
    cardEnter: () => { overCard = true; update(); },
    cardLeave: () => { overCard = false; update(); },
    dispose: () => { overLink = false; overCard = false; cancelOpen(); cancelClose(); },
  };
}
