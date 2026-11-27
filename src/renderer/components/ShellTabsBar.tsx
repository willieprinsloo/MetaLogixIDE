import { Component, createRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type Ref } from 'react';
import { AnimatePresence, m, useIsPresent, useReducedMotion } from 'motion/react';
import { menuMotion } from '../menu-motion';
import { toast } from '../hooks/useToasts';
import { api } from '../api';
import { Tooltip } from './Tooltip';
import { SHELL_TAB_TEST_ID, type AgentKind, type AgentState } from '@shared/agent-state';
import { ShellTabDot } from './ShellTabDot';
import { shellChipLabel } from '../shell-label';
import { PlusIcon, StarFilledIcon, StarIcon, XIcon } from './shell-icons';
import type { Project } from '@shared/types';
import { PROJECT_SETTINGS_COPY } from '@renderer/project-settings-contract';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
import { deriveProfileName } from '@renderer/cli-profile-name';
import { ICON_SIZE } from './icon-size';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { errMessage, isOlderHostError } from '@renderer/p2p/err-message';
import { remoteMachineLabel } from '@renderer/p2p/remote-tabs';
import { REMOTE_ACTIVE_CHIP_CLASS, REMOTE_MENU_COPY } from '@renderer/remote-pane-contract';

/** Receives the confirmed local shell index before the strip's next membership update. */
export type ShellLaunched = (shellIndex: number) => void;

/** Connect actions outside the tab strip to the relevant chip animation. */
export interface ShellTabMotion {
  launchResult(): ShellLaunched | undefined;
  beginClose(index: number): (() => void) | undefined;
}

/** A remote peer exposes profile labels and icons, but never its command or environment. */
export interface ShellMenuProfile {
  readonly name: string;
  readonly scope: 'project' | 'global';
  readonly icon?: string;
  readonly argv?: readonly string[];
}

/** The + menu's remote source: the host's display name (for the older-host message) and its profile RPCs. */
export interface RemoteShellMenu {
  readonly hostName: string;
  readonly profiles: () => Promise<readonly ShellMenuProfile[]>;
  readonly remove: (name: string) => Promise<void>;
  readonly setDefault: (name: string | null) => Promise<void>;
}

type RemoteMenuError = 'older-host' | 'failed';

function remoteMenuErrorCopy(error: RemoteMenuError, hostName: string): string {
  return error === 'older-host' ? REMOTE_MENU_COPY.olderHost(remoteMachineLabel(hostName)) : REMOTE_MENU_COPY.loadFailed;
}

/** The add-shell menu: saved CLI profiles with a default-star toggle, a custom-command form and the plain terminal row. */
export function NewShellMenu({
  projectId, remoteMenu,
  defaultCliName,
  onLaunchProfile,
  onLaunchPlainTab,
  onLaunchCustom,
  onDefaultChanged,
  onClose,
}: {
  projectId: number;
  remoteMenu?: RemoteShellMenu;
  /** Current per-project auto-launch CLI (drives the star toggle). */
  defaultCliName: string | null;
  onLaunchProfile: (name: string) => void;
  onLaunchPlainTab: () => void;
  onLaunchCustom: (name: string, cmdLine: string, save: boolean) => void;
  /** Called for local project defaults; remote defaults update through remoteMenu. */
  onDefaultChanged?: (project: Project) => void;
  onClose: () => void;
}) {
  const platform = useShortcutPlatform();
  const [profiles, setProfiles] = useState<readonly ShellMenuProfile[]>([]);
  const [profilesError, setProfilesError] = useState<RemoteMenuError | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [customSave, setCustomSave] = useState(true);

  const [savingDefault, setSavingDefault] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const profiles = remoteMenu
          ? await remoteMenu.profiles()
          : (await api.invoke('shells:cli-profiles-list', { projectId })).profiles;
        setProfiles(profiles);
        setProfilesError(null);
      } catch (e) {
        if (remoteMenu) setProfilesError(isOlderHostError(e) ? 'older-host' : 'failed');
      }
    })();
  }, [projectId, remoteMenu]);

  const present = useIsPresent();
  const motionProps = menuMotion(useReducedMotion() ?? false);
  const panelProps = {
    ...motionProps,
    'data-new-shell-menu': '1',
    'data-overlay': '',
    ...(present ? {} : { inert: '' }),
    'data-testid': present ? undefined : 'new-shell-menu-leaving',
    style: { transformOrigin: 'top left', pointerEvents: present ? undefined : ('none' as const) },
  };

  useEffect(() => {
    if (!present) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('[data-new-shell-menu="1"]')) return;
      onClose();
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose, present]);

  async function removeProfile(name: string) {
    try {
      if (remoteMenu) {
        await remoteMenu.remove(name);
        setProfiles(await remoteMenu.profiles().catch(() => profiles.filter(p => p.name !== name)));
        return;
      }
      await api.invoke('shells:cli-profiles-remove', { projectId, name });
      setProfiles(prev => prev.filter(p => p.name !== name));
    } catch { /* ignore */ }
  }

  if (customOpen) {
    return (
      <m.div
        {...panelProps}
        className="new-shell-menu new-shell-menu-custom absolute mt-1 z-40 rounded-md border border-[--border] bg-[--panel-strong] shadow-xl overflow-hidden p-3 space-y-2 text-xs"
      >
        <div className="font-semibold text-sm">Run a custom command</div>
        <input
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          placeholder="Name (optional, e.g. Llama)"
          className="w-full bg-[--panel] border border-[--border] rounded px-2 py-1 outline-none focus:ring-1 focus:ring-[--accent]/60"
          autoFocus
        />
        <input
          value={customCmd}
          onChange={(e) => setCustomCmd(e.target.value)}
          placeholder='Command, e.g. `llama chat --model llama3`'
          className="w-full bg-[--panel] border border-[--border] rounded px-2 py-1 font-mono outline-none focus:ring-1 focus:ring-[--accent]/60"
        />
        <label className="flex items-center gap-2 text-[--text-muted]">
          <input type="checkbox" checked={customSave} onChange={(e) => setCustomSave(e.target.checked)} className="accent-[color:var(--accent)]" />
          <span>Save to this project&apos;s CLI list</span>
        </label>
        <div className="flex gap-2">
          <button
            className="flex-1 px-2 py-1.5 rounded pressable bg-[color:var(--accent)] text-[--accent-text] hover:brightness-110 disabled:opacity-40"
            disabled={!customCmd.trim()}
            onClick={() => {
              const name = customName.trim() || (customSave
                ? deriveProfileName(customCmd.trim(), profiles.map((p) => p.name))
                : '');
              onLaunchCustom(name, customCmd.trim(), customSave);
            }}
          >
            Run
          </button>
          <button className="px-3 py-1.5 rounded border border-[--border] hover:bg-[--panel] text-[--text-muted]" onClick={() => setCustomOpen(false)}>Back</button>
        </div>
        <div className="text-[10px] text-[--text-muted]">
          {remoteMenu ? 'Runs on the remote machine in a new tab.' : 'Adds this as a new tab. To move it to a separate window afterwards, click the popout icon in the top bar.'}
        </div>
      </m.div>
    );
  }

  return (
    <m.div
      {...panelProps}
      className="new-shell-menu absolute mt-1 z-40 rounded-md border border-[--border] bg-[--panel-strong] shadow-xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-[--border]">
        <div className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">
          Add a shell
        </div>
        <div className="text-[10px] text-[--text-muted] mt-0.5">
          {remoteMenu ? 'Opens a tab on the linked machine.' : 'Opens as a new tab. Use the popout icon to move it to its own window.'}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[--hue-orange-text]">{PROJECT_SETTINGS_COPY.menuDefaultNotice}</p>
      </div>
      {profilesError && remoteMenu && <p role="alert" className="px-3 py-4 text-xs text-[--danger]">{remoteMenuErrorCopy(profilesError, remoteMenu.hostName)}</p>}
      {profiles.length === 0 && !profilesError && (
        <div className="px-3 py-4 text-xs text-[--text-muted] text-center">
          No CLIs configured yet. Add one below.
        </div>
      )}
      {profiles.map((p) => {
        const isDefault = defaultCliName === p.name;
        return (
          <div key={p.name} className="group flex items-stretch hover:bg-[--panel]">
            <button
              className="flex-1 text-left px-3 py-2 text-xs flex items-center gap-2"
              onClick={() => onLaunchProfile(p.name)}
              title={p.argv?.join(' ') ?? p.name}
            >
              <span aria-hidden="true" className="w-5 h-5 shrink-0 flex items-center justify-center text-base leading-none">
                {p.icon ?? '▸'}
              </span>
              <span className="flex-1 truncate font-medium">{p.name}</span>
              {isDefault && <span className="text-[9px] uppercase text-[color:var(--accent)] px-1 py-0.5 rounded bg-[color:var(--accent)]/15 border border-[color:var(--accent)]/40">auto</span>}
              {p.scope === 'project' && !isDefault && <span className="text-[9px] uppercase text-[--text-muted] px-1 py-0.5 rounded bg-[--panel] border border-[--border]">saved</span>}
            </button>
            <Tooltip label={isDefault ? 'Clear folder default (fall back to global)' : `Make ${p.name} the auto-launch for this folder`}>
              <button
                disabled={savingDefault}
                className={`px-2 flex items-center transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] ${isDefault
                  ? 'text-[color:var(--accent)] opacity-100'
                  : 'opacity-0 group-hover:opacity-60 focus:opacity-100 hover:opacity-100 text-[--text-muted] hover:text-[color:var(--accent)]'}`}
                onClick={async () => {
                  if (savingDefault) return;
                  setSavingDefault(true);
                  try {
                    if (remoteMenu) await remoteMenu.setDefault(isDefault ? null : p.name);
                    else {
                      const { project } = await api.invoke('shells:set-default-cli', { projectId, name: isDefault ? null : p.name });
                      if (project.id !== projectId) return;
                      onDefaultChanged?.(project);
                    }
                    toast(isDefault ? `Cleared folder default` : `${p.name} will auto-launch in this folder`, { kind: 'success', timeoutMs: 1400 });
                  } catch (e) {
                    toast('Could not set default', { kind: 'error', detail: errMessage(e) });
                  } finally {
                    setSavingDefault(false);
                  }
                }}
                aria-label={isDefault ? 'Clear folder default' : `Set ${p.name} as folder default`}
              >
                {isDefault ? <StarFilledIcon /> : <StarIcon />}
              </button>
            </Tooltip>
            {p.scope === 'project' && (
              <Tooltip label="Remove from this project">
                <button
                  className="px-2 opacity-0 group-hover:opacity-60 hover:opacity-100 hover:text-[--danger] flex items-center"
                  onClick={() => removeProfile(p.name)}
                  aria-label={`Remove ${p.name} from this project`}
                >
                  <XIcon size={ICON_SIZE.sm} />
                </button>
              </Tooltip>
            )}
          </div>
        );
      })}
      {/* A remote host runs only its own saved profiles; viewers cannot send it a raw command. */}
      {!remoteMenu && <div className="border-t border-[--border]">
        <button
          onClick={() => setCustomOpen(true)}
          className="w-full text-left px-3 py-2 text-xs hover:bg-[--panel] flex items-center gap-2 text-[--text-muted] hover:text-[--text]"
        >
          <span className="w-5 text-center text-base leading-none">＋</span>
          <span>Add a custom command…</span>
        </button>
      </div>}
      <div className="border-t border-[--border]">
        <button
          onClick={onLaunchPlainTab}
          className="w-full text-left px-3 py-2 text-xs hover:bg-[--panel] flex items-center justify-between"
          title={remoteMenu ? "Opens the linked machine's login shell in this project's directory" : "Opens your login shell ($SHELL) at the project's directory"}
        >
          <span className="flex items-center gap-2">
            <span className="w-5 text-center text-base leading-none">⌨️</span>
            <span>Terminal</span>
          </span>
          <span className="opacity-60 font-mono">{SHORTCUT_COPY.newTerminalHint(platform)}</span>
        </button>
      </div>
    </m.div>
  );
}

export interface ShellTabsBarItem {
  projectId: number;
  shellIndex: number;
  pinned: boolean;
  startedAt: string | null;
  lastActiveAt: string | null;
  launchName: string;
  agent?: AgentKind | null;
  state?: AgentState;
}

interface ChipStripProps {
  readonly projectId: number;
  readonly shells: readonly ShellTabsBarItem[];
  readonly active: number;
  readonly reduced: boolean;
  readonly onSelect: (idx: number) => void;
  readonly onClose: (idx: number, cancelCloseMotion?: () => void) => void;
  readonly renderDot?: (shell: ShellTabsBarItem, active: boolean) => React.ReactNode;
}

interface ChipSnapshot {
  readonly viewport: DOMRect;
  readonly boxes: Map<HTMLElement, DOMRect>;
}

const CHIP_ENTER_MS = 200;
const CHIP_EXIT_MS = 180;
const CHIP_REFLOW_MS = 160;
const CHIP_OFFSET = 'translateY(6px)';
const CHIP_FADE_EASING = 'cubic-bezier(0.33, 1, 0.68, 1)';

function chipKey(shell: ShellTabsBarItem): string {
  return `${shell.shellIndex}:${shell.startedAt}`;
}

/** Uses React's pre-commit snapshot to animate real chip positions without changing the flow layout. */
class ChipStrip extends Component<ChipStripProps> {
  private readonly scroller = createRef<HTMLDivElement>();
  private readonly exits = createRef<HTMLDivElement>();
  private readonly closing = new WeakMap<HTMLElement, number>();
  private readonly slides = new Map<HTMLElement, Animation>();
  private membershipRevision = 0;
  private entry: { index: number; deadline: number } | null = null;

  launchResult(): ShellLaunched {
    this.entry = null;
    const before = this.membershipRevision;
    return index => {
      // If the broadcast committed first, the launch index no longer identifies a safe entrance.
      if (!this.scroller.current || before !== this.membershipRevision || this.props.shells.some(shell => shell.shellIndex === index)) return;
      this.entry = { index, deadline: performance.now() + CHIP_ENTER_MS };
    };
  }

  beginClose(index: number): (() => void) | undefined {
    const chip = this.chips().find(node => node.dataset.shellIndex === String(index));
    if (!chip) return;
    this.closing.set(chip, (this.closing.get(chip) ?? 0) + 1);
    return () => {
      const pending = this.closing.get(chip) ?? 0;
      if (pending > 1) this.closing.set(chip, pending - 1);
      else this.closing.delete(chip);
    };
  }

  private close(event: ReactMouseEvent<HTMLButtonElement>, index: number): void {
    event.stopPropagation();
    this.props.onClose(index, this.beginClose(index));
  }

  private chips(): HTMLElement[] {
    return Array.from(this.scroller.current?.children ?? []).filter(node => node instanceof HTMLElement);
  }

  override getSnapshotBeforeUpdate(prev: ChipStripProps): ChipSnapshot | null {
    const shells = this.props.shells;
    if (prev.shells.length === shells.length && prev.shells.every((shell, i) => {
      const next = shells[i];
      return next && chipKey(shell) === chipKey(next);
    })) return null;
    const viewport = this.scroller.current?.getBoundingClientRect();
    return viewport ? { viewport, boxes: new Map(this.chips().map(node => [node, node.getBoundingClientRect()])) } : null;
  }

  override componentDidUpdate(prev: ChipStripProps, _state: unknown, before: ChipSnapshot | null): void {
    if (before || prev.reduced !== this.props.reduced) this.cancelSlides();
    if (!before) return;
    this.membershipRevision++;
    const entry = this.entry;
    this.entry = null;
    const live = new Set(this.chips());
    const added = [...live].filter(node => !before.boxes.has(node));
    const removed = [...before.boxes].filter(([node]) => !live.has(node));
    const [newChip] = added;
    const enters = newChip && added.length === 1 && removed.length === 0 && entry &&
      newChip.dataset.shellIndex === String(entry.index) && performance.now() <= entry.deadline;
    if (enters) this.fade(newChip, false);

    const closing = removed.filter(([node]) => this.closing.has(node));
    for (const [node, box] of closing) {
      this.closing.delete(node);
      this.leave(node, box, before.viewport);
    }
    const onlyTabClose = closing.length > 0 && closing.length === removed.length && added.length === 0;
    if (!this.props.reduced && (enters || onlyTabClose)) this.slide(live, before.boxes);
  }

  override componentWillUnmount(): void {
    this.cancelSlides();
  }

  private fade(node: HTMLElement, exit: boolean): Animation {
    const faded: Keyframe = { opacity: 0, ...(this.props.reduced ? {} : { transform: CHIP_OFFSET }) };
    const shown: Keyframe = { opacity: 1, ...(this.props.reduced ? {} : { transform: 'none' }) };
    return node.animate(exit ? [shown, faded] : [faded, shown], {
      duration: exit ? CHIP_EXIT_MS : CHIP_ENTER_MS,
      easing: CHIP_FADE_EASING,
    });
  }

  private leave(node: HTMLElement, box: DOMRect, viewport: DOMRect): void {
    const exits = this.exits.current;
    if (!exits || box.right <= viewport.left || box.left >= viewport.right) return;
    const frame = exits.getBoundingClientRect();
    const ghost = node.cloneNode(true);
    if (!(ghost instanceof HTMLElement)) return;
    ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('data-testid', 'shell-tab-leaving');
    ghost.removeAttribute('data-shell-index');
    // The live scroller can shrink past a closing chip; keep its old clipping bounds.
    const clip = document.createElement('div');
    Object.assign(clip.style, {
      position: 'absolute', overflow: 'hidden',
      left: `${viewport.left - frame.left}px`, top: `${viewport.top - frame.top}px`,
      width: `${viewport.width}px`, height: `${viewport.height}px`,
    });
    Object.assign(ghost.style, {
      position: 'absolute', left: `${box.left - viewport.left}px`, top: `${box.top - viewport.top}px`,
      width: `${box.width}px`, height: `${box.height}px`,
    });
    clip.append(ghost);
    exits.append(clip);
    this.fade(ghost, true).onfinish = () => clip.remove();
  }

  private slide(live: Set<HTMLElement>, before: Map<HTMLElement, DOMRect>): void {
    const offsets = [...live].map(node => {
      const x = node.getBoundingClientRect().left;
      return { node, dx: (before.get(node)?.left ?? x) - x };
    });
    for (const { node, dx } of offsets) {
      if (Math.abs(dx) < 0.5) continue;
      const animation = node.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
        duration: CHIP_REFLOW_MS,
        easing: getComputedStyle(node).getPropertyValue('--ease-out').trim(),
      });
      this.slides.set(node, animation);
      animation.onfinish = () => this.slides.delete(node);
    }
  }

  private cancelSlides(): void {
    for (const animation of this.slides.values()) animation.cancel();
    this.slides.clear();
  }

  override render(): React.ReactNode {
    const { shells, active, projectId, onSelect, renderDot } = this.props;
    return (
      <div className="relative min-w-0">
        <div ref={this.scroller} className="flex items-center gap-1 overflow-x-auto">
          {shells.map((s) => {
            const label = shellChipLabel(shells, s.shellIndex);
            const isActive = s.shellIndex === active;
            return (
              <div
                key={chipKey(s)}
                data-testid={SHELL_TAB_TEST_ID}
                data-shell-index={s.shellIndex}
                className={`terminal-chip group flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md cursor-pointer whitespace-nowrap
                  ${isActive ? REMOTE_ACTIVE_CHIP_CLASS : 'hover:bg-[--surface-hover]'}`}
                onClick={() => onSelect(s.shellIndex)}
              >
                {renderDot ? renderDot(s, isActive) : <ShellTabDot projectId={projectId} shellIndex={s.shellIndex} isActive={isActive} />}
                <span className={`${isActive ? 'text-[--text] font-medium' : 'text-[--text-muted]'}`}>{label}</span>
                <Tooltip label={`Close ${label}`} wrapClassName="ml-0.5 opacity-0 group-hover:opacity-70 hover:opacity-100">
                  <button
                    onClick={e => this.close(e, s.shellIndex)}
                    className="hover:text-[--danger] w-4 h-4 flex items-center justify-center rounded"
                    aria-label={`Close ${label}`}
                  >
                    <XIcon />
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
        <div ref={this.exits} className="pointer-events-none absolute inset-0" aria-hidden="true" />
      </div>
    );
  }
}

/** The desktop strip owns membership motion and the new-shell menu, not shell activation or PTY lifetime. */
export function ShellTabsBar({
  projectId, shells, active, onSelect, onClose,
  defaultCliName, onDefaultCliChanged, remoteMenu, renderDot,
  onLaunchProfile, onLaunchPlainTab, onLaunchCustom,
  motionRef,
}: {
  projectId: number;
  shells: readonly ShellTabsBarItem[];
  active: number;
  onSelect: (idx: number) => void;
  onClose: ChipStripProps['onClose'];
  /** Current per-folder auto-launch CLI, forwarded to NewShellMenu's star toggle. */
  defaultCliName: string | null;
  onDefaultCliChanged?: (project: Project) => void;
  remoteMenu?: RemoteShellMenu;
  renderDot?: (shell: ShellTabsBarItem, active: boolean) => React.ReactNode;
  onLaunchProfile: (name: string, onLaunched?: ShellLaunched) => void;
  onLaunchPlainTab: (onLaunched?: ShellLaunched) => void;
  onLaunchCustom: (name: string, cmdLine: string, save: boolean, onLaunched?: ShellLaunched) => void;
  motionRef?: Ref<ShellTabMotion>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const platform = useShortcutPlatform();
  const strip = useRef<ChipStrip>(null);
  useImperativeHandle(motionRef, () => ({
    launchResult: () => strip.current?.launchResult(),
    beginClose: index => strip.current?.beginClose(index),
  }), []);
  const reduced = usePrefersReducedMotion();
  return (
    <div className="shell-tabs-bar no-drag flex min-w-0 max-w-full items-center gap-1 px-[14px] text-xs">
      <ChipStrip ref={strip} {...{ projectId, shells, active, reduced, onSelect, onClose, renderDot }} />
      {/* Add button sits right after the chips, outside their scroller so it never scrolls away. Click opens a
          menu of CLIs; the selected one is added as another tab. To put it
          in its own window instead, use the popout icon in the top toolbar
          (it moves the currently-active tab out). */}
      <div className="shrink-0">
        <Tooltip label="Add a shell" shortcut={SHORTCUT_COPY.newTerminalHint(platform)}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="new-shell-trigger text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
            data-testid="tabbar-new-shell"
          >
            <PlusIcon size={ICON_SIZE.sm} />
          </button>
        </Tooltip>
        <AnimatePresence>
          {menuOpen && (
          <NewShellMenu
            key={`new-shell-menu-${projectId}`}
            projectId={projectId}
            defaultCliName={defaultCliName}
            remoteMenu={remoteMenu}
            onDefaultChanged={onDefaultCliChanged}
            onLaunchProfile={(name) => { setMenuOpen(false); onLaunchProfile(name, strip.current?.launchResult()); }}
            onLaunchPlainTab={() => { setMenuOpen(false); onLaunchPlainTab(strip.current?.launchResult()); }}
            onLaunchCustom={(name, cmdLine, save) => {
              setMenuOpen(false);
              onLaunchCustom(name, cmdLine, save, strip.current?.launchResult());
            }}
            onClose={() => setMenuOpen(false)}
          />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
