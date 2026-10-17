# Architecture

## Overview

MetaLogix IDE is an Electron desktop app with a main process (`src/main/`),
a preload script (`src/preload/`) and a React renderer (`src/renderer/`). The
renderer calls the main process through the IPC API that the preload script
exposes as `window.api` (`src/renderer/api.ts:4`).

This document is incomplete. At this time it describes only the Markdown
preview pipeline, terminal focus, Claude notifications and the Claude status
dots. The product design is in
`docs/superpowers/specs/2026-07-18-metaide-design.md`.

### Main-process startup invariant

After services are constructed, `src/main/index.ts` registers every generic
IPC handler before creating the initial `BrowserWindow`. `startApp`
(`src/main/index.ts:503-518`) runs the startup steps in order, and
`registerMainIpc` comes before `openMainWindow`. Renderer providers
may invoke settings channels while the first document is still loading, so
window creation must not move ahead of `registerIpc`.

| Layer | File | Responsibility |
|---|---|---|
| Composition | `src/main/index.ts` | `startApp` runs the startup steps in order. It owns the module state: the main window, popout windows, and the window-setting readers. It reads the environment and app paths. |
| Composition | `src/main/startup/receivers.ts` | Starts the Claude hook receiver, then the OMP receiver. A failure in either is logged and does not stop startup. |
| Composition | `src/main/startup/boot-rescan.ts` | Rescans every registered root at boot and prunes projects whose folder is gone. A failure is logged. |
| Logic and adapter | `src/main/startup/done-notifier.ts` | Polls finished long-running commands every 500 ms. `planDoneNotice` decides, for one finished command, whether to notify and how. Each command is planned and shown before the next. The wiring shows the native notification and routes its click to the main window or a popout. |

On macOS, startup resolves PATH from the user's interactive login shell before
constructing services or creating a renderer (`adoptLoginShellPath`,
`src/main/index.ts:377-389`, the first step of `startApp`).
The resolver reads only NUL-framed PATH output, ignoring shell startup banners.
It limits execution to 10 seconds and output to 1 MiB
(`src/main/domain/login-shell-path.ts:10-33`).
If resolution fails, startup logs a warning and retains the inherited PATH.
Managed runtimes such as mise-provided Bun are available when the shell exposes
them in PATH. CLI profile commands still launch directly, not through shell text.

`buildServices()` clears the `shells` table before constructing the fresh PTY
runtime (`src/main/services.ts:77-96`). These records belong to the previous
runtime, not resumable terminals. Cleanup removes pinned and unpinned records
but preserves projects and settings. Previous-run records cannot consume the
keep-alive cap or block the first terminal after restart.

### Main-process responsiveness

The Electron main thread also pumps the window event loop. If it stays busy
for about 2 s (macOS) or 5 s (GNOME), the OS reports the app as not
responding. Work that runs on a timer or once per PTY chunk must therefore
stay cheap and must never wait on a child process.

- **PTY output is coalesced.** `PtyManager` buffers each shell's output and
  emits one `data` event per shell every `OUTPUT_FLUSH_MS` (5 ms)
  (`src/main/pty/manager.ts`). Each event becomes one `pty:data` send per
  window. Pending output is flushed before the shell's `exit` event and on
  kill, so no byte is lost or reordered.
- **Scrollback append is O(chunk).** `RollingScrollback` keeps the raw
  scrollback as a list of chunks with a running length and trims whole
  chunks from the front. It joins the chunks and snaps the cut to a line
  boundary only when `getScrollback` or `searchScrollback` reads it.
- **Polled child processes are asynchronous.** `git:status`,
  `git:panel-status`, `git:file-diff` and `git:diff-sides` run git through
  the async `runGit` (`src/main/git/run-git.ts`). The `shells:live-stats`
  sampler runs `ps` through async `execFile`. Async replies can arrive out
  of order, so every git poller in the renderer (`useGitStatus`,
  `usePanelStatus` in `GitPanel.tsx`, `useGitChanges`) uses
  `createRequestGate`: it applies only the latest request's reply and
  skips a poll tick while a request is in flight. Git commands that the user
  starts (`add`, `restore`, `commit`, `push`, `pull`, `clone`, `init`) still
  use `spawnSync`; this is a known gap, recorded as a follow-up.

## Components

### Coding-agent CLI profiles

The shell tab bar's **+** menu offers **Pi** (`pi`) and **oh-my-pi** (`omp`)
alongside Claude, OpenAI Codex, and the other built-in CLI profiles.
Install and configure each agent separately; the IDE starts its executable through the user's PATH.
The IDE does not install agents or supply their provider credentials.

`src/main/repos/settings-repo.ts` seeds the profiles on new installations.
Its existing name-based merge also adds missing built-in profiles to existing installations.
Profiles with the same name retain their custom command and environment.

The Pi and oh-my-pi profiles use official SVG icons bundled with the renderer.
Startup fills missing icons on existing global profiles without replacing
custom icons, commands, environments, or profile order
(`src/main/repos/settings-repo.ts:65-85`).
Pi's monochrome mark follows the app text color; omp retains its gradient.
The build emits these icons as local files because the CSP blocks data URLs
(`electron.vite.config.ts:62-63`).
Icon sources: [Pi favicon](https://pi.dev/favicon.svg) and
[omp favicon](https://omp.sh/favicon.svg).
Project profiles override global profiles (`src/main/domain/launch.ts:14-18`).

Click a profile to open a new terminal tab.
Use its star button to select the project's default agent.
Clear the star to use the global launch commands.
The existing shell launch, environment, tab, and popout paths apply to these agents.
Pi and oh-my-pi use bare `pi` and `omp` commands on both first and subsequent launches.
They do not receive Claude-specific permission flags or hooks.

Upstream CLI references: [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
and [oh-my-pi](https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md).

### Project settings and default agent

The **Project settings** tab sits immediately after **Env**.
It shows the target project's name, path, and **Default agent** field.
It shows a selection prompt only when neither an explicit target nor a selected project exists.
The sidebar's **Project settings…** context action can target an inactive project without selecting it or starting its shell
(`src/renderer/App.tsx`, `src/renderer/components/Sidebar.tsx`).

The field uses the merged project and global CLI profile catalog.
This includes **Pi** (`pi`) and **oh-my-pi** (`omp`).
Project profiles shadow global profiles with the same name.
**Use global default** selects no named profile.
It uses the current global first-launch or subsequent-launch command, not a fixed profile
(`src/main/domain/launch.ts:14-18,36-52`).

Changes save immediately through `shells:set-default-cli`.
The settings field and star control use the same validated operation.
It updates only `defaultCliName` and `launchCmd` in the project's configuration.
An explicit choice or reset clears both legacy custom launch-command variants.
The field explains this replacement before the user acts.
A separate replacement button applies the current choice when legacy commands still override it.
Opening the tab does not write or migrate configuration
(`src/main/domain/project-default-agent.ts`, `src/renderer/project-default-agent-store.ts`).

The per-tab store captures the target project ID and retains the last confirmed choice.
It disables overlapping saves and ignores results after the session disconnects.
A failed save restores the confirmed display and shows an error.
A missing saved profile remains visible as unavailable.
Without a legacy custom override, automatic launch falls back to the global command.
Saving an inactive project's settings does not replace the active project's state
(`src/renderer/project-default-agent-store.ts:91-128`, `src/renderer/App.tsx:729-731`).

Changing the default does not restart or replace a running terminal.
The next new automatic primary launch uses the saved choice.
Named profiles use their configured command on both first and subsequent launches.
Explicit profile launches and plain terminals keep their existing behavior.
The SQLite schema and IPC channel names do not change.

### IDE themes

Settings → General provides **Default**, **Catppuccin**, and **Rosé Pine** palettes.
Appearance remains independent: **Light**, **Dark**, or **System**.
Default preserves the original IDE colors and starts in dark mode.
Catppuccin uses Mocha in dark mode and Latte in light mode.
Rosé Pine uses Rosé Pine in dark mode and Dawn in light mode.
System appearance follows the operating system for each palette.

`src/renderer/hooks/useTheme.ts` shares preferences between controls through
`useSyncExternalStore`. It stores appearance in `metaide.theme.v2` and palette
in `metaide.theme.palette`. Existing appearance choices remain valid.
Local events synchronize controls within a window; storage events synchronize
other renderer windows. `App` initializes the preferences for main and popout windows.
The hook applies `data-theme` and `data-palette` before paint and synchronizes
Electron native chrome with the appearance mode.

`src/renderer/styles.css` defines the palette tokens. Chrome, inputs, status icons,
syntax highlighting, and terminal colors use those tokens.
Accent-filled controls use `--accent-text` rather than a fixed white foreground.
Existing terminals refresh their foreground, cursor, selection, and ANSI colors
when either document theme attribute changes.
Mermaid diagrams render again on palette changes, including changes between
palettes with the same light/dark appearance. Explicit diagram themes remain independent.
The command palette also provides commands for all three palettes.

Each palette card in Settings previews its own palette, whichever palette is
active. The previews are literal colours in
`src/renderer/components/settings/palette-swatches.ts`, one dark and one light
set per palette; a card shows the set for the effective appearance. These are
the only literal colours in Settings.

### Settings dialog

`src/renderer/components/Settings.tsx` is the dialog shell: an 820x640 modal
(`role="dialog"`, `aria-modal`, labelled by its `h1`), the section nav, the
version footer and the Done bar. Each section is its own module in
`src/renderer/components/settings/`:

| File | Responsibility |
|---|---|
| `GeneralPanel.tsx` | Appearance, Fonts, Workspace and Notifications sections. Loads and saves the General settings. |
| `RootsPanel.tsx`, `LaunchPanel.tsx`, `MetaprojectPanel.tsx` | The other sections. |
| `primitives.tsx` | `SettingsSection`, `SettingRow`, `SettingStack`, `WorkspaceNumber`, `Switch`, and the older `Header` and `Field`. |
| `PaletteCards.tsx`, `palette-swatches.ts` | Palette cards (`aria-pressed` buttons) and their preview colours. |
| `ModeControl.tsx`, `mode-keys.ts` | The Mode radiogroup; arrow keys move and apply the selection. |
| `nav-icons.tsx` | Section nav buttons and their icons; the active item has `aria-current="page"`. |
| `dialog-focus.ts`, `src/renderer/hooks/useDialogFocus.ts` | Focus moves to the panel on open, Tab stays inside the dialog, and focus returns to the opener on close. Escape is not intercepted. |
| `version-label.ts`, `src/renderer/hooks/useAppVersion.ts` | Footer text from `app:get-version`; it shows the wordmark alone if the call fails. |

Components below `GeneralPanel` take values and callbacks as props, so unit
tests render them without a DOM. Real focus, layout and colour are covered by
`tests/e2e/settings-board.spec.ts`.

### App chrome

The chrome around the content (title bar, activity bar, sidebar columns and
status bar) is one continuous surface, `--surface-chrome`, painted once on the
window root. Regions are separated by tone and spacing, not borders. The main
area and the popout's content are rounded sheets (`--surface-sheet`) inset on
that surface. Dialogs and popovers keep their edges because they float.

`src/renderer/styles.css` ("Chrome surfaces and semantic hues") derives every
chrome token from the palette tokens above, so all palettes and both
appearances inherit it:

| Token | Use |
|---|---|
| `--surface-hover`, `--surface-active`, `--surface-field` | Hover, selected and input fills, mixed from `--text`. |
| `--accent-soft`, `--accent-soft-text` | Selected tabs, nav items, the active project and soft primary buttons. |
| `--surface-raised` | Floating lists over a dialog, such as the font list. Inside a modal (`.modal-sheet`) it is the opaque modal panel colour mixed with white by `--modal-raised-lift` (8% dark, 30% light), so it is always lighter than the glass. |
| `--switch-off` | The track of a switch that is off. |
| `--hue-yellow`, `--hue-purple`, `--hue-cyan`, `--hue-pink`, `--hue-orange` | Semantic accents: dirty branch, Board icon, ahead/behind, task badge, Diff count. A palette's `--term-*` colour wins; otherwise the `-default` value for the appearance applies. |
| `--hue-orange-text` | Small coloured text, such as the Diff count. |
| `--hue-orange-soft`, `--hue-orange-soft-text`, `--badge-accent-text` | Activity-bar count badges: a soft hue fill with text that keeps 4.5:1 contrast. Light appearances mix the badge text almost fully toward `--text`. |
| `--badge-ink` | Unused since badges became soft tints; kept for a later token cleanup. |

The side panels (projects, chat, git) paint no tint of their own; they sit
directly on `--surface-chrome`. On macOS the chat column is the exception: it
paints the solid sheet colour (see "macOS frosted chrome").

**Title bar.** The main and popout title bars are 44px tall. The main title
bar centres `TitleGroup` (`src/renderer/components/TitleGroup.tsx`): the
selected project's name and its branch in `--hue-pink`, or "MetaLogix IDE"
when no project is selected. The branch uses the status bar's rule
(`git.branch`, or `HEAD` when detached). The group sits in a box inset 130px
from both edges, so it stays centred on the window and clear of the traffic
lights and the buttons. On macOS, `platformChrome` in `src/main/window-chrome.ts` sets
`trafficLightPosition: { x: 12, y: 14 }` for both window types, which centres
the lights on the 44px bar. The title-bar buttons are 32px with 3px right
padding, so the last glyph ends 12px from the edge and mirrors the lights.
The document title (`<project> — MetaLogix IDE`) is unchanged.

**Activity bar and status bar.** The activity bar is 56px wide with 36px
buttons; count badges sit at the top-right of their button. Settings is
reached from the title-bar gear or ⌘,. The status bar is 34px at 12px text.

**Sidebar.** The header is one row: a filter field and a "+" button
(`src/renderer/components/SidebarHeader.tsx`). "+" opens the shared
`ContextMenu` with New project… (⌘⇧N), Add root folder… and Rescan roots;
`src/renderer/sidebar-add-menu.ts` builds the items and runs the add-root and
rescan flows. With `autoFocus`, `ContextMenu` focuses its first enabled item,
and moves with the arrow keys; `SidebarHeader` returns focus to "+" when the menu closes. Copy and
test ids live in `src/renderer/sidebar-copy.ts`.

Rescan (and the automatic rescan at startup) adds newly discovered folders and
drops projects whose folder no longer exists
(`src/main/domain/prune-missing.ts`). Deleting a project row cascades to its
saved shells, recents and prompts, so pruning skips a root whose own folder is
missing (an unmounted drive must not empty it) and any project that still has
a live shell.

Section headers (In use, Recents, Projects) align with the filter field and
show a chevron on the right. The full list is titled "Projects" but stores its
collapsed state under the legacy key "All projects", so existing state
survives the rename. Rows are 34px tall. The scroll region runs to the
sidebar's edge and never scrolls horizontally.

The default width is 260px (`src/renderer/sidebar-width.ts`). Every existing
install had the old 288px default stored, because the width is written on
mount. A one-time migration, guarded by `metaide.sidebarWidth.migrated`,
clears a stored 288 so the new default applies; any other width is kept.
The resize handle sits above the sidebar and sheet so it can be dragged and
double-clicked to reset.

Each sidebar root shows a folder glyph in a stable hue.
`src/renderer/root-hue.ts` hashes the root path (FNV-1a, trailing separators
ignored) to one of five hue tokens, so a root keeps its colour across launches
and palettes. Root labels are abbreviated by `src/renderer/abbreviate-path.ts`:
the macOS home becomes `~`, leading segments shrink to their first character,
and the last segment stays whole (`~/P/P/acme`). The tooltip shows the full
path.

### macOS frosted chrome

On macOS the window sits on a native vibrancy material (`sidebar` by default),
and the chrome lets that material show through. The working area stays solid
unless the user sets a Terminal frost level. The user controls all of this in
the Frosted glass settings (see "Frosted glass settings" below). Windows and
Linux are unchanged.

**Layers.** All mac styling lives in `src/renderer/frosted-chrome.css`,
imported after `styles.css`. Every selector starts with
`:root[data-platform="mac"]`, so no rule can match off macOS;
`frosted-chrome-css.test.ts` enforces this. `styles.css` is not changed by
this layer. On macOS:

| Layer | Paint |
|---|---|
| `html`, `body` | Transparent. `--bg` is not redeclared, so tokens derived from it (the modal scrim) keep their values. |
| Chrome root (`[data-chrome-root]`) | `--surface-chrome`: the opaque `--chrome-solid` at `--chrome-glass-alpha`. At Chrome frost Subtle that is 0.805 to 0.87 per palette and theme; Medium and Strong are lower (see "Frosted glass settings"). |
| Main and popout sheet, chat column (`[data-view="chat"]`) | `--sheet-solid`, alpha 1. |
| Sheet while a shell shows (`[data-sheet-content="shell"]`), Terminal frost not Off | `--surface-terminal`: `--sheet-solid` at `--terminal-live-alpha`. |
| Split-shell cards | `--surface-pane`: `--pane-solid`. With Terminal frost on, cards follow the sheet; only at Chrome Subtle with Terminal Subtle do they add their own glass, as before. |
| Raw `--panel`, `--panel-strong`, `--chat-surface` | Same colour, alpha 1, so menus, popovers and inputs are never more translucent than before. |

Hover, selected, active and field fills (`--surface-hover`, `--surface-active`,
`--accent-soft`, `--surface-field`) and the Tasks badge fill
(`--hue-orange-soft`) on the chrome are opaque chips mixed into
`--chrome-solid`, so text on them keeps its contrast. The Git panel ahead and
behind counts read `--git-ahead-chip` and `--git-behind-chip`, which are opaque
chips on the chrome. The sheet, the chat column, the modal and command-palette
layer (`.modal-layer`) and the overlays marked `data-overlay` (the shells
popover, the Add a shell popover, context menus, toasts) restore every chrome lift. Palette tokens come
back from `*-base` tokens captured on `:root`. Chrome-only tokens are reset to
`initial`, so the classes that read them use their fallback.

**Glass invariant.** Palette blocks set only the solid colours, the alphas and
the label lifts. `--surface-chrome`, `--surface-terminal` and `--surface-pane`
each have exactly two declarations: the base rule and the Reduce transparency
override. A count test enforces this, as for the modal glass. The setting
switches one root token, `--terminal-live-alpha`, so the count stays at two.

**Reduce transparency.** `@media (prefers-reduced-transparency: reduce)` maps
the three glass surfaces to their solid sources. It reads only the media
query, never the stored setting, so the stored value is never changed.

**Contrast envelope.** The material colour is unknown, so floors are proven
over the black-to-white range (`REFERENCE_MATERIALS`):
`frosted-chrome-contrast.test.ts` runs the cascade of both stylesheets and
flattens each surface over 18 greys. Text needs 4.5:1, icons and indicators
3:1. The visible effect, `(1 − total alpha) × 255` per channel, must be at
least 32, which caps the total alpha at 0.8745. The terminal alpha multiplies
the chrome alpha, so the terminal can never be more translucent than the
chrome around it, and `--terminal-glass-alpha` is small (0 to 0.18 at Subtle). Muted and
label text on the chrome and on the frosted terminal may be lifted
(`--chrome-text-muted`, `--terminal-text-muted`, `--chrome-chip-text`) to keep
the floor.

Every coloured text and indicator on the chrome is listed in the test's
`CHROME_PAINT` inventory (D17). Each entry is held to 4.5:1 (text) or 3:1
(indicator) in every palette and theme, with the setting OFF and ON and with
Reduce transparency on and off. A source scan fails if a component already
in the inventory gains a colour class that is neither listed nor explained. A
new chrome component is not scanned until it is added to the inventory. To reach the floor, each palette block sets lifted hues that only the
chrome root reads. In dark themes they are lighter, in light themes darker:

- `--chrome-hue-pink`, `--chrome-hue-cyan`, `--chrome-hue-yellow` and
  `--chrome-hue-purple`.
- `--chrome-danger`.
- `--chrome-agent-idle`, `--chrome-agent-busy` and `--chrome-agent-blocked`.
- `--chrome-accent-label`, read as `--accent-label` by the Git panel's
  Stage all.
- `--chrome-git-*`, read as `--git-*` by the Git panel letters, the ahead and
  behind counts, and the inline diff.

Classes that need a lift Tailwind cannot reach read a token with the exact old
colour as fallback, such as `var(--git-added,#34d399)` or
`var(--accent-label,var(--accent))`. Off macOS, and in the Diff tab, that
fallback renders, so nothing changes there. The keyboard focus outline reads
`--focus-outline`. It becomes solid accent only where frosting had lowered it
below its 26eed37 contrast: catppuccin dark, and rose-pine dark and light.
The mac prefix of that rule sits in `:where()`, so it keeps the styles.css
specificity and an element's own `focus-visible:outline-none` still wins.

Two groups are pinned in the test as known debt:

- Indicator colours that were already below their floor at `main@26eed37`
  (D13).
- Chrome labels drawn through element opacity (`opacity-60`, `opacity-70`).
  No token lift can reach the floor for those without collapsing
  `--text-muted` into `--text`.

The test fails if a pin starts to pass. ANSI colours are not tested.

**Root flags.** `src/renderer/root-flags.ts` sets three attributes on `<html>`:
`data-platform="mac"` (darwin with Frosted chrome on), `data-chrome-frost`
(`medium` or `strong`; absent at Subtle) and `data-terminal-frost` (`subtle`,
`medium` or `strong`; absent at Off). In every other case it removes all three.
Only the mac stylesheets read `data-platform`, so Frosted chrome off renders
the pre-frost stack by construction. `main.tsx` calls it before React renders,
because the CSP forbids an inline script. Attribute names live in
`src/renderer/frosted-chrome-contract.ts`.

**Frosted glass settings.** Settings > General > Appearance shows a Frosted
glass group after Window opacity, on macOS only
(`src/renderer/components/settings/FrostedGlassGroup.tsx`, with
`FrostLevelRow.tsx` and `MaterialRow.tsx`). It holds four
settings, declared in `src/shared/frosted-glass.ts`:

| Key | Values | Default |
|---|---|---|
| `frost_chrome` | on, off | on |
| `chrome_frost_level` | Subtle, Medium, Strong | Subtle (the original tuned look) |
| `terminal_frost_level` | Off, Subtle, Medium, Strong | Off |
| `vibrancy_material` | Sidebar, Under window, HUD, Menu, Popover | Sidebar |

- Each key is written only through its own channel (`settings:set-frost-chrome`,
  `settings:set-chrome-frost-level`, `settings:set-terminal-frost-level`,
  `settings:set-vibrancy-material`). The channel rejects any value outside its
  list without writing, and emits `settings:changed` on success. The generic
  `settings:set` refuses all four keys and the legacy `frost_terminal`.
- `useFrostedGlassAttributes` re-reads the values in every window on
  `settings:changed`. For the first paint, main adds `frostChrome`,
  `chromeFrost` and `terminalFrost` to the renderer URL (`rendererQuery` in
  `src/main/window-chrome.ts`). Off darwin it always sends the no-effect
  defaults. Main reads the stored values through `readStoredFrostedGlass`,
  which falls back to the default for any value outside its list.
- The material reaches new windows through `platformChrome(platform, material)`
  and open ones through `applyVibrancy`, which calls `setVibrancy` on every
  window that is not destroyed. Any value outside the list falls back to
  `sidebar`. Off darwin nothing is applied.
- With Frosted chrome off, the two level controls are disabled but keep their
  values, and the material still applies.
- `seedDefaults` migrates the legacy `frost_terminal` boolean once: `true`
  becomes Terminal frost Subtle, anything else Off. The legacy row is kept for
  downgrade and is never written again.
- `win.setOpacity` (window opacity) multiplies on top of all of this.

Level values live in `src/renderer/frosted-glass-levels.css`, keyed on the two
level attributes. Chrome alphas (Subtle / Medium / Strong) are 0.85 / 0.805 /
0.77 in default dark, 0.855 / 0.81 / 0.775 in default light and catppuccin light,
0.805 / 0.77 / 0.735 in catppuccin dark, 0.81 / 0.775 / 0.74 in rose-pine dark
and 0.87 / 0.81 / 0.775 in rose-pine light. Each step adds at least 8/255 of
visible effect. Terminal levels are set per chrome level, as total alphas that
never go below the chrome alpha. At Chrome Subtle some terminal levels are
equal, because the chrome leaves no room; the contrast test lists those
combinations explicitly. Medium and Strong add per-palette label, text and
`--accent-mark` lifts to keep every floor:
- Sidebar, Tasks, status bar, root folder, split grip and drop-target accents
  read `--accent-mark`, so `--accent` and white-on-accent fills never change.
- In catppuccin light and rose-pine light at Strong, `--term-fg` on `:root` and
  `--text` on the frosted Shell sheet are slightly darker. ANSI colours are
  unchanged.
- At Strong, muted text on the chrome comes close to `--text` in the dark
  palettes, and equals it in catppuccin light and rose-pine light at Medium and
  Strong. This is an accepted trade-off of the opt-in levels.

**Focus.** Main and popout windows use `visualEffectState: 'followWindow'`, so
the material goes flat when the window is not focused, as in Finder. Electron
sets this only at window creation, so it does not change with the settings.

**Why the envelope covers every material.** Every material paints some sRGB
colour, and the luminance of a composite rises with each backdrop channel. So
the black and white composites the test already samples bound every material,
and no per-material contrast test is needed. Whether a material visibly frosts
is a manual check.

### Command palette

One palette (`src/renderer/components/CommandPalette.tsx`) replaces the
project switcher, the separate command palette and the file finder. It lists
projects, the app's commands, one "Settings: <section>" entry per Settings
section, and the project's files.

The first character of the query selects the mode:

| Prefix | Mode | Lists |
|---|---|---|
| none | all | projects, commands, Settings entries (never files) |
| `#` | projects | projects only |
| `>` | commands | commands and Settings entries |
| `@` | files | files of the selected project |

Shortcuts: ⌘K (Ctrl+K on Linux and Windows) toggles the palette with an empty
query, ⌘⇧P opens it with `>`, and ⌘P opens it with `@`. See Keyboard shortcuts
for the platform modifier and what changes while a terminal has focus. Pressing ⌘⇧P or ⌘P while it is open
switches its mode. The status bar keeps one hint, a button that opens the
palette. The palette opens above any other open modal; Esc closes only the
palette.

Groups keep a fixed order (projects, then the command categories Go, Project,
View, Shell, Theme, App, then Settings); within a group, rows are ordered by
match quality. At most 50 rows render (40 in file mode). Commands that need a
selected project are hidden when there is none. Choosing a project uses the
same pick path as the sidebar; choosing the current one closes the palette and
focuses its terminal. A command runs after the palette closes, and a failure
raises an error toast. Closing returns focus to where it was before the palette
opened, unless a project or file pick, or a modal a command opened, has
already placed it (`restoresOpenerOnClose` in `palette-run.ts`).

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/renderer/command-palette-contract.ts` | Types, copy, test ids, group order and row caps shared by the component, App, the unit tests and the E2E suite. |
| Logic | `src/renderer/palette-keys.ts` | Maps a keydown and the platform to toggle, open with a seed, swallow (other mod-chords while open) or pass. |
| Logic | `src/renderer/palette-commands.ts` | Builds the command list from App's actions, including the Settings entries and the two new-terminal commands. |
| Logic | `src/renderer/palette-query.ts`, `palette-search.ts`, `palette-run.ts` | Prefix parsing, fuzzy search (fuse.js) into groups, rows and empty states, and safe command execution. Pure. |
| Adapter | `src/renderer/hooks/usePaletteFiles.ts` | Loads the file list (`files:list-all`, 5000-file cap) on entering file mode and reuses it until the palette closes. |
| Presentation | `src/renderer/components/CommandPalette.tsx`, `components/palette/*` | Input (combobox with `aria-activedescendant`), listbox, rows, footer with key hints and the prefix legend. |
| Composition | `src/renderer/App.tsx` | Holds the open request (`{ seq, seed }`; a new `seq` re-seeds an open palette) and routes keys, project picks and file picks. |

### Keyboard shortcuts

The app uses one platform modifier. On macOS it is ⌘ and Ctrl does not count.
On Linux and Windows it is Ctrl and Super does not count. Every app shortcut
matches on that modifier only, and Alt chords never match.

The renderer learns the platform from the preload, which exposes
`process.platform` as `window.api.platform`. `shortcut-platform.ts` reads it
once, at module load, so the first render already has the right labels. With
no bridge (unit tests in node) it falls back to macOS.

Labels come from one platform-neutral definition in `SHORTCUTS`. macOS shows
glyphs in the order ⌃⌥⌘⇧ (`⌘⇧O`). Linux and Windows show text in the order
Ctrl, Alt, Shift (`Ctrl+Shift+O`), with Enter shown as `Enter`. Sentences that
contain a shortcut (placeholders, titles, tips, a toast) live in
`shortcut-copy.ts`. The commit box keeps "⌘Enter to commit" on macOS.

While a terminal has focus on Linux and Windows, xterm's custom key handler
decides who gets each key:

| Key | Goes to | Why |
|---|---|---|
| Unshifted Ctrl+letter, Ctrl+\ | Shell | readline and TUI keys (history, SIGINT, reverse search) |
| Ctrl+F | App: terminal search | taken from the shell (readline forward-char) |
| Ctrl+K | App: command palette | taken from the shell (readline kill-line); the terminal takes focus automatically, so the palette key must work there |
| Ctrl+Shift+P/K/O/N/T/F, Ctrl+, Ctrl+/ Ctrl+= Ctrl+- Ctrl+0 | App | an explicit allow-list; xterm sends nothing and the event bubbles |
| Ctrl+Shift+C | Copy | writes the sanitised selection; does nothing without a selection |
| Ctrl+Shift+V | Paste | reads the clipboard and inserts it through the terminal paste pipeline (see Terminal drop and paste) |
| Anything else | xterm default | unchanged |

So Ctrl+P, Ctrl+B and Ctrl+T do nothing in the app from a focused terminal;
the palette (Ctrl+K or Ctrl+Shift+P) reaches those commands instead. The cheat
sheet marks those rows on Linux. On macOS, ⌘F goes to the app and every other key keeps xterm's
default handling.

The native menu is built from `buildMenuTemplate(isMac)`. The menu bar is
hidden on Linux, but its accelerators stay live, so on Linux and Windows the
Reload and Minimize items have no accelerator (Ctrl+R and Ctrl+M are shell
keys). Undo, Redo and Select All keep theirs.

| Layer | File | Role |
|---|---|---|
| Contract | `src/renderer/shortcut-contract.ts` | Platform type, key-event shape, decision-function signatures and the `SHORTCUTS` registry. |
| Adapter | `src/preload/index.ts`, `src/renderer/shortcut-platform.ts` | Expose and resolve the platform; context and `useShortcutPlatform()`. |
| Logic | `src/renderer/shortcut-match.ts`, `app-keys.ts`, `terminal-keys.ts` | Modifier matching, app-wide shortcuts, terminal routing and the xterm handler. Pure. |
| Logic | `src/renderer/shortcut-format.ts`, `shortcut-copy.ts` | Label formatting and sentence copy per platform. Pure. |
| Logic | `src/main/menu-template.ts` | Per-platform native menu template. Pure. |

### Modal material

Every modal uses one frosted-glass material: a full-window scrim tinted from
`--bg` with a light blur, and a translucent panel lifted toward white with a
heavy, saturated blur. The tokens (`--modal-*`) and classes (`.modal-scrim`,
`.modal-layer`, `.modal-sheet`, `.modal-sheet--compact`) live at the end of
`src/renderer/styles.css`. Muted text inside a modal uses `--modal-text-muted`
and the highlighted row uses `--text` on `--modal-row-active`, so text keeps
4.5:1 contrast in every palette and appearance.

`src/renderer/components/ModalFrame.tsx` renders the scrim and, as its
sibling, a pointer-transparent layer that holds the panel. They must stay
siblings: an element with `backdrop-filter` is a Backdrop Root, so a panel
nested inside the blurred scrim could only blur the scrim's flat tint. The
layer therefore carries no filter, opacity or transform. A modal's test id sits
on the layer; the scrim carries `<test id>-scrim` and receives backdrop clicks.

Stacking order: other modals (z 50/51) < palette (52/53) < toasts (60) <
permission dialog (100/101). `src/renderer/modal-glass.ts` lists every modal
surface with its tier, motion and radius. Mouse-opened modals (Settings, New
project, Permission mode) opt into the existing fade; keyboard-summoned ones do
not animate.

When the OS asks for reduced transparency (`prefers-reduced-transparency`),
the panel becomes opaque and neither layer is blurred; the scrim keeps its
tint. No theme block may set `--modal-panel` or the two filter tokens, so this
override always applies.

### Markdown preview pipeline

The Files tab shows a rendered preview for `.md`, `.markdown` and `.mdx`
files. `FilesTab.tsx` mounts `MarkdownPreview` only when the file is not in
Edit mode (`src/renderer/components/FilesTab.tsx:610`).

| Layer | File | Responsibility |
|---|---|---|
| Presentation | `src/renderer/components/MarkdownPreview.tsx` | Sets the rendered HTML, starts diagram rendering, and routes link clicks. |
| Presentation | `src/renderer/hooks/useDocumentTheme.ts` | Gives the effective light or dark theme. |
| Logic | `src/renderer/markdown/markdownRenderer.ts` | Owns the one `markdown-it` instance. Converts Markdown to an HTML string. |
| Logic | `src/renderer/markdown/fenceRule.ts` | Changes `mermaid` fences into placeholders and `math` fences into display math. |
| Logic | `src/renderer/markdown/math/mathPlugin.ts` | `markdown-it` plugin for the math delimiters. |
| Logic | `src/renderer/markdown/math/renderMath.ts` | Calls KaTeX. Changes a KaTeX error into an escaped error span. |
| Logic | `src/renderer/markdown/previewLinks.ts` | Decides if a link click opens externally or does nothing. |
| Logic | `src/renderer/markdown/mermaid/useMermaidDiagrams.ts` | Finds the placeholders and renders them one at a time. |
| Adapter | `src/renderer/markdown/mermaid/mermaidRenderer.ts` | Wraps the `mermaid` library behind the `DiagramRenderer` interface. Chooses the app palette or the diagram's own theme. |
| Adapter | `src/renderer/markdown/mermaid/themeTokens.ts` | Reads the live theme tokens from the computed style of `<html>`. |
| Logic | `src/renderer/markdown/mermaid/mermaidPalette.ts` | Turns the theme tokens into Mermaid `themeVariables`. Pure; never reads the DOM. |
| Logic | `src/renderer/markdown/mermaid/categoricalColours.ts` | Picks distinct pie, gitGraph and journey colours from the app's hues. |
| Logic | `src/renderer/markdown/mermaid/colour.ts` | Colour parsing, compositing, WCAG contrast and lightness adjustment. |
| Contract | `src/renderer/markdown/mermaid/paletteContract.ts` | Token names, reference materials and contrast thresholds shared by the palette and the E2E suite. |
| Contract | `src/renderer/markdown/contract.ts` | Class names, attributes, messages and types that the other files and the E2E suite share. |

### Configurable fonts

The app stores independent UI and Terminal font-family preferences. A null
preference preserves the compatibility stack (`src/shared/font-settings.ts:1-10`).

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/font-settings.ts` | Defines the two keys, fallback stacks, and bounded family-name parser. |
| Persistence | `src/main/repos/settings-repo.ts` | Seeds null defaults and stores the selected family in SQLite. |
| IO | `src/main/ipc/register.ts` | Validates dedicated font writes, blocks the generic setter, and broadcasts keyed changes after a successful write. |
| Renderer state | `src/renderer/fonts/font-settings-context.tsx` | Loads both preferences once per renderer and refreshes the changed key. |
| Platform adapter | `src/renderer/fonts/local-font-access.ts` | Requests installed-family metadata after a user action. It does not read font blobs. |
| Presentation | `src/renderer/components/FontControl.tsx` | One combobox per preference: installed-family search, exact-name entry, System default, preview, and status. |
| Style adapter | `src/renderer/fonts/use-apply-ui-font.ts` | Sets the UI font through one CSS custom property. |
| Terminal adapter | `src/renderer/terminal-font-update.ts` | Updates xterm in place, waits for readiness, and synchronizes terminal geometry. |
| Contract | `src/shared/terminal-font-size.ts` | Defines the terminal font size key, bounds (9-28, default 14), parser, clamp, zoom step, and legacy migration rule. |
| IO | `src/main/ipc/register.ts` | `settings:set-terminal-font-size` validates the size, writes only when unset if asked, and broadcasts `settings:changed` only when the value changed. The generic setter rejects the key. |
| Renderer state | `src/renderer/fonts/terminal-font-size-store.ts`, `terminal-font-size-context.tsx` | One store per window: loads or migrates the size, applies changes locally first, ignores stale refreshes, and reverts with a toast on a failed save. |
| Presentation | `src/renderer/components/settings/TerminalFontSizeControl.tsx`, `font-size-draft.ts` | The Terminal font size stepper and its pure input rules. |
| Contract | `src/shared/terminal-font-weight.ts` | Defines the font weight and bold weight keys, the nine weights, the defaults (400 and 700), the bold rule (`derivedBoldWeight`, `isValidBoldWeight`, `boldWeightChoices`), and `resolveTerminalWeights`, which turns the stored pair into the weights in use. |
| IO | `src/main/ipc/register.ts` | `settings:set-terminal-font-weight` validates W, derives bold in main, writes both keys in one `setMany` transaction, and broadcasts once per changed key. `settings:set-terminal-bold-weight` accepts only a bold weight heavier than the font weight in use. The generic setter rejects both keys. |
| Renderer state | `src/renderer/fonts/terminal-font-weight-store.ts`, `terminal-font-weight-context.tsx` | One store per window for the pair: resolves the stored values without writing, applies changes locally first, re-syncs on either key, and reverts with that setting's toast on a failed save. |
| Presentation | `src/renderer/components/settings/TerminalFontWeightControl.tsx` | The Terminal font weight and Terminal bold weight selects. |
| Terminal adapter | `src/renderer/terminal-font-weight-apply.ts` | Maps the pair to xterm's `fontWeight` and `fontWeightBold`. |

The UI preference changes inherited application text. Explicit `.font-mono`
and Markdown code rules keep their compatibility stack
(`src/renderer/styles.css:413-415`, `:457-458`). The layered Files editor
therefore keeps identical metrics for its gutter, syntax underlay, and
textarea (`src/renderer/components/FilesTab.tsx:621-624`, `:698-720`).

The Terminal preference updates every `ShellTab` through the renderer-local
font store. The updater changes `term.options.fontFamily`, waits for the
selected family with a bounded timeout, fits the terminal, clears stale glyph
state, repaints all rows, and reports the resulting dimensions to the PTY
(`src/renderer/terminal-font-update.ts:108-139`).

The terminal font size follows the same store-and-broadcast path through its
own channel. `null` in the settings store means the size was never saved; the
first window to load then migrates the legacy `metaide.shellFontSize` value
with `onlyIfUnset`, so concurrent windows cannot overwrite each other. Each
`ShellTab` reads the shared size through a ref, so a change sets
`term.options.fontSize` and forces a geometry sync instead of recreating the
terminal (`src/renderer/components/ShellTab.tsx:398-403`). A terminal waits
for the loaded size before it opens, within the existing 2 s layout cap.

The terminal font and bold weights use the same store-and-broadcast path
with two channels, one per user action. Main is the only place that derives
bold from the font weight, so the stored pair is never half-written; both
main and the renderer resolve a missing or invalid stored value with the same
shared function. A weight change sets `fontWeight` and `fontWeightBold` in
one `term.options` assignment (`src/renderer/components/ShellTab.tsx:408`).
xterm repaints in place and the WebGL renderer rebuilds its glyph atlas.
Weight does not change cell size, so there is no geometry sync or PTY
resize. A terminal also waits for the loaded weights before it opens.

### Split shell and motion

The shell area shows one pane, or two side by side when the split is open.
The split's right shell is not a tab: it has no chip in the strip while it
sits in the split. **To tab** moves it into the strip without killing it,
and once its fold-out finishes it becomes the active tab and takes focus.
Closing the split kills the right shell when its fold-out finishes; when
all of the split's exits settle, any shell still awaiting a kill (for
example one queued by a fast close, open, close) is killed too. A closing
shell stays out of the strip until the first alive-shells list after its
kill.

| Layer | File | Responsibility |
|---|---|---|
| Presentation | `src/renderer/components/ShellTabsBar.tsx`, `SplitPill.tsx` | The tab strip: chips, the new-shell menu, and the labelled **Split** toggle (`aria-pressed`). |
| Presentation | `src/renderer/components/ShellSplit.tsx`, `SplitPaneHeader.tsx`, `SplitGutter.tsx`, `FoldPane.tsx` | Split mode: pane cards, headers (dot, label, abbreviated project path, To tab, Close), the focused-pane ring, and the resizable gutter (**Resize panes**, arrow keys move it by 2%). |
| Logic | `src/renderer/shell-label.ts`, `split-ratio.ts`, `split-copy.ts` | Chip labels and which shells the strip hides; the ratio default, clamp and sanitising; exact test ids and copy. |
| Logic | `src/renderer/pane-fold.ts`, `pending-kill.ts`, `terminal-geometry-hold.ts`, `menu-motion.ts`, `motion-tokens.ts` | Fold and menu transitions, shells awaiting a kill or an activation after their exit, the terminal size hold, and the shared durations and easings. |
| Adapter | `src/renderer/hooks/useTerminalGeometryHold.ts`, `usePrefersReducedMotion.ts` | Holds terminal refits while a fold runs; reads the OS reduced-motion setting live. |
| State | `src/renderer/hooks/useSplitLifecycle.ts`, `src/renderer/App.tsx` | The hook owns close, To tab, and the pending kill and activation sets with their flush and focus effects; App holds `rightShellIndex`, `splitRatio` and the sidebar fold, and wires the hook. |

Rules:

- Motion uses the `motion` package (pinned at 14.0.0) through a strict
  `LazyMotion` with `domAnimation` in `main.tsx`, under
  `MotionConfig reducedMotion="user"`. Only `m.*` elements are used.
- A fold animates one CSS variable, `--fold`, on the folding pane's
  container. The staying pane is `flex-1`, so it fills the row on every
  frame: no gap and no end-of-fold jump. No clip-path or transform touches
  a terminal, and none remains at rest.
- Terminals hold their size during a fold and refit once at the end. One
  shared 1000ms watchdog covers all holds and restarts on every hold or
  mid-fold toggle. The left terminal is never remounted by a split open
  or close.
- Keyboard toggles (⌘B or Ctrl+B, ⌘\ or Ctrl+\, palette commands) stay instant.
- With reduced motion, panes and menus fade (at least 150ms) and the
  layout changes in one step. The panes read the setting live because
  motion's `useReducedMotion` reads it once per mount.
- `ContextMenu` and the new-shell menu animate in and out. A leaving menu
  drops its backdrop, role and test id and takes no pointer or keyboard
  input; reopening during an exit reuses the same instance, and a menu
  opened with `autoFocus` refocuses its first item.

### Terminal focus

When a window gains OS focus, or the user switches project, the visible
shell terminal takes keyboard focus, so typing goes to the Claude Code
prompt without a click. One
coordinator per window makes the decision. Each renderer window is its own
JS realm, so a module-level instance gives one owner per window.

| Layer | File | Responsibility |
|---|---|---|
| Logic | `src/renderer/terminal-focus.ts` | Classifies the active element, holds the focus rules, and builds the coordinator. DOM-free. |
| Adapter | `src/renderer/hooks/useWindowTerminalFocus.ts` | Creates the window's one `terminalFocus` coordinator. Owns the `window` `focus` and `blur` listeners and passes the overlay flag in a layout effect. This is defensive: it keeps the flag current before any later task, such as an awaited IPC reply, issues a request. React 18 already flushes passive effects at the end of a click or key commit, so the existing tests pass with either effect. |
| Presentation | `src/renderer/components/ShellTab.tsx` | Registers its terminal, and reports when it opens, when it is used, and when it unmounts. |
| Presentation | `src/renderer/App.tsx` | Computes the overlay flag, marks the left pane and the popout terminal as `primary`, forwards `shell:focus-request`, popout open and scrollback-search jumps to `requestFocus`, and project switches (sidebar, command palette, new-project dialog) to `requestProjectFocus`. |

Rules:

- On window focus, a terminal takes focus only when no overlay is open and
  focus is on nothing or on a non-text control. Focus in a text field, the
  editor, the find box or the chat panel stays where it is.
- The target is the last-used terminal, then the `primary` terminal, then
  the only terminal. A target that has not opened yet takes focus when it
  opens, and the rule is checked again at that moment.
- A notification click, a popout open or a jump from scrollback search
  requests a specific shell. A project switch requests the target
  project's `primary` (left-pane) terminal, whichever shell it shows. There
  is one pending request; a newer one replaces it, and starting a new
  switch or scrollback jump cancels it. A switch that lands on the Files
  tab requests nothing.
- A request expires after `FOCUS_REQUEST_TTL_MS`. It is honoured when no
  overlay is open and no text-entry element has focus, checked when the
  terminal opens, or at once when it is already open. A window blur drops
  it.
- The focus call runs synchronously in the window `focus` handler. On
  Windows and Linux, an activating click on a text field therefore keeps that
  field focused. On macOS the activating click does not reach the page,
  because `acceptFirstMouse` is off. The terminal takes focus, and a second
  click moves focus to the field.
- In-app shell tab switches and main-tab (Files ↔ Shell) switches do not
  move focus.
- Closing the split from its header returns focus to the left terminal.
  **To tab** focuses the moved shell's terminal once it is the active pane.

### Terminal drop and paste

Every drop onto a terminal and every paste into it goes through one
pipeline. The pipeline resolves each item to text, escapes file paths,
replaces control characters, and inserts the result with `term.paste`. So
bracketed paste applies when the program in the terminal has turned it on
(DECSET 2004), and the text arrives as a paste, not as keystrokes. The
behaviour follows Ghostty, with two additions: dropped bytes that have no
filesystem path, and an image-only clipboard, are saved to a temporary file
and that file's path is inserted.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/terminal-drop-contract.ts` | Size limit, Files-tree drag type, result unions, function types and every user-facing string. |
| Logic | `src/shared/paste-sanitize.ts` | Replaces each C0 control character other than TAB, LF and CR, plus DEL and the C1 controls U+0080-U+009F, with a space. A C1 character such as U+009B is otherwise echoed back by `cat` and bash readline, and xterm runs it as a control sequence. A payload that contains `ESC[201~` cannot end a bracketed paste early. Pure. |
| Logic | `src/shared/shell-escape.ts` | POSIX: a backslash before each character in Ghostty's macOS set. Windows: double quotes when the path contains a space or one of `&()^;,=`. Every C0 and C1 control character and DEL in a path, CR, LF and TAB included, becomes a space first. Pure. |
| Logic | `src/renderer/terminal-drop.ts` | `planDrop`: drop precedence, item order, size pre-check, per-item failure toasts, escaping and sanitising. Pure, with every dependency injected. |
| Logic | `src/renderer/clipboard-paste.ts` | `resolveClipboardPaste`: clipboard text is sanitised; empty text stages the clipboard image and returns its escaped path. `createPasteFromText` builds the function every paste route calls. `installPasteInterceptor(host)` adds the capture-phase `paste` listener on the xterm host element, before xterm's own listener. Pure. |
| Logic | `src/renderer/terminal-drop-controller.ts` | `createTerminalDropController`: the drag enter, over, leave and drop handlers, the overlay state, and the window `dragend`/`drop` reset. It copies the `DataTransfer` synchronously, because it is unreadable after the event returns. Pure, over small event interfaces. |
| Logic | `src/renderer/drag-hover.ts` | The overlay depth counter and `dropKindFor`. Pure. |
| Adapter | `src/renderer/hooks/useExternalDragGuard.ts` | The window-level guard: the pure `createExternalDragGuard` state, `installExternalDragGuard(target)` for the listeners, and the hook that installs it on `window`. |
| Adapter | `src/renderer/hooks/useTerminalDrop.ts`, `useTerminalPaste.ts` | React wiring only: each hook builds its controller or interceptor with the IPC, toast and terminal dependencies, and disposes it on unmount. |
| Presentation | `src/renderer/components/ShellTab.tsx`, `FilesTab.tsx`, `App.tsx` | Wiring: the drop overlay, the context-menu Paste item and the Ctrl+Shift+V key path in ShellTab; the Files-tree drag type in FilesTab; the guard hook in both `MainApp` and `PopoutShell` (`App.tsx:544`, `App.tsx:1120`). |
| IPC | `src/main/drops/handlers.ts` | `drops:resolve-app-file`, `drops:stage-file`, `drops:stage-clipboard-image`. Each guards its request shape by hand and returns failures as result values. It does not throw. |
| Adapter | `src/main/drops/staging.ts`, `file-name.ts`, `clipboard-image.ts` | The temporary directory, file names, and the Electron clipboard wrapper. Built once in `buildServices` (`src/main/services.ts:86`). |

Drop precedence:

1. A Files-tree drag carries `application/x-metaide-file` with the
   `projectId` and `relPath`. The main process resolves it to an absolute
   path inside the project root. This type wins over any `Files` or
   `text/plain` entry in the same drop, so the path is inserted once.
2. Otherwise each dropped file is used in drop order. A file with a path from
   `webUtils.getPathForFile` inserts that path. A file without a path but
   with bytes is staged. A file over 50 MB shows a toast and is skipped. A
   file whose staging fails shows a toast; the other files are still
   inserted.
3. With no files, `text/plain` is inserted as it is, without escaping.

A drop with nothing usable inserts nothing. A drop onto an exited shell
inserts nothing. The pipeline never calls `term.paste('')`, because with
bracketed paste on that sends an empty bracketed pair.

Paste routes: macOS ⌘V and the Edit menu fire a DOM `paste` event, which the
paste hook takes. Ctrl+Shift+V and the context-menu Paste item read the
clipboard and call the same function (`ShellTab.tsx:183`,
`ShellTab.tsx:599`). All routes sanitise the text. When the clipboard has no
text, all routes try the clipboard image. The renderer is sandboxed, so the
main process reads the image.

Temporary directory:

- The location is `<tmp>/metaide-drops-<uid>` on POSIX and
  `<tmp>/metaide-drops` on Windows (`src/main/drops/staging.ts:46`).
  In test mode (`METAIDE_TEST_MODE=1`) the entrypoint passes
  `METAIDE_DROP_DIR`, or `<userData>/drops` when it is unset, so an E2E launch
  never stages into or prunes the real directory (`testModeDropDir`,
  `createServices`, `src/main/index.ts:397-406`).
- Before every write, staging creates the directory with mode 0700 when it
  is missing. It then refuses to write when the directory is a symlink or
  not a directory. On POSIX it also refuses when another user owns the
  directory or its mode is not exactly 0700 (`staging.ts:63-73`). On Windows
  the owner and mode checks do not run; the per-user `%TEMP%` applies.
- Files are created with `open(path, 'wx', 0o600)`, an exclusive create
  (`staging.ts:94`). A name collision adds `-1`, `-2` and so on. A file is
  never overwritten.
- File names keep only `A-Z a-z 0-9`, space and `._()+,-`, lose leading
  dots, and are capped at 100 characters. An empty name becomes
  `dropped-<timestamp>.<ext>`; a clipboard image is `pasted-<timestamp>.png`.
  Timestamps are UTC.
- At startup, after the main window is created, the main process deletes
  regular files older than 24 hours, once, without awaiting the result
  (`openMainWindow`, `src/main/index.ts:457-463`). Pruning refuses an untrusted directory, so a
  planted symlink cannot make it delete other files. A dev build and a
  packaged build share the directory, so each can prune the other's old
  files.

The global guard cancels `dragover` and `drop` for every drag that did not
start in this window, whatever its type. It runs in the main window and in
every popped-out window. So a file, link or
text dropped outside a terminal never navigates the window and never opens
a browser. A drag that starts in the window keeps its native behaviour, for
example text dragged into the editor or the find box. `dragstart` and
`dragend` are tracked in the capture phase
(`src/renderer/hooks/useExternalDragGuard.ts:62`). The in-app state also
clears on any `pointerdown`, and on a `mousemove` with no button pressed.
Neither event occurs during a drag, so a lost `dragend` cannot leave the
guard disabled. A drag from the main window into a popped-out window counts
as external there.

### Claude notifications

The app uses authenticated Claude Code hooks for OS notifications when an
app-launched shell needs input or finishes. It does not use those hooks to
set status dots. The notification path does not read terminal output.

| Layer | File | Responsibility |
|---|---|---|
| IO | `src/main/claude-hooks/receiver.ts` | Loopback HTTP server. Checks the request, authenticates it, answers `204`, then passes a typed event on. |
| IO | `src/main/claude-hooks/settings-file.ts` | Builds, writes and removes the app-owned Claude Code settings file. |
| Logic | `src/main/claude-hooks/hook-event.ts` | Parses and classifies the event name, notification type, message and background-task count for notifications. |
| Logic | `src/main/claude-hooks/hook-fanout.ts` | Delivers authenticated hooks to the notification history. |
| Logic | `src/main/claude-hooks/session-registry.ts` | Issues, verifies and releases the per-spawn id and secret. Records which shells are hook-confirmed. |
| Logic | `src/main/claude-hooks/launch-decorator.ts` | Adds `--settings <file>` and the id and secret to the environment of a Claude launch, just before spawn. |
| Logic | `src/main/claude-hooks/runtime.ts` | Starts the receiver, then writes the settings file. Stops both on quit. |
| Contract | `src/main/claude-hooks/protocol.ts` | Hook path, header name and environment variable names. |
| Logic | `src/main/notifications/claude-hook-history.ts` | Confirms the current hook session and tracks notification eligibility separately from status. |
| Logic | `src/main/notifications/claude-notifier.ts` | Applies the two notification toggles and viewing rules to eligible hooks. It also filters hook-confirmed shells from the generic notifier. |
| Logic | `src/main/notifications/viewed-shells.ts` | Holds the shells the main window shows. Decides if the user is viewing a shell. |
| Adapter | `src/main/notifications/os-notifications.ts` | Wraps Electron `Notification`. Keeps each instance referenced until it is clicked or closed. |
| Composition | `src/main/notifications/install.ts` | Connects authenticated hooks, notification history, PTY answers and exits, the notifier and click navigation. |
| Presentation | `src/renderer/viewed-shells.ts`, `src/renderer/hooks/useReportViewedShells.ts` | Derive the shells on screen and report them on `notifications:viewed-shells`. |
| Presentation | `src/renderer/components/settings/GeneralPanel.tsx` | The two switches in Settings → General → Notifications. |

Rules:

- A Claude shell is a shell whose launch argv starts with `claude`,
  `claude.exe` or `claude.cmd` (`isClaudeArgv`). Other shells spawn
  unchanged. A launch that already has `--settings` also spawns unchanged.
- On Windows, a launch that runs through `cmd.exe /c` (an npm `.cmd`
  shim) spawns unchanged when the settings path contains whitespace.
  node-pty quotes the shim path and the settings path, and `cmd /c` then
  removes the outer quotes and cannot start Claude. That shell keeps the
  generic notifier.
- The stored launch argv is never decorated. `PtyManager` applies the
  decorator to a copy inside `spawn`.
- `ClaudeHookHistory` owns notification eligibility. Screen-based status
  does not affect it.
- Needs input is an authenticated `Notification` with
  `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` or
  `agent_needs_input`, unless the user already answered that prompt.
- Finished is a `Stop` without background tasks after a confirmed busy
  turn. A background `Stop`, an idle `Stop` and a PTY exit do not notify.
- A confirmed hook marks its current shell hook-confirmed. The generic
  "Command finished" notifier skips that shell. Before confirmation,
  the generic notifier remains available.
- The user is viewing a shell when its popout window has focus, or when
  the main window has focus, shows the shell, and the shell is not popped
  out. In split view, both panes are shown.
- A new notification for a shell closes the previous one. A PTY exit
  releases the shell's session and closes its notification, unless a
  respawn has already replaced that PTY.

### Claude and OMP status dots

The main process derives one status for each live agent shell. Claude status
comes from the current terminal title and bounded bottom viewport after xterm
parses PTY output. OMP status comes from lifecycle events in the app-owned
extension. Neither Claude hooks nor a renderer's scroll position control
status dots.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/agent-state.ts`, `src/shared/omp-report.ts` | Define agent identity, three states, accessible labels and a versioned OMP report. |
| Adapter | `src/main/pty/{manager,screen-mirror}.ts` | Preserve original launch identity and PTY generation. Sample the active terminal's bottom twelve physical rows, join xterm-wrapped fragments, and capture OSC 0/2 title changes. |
| Adapter | `src/main/agent-status/foreground-posix.ts` | Check process ancestry and the foreground process group for a manually started Claude on macOS or Linux. |
| Adapter | `src/main/agent-status/omp-receiver.ts` | Receive bounded reports on loopback. Authenticate the current OMP spawn and reject stale reports. |
| Adapter | `src/main/agent-status/omp-launch.ts`, `resources/omp-status-extension.js` | Add an explicit app-owned extension to direct OMP launches. Report root-session lifecycle without prompt or tool arguments. |
| Service | `src/main/agent-status/{claude-screen,omp-session,state-tracker}.ts` | Classify Claude's current title, working rows, and live confirmation forms; apply ordered OMP events and publish changed shell states. |
| Composition | `src/main/agent-status/install.ts`, `src/main/startup/receivers.ts`, `src/main/index.ts` | Start the receiver before any launch, subscribe to PTY lifecycle, and sample Claude status every 250 ms. |
| Transport | `src/main/ipc/register.ts`, `src/shared/ipc-contract.ts` | Send `agent-state:list` snapshots, including recognized idle agents, and `agent-state:changed` deltas to all windows. |
| Renderer | `src/renderer/agent-state.ts`, `src/renderer/hooks/useAgentStates.ts` | Keep the current shell map, apply snapshots and deltas, and compute project/global severity. |
| Presentation | `src/renderer/components/{StatusDot,ShellTabDot}.tsx`, `src/renderer/styles.css` | Show agent-specific shell labels, generic aggregate labels, the existing three colours and inactive grey tabs. |

Rules:

- A direct app-launched Claude keeps its launch identity for one PTY
  generation, including a Windows `.cmd` wrapper or unavailable Claude
  hooks. A manually started Claude requires foreground process evidence on
  macOS or Linux. Without that evidence, including on Windows, its dot
  remains idle.
- Claude shows busy for a working OSC title or recognized live activity,
  including a spinner above the persistent input box. A known current approval
  or confirmation form takes precedence and shows blocked. Unknown or stale
  text remains idle. The sampler never reads scrollback or a user-scrolled viewport.
- A direct app-launched OMP loads `resources/omp-status-extension.js` with
  `-e` alongside user extensions. It clears an inherited `OMPCODE=1`
  nesting flag for this app-owned root shell. If the receiver or extension
  is unavailable, or `--trusted-extension` conflicts, OMP still starts
  and its status remains idle.
- The OMP receiver accepts only bounded versioned reports for the current
  spawn credential, PTY generation, session and increasing sequence. During
  a root session, the extension sends current turn and blocker counts every
  250 ms. A later heartbeat repairs a lost transition. After 1,500 ms
  without an accepted report, the tracker returns a live OMP shell to idle.
  A shell exit or replacement revokes its credential. OMP sends no OS notification.
- The IPC payload carries only `projectId`, `shellIndex`, `agent` and
  `state`. An exit clears the renderer entry. Every recognized individual
  shell label names Claude or OMP, including idle. Project and global
  labels use generic text. Severity is blocked, then busy, then idle.

### Project and app-wide environment variables

Each project can store environment variables. The app can also store
app-wide environment variables, which apply to every project. Every shell
the app starts gets both: the primary launch (first, subsequent and the
no-session fallback), plain shells, CLI profiles, custom commands and task
runs. A project variable overrides the app-wide variable with the same name.

The user edits project variables in the project's Env tab, next to Shell
and Files. The sidebar context menu item "Environment variables…" selects
the project and opens that tab. The user edits app-wide variables in
Settings → Environment, after "Launch commands".

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/project-env.ts` | Name and value rules (`envNameProblem`, `envValueProblem`) and `parseEnvMap`, used by the editors and the IPC handlers. `parseProjectEnv` and `parseAppEnv` apply the same rules; only the wording of the rejection message differs. |
| Contract | `src/shared/types.ts` → `SettingsMap['app_env']` | The stored app-wide map, in the `settings` table. Default `{}`. |
| Logic | `src/main/domain/spawn-env.ts` | `resolveSpawnEnv`: the environment overlay for one spawn, and the lookup for `${env.NAME}` in launch argv. Takes the stored app-wide map as the required `appEnv` input. Never reads `process.env` or the settings. |
| Logic | `src/main/domain/launch.ts` | `resolveLaunch` takes the inherited environment, reads `app_env` from the settings and uses `resolveSpawnEnv` for the primary launch. |
| IO | `src/main/ipc/register.ts` | `projectSpawnEnv` reads `app_env` for the plain shell, CLI and task sites. `validatedConfigPatch` checks `projects:update-config` before it writes. That channel emits `projects:changed`. `settings:set-app-env` runs `parseAppEnv` before it writes, and emits `settings:changed { key: 'app_env' }` only after a successful write. The generic `settings:set` rejects the `app_env` key. |
| Logic | `src/renderer/project-env-rows.ts` | The editor's row model: rows from the stored map, per-row problems, `canSave` and rows back to a map. |
| Logic | `src/renderer/project-env-rows.ts` → `isDraftDirty` | Decides if a draft differs from the stored map: the ordered non-blank rows against the ordered stored entries. |
| Presentation | `src/renderer/hooks/useEnvDrafts.ts` | Holds unsaved drafts per project and one app-wide draft (`APP_ENV_DRAFT_KEY`), in memory only. A draft lasts until Save, Discard or app close. `App` owns the drafts, so the app-wide draft survives closing Settings. |
| Logic | `src/renderer/env-reveal.ts` | `createRevealTimers`: one timer for each revealed row. A revealed value masks again after `REVEAL_TIMEOUT_MS` (39 000 ms). It calls `setTimeout` and `clearTimeout` at call time, so a test clock can replace them. |
| Logic | `src/renderer/env-clipboard.ts` | `copyEnvValue`: writes the raw value through `navigator.clipboard` and shows a toast. The toast never contains the value or the name. |
| Logic | `src/renderer/app-env-inherited.ts` | `inheritedRows`: the app-wide rows in stored order, each marked `overridden` when the project's saved map has the same name. |
| Presentation | `src/renderer/hooks/useRevealState.ts` | Reveal state for one mounted editor. Unmount masks every value. `clearAll` masks every value on demand. |
| Presentation | `src/renderer/hooks/useAppEnv.ts` | `useAppEnv` reads `app_env` through `settings:get` and reads it again on `settings:changed { key: 'app_env' }`. `saveAppEnv` calls `settings:set-app-env`. |
| Presentation | `src/renderer/components/env/EnvEditor.tsx` | The editable body that both editors share: notices, rows, Add, Save and Discard. `saveEnvRows` saves, drops the draft and then masks every value. A failed save keeps the draft and the reveal state. |
| Presentation | `src/renderer/components/env/EnvValueField.tsx` | The masked value input with its reveal and copy buttons. |
| Presentation | `src/renderer/components/env/InheritedEnvList.tsx` | The read-only "From app settings" list in the project Env tab. |
| Presentation | `src/renderer/components/ProjectEnvTab.tsx` | The Env tab body. Reads the project fresh through `projects:list` when it mounts, edits the draft, and saves only `{ env }`. Save stays disabled until the stored values have loaded. Shows the inherited list below Save and Discard. |
| Presentation | `src/renderer/components/settings/EnvironmentPanel.tsx` | Settings → Environment: `useAppEnv`, `saveAppEnv` and the shared editor. |
| Contract | `src/renderer/main-tab.ts` | `MainTab` (`shell`, `files`, `diff`, `env`, `settings`) and `isMainTab`, the validator for the persisted tab. |
| Contract | `src/renderer/project-env-copy.ts` | Every string and test id of both editors (`ENV_COPY`, `ENV_TESTIDS`, `APP_ENV_COPY`, `APP_ENV_TESTIDS`). |

Rules:

- Precedence, lowest to highest: the app's inherited environment, the
  app-wide variables, the template env (the launch command, CLI profile or
  custom command env), the project variables, and the Claude hook
  variables. `PtyManager` layers the inherited environment underneath and
  the launch decorator layers the hook variables on top. A project cannot
  unset an app-wide variable. It can override it, also with the empty
  string.
- App-wide variables use the same name and value rules as project
  variables. Stored app-wide entries that break the rules are skipped at
  spawn.
- App-wide values can use `${HOME}`, `${PROJECT_PATH}`, `${PROJECT_NAME}`
  and `${env.NAME}`. The path tokens resolve for the project being spawned.
  In an app-wide value, `${env.NAME}` reads the inherited environment only,
  so an app-wide variable cannot read another app-wide variable.
- A valid name matches `^[A-Za-z_][A-Za-z0-9_]*$`, has at most 255
  characters, does not start with `METAIDE_` (any case) and is not
  `__proto__`, which a plain object would drop on save. A value must
  not contain a NUL character. An empty value sets the variable to the
  empty string. Stored entries that break these rules are skipped at spawn.
- Project values can use `${HOME}`, `${PROJECT_PATH}`, `${PROJECT_NAME}`
  and `${env.NAME}`. `${env.NAME}` reads the inherited environment, then the
  interpolated app-wide variables, then the template env, in one pass. A
  project variable cannot read another project variable. An unset name
  gives the empty string.
- `${env.NAME}` in launch argv reads the final environment: inherited,
  then app-wide variables, then template env, then project variables. On a
  name clash, argv sees the project value. Template env values reach argv after interpolation,
  so `X=${HOME}/t` gives argv the expanded path, not the literal token.
- Template env values are interpolated as before this feature, against
  the stored project map and the template env, without the inherited
  environment and without the app-wide variables
  (`src/main/domain/launch.ts:59-62`). A template env value that uses
  `${env.NAME}` therefore cannot read an app-wide variable, although the
  template env ranks above the app-wide variables.
- CLI profile and custom command env is passed as it is, without
  interpolation.
- Saving replaces the whole map, so a removed row is gone. Shells that
  already run keep their environment. Changes apply to the next spawn.
- Unsaved edits stay as a draft for each project when the user switches
  tab or project. The Env tab label shows `•` while a draft differs from
  the stored values. Discard drops the draft. The app-wide draft follows
  the same rules. It survives a Settings section change and closing
  Settings. The Environment nav item shows `•` while the draft differs.
- Both editors mask every value by default, as a password field does.
  Names are not masked. Each row has a reveal button and a copy button.
  A revealed value masks again after 39 seconds. Each row has its own
  timer. Removing a row masks that row. Discard, a save that succeeds, a
  change to the stored map while no draft is open, leaving the editor,
  selecting another project and closing Settings mask every value. In the
  project Env tab, a change to the saved app-wide map also masks every
  value, including the inherited rows. Reveal state is not stored.
- Masking only hides values on screen. Values are stored as plain text in
  the local SQLite database, and the renderer holds them in memory.
- Copy writes the raw value, with `${…}` tokens not expanded. Copy works
  while the value is masked and does not reveal it. The copy button is
  disabled while the value is empty.
- The project Env tab lists the saved app-wide variables read-only, below
  Save and Discard. A row whose name the project's saved map also defines
  shows "Overridden by this project". The list updates when
  `settings:changed { key: 'app_env' }` arrives.
- The Env tab does not count as viewing a shell for notifications.
  Switching from Env back to Shell does not focus the terminal, the same
  as switching from Files. The sidebar handler sets the tab before it
  selects the project, so the project switch queues no terminal focus.
- On Windows, the inherited environment can hold `Path` instead of `PATH`.
  `${env.PATH}` is case-sensitive and then gives the empty string. This is
  a known limitation.

### Diff tab

The Diff tab sits between Files and Env. It lists the uncommitted changes
of the selected project in three groups: Staged, Changes and Untracked.
It shows the selected file's diff side by side, before on the left and
after on the right, with syntax highlighting. The tab is read-only.
Staging and committing stay in the sidebar Git panel.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/ipc-contract.ts` | `GitChangeEntry`, `GitDiffKind`, `GitSideContent`, and the `git:panel-status`, `git:file-diff` and `git:diff-sides` channels. |
| Logic | `src/shared/parse-git-panel-status.ts` | Parses `git status --porcelain=v1 -z` into staged, unstaged and untracked lists. Renames and copies carry `origPath`. A conflicted file goes into both lists. |
| IO | `src/main/git/run-git.ts` | `runGit`: the only place that starts git for these channels and for `git:status`. It runs git asynchronously through `execFile`, so a slow git never blocks the main thread. It adds the safety arguments and turns an output overflow or a timeout into a flag. It never returns partial output. |
| Logic | `src/main/git/repo-path.ts` | `toRepoRelativePath` (lexical containment) and `assertWorktreeContained` (containment by real path of the parent folder). |
| IO | `src/main/git/file-diff.ts` | `readFileDiff`: the unified diff of one entry, capped at 1 MiB (`GIT_DIFF_MAX_BYTES`). Used by the Git panel and by `readDiffSides`. |
| IO | `src/main/git/diff-sides.ts` | `readDiffSides`: the diff plus the full old and new content of the file, each capped at 256 KiB (`HIGHLIGHT_MAX_BYTES`), for highlighting. |
| IO | `src/main/ipc/register.ts` | Thin handlers for the three channels. They resolve the project and call the modules above. |
| Logic | `src/renderer/diff/diff-selection.ts` | Groups the lists, keeps the selection across refreshes within the same group, and counts unique changed paths for the tab label. |
| Logic | `src/renderer/diff/diff-load-state.ts` | The request gate that drops stale responses, the list phases, and the reducer for `git:diff-sides` responses. |
| Logic | `src/renderer/diff/unified-diff.ts` | Parses a unified diff into hunks, and detects binary and mode-only changes. |
| Logic | `src/renderer/diff/diff-rows.ts` | Aligns hunks into side-by-side rows with filler rows and line numbers. Checks that a side's content matches the diff. |
| Logic | `src/renderer/diff/highlight-lang.ts` | `langForPath`: the language for a file extension. The Files tab uses the same map. |
| Logic | `src/renderer/diff/highlight-lines.ts` | Highlights a full file with highlight.js and splits the result into one `SafeLineHtml` per line. |
| Presentation | `src/renderer/hooks/useGitChanges.ts` | Polls `git:panel-status` every 3 s while the Diff tab body is mounted. |
| Presentation | `src/renderer/hooks/useDiffSides.ts` | Loads `git:diff-sides` for the selected file and reloads it on each poll. |
| Presentation | `src/renderer/components/DiffTab.tsx`, `DiffFileList.tsx` | The tab body, the empty and error states, and the file list. |
| Presentation | `src/renderer/components/SplitDiffView.tsx`, `SplitDiffRows.tsx` | The side-by-side view. One vertical scroll container holds both sides. |
| Contract | `src/renderer/diff-tab-copy.ts` | Every string and test id of the tab. |
| Logic | `src/renderer/git-status-style.ts` | Status letter colours, shared by the Diff tab and the Git panel. |

Rules:

- A staged entry compares HEAD with the index. An unstaged entry compares
  the index with the working tree. An untracked entry has an empty before
  side.
- The tab polls only while its body is mounted. A poll that finds the same
  diff (same SHA-1 as the last one) gets `unchanged` and reads no file
  content, so the pane does not change and keeps its scroll position.
- A diff over 1 MiB shows "Diff too large to show". No file content is
  read. If either side is over 256 KiB, the diff shows without
  highlighting, with a note. A side whose content does not match the diff
  shows as plain text without a note.
- The tab label count comes from the app-wide `useGitStatus` poll (4 s).
  It counts unique paths, so it can lag the list by one poll.
- The Diff tab does not count as viewing a shell for notifications.
  Switching from Diff back to Shell does not focus the terminal.
- The Git panel uses the same `git:panel-status` and `git:file-diff`
  handlers. It keeps its own unified diff, without highlighting.

## Data Flow

1. `MarkdownPreview` calls `renderMarkdown(source)`. This is synchronous.
2. `markdown-it` parses the source. The math plugin renders math through
   KaTeX during the parse. The fence rule emits one placeholder per `mermaid`
   fence, with the escaped source and `data-mermaid-state="pending"`.
3. React sets the HTML string into the preview container.
4. `useMermaidDiagrams` finds the placeholders. It renders each one through
   `mermaidRenderer`, in document order. It yields to the event loop between
   diagrams (`useMermaidDiagrams.ts:47`).
5. For each diagram, the hook adds an output element or an error element to
   the block. It sets the block state to `rendered` or `error`. The source
   element stays in the block. CSS hides it when the state is `rendered`.
6. A theme change or a new HTML string starts the hook again. The effect
   cleanup cancels the previous run. The run also stops when a block is no
   longer in the document (`useMermaidDiagrams.ts:64-79`).

A link click in the preview always calls `preventDefault`
(`MarkdownPreview.tsx:22`). The handler reads `href`, then `xlink:href`.
Links inside a diagram do nothing. `http`, `https`, `mailto` and `file`
links outside a diagram open through the `app:open-external` IPC channel.

### Font preference change

1. The renderer sends `settings:set-font` with one font key and an unknown
   value.
2. The main process validates and normalizes the value. It stores the value,
   then broadcasts `settings:changed` for that key
   (`src/main/ipc/register.ts:572-578`, `:1275-1279`).
3. Each renderer font store reads the changed key. The main window and each
   popout window therefore receive the same durable value
   (`src/renderer/fonts/font-settings-context.tsx:39-68`).
4. The UI adapter updates the root CSS property, or each terminal updater
   changes its existing xterm instance (`src/renderer/fonts/use-apply-ui-font.ts:12-28`,
   `src/renderer/components/ShellTab.tsx:411-416`).
5. A terminal font change completes with fit, repaint, and PTY resize. It
   does not recreate the PTY or replay scrollback
   (`src/renderer/terminal-font-update.ts:68-105`).

### Claude notification event

1. At app start, `runtime.ts` starts the receiver on an ephemeral
   `127.0.0.1` port. It writes
   `~/.metaide/claude-hooks/settings-<port>.json` with `Notification`,
   `Stop` and `UserPromptSubmit` HTTP hooks, each with a one-second timeout
   (`src/main/claude-hooks/settings-file.ts:21-55`).
2. When a Claude shell spawns, the decorator issues a session id and a
   secret. It adds `--settings <file>` after `argv[0]`, and
   `METAIDE_HOOK_SHELL` and `METAIDE_HOOK_TOKEN` to the environment.
3. Claude Code posts each hook event. It fills the `X-Metaide-Shell` and
   `Authorization: Bearer` headers from those environment variables.
4. The receiver checks method, path, `Host`, content type, the id and
   secret, and then the body size (1 MiB at most). It answers `204` with no
   body, and only then passes the event on through the fan-out. Claude Code
   never gets a decision from the app.
5. `ClaudeHookHistory` confirms the current session and updates only
   notification eligibility. It sends the applied event and its prior and
   current eligibility to `ClaudeNotifier`.
6. The notifier reads the appropriate toggle and checks support and
   whether the user is viewing the shell. It then shows the notification.
7. A click on a popped-out shell's notification focuses the popout.
   Otherwise the main window is restored and focused, and
   `shell:focus-request` is sent only while the shell is still alive.

### Agent status update

1. `PtyManager.spawn` records the requested agent identity and a new
   generation before it emits `spawn`.
2. Every 250 ms, `AgentStatusTracker` reads the bottom of a recognized
   Claude shell's active screen after the parser drains. On macOS and
   Linux, it first checks the foreground process for manually started
   Claude. Unknown screen content or missing process evidence stays idle.
3. A direct OMP launch loads the packaged extension. Its root session
   sends versioned, ordered lifecycle reports to the local receiver.
   The receiver accepts only credentials bound to the live PTY generation.
4. The tracker sends changed identity or state through
   `agent-state:changed`. A new window reads `agent-state:list`.
   An exit revokes OMP credentials and removes the renderer entry.

### Project and app-wide environment variables at spawn

The user saves Settings → Environment:

1. `settings:set-app-env` runs `parseAppEnv` on `env`. An invalid map is
   rejected before any write, with an error that names the key and never
   the value.
2. The handler writes `app_env` to the `settings` table and emits
   `settings:changed { key: 'app_env' }`. `useAppEnv` reads the map again.

The user saves the project Env tab, and a shell starts:

1. The user saves the Env tab. `projects:update-config` runs
   `parseProjectEnv` on `env`. An invalid map is rejected before any write,
   with an error that names the key and never the value.
2. `ProjectsRepo.updateConfig` merges the patch shallowly, so `env`
   replaces the stored map. The handler emits `projects:changed`.
3. A spawn site builds its template env, reads `app_env` from the settings
   and calls `resolveSpawnEnv` with the project, the template env, the
   app-wide map and `process.env`.
4. `resolveSpawnEnv` interpolates the valid app-wide variables against the
   inherited environment. It interpolates the valid project variables
   against the inherited environment, then the app-wide variables, then
   the template env. It returns the app-wide variables, then the template
   env, then the project variables on top.
5. `PtyManager.spawn` starts the PTY with `process.env` underneath that
   overlay. For a Claude shell, the launch decorator adds the hook
   variables last.

### Diff tab refresh

1. While the Diff tab body is mounted, `useGitChanges` calls
   `git:panel-status` every 3 s. It skips a tick while a request is in
   flight, and drops a response that arrives after a project switch.
2. The handler runs `git status --porcelain=v1 -z` through `runGit`.
   On failure it returns git's error text in `error`, and the tab shows
   the error state, not the clean state.
3. `reconcileSelection` keeps the selected file if it is still in the same
   group. Otherwise it selects the first file, or nothing.
4. `useDiffSides` calls `git:diff-sides` with the SHA-1 of the diff it
   already shows. `readDiffSides` checks the path, reads the diff and
   compares the hash. A match returns `unchanged` and the pane stays as
   it is.
5. On a new diff, `readDiffSides` reads the before side and the after
   side with `git cat-file blob` (`HEAD:<path>` or `:0:<path>`), or from
   the working tree without following a symlink.
6. `SplitDiffView` parses the diff, aligns the rows, and highlights each
   side over its full content. The highlighting is memoised on the content
   and the language, so an unchanged side is not highlighted again.

## Authorization Model

Not applicable to the preview. It reads only the local file buffer.

The Claude hook receiver accepts requests only on `127.0.0.1`, with a
`Host` header that matches its port. Each Claude spawn gets a 32-byte
secret. The receiver compares it with `timingSafeEqual`. The secret stays
in the PTY environment, not in argv, settings or logs. Child processes
inherit it and can raise notifications for that shell, but cannot change
status dots. Released sessions stop authenticating. The receiver
authenticates before it buffers the request body.

The OMP receiver binds only to `127.0.0.1`. It limits input size, concurrent
connections and report rate. It checks a per-spawn secret, PTY generation,
active session and increasing report sequence
(`src/main/agent-status/omp-receiver.ts:13-36,62-101,104-145`).
Only a process with the live shell's current credential can report its OMP status.

The `agent-state:list` reply and `agent-state:changed` event carry only
`projectId`, `shellIndex`, `agent` and `state`. No hook message, prompt,
tool input, tool response, terminal text, session id or credential crosses
the status IPC boundary (`src/shared/ipc-contract.ts:102-103,383-384`).

Project variable values are stored in plain text in the project's
`config_json` in SQLite, and the database backups copy them as they are.
They reach the renderer with every project in `projects:list`. The editor
says that values are stored unencrypted. Values are never logged and never
shown in a notification or toast. One exception: when the user's own launch
command uses `${env.NAME}` for a project variable in its argv, the resolved
argv is stored in the shell row, as every resolved launch argv is. The
Env tab says so. An inherited value that argv reads through `${env.NAME}`
is stored there the same way.

The Diff tab reads git data from projects that can come from an untrusted
clone. Two rules apply to `git:panel-status`, `git:file-diff` and
`git:diff-sides`:

- **Paths stay inside the project.** Every path from the renderer goes
  through `toRepoRelativePath`, which rejects `..`, absolute paths and a
  sibling folder whose name starts with the project's name. Working-tree
  reads also go through `assertWorktreeContained`, which compares the real
  path of the parent folder, so a symlinked folder cannot lead outside the
  project. A rejected path runs no git command. A working-tree symlink is
  shown as its link text and is never followed.
- **Repository config cannot start programs.** `runGit` adds
  `-c core.fsmonitor=false` and `--literal-pathspecs` to every call, and
  sets `GIT_OPTIONAL_LOCKS=0`, so status takes no optional index lock and
  polling never contends with the user's own git commands.
  Every diff also runs with `--no-ext-diff` and `--no-textconv`. File
  content is read with `git cat-file blob`, which runs no textconv or
  filter.

The app-wide `git:status` poll also runs through `runGit`, so the same
rules apply to it.

Known gaps, recorded as follow-ups: a repository's `filter.<name>.clean`
programs can still run during status, because git cannot turn them off
for one command. The `files:*` handlers check containment lexically
(`src/main/domain/path-containment.ts`), so unlike `assertWorktreeContained`
they follow a symlink inside the project that points outside it.

Highlighted lines reach the DOM through one `dangerouslySetInnerHTML`, in
`SplitDiffRows.tsx`. It takes only the branded `SafeLineHtml` type, which
only `highlight-lines.ts` creates. highlight.js escapes all text and emits
only `<span class="…">` and `</span>`. Each line must also match an
allow-list pattern. If any line fails, or the line count does not match,
the whole side falls back to escaped plain text.

## Infrastructure Dependencies

| Dependency | Version | Use |
|---|---|---|
| `markdown-it` | 14.3.0 | Markdown parser. `html` is `false`. |
| `highlight.js` | lockfile | Code block highlighting, and both sides of the Diff tab. |
| `katex` | 0.16.47, exact pin | Math. Also the version `mermaid` depends on, so the bundle has one copy. |
| `mermaid` | 11.17.2, exact pin | Diagrams. Version 12 requires Node 22, and the repo uses Node 20. |

## Architectural Decisions

- **Terminal drops use Ghostty's escaping, not quotes.** Dropped paths are
  backslash-escaped and pasted, the same as Ghostty does. CLI agents such as
  Claude Code recognise this form as a file path. The Files-tree resolver
  checks containment with `isInsideRoot` from
  `src/main/domain/path-containment.ts`.

- **One containment rule for project files.** `isInsideRoot` and
  `resolveInsideRoot` (`src/main/domain/path-containment.ts`) decide whether a
  path is inside a project root with `path.relative()`. The `files:*` handlers,
  `files:start-drag` and the drop resolver all use them. A string-prefix test is
  not used, because it accepts a sibling such as `/proj-evil` for the root
  `/proj`. `files:peek` still reads absolute paths by design; it uses
  `isInsideRoot` only to choose which root a path is shown under.

- **Motion library.** `motion@14.0.0` is pinned exactly. It was five days
  old when added, inside the usual release-age window; it was accepted
  because 14.0.0 equals 13.5.1 minus internal APIs, and older 13.x
  releases lack the `AnimatePresence` fixes in 13.4.5 and 13.4.6.

- **Mermaid loads lazily.** `mermaidRenderer.ts` reaches `mermaid` only
  through `import('mermaid')` (`mermaidRenderer.ts:52`). Vite puts it in a
  separate chunk. A document without diagrams does not load it.
- **Mermaid security configuration.** The adapter calls `initialize` with
  `securityLevel: 'strict'`, `suppressErrorRendering: true` and
  `startOnLoad: false` (`mermaidRenderer.ts:91-94`), in both the palette and
  the directive-theme branch. It does not set
  `secure`, so the Mermaid default secure keys apply and an `%%{init}%%`
  directive cannot change `securityLevel`.
- **Mermaid renders into a scratch element.** `mermaid.render` clears the
  element it receives. The adapter gives it a temporary child of the block
  and removes that child after the render (`mermaidRenderer.ts:180`). The
  child is absolutely positioned and hidden, so it does not change the block
  height while Mermaid lays out the diagram. This
  keeps the block source for the next render.
- **Diagram results are cached.** The adapter keeps up to 50 SVG results,
  keyed by theme, the theme token values and source
  (`mermaidRenderer.ts:139`, `:211`). A token change misses the cache. The
  derived palette is memoised per theme and token set, up to four entries
  (`mermaidRenderer.ts:39`).
- **Diagram palette comes from the live tokens.** Every render reads the
  theme tokens listed in `paletteContract.ts` from the computed style of
  `<html>`, so System mode and both explicit themes need no extra logic.
  `mermaidPalette.ts` derives Mermaid `base`-theme `themeVariables` from them.
  There is no second, hand-copied colour list. Text uses the exact `--text`
  token. Node and box fills are `--panel-strong` and `--panel` composited over
  the lighter reference background (the plan's near bound). Lines, borders
  and the accent roles keep their token's hue and are
  moved in lightness until they reach 3:1 against both reference backgrounds.
  Categorical colours start from the icon and highlight.js hues, avoid
  `--danger`, and are at least CIEDE2000 15 apart. Every emitted value is an
  opaque `#rrggbb`, because Mermaid's colour library cannot parse `var()` or
  `color-mix()` and keeps alpha. A token that cannot be parsed fails every
  diagram with an error that names the token; there is no fallback palette.
  The same holds when the tokens leave no feasible categorical palette: if no
  hue turn or lightness shift of a seed meets the contrast rules, or none
  stands far enough from the earlier categories and `--danger`, every
  diagram fails with a `CategoricalColourError` naming the seed's token and
  the unmet rule (`categoricalColours.ts`).
  The unit suite runs the real `styles.css` token blocks through the palette.
- **Directive-themed diagrams get no app palette.** Mermaid merges the
  `themeVariables` given to `initialize` into a directive's theme. The adapter
  therefore calls `mermaid.parse` first (`mermaidRenderer.ts:217`). If the
  source's own directive or frontmatter sets `theme` to one of Mermaid's theme
  names, it calls `initialize` with no `theme` and no `themeVariables`
  (`mermaidRenderer.ts:64-88`). The names are every value of Mermaid's own
  `MermaidConfig['theme']` type in 11.17.2: `default`, `base`, `dark`,
  `forest`, `neutral`, `neo`, `neo-dark`, `redux`, `redux-dark`,
  `redux-color`, `redux-dark-color` and `null`. The list is checked against
  that type with `satisfies`, so a Mermaid upgrade that adds or drops a theme
  fails the build. `base` counts, so an author's own `base` palette is left
  as it is. Any other value, such as `Dark` or a typo, is ignored by Mermaid
  too, so the diagram keeps the app palette. Otherwise it uses
  `theme: 'base'` with the app palette. Only the `theme` and
  `themeVariables` keys of the parsed config are read.
- **Directive `themeVariables` without a `theme` re-derive what they feed.**
  Mermaid does not re-derive the theme for such a directive, so an explicit
  palette `mainBkg` would hide an author's `primaryColor`.
  `withAuthorVariables` (`mermaidPalette.ts`) adds the author keys to the
  `initialize` palette and drops every palette colour that Mermaid's `base`
  theme derives from them, so Mermaid derives those from the author's value.
  All other roles keep the app palette. Only plain keys are folded in, and
  only when the value passes Mermaid's own directive filter and is written in
  a form that Mermaid's colour library and the palette both read the same
  way: unpadded `#rgb`, `#rrggbb` or `#rrggbbaa`, or comma-separated
  `rgb()`/`rgba()`. Mermaid's colour library throws on other forms under
  `base` (`none`, a typo such as `#ff00f`, a padded value, four-part space
  syntax), which would fail the whole diagram;
  such a value is left out, and Mermaid still overlays it from the directive
  at render time without re-deriving, as it did before the palette.
- **Reference backgrounds.** The preview pane paints no background of its
  own: Tailwind 3.4 emits no rule for `bg-[--panel]/40`, because it drops a
  `var()` colour with an opacity modifier. A diagram therefore lands on
  `--bg`, painted by both `html` and `body`, over the window's vibrancy
  material. `capturePage` cannot see that material, so the palette checks
  contrast against `--bg` painted twice over black and over white
  (`REFERENCE_MATERIALS`, `BG_LAYERS` in `paletteContract.ts`). On macOS the
  sheet is opaque, so a diagram lands on `--sheet-solid`
  (`MAC_PREVIEW_SURFACE`).
- **KaTeX runs untrusted.** `renderMath.ts:5-10` sets `trust: false`,
  `maxSize: 20` and `maxExpand: 1000`.
- **Own math plugin.** No maintained plugin supports `markdown-it` 14 and all
  five delimiters. The inline rule runs before the `escape` rule
  (`mathPlugin.ts:238`), so it sees `\(` and `\[`.
- **Theme comes from the document.** `useDocumentTheme` reads
  `<html data-theme>`, then the `prefers-color-scheme` media query
  (`useDocumentTheme.ts:13-15`). It does not use `useTheme`, because each
  `useTheme` call holds its own state.
- **Fonts are never inlined.** The CSP has no `font-src`, so a `data:` font
  is blocked. The renderer build excludes font files from asset inlining
  (`electron.vite.config.ts:63`). The KaTeX stylesheet is imported in
  `src/renderer/main.tsx:5`.
- **Font discovery is user-initiated and optional.** Chromium Local Font
  Access is permission-sensitive. Settings calls it only when a font list
  opens (focusing a font field opens its list), at most once per successful
  Settings session. After a failure, **Retry** or reopening the list requests
  it again. Exact-name entry and System default remain
  available when discovery is unsupported or denied
  (`src/renderer/components/FontControl.tsx`, `useFontDiscoverySession` in `src/renderer/components/Settings.tsx:48-74`).
  Option building, validation and the highlight live in the pure module
  `src/renderer/fonts/font-options.ts`. The highlight is stored as an option's
  identity, not an index, so it survives the list changing when discovery
  completes, and Enter on an unedited field saves nothing.
- **A selected family is one literal CSS family.** The serializer validates
  the value, escapes quotes and backslashes, and places it before the exact
  compatibility fallback. It sets one CSSOM property and never creates
  stylesheet text (`src/renderer/fonts/font-family.ts:10-25`,
  `src/renderer/fonts/use-apply-ui-font.ts:12-28`).
- **Terminal focus uses the renderer `window` focus event.** On macOS,
  webContents `focus` and `blur` do not fire when the user switches between
  windows, so the coordinator listens on the renderer `window` instead.
  Unit tests cover the coordinator in the node environment. The E2E suite
  (`tests/e2e/terminal-window-focus.spec.ts`) dispatches a synthetic
  `focus` event on `window`. A real `BrowserWindow.blur()`/`focus()` cannot
  drive it: Playwright enables focus emulation on every page it attaches,
  and with emulation off, `blur()` does not resign key while no other window
  or app can take focus. Real macOS app activation delivers the event; this
  was verified by hand, not by the suite.
- **Status authority differs from notification authority.** Claude
  notifications use authenticated `Notification`, `Stop` and
  `UserPromptSubmit` hooks. Status dots use the live terminal title and
  bounded current screen of a recognized Claude PTY. A plain terminal's text
  cannot establish Claude identity. OMP dots use authenticated lifecycle reports
  from the app-owned extension. A reporter heartbeat repairs a missed
  transition; its lease returns stale busy or blocked status to idle.
- **A `Stop` with background tasks is not the end of the work.** Claude
  Code fires `Stop` when the main agent stops responding, also while
  background shells, subagents or teammates still run. The `background_tasks`
  list in the payload tells the two cases apart. Only its length is kept.
- **Notifications keep their own hook history.** The notification
  history confirms Claude's current hook session and tracks eligibility
  after a prompt answer, background `Stop`, or quiet turn. It does not
  set status dots. A received needs-input or finished hook can notify
  while the independent live-screen dot remains idle.
- **Hooks are `http`, not `command`.** An `http` hook needs no shell,
  `curl` or `node` on the PATH, so the same file works on Windows. HTTP
  errors and timeouts do not block Claude Code.
- **Hooks are injected with `--settings`.** Hook lists from `--settings`
  merge with the user's and the project's hooks. The app does not write to
  `~/.claude`, `~/.claude.json` or the project's `.claude/` directory.
- **One settings file per app instance.** The file name has the receiver
  port in it. Two instances that share one home directory, for example a
  packaged app and a development build, do not redirect each other's
  shells.
- **`UserPromptSubmit` confirms the shell early.** `SessionStart` does not
  support `http` hooks. `UserPromptSubmit` fires before each turn, so the
  shell is confirmed before the generic notifier can fire during the turn.
- **Notifications stay referenced.** Electron can garbage-collect a
  `Notification` that only a local variable holds, and its `click` event
  then does not fire (electron/electron#21610).
- **Windows needs an AppUserModelID.** `index.ts` calls
  `app.setAppUserModelId('com.metalogix.metaide')` on Windows. Windows and
  Linux notifications were checked by code review only.
- **One resolver for every spawn site.** Before this feature, only the
  primary launch applied project env, and its argv lookup used the reverse
  precedence of its env. `resolveSpawnEnv` computes both for every site, so
  the precedence cannot drift between sites again.
- **The editor reads the project fresh.** The App's `projects:changed`
  listener ignores `config.env`, so the Env tab loads the project through
  `projects:list` each time it mounts instead of using cached state.
- **A separate channel for the Diff tab.** `git:diff-sides` returns the
  diff and both full sides in one call. The Git panel keeps
  `git:file-diff`, so its unified diff does not pay for content reads.
- **Highlighting runs over the full file.** Highlighting only the hunk
  lines would colour a comment or string that opens above the hunk as
  code. The full side is highlighted once and then split per line,
  keeping open spans across line breaks.
- **A hash check makes polls cheap.** The renderer sends the SHA-1 of the
  diff it shows. When the diff is the same, main returns `unchanged`
  without reading content, and the renderer keeps the same state object,
  so nothing renders again.
- **`-z` porcelain for the panel status.** Without `-z`, git quotes paths
  with spaces or non-ASCII characters and writes renames as `old -> new`,
  which the diff call could not resolve.
