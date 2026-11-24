import { useId, useRef } from 'react';
import { useDialogFocus } from '@renderer/hooks/useDialogFocus';
import { MODAL_CLASSES } from '@renderer/modal-glass';
import { ModalFrame } from './ModalFrame';
import { XIcon } from './shell-icons';
import { SHORTCUTS, type ShortcutDef, type ShortcutKeyLike, type ShortcutPlatform } from '@renderer/shortcut-contract';
import { formatShortcut } from '@renderer/shortcut-format';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
import { routeTerminalKey } from '@renderer/terminal-keys';

interface ShortcutRow {
  /** The shortcut first, then any alternatives that do the same thing. */
  readonly keys: readonly ShortcutDef[];
  readonly label: string;
}

const SHORTCUT_GROUPS: ReadonlyArray<{ readonly title: string; readonly rows: readonly ShortcutRow[] }> = [
  { title: 'Go', rows: [
    { keys: [SHORTCUTS.palette, SHORTCUTS.paletteCommands], label: 'Command palette' },
    { keys: [SHORTCUTS.findFile], label: 'Find file in project' },
    { keys: [SHORTCUTS.findInProject], label: 'Find in project' },
  ] },
  { title: 'Views', rows: [
    { keys: [SHORTCUTS.sidebar], label: 'Toggle sidebar' },
    { keys: [SHORTCUTS.agentsDock], label: 'Toggle agents dock' },
    { keys: [SHORTCUTS.agentsComposer], label: 'Focus agents composer' },
    { keys: [SHORTCUTS.settings], label: 'Settings' },
    { keys: [SHORTCUTS.help], label: 'This cheat sheet' },
  ] },
  { title: 'Project', rows: [
    { keys: [SHORTCUTS.newProject], label: 'New project' },
    { keys: [SHORTCUTS.newTerminal], label: 'New terminal' },
    { keys: [SHORTCUTS.newTerminalWindow], label: 'New terminal in a new window' },
  ] },
  { title: 'Shell', rows: [
    { keys: [SHORTCUTS.findInTerminal], label: 'Find in terminal' },
    { keys: [SHORTCUTS.scrollbackSearch], label: 'Search all shells' },
    { keys: [SHORTCUTS.prompts], label: 'Prompt library' },
    { keys: [SHORTCUTS.zoomIn], label: 'Zoom in' },
    { keys: [SHORTCUTS.zoomOut], label: 'Zoom out' },
    { keys: [SHORTCUTS.zoomReset], label: 'Reset zoom' },
  ] },
];

/** The keydown a definition produces off mac, so terminal routing can say who owns it. */
function keyEventFor(def: ShortcutDef): ShortcutKeyLike {
  return {
    type: 'keydown',
    key: def.shift ? def.key.toUpperCase() : def.key.toLowerCase(),
    ctrlKey: !!(def.mod || def.ctrl),
    metaKey: false,
    shiftKey: !!def.shift,
    altKey: !!def.alt,
  };
}

/** True when the shell, not the app, gets this shortcut while a terminal is focused off mac. */
const goesToShell = (def: ShortcutDef): boolean => routeTerminalKey(keyEventFor(def), 'other') === 'shell';

/** "A, B and C" */
function listOf(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One shortcut chip; off mac, a shell-owned key also carries a visible marker and a screen-reader note. */
function ShortcutKey({ def, platform }: { readonly def: ShortcutDef; readonly platform: ShortcutPlatform }): React.JSX.Element {
  const label = formatShortcut(def, platform);
  if (platform === 'mac' || !goesToShell(def)) return <kbd>{label}</kbd>;
  return (
    <span data-terminal-shell="true" className="inline-flex items-start">
      <kbd>{label}</kbd>
      <span aria-hidden="true" className="text-[10px] leading-none">*</span>
      <span className="sr-only">, goes to the shell while a terminal is focused</span>
    </span>
  );
}

/** Off-mac note naming every shell-owned shortcut (sidebar backslash included) and the terminal-safe palette key. */
function TerminalNote(): React.JSX.Element {
  const shellKeys = [...SHORTCUT_GROUPS.flatMap((g) => g.rows.flatMap((r) => r.keys)), SHORTCUTS.sidebarAlt]
    .filter(goesToShell)
    .map((def) => formatShortcut(def, 'other'));
  return (
    <p data-testid="shortcuts-terminal-note" className="px-5 pb-4 text-[11px] text-[--modal-text-muted]">
      <span aria-hidden="true">* </span>In a terminal, {listOf(shellKeys)} go to the shell. Use {formatShortcut(SHORTCUTS.paletteCommands, 'other')} for the command palette.
    </p>
  );
}

interface ShortcutsHelpProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Keyboard shortcut cheat sheet (⌘/, Ctrl+/ off mac) on the shared modal frame and glass sheet,
 * labelled in the platform's notation. Off mac it stars the shortcuts the shell keeps while a
 * terminal is focused and explains them in a note (AC13). Each row is a dt/dd pair: the label,
 * then the shortcut and its alternatives. A click on the scrim, the close button or Escape
 * (handled by App) calls `onClose`. While open the dialog holds focus (Tab wraps inside it) and
 * gives it back to the opener on close.
 */
export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps): React.JSX.Element | null {
  return open ? <ShortcutsSheet onClose={onClose} /> : null;
}

function ShortcutsSheet({ onClose }: Pick<ShortcutsHelpProps, 'onClose'>): React.JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useDialogFocus(panelRef);
  const platform = useShortcutPlatform();
  return (
    <ModalFrame testId="shortcuts-help" tier="modal" motion="none" layerClassName="flex items-center justify-center" onDismiss={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`${MODAL_CLASSES.sheet} w-[560px] max-w-[92vw] overflow-hidden focus-visible:rounded-2xl focus-visible:outline-none`}
      >
        <div className="px-4 py-3 border-b border-[--modal-hairline] flex items-center justify-between">
          <h2 id={titleId} className="font-semibold text-sm">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-[--modal-text-muted] hover:text-[--text] hover:bg-[--surface-hover]"
            title="Close (Esc)"
            aria-label="Close shortcuts"
          >
            <XIcon />
          </button>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title}>
              <h3 className="text-[10px] uppercase tracking-wider text-[--modal-text-muted] font-semibold mb-2">{g.title}</h3>
              <dl className="space-y-1.5">
                {g.rows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
                    <dt className="text-[--modal-text-muted]">{row.label}</dt>
                    <dd className="flex items-center gap-1">
                      {row.keys.map((def) => <ShortcutKey key={formatShortcut(def, platform)} def={def} platform={platform} />)}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        {platform !== 'mac' && <TerminalNote />}
        <div className="px-4 py-2 border-t border-[--modal-hairline] text-[11px] text-[--modal-text-muted] text-right">
          <kbd>Esc</kbd> to close
        </div>
      </div>
    </ModalFrame>
  );
}
