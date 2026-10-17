import { useEffect, useState } from 'react';
import { AnimatePresence, m, useIsPresent, useReducedMotion } from 'motion/react';
import { menuMotion } from '../menu-motion';
import { toast } from '../hooks/useToasts';
import { api } from '../api';
import { Tooltip } from './Tooltip';
import { SHELL_TAB_TEST_ID } from '@shared/agent-state';
import { ShellTabDot } from './ShellTabDot';
import { shellChipLabel } from '../shell-label';
import { SplitPill } from './SplitPill';
import { PlusIcon, StarFilledIcon, StarIcon, XIcon } from './shell-icons';
import type { ScopedCliProfile } from '@shared/project-default-agent';
import type { Project } from '@shared/types';
import { PROJECT_SETTINGS_COPY } from '@renderer/project-settings-contract';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { useShortcutPlatform } from '@renderer/shortcut-platform';

const piIconUrl = new URL('../assets/cli-icons/pi.svg', import.meta.url).href;
const ompIconUrl = new URL('../assets/cli-icons/omp.svg', import.meta.url).href;


/** The add-shell menu: saved CLI profiles with a default-star toggle, a custom-command form and the plain terminal row. */
export function NewShellMenu({
  projectId,
  defaultCliName,
  onLaunchProfile,
  onLaunchPlainTab,
  onLaunchCustom,
  onDefaultChanged,
  onClose,
}: {
  projectId: number;
  /** Current per-project auto-launch CLI (drives the star toggle). */
  defaultCliName: string | null;
  onLaunchProfile: (name: string) => void;
  onLaunchPlainTab: () => void;
  onLaunchCustom: (name: string, cmdLine: string, save: boolean) => void;
  /** Called when the star toggle sets/clears the folder-level default. */
  onDefaultChanged: (project: Project) => void;
  onClose: () => void;
}) {
  const platform = useShortcutPlatform();
  const [profiles, setProfiles] = useState<ScopedCliProfile[]>([]);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [customSave, setCustomSave] = useState(true);

  const [savingDefault, setSavingDefault] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const { profiles } = await api.invoke('shells:cli-profiles-list', { projectId });
        setProfiles(profiles);
      } catch { /* ignore */ }
    })();
  }, [projectId]);

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
      await api.invoke('shells:cli-profiles-remove', { projectId, name });
      setProfiles(prev => prev.filter(p => p.name !== name));
    } catch { /* ignore */ }
  }

  if (customOpen) {
    return (
      <m.div
        {...panelProps}
        className="absolute top-full left-0 mt-1 z-40 w-80 rounded-md border border-[--border] bg-[--panel-strong] shadow-xl overflow-hidden p-3 space-y-2 text-xs"
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
            onClick={() => onLaunchCustom(customName.trim(), customCmd.trim(), customSave && !!customName.trim())}
          >
            Run
          </button>
          <button className="px-3 py-1.5 rounded border border-[--border] hover:bg-[--panel] text-[--text-muted]" onClick={() => setCustomOpen(false)}>Back</button>
        </div>
        <div className="text-[10px] text-[--text-muted]">
          Adds this as a new tab. To move it to a separate window afterwards, click the popout icon in the top bar.
        </div>
      </m.div>
    );
  }

  return (
    <m.div
      {...panelProps}
      className="absolute top-full left-0 mt-1 z-40 w-72 rounded-md border border-[--border] bg-[--panel-strong] shadow-xl overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-[--border]">
        <div className="text-[10px] uppercase tracking-wider text-[--text-muted] font-semibold">
          Add a shell
        </div>
        <div className="text-[10px] text-[--text-muted] mt-0.5">
          Opens as a new tab. Use the popout icon to move it to its own window.
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[--hue-orange-text]">{PROJECT_SETTINGS_COPY.menuDefaultNotice}</p>
      </div>
      {profiles.length === 0 && (
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
              title={p.argv.join(' ')}
            >
              <span aria-hidden="true" className="w-5 h-5 shrink-0 flex items-center justify-center text-base leading-none">
                {p.icon === 'builtin:pi' ? (
                  <span
                    className="w-5 h-5 bg-current"
                    style={{
                      maskImage: `url("${piIconUrl}")`,
                      maskSize: 'contain',
                      maskRepeat: 'no-repeat',
                      maskPosition: 'center',
                      WebkitMaskImage: `url("${piIconUrl}")`,
                      WebkitMaskSize: 'contain',
                      WebkitMaskRepeat: 'no-repeat',
                      WebkitMaskPosition: 'center',
                    }}
                  />
                ) : p.icon === 'builtin:omp' ? (
                  <img src={ompIconUrl} alt="" className="w-5 h-5" />
                ) : (
                  p.icon ?? '▸'
                )}
              </span>
              <span className="flex-1 truncate font-medium">{p.name}</span>
              {isDefault && <span className="text-[9px] uppercase text-[color:var(--accent)] px-1 py-0.5 rounded bg-[color:var(--accent)]/15 border border-[color:var(--accent)]/40">auto</span>}
              {p.scope === 'project' && !isDefault && <span className="text-[9px] uppercase text-[--text-muted] px-1 py-0.5 rounded bg-[--panel] border border-[--border]">saved</span>}
            </button>
            <button
              disabled={savingDefault}
              className={`px-2 flex items-center transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--accent] ${isDefault
                ? 'text-[color:var(--accent)] opacity-100'
                : 'opacity-0 group-hover:opacity-60 focus:opacity-100 hover:opacity-100 text-[--text-muted] hover:text-[color:var(--accent)]'}`}
              onClick={async () => {
                if (savingDefault) return;
                const capturedProjectId = projectId;
                setSavingDefault(true);
                try {
                  const { project } = await api.invoke('shells:set-default-cli', { projectId: capturedProjectId, name: isDefault ? null : p.name });
                  if (project.id !== capturedProjectId) return;
                  onDefaultChanged(project);
                  toast(isDefault ? `Cleared folder default` : `${p.name} will auto-launch in this folder`, { kind: 'success', timeoutMs: 1400 });
                } catch (e) {
                  toast('Could not set default', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
                } finally {
                  setSavingDefault(false);
                }
              }}
              title={isDefault ? 'Clear folder default (fall back to global)' : `Make ${p.name} the auto-launch for this folder`}
              aria-label={isDefault ? 'Clear folder default' : `Set ${p.name} as folder default`}
            >
              {isDefault ? <StarFilledIcon /> : <StarIcon />}
            </button>
            {p.scope === 'project' && (
              <button
                className="px-2 opacity-0 group-hover:opacity-60 hover:opacity-100 hover:text-[--danger] flex items-center"
                onClick={() => removeProfile(p.name)}
                title="Remove from this project"
              >
                <XIcon />
              </button>
            )}
          </div>
        );
      })}
      <div className="border-t border-[--border]">
        <button
          onClick={() => setCustomOpen(true)}
          className="w-full text-left px-3 py-2 text-xs hover:bg-[--panel] flex items-center gap-2 text-[--text-muted] hover:text-[--text]"
        >
          <span className="w-5 text-center text-base leading-none">＋</span>
          <span>Add a custom command…</span>
        </button>
      </div>
      <div className="border-t border-[--border]">
        <button
          onClick={onLaunchPlainTab}
          className="w-full text-left px-3 py-2 text-xs hover:bg-[--panel] flex items-center justify-between"
          title="Opens your login shell ($SHELL) at the project's directory"
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
}

export function ShellTabsBar({
  projectId, shells, active, onSelect, onClose,
  defaultCliName, onDefaultCliChanged,
  onLaunchProfile, onLaunchPlainTab, onLaunchCustom,
  splitOn, onToggleSplit,
}: {
  projectId: number;
  shells: ShellTabsBarItem[];
  active: number;
  onSelect: (idx: number) => void;
  onClose: (idx: number) => void;
  /** Current per-folder auto-launch CLI, forwarded to NewShellMenu's star toggle. */
  defaultCliName: string | null;
  onDefaultCliChanged: (project: Project) => void;
  onLaunchProfile: (name: string) => void;
  onLaunchPlainTab: () => void;
  onLaunchCustom: (name: string, cmdLine: string, save: boolean) => void;
  /** True when the split view is active — the toggle icon reflects it. */
  splitOn: boolean;
  onToggleSplit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const platform = useShortcutPlatform();
  return (
    <div className="flex items-center gap-1 pl-2 pr-[14px] py-1 text-xs shrink-0 overflow-visible">
      <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
        {shells.map((s) => {
          // Show the name of the running CLI (e.g. "Claude", "Llama", "Terminal").
          const label = shellChipLabel(shells, s.shellIndex);
          const isActive = s.shellIndex === active;
          return (
            <div
              key={s.shellIndex}
              data-testid={SHELL_TAB_TEST_ID}
              data-shell-index={s.shellIndex}
              className={`group flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md cursor-pointer whitespace-nowrap
                ${isActive ? 'bg-[--surface-active]' : 'hover:bg-[--surface-hover]'}`}
              onClick={() => onSelect(s.shellIndex)}
            >
              <ShellTabDot projectId={projectId} shellIndex={s.shellIndex} isActive={isActive} />
              <span className={`${isActive ? 'text-[--text] font-medium' : 'text-[--text-muted]'}`}>{label}</span>
              {s.shellIndex !== 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(s.shellIndex); }}
                  className="ml-0.5 opacity-0 group-hover:opacity-70 hover:opacity-100 hover:text-[--danger] w-4 h-4 flex items-center justify-center rounded"
                  title={`Close ${label}`}
                >
                  <XIcon />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Add button sits right after the chips, outside their scroller so it never scrolls away. Click opens a
          menu of CLIs; the selected one is added as another tab. To put it
          in its own window instead, use the popout icon in the top toolbar
          (it moves the currently-active tab out). */}
      <div className="relative shrink-0">
        <Tooltip label="Add a shell" shortcut={SHORTCUT_COPY.newTerminalHint(platform)}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="text-[--text-muted] hover:text-[--text] w-6 h-6 flex items-center justify-center rounded hover:bg-[--panel-strong]"
            data-testid="tabbar-new-shell"
          >
            <PlusIcon />
          </button>
        </Tooltip>
        <AnimatePresence>
          {menuOpen && (
          <NewShellMenu
            key={`new-shell-menu-${projectId}`}
            projectId={projectId}
            defaultCliName={defaultCliName}
            onDefaultChanged={onDefaultCliChanged}
            onLaunchProfile={(name) => { setMenuOpen(false); onLaunchProfile(name); }}
            onLaunchPlainTab={() => { setMenuOpen(false); onLaunchPlainTab(); }}
            onLaunchCustom={(name, cmdLine, save) => {
              setMenuOpen(false);
              onLaunchCustom(name, cmdLine, save);
            }}
            onClose={() => setMenuOpen(false)}
          />
          )}
        </AnimatePresence>
      </div>
      <div className="flex-1" />
      <SplitPill on={splitOn} onToggle={onToggleSplit} />
    </div>
  );
}
