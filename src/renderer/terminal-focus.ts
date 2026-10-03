// Decides whether, and which, shell terminal takes keyboard focus when a
// window regains OS focus, a notification asks for a shell, or the user
// switches project. DOM-free so it runs in the node test environment; the DOM
// adapter lives in hooks/useWindowTerminalFocus.ts.

export type ActiveElementKind = 'none' | 'terminal' | 'text-entry' | 'control';

/** Structural subset of Element, so the classifier runs in the node test environment. */
export interface ElementLike {
  tagName: string;
  isContentEditable: boolean;
  classList: { contains(token: string): boolean };
}

export const XTERM_TEXTAREA_CLASS = 'xterm-helper-textarea';
export const FOCUS_REQUEST_TTL_MS = 5000; // covers ShellTab's <=2s open gate + snapshot

const NO_FOCUS_TAGS = new Set(['BODY', 'HTML']);
const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** null, BODY or HTML → 'none'; xterm helper textarea → 'terminal';
 *  INPUT / TEXTAREA / SELECT / contenteditable → 'text-entry'; anything else → 'control'. */
export function classifyActiveElement(el: ElementLike | null): ActiveElementKind {
  if (!el || NO_FOCUS_TAGS.has(el.tagName)) return 'none';
  if (el.tagName === 'TEXTAREA' && el.classList.contains(XTERM_TEXTAREA_CLASS)) return 'terminal';
  if (TEXT_ENTRY_TAGS.has(el.tagName) || el.isContentEditable) return 'text-entry';
  return 'control';
}

/** Window-focus rule: no overlay, and focus on nothing or on a non-text control. */
export function shouldTakeFocus(input: { overlayOpen: boolean; active: ActiveElementKind }): boolean {
  return !input.overlayOpen && (input.active === 'none' || input.active === 'control');
}

/** Notification-request rule: no overlay, and focus not in a text-entry element. */
export function shouldHonourRequest(input: { overlayOpen: boolean; active: ActiveElementKind }): boolean {
  return !input.overlayOpen && input.active !== 'text-entry';
}

export interface ShellKey { projectId: number; shellIndex: number }

export interface TerminalHandle {
  key: ShellKey;
  primary: boolean;          // left pane / popout terminal
  isOpen(): boolean;         // true after term.open()
  focus(): void;             // term.focus()
}

export interface TerminalRegistration {
  opened(): void;            // call right after term.open()
  used(): void;              // call on the xterm textarea's 'focus' event
  unregister(): void;        // call in effect cleanup
}

export interface TerminalFocusCoordinator {
  register(handle: TerminalHandle): TerminalRegistration;
  setOverlayOpen(open: boolean): void;
  onWindowFocus(): void;
  onWindowBlur(): void;
  /** Focus the terminal with exactly this key (notification, popout, scrollback jump). */
  requestFocus(key: ShellKey): void;
  /** Focus the primary (left-pane) terminal of `projectId` (project switch). */
  requestProjectFocus(projectId: number): void;
  /** Drop any pending request. Called when a new switch starts, so a superseded one never fires. */
  cancelRequest(): void;
}

export interface CoordinatorDeps {
  activeElementKind(): ActiveElementKind;
  now(): number;
}

interface PendingRequest { matches(h: TerminalHandle): boolean; at: number }

const sameKey = (a: ShellKey, b: ShellKey): boolean =>
  a.projectId === b.projectId && a.shellIndex === b.shellIndex;

/** Per-window focus owner. It tracks registered terminals, the last-used one,
 *  a window-focus target still waiting for `term.open()`, and one focus request
 *  (an exact shell, or a project's primary terminal) that a newer request
 *  replaces and that expires after `FOCUS_REQUEST_TTL_MS`. Every deferred focus
 *  re-checks the rule at the moment it would fire. */
class Coordinator implements TerminalFocusCoordinator {
  private readonly handles: TerminalHandle[] = [];
  private overlayOpen = false;
  private lastUsed: TerminalHandle | null = null;
  private pendingTarget: TerminalHandle | null = null;
  private request: PendingRequest | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  register(handle: TerminalHandle): TerminalRegistration {
    this.handles.push(handle);
    return {
      opened: () => this.opened(handle),
      used: () => { if (this.handles.includes(handle)) this.lastUsed = handle; },
      unregister: () => this.unregister(handle),
    };
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
  }

  onWindowFocus(): void {
    this.pendingTarget = null;
    if (!shouldTakeFocus(this.ruleInput())) return;
    const target = this.pickTarget();
    if (!target) return;
    if (target.isOpen()) target.focus();
    else this.pendingTarget = target;
  }

  onWindowBlur(): void {
    this.pendingTarget = null;
    this.request = null;
  }

  requestFocus(key: ShellKey): void {
    this.requestMatching((h) => sameKey(h.key, key));
  }

  requestProjectFocus(projectId: number): void {
    this.requestMatching((h) => h.primary && h.key.projectId === projectId);
  }

  cancelRequest(): void {
    this.request = null;
  }

  private requestMatching(matches: (h: TerminalHandle) => boolean): void {
    this.request = { matches, at: this.deps.now() };
    const target = this.handles.find((h) => h.isOpen() && matches(h));
    if (target && this.consumeRequest(target)) target.focus();
  }

  private ruleInput(): { overlayOpen: boolean; active: ActiveElementKind } {
    return { overlayOpen: this.overlayOpen, active: this.deps.activeElementKind() };
  }

  private pickTarget(): TerminalHandle | undefined {
    if (this.lastUsed) return this.lastUsed;
    return this.handles.find((h) => h.primary) ?? this.handles[0];
  }

  private consumeRequest(handle: TerminalHandle): boolean {
    if (!this.request) return false;
    if (this.deps.now() - this.request.at > FOCUS_REQUEST_TTL_MS) {
      this.request = null;
      return false;
    }
    if (!this.request.matches(handle)) return false;
    this.request = null;
    return shouldHonourRequest(this.ruleInput());
  }

  private opened(handle: TerminalHandle): void {
    const isPending = this.pendingTarget === handle;
    if (isPending) this.pendingTarget = null;
    if (this.consumeRequest(handle) || (isPending && shouldTakeFocus(this.ruleInput()))) handle.focus();
  }

  private unregister(handle: TerminalHandle): void {
    const i = this.handles.indexOf(handle);
    if (i >= 0) this.handles.splice(i, 1);
    if (this.lastUsed === handle) this.lastUsed = null;
    if (this.pendingTarget === handle) this.pendingTarget = null;
  }
}

/** Builds the window's terminal-focus coordinator; see `Coordinator`. */
export function createTerminalFocusCoordinator(deps: CoordinatorDeps): TerminalFocusCoordinator {
  return new Coordinator(deps);
}
