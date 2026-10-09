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
IPC handler before creating the initial `BrowserWindow`. Renderer providers
may invoke settings channels while the first document is still loading, so
window creation must not move ahead of `registerIpc`.

On macOS, startup resolves PATH from the user's interactive login shell before
constructing services or creating a renderer (`src/main/index.ts:374-386,508-510`).
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
Use its star button to select it as the folder's automatic launch command.
Clear the star to restore the global launch command.
The existing shell launch, environment, tab, and popout paths apply to these agents.
Pi and oh-my-pi use bare `pi` and `omp` commands on both first and subsequent launches.
They do not receive Claude-specific permission flags or hooks.

Upstream CLI references: [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
and [oh-my-pi](https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md).

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
The Command Palette also provides commands for all three palettes.

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
| `--surface-raised` | Floating lists over a dialog, such as the font list. It is the dialog surface mixed with white, so it is always lighter than the dialog. |
| `--switch-off` | The track of a switch that is off. |
| `--hue-yellow`, `--hue-purple`, `--hue-cyan`, `--hue-pink`, `--hue-orange` | Semantic accents: dirty branch, Board icon, ahead/behind, task badge, Diff count. A palette's `--term-*` colour wins; otherwise the `-default` value for the appearance applies. |
| `--hue-orange-text` | Small coloured text, such as the Diff count. |
| `--hue-orange-soft`, `--hue-orange-soft-text`, `--badge-accent-text` | Activity-bar count badges: a soft hue fill with text that keeps 4.5:1 contrast. Light appearances mix the badge text almost fully toward `--text`. |
| `--badge-ink` | Unused since badges became soft tints; kept for a later token cleanup. |

The side panels (projects, chat, git) paint no tint of their own; they sit
directly on `--surface-chrome`.

**Title bar.** The main and popout title bars are 44px tall. The main title
bar centres `TitleGroup` (`src/renderer/components/TitleGroup.tsx`): the
selected project's name and its branch in `--hue-pink`, or "MetaLogix IDE"
when no project is selected. The branch uses the status bar's rule
(`git.branch`, or `HEAD` when detached). The group sits in a box inset 130px
from both edges, so it stays centred on the window and clear of the traffic
lights and the buttons. On macOS, `src/main/index.ts` sets
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
terminal (`src/renderer/components/ShellTab.tsx:374-379`). A terminal waits
for the loaded size before it opens, within the existing 2 s layout cap.

The terminal font and bold weights use the same store-and-broadcast path
with two channels, one per user action. Main is the only place that derives
bold from the font weight, so the stored pair is never half-written; both
main and the renderer resolve a missing or invalid stored value with the same
shared function. A weight change sets `fontWeight` and `fontWeightBold` in
one `term.options` assignment (`src/renderer/components/ShellTab.tsx:384`).
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
- Keyboard toggles (⌘B, ⌘\, palette commands) stay instant.
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
| Presentation | `src/renderer/App.tsx` | Computes the overlay flag, marks the left pane and the popout terminal as `primary`, forwards `shell:focus-request`, popout open and scrollback-search jumps to `requestFocus`, and project switches (sidebar, switcher, new-project dialog) to `requestProjectFocus`. |

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

### Claude notifications

The app shows an OS notification when Claude Code, running in an app
shell, needs the user's input or finishes its turn. Claude Code reports
these events through its own hooks. The app does not read terminal output
or escape sequences for this.

| Layer | File | Responsibility |
|---|---|---|
| IO | `src/main/claude-hooks/receiver.ts` | Loopback HTTP server. Checks the request, authenticates it, answers `204`, then passes a typed event on. |
| IO | `src/main/claude-hooks/settings-file.ts` | Builds, writes and removes the app-owned Claude Code settings file. |
| Logic | `src/main/claude-hooks/hook-event.ts` | Parses a hook payload into a `HookEvent`. Keeps only the event name, notification type, message and the number of background tasks. Classifies an event as `needs-input`, `finished` or `ignored`, and maps it to a state transition (`stateTransitionFor`). |
| Logic | `src/main/claude-hooks/hook-fanout.ts` | Registers the receiver's one listener and delivers each hook to several listeners. A failure in one listener is logged and does not stop the others. |
| Logic | `src/main/claude-hooks/session-registry.ts` | Issues, verifies and releases the per-spawn id and secret. Records which shells are hook-confirmed. |
| Logic | `src/main/claude-hooks/launch-decorator.ts` | Adds `--settings <file>` and the id and secret to the environment of a Claude launch, just before spawn. |
| Logic | `src/main/claude-hooks/runtime.ts` | Starts the receiver, then writes the settings file. Stops both on quit. |
| Contract | `src/main/claude-hooks/protocol.ts` | Hook path, header name and environment variable names. |
| Logic | `src/main/notifications/claude-notifier.ts` | Decides if an applied hook shows a notification, from the state before and after the tracker applied it. Builds the text and keeps one notification per shell. Also `withoutHookConfirmed`, the filter for the generic notifier. |
| Logic | `src/main/notifications/viewed-shells.ts` | Holds the shells the main window shows. Decides if the user is viewing a shell. |
| Adapter | `src/main/notifications/os-notifications.ts` | Wraps Electron `Notification`. Keeps each instance referenced until it is clicked or closed. |
| Composition | `src/main/notifications/install.ts` | Connects the Claude state tracker's `onHookApplied` stream, the notifier, windows and PTY exit events. Builds the click navigation. |
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
- Notifications follow the Claude state (see "Claude status dots"). The
  notifier reads each hook after the tracker applied it, with the shell's
  state before and after.
- Needs input is a `Notification` event with `notification_type`
  `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` or
  `agent_needs_input` that leaves the shell blocked. Claude Code's question
  prompt also arrives as `permission_prompt`. A stale needs-input event
  leaves the shell as it is and shows nothing.
- Finished is a `Stop` event with no background tasks that moves the shell
  from busy to idle. A `Stop` with background tasks, a `Stop` on an idle
  shell, and an idle state from the stale-busy guard, `idle_prompt`,
  `StopFailure` or a PTY exit show nothing.
- All other events show nothing, but any confirmed event marks the shell
  hook-confirmed. The tracker confirms the session.
- The generic "Command finished" notifier skips hook-confirmed shells.
  Before a shell is confirmed, the generic notifier is its fallback.
- The user is viewing a shell when its popout window has focus, or when
  the main window has focus, shows the shell, and the shell is not popped
  out. In split view, both panes are shown.
- A new notification for a shell closes the previous one. A PTY exit
  releases the shell's session and closes its notification, unless a
  respawn has already replaced that PTY.

### Claude status dots

Each live dot shows the Claude state of its shell: idle (green), busy
(amber) or blocked (red). The main process derives the state and pushes it
to every window. Renderers never read terminal text for it.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/claude-state.ts` | `ClaudeShellState`, the state entry, the text label per state and the DOM test hooks. |
| IO | `src/main/ipc/register.ts` | `claude-state:list` returns every shell that is not idle. |
| Service | `src/main/claude-status/state-tracker.ts` | The state machine per shell. Confirms each hook session. Emits `onChange` on real transitions and `onHookApplied` for every confirmed hook. |
| Logic | `src/main/claude-status/answer-input.ts` | `isAnsweringInput`: Enter, a lone Esc, Ctrl-C or a single digit 1-9. |
| Composition | `src/main/claude-status/install.ts` | Connects the hook fan-out, PTY `input` and `exit` events and a 1 s guard tick to the tracker. Broadcasts `claude-state:changed`. |
| Adapter | `src/main/pty/manager.ts` | `write()` emits `input` for every write to a shell. |
| Logic | `src/renderer/claude-state.ts` | Pure snapshot and delta reducers, and the worst state of a shell, a project or all shells. |
| Presentation | `src/renderer/hooks/useClaudeStates.ts` | One store per window. Fetches the snapshot on first use, applies deltas, and fetches again on `alive-shells:changed`. |
| Presentation | `src/renderer/components/StatusDot.tsx` | The dot: colour from `data-claude-state`, `title` and `aria-label` from the state label. |
| Style | `src/renderer/styles.css` | `--claude-idle`, `--claude-busy` and `--claude-blocked` per theme, and the 1 px white ring on the active Project Switcher row. |

Rules:

- A shell with no current hook session is always idle. The tracker keeps a
  state only while its session is the shell's current session, so a
  respawn or a release reads idle.
- `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `PostToolUseFailure`
  set busy. `PermissionRequest` and a needs-input `Notification` set
  blocked.
- `Stop` with no background tasks and `StopFailure` set idle. `idle_prompt`
  sets idle unless the shell waits on background work.
- `Stop` with background tasks sets busy and marks the shell as waiting on
  background work. Claude Code resumes when that work reports back.
  `session_crons` does not count.
- An answering keystroke moves a blocked shell to busy. Terminal reports,
  such as focus and cursor-position replies, and arrow keys do not.
- A needs-input `Notification` that arrives after an answering keystroke,
  with no hook since, is stale and is ignored.
- A busy shell with no PTY output for 15 s becomes idle, unless it waits on
  background work. Blocked never expires.
- Per-shell dots show the shell's state. Project dots show the worst state
  of the project's live shells. The "In use" header shows the worst state
  of all live shells. An inactive shell tab is grey when idle.

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
| Contract | `src/renderer/main-tab.ts` | `MainTab` (`shell`, `files`, `diff`, `env`) and `isMainTab`, the validator for the persisted tab. |
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
| IO | `src/main/git/run-git.ts` | `runGit`: the only place that starts git for these channels. It adds the safety arguments and turns an output overflow or a timeout into a flag. It never returns partial output. |
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
   `src/renderer/components/ShellTab.tsx:387-392`).
5. A terminal font change completes with fit, repaint, and PTY resize. It
   does not recreate the PTY or replay scrollback
   (`src/renderer/terminal-font-update.ts:68-105`).

### Claude notification event

1. At app start, `runtime.ts` starts the receiver on an ephemeral
   `127.0.0.1` port. It then writes
   `~/.metaide/claude-hooks/settings-<port>.json`. The file registers
   `http` hooks for `Notification`, `Stop`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`
   and `StopFailure`, with a timeout of 1 second.
2. When a Claude shell spawns, the decorator issues a session id and a
   secret. It adds `--settings <file>` after `argv[0]`, and
   `METAIDE_HOOK_SHELL` and `METAIDE_HOOK_TOKEN` to the environment.
3. Claude Code posts each hook event. It fills the `X-Metaide-Shell` and
   `Authorization: Bearer` headers from those environment variables.
4. The receiver checks method, path, `Host`, content type, the id and
   secret, and then the body size (1 MiB at most). It answers `204` with no
   body, and only then passes the event on through the fan-out. Claude Code
   never gets a decision from the app.
5. The tracker confirms the session, marks the shell hook-confirmed and
   applies the event. It broadcasts `claude-state:changed` when the state
   changed, and emits the applied hook with its before and after state.
6. The notifier classifies the applied hook. It reads the toggle, checks
   that notifications are supported, and checks if the user is viewing the
   shell. Then it shows the notification.
7. A click on a popped-out shell's notification focuses the popout.
   Otherwise the main window is restored and focused, and
   `shell:focus-request` is sent only while the shell is still alive.

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
`Host` header that matches its port. Each Claude spawn gets its own
32-byte secret. The receiver compares it with `timingSafeEqual`. The
secret is in the PTY environment only, never in argv, in the settings file
or in logs. Processes that Claude starts inherit the secret, so they can
raise notifications and change the dot colour for that shell only. A
released session no longer authenticates. Authentication runs before the
body is read, so an unauthenticated request never has its body buffered.

The `claude-state:list` reply and the `claude-state:changed` event carry
only `projectId`, `shellIndex` and `state`. No hook message, tool input,
tool response or background task leaves the parser. The tracker never logs
PTY input.

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

Known gaps, recorded as follow-ups: the app-wide `git:status` poll still
runs a repository's `core.fsmonitor`. A repository's `filter.<name>.clean`
programs can still run during status, because git cannot turn them off
for one command. `files:read` checks containment with a plain
`startsWith` on the project path.

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
  (`REFERENCE_MATERIALS`, `BG_LAYERS` in `paletteContract.ts`).
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
- **Claude events come from hooks, not terminal output.** By default,
  Claude Code sends no bell and no notification escape sequence to an
  xterm.js terminal. A bell also does not tell which event happened. The
  hook payload gives the event type and message. Tools that read the
  terminal title spinner or the screen text break when Claude Code changes
  its interface. The status dots use the PTY only for two things: answering
  keystrokes, because no hook fires when the user answers a prompt, and
  output silence, because no hook fires when the user interrupts a turn.
- **A `Stop` with background tasks is not the end of the work.** Claude
  Code fires `Stop` when the main agent stops responding, also while
  background shells, subagents or teammates still run. The `background_tasks`
  list in the payload tells the two cases apart. Only its length is kept.
- **One state drives the dots and the notifications.** The notifier reads
  the tracker's applied hooks, not the receiver. A stream of state changes
  alone is not enough: `PermissionRequest` sets blocked, and the
  `permission_prompt` notification about 6 s later does not change the
  state but must still notify.
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
