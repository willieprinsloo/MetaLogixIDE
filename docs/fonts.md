# Fonts

MetaLogix IDE has separate font preferences for application text and terminal text. Open **Settings → General → Fonts** to change them (`src/renderer/components/settings/GeneralPanel.tsx:240-280`).

## UI font

The UI font applies to navigation, labels, controls, chat prose, and rendered Markdown prose. Source editors, source previews, paths, keyboard shortcuts, and code spans keep the built-in monospace stack (`src/renderer/styles.css:413-415`, `src/renderer/components/FilesTab.tsx:698-720`).

## Terminal font

The Terminal font applies to all integrated terminals, including split and popped-out terminals. A live change keeps the terminal process, scrollback, selection, and input, then remeasures and repaints the terminal (`src/renderer/components/ShellTab.tsx:387-392`, `src/renderer/terminal-font-update.ts:108-139`).

Terminals include **Symbols Nerd Font Mono v3.4.0** as a bundled fallback for private-use Nerd Font icons. Normal text keeps the existing system stack or your selected family. A selected font that already contains an icon takes precedence. The bundled face is restricted to private-use Unicode ranges, so it does not replace ordinary letters, numbers, or punctuation. **System default** keeps this icon fallback.

The app loads the symbols before opening or repainting a terminal, including split and popout terminals. The font and its MIT license ship inside the application; no OS installation or runtime download is required. The upstream release is https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0.

## Terminal font size

One font size applies to every integrated terminal in every window: single and split panes, and popped-out shell windows. Set it in **Settings → General → Fonts → Terminal font size**, directly below the Terminal font field (`src/renderer/components/settings/TerminalFontSizeControl.tsx`).

- Sizes are whole numbers from 9 to 28 px. The default is 14 px.
- The **−** and **+** buttons, and the Up and Down arrow keys in the field, change the size by 1 px and save it immediately. If you have typed a whole number that is not yet saved, they step from that number. At 9 or 28 px they do nothing.
- Typed text is saved only when the field loses focus or you press Enter, so the terminals do not resize while you type. A number outside the range is clamped to the nearest bound. Empty input or a fraction such as 16.5 saves nothing, and the field returns to the saved size (`src/renderer/components/settings/font-size-draft.ts`).
- In a focused terminal, ⌘= or ⌘+ makes the text 1 px larger and ⌘- makes it 1 px smaller (Ctrl on Linux and Windows). ⌘0 returns to 14 px. These keys change the same shared size, so every terminal and the Settings field follow. At 9 or 28 px the key does nothing.
- A change applies to every open terminal immediately. The terminal keeps its process and scrollback, remeasures, and sends its new columns and rows to the shell (`src/renderer/components/ShellTab.tsx:374-379`). Terminals opened later start at the saved size.
- The size is stored in the main-process settings store and survives a restart. The main process accepts only whole numbers from 9 to 28 (`src/shared/terminal-font-size.ts`).
- If a save fails, every terminal and the Settings field return to the stored size and an error toast appears.

Before this setting existed, keyboard zoom saved the size in the window's `metaide.shellFontSize` local storage. On the first launch with the setting, that value is rounded, clamped to 9-28, and saved once; if it is missing or invalid, 14 is saved. The old key is not deleted, and it is not read again after migration.

## Terminal font weight

Two settings control how heavy terminal text is. Both apply to every integrated terminal in every window. Set them in **Settings → General → Fonts**, directly below Terminal font size (`src/renderer/components/settings/TerminalFontWeightControl.tsx`).

- **Terminal font weight** sets normal text. Choose one of nine weights, from Thin (100) to Black (900). The default is Regular (400).
- **Terminal bold weight** sets bold text. The default is Bold (700). The list offers only weights heavier than the font weight.
- When you choose a font weight, bold is set to 200 heavier, up to 900, and replaces any bold weight you chose before. For example, Light (300) sets bold to Medium (500), and Bold (700) sets bold to Black (900). You can then choose a different bold weight.
- At font weight Black (900), bold is also 900 and the bold list is disabled.
- A choice is saved immediately. Choosing the value that is already selected saves nothing.
- A change applies to every open terminal immediately. The terminal keeps its process, scrollback, and columns and rows. Terminals opened later start at the saved weights.
- Many fonts have only Regular and Bold faces. For a weight the font does not have, the nearest face is used, so some choices can look the same.
- Both weights are stored in the main-process settings store and survive a restart. The main process accepts only 100, 200, … 900, and only a bold weight heavier than the font weight (`src/shared/terminal-font-weight.ts`).
- If a stored value is invalid, for example edited by hand, the font weight falls back to 400. The bold weight falls back to 700 if that is heavier than the font weight, and otherwise to the font weight + 200, up to 900. The error is logged to the developer console, and the stored value is not changed.
- If a save fails, both settings and every terminal return to the stored weights and an error toast appears.

## Choose a font

Each preference is one field: **Interface** for application text and **Terminal** for terminals (`src/renderer/components/FontControl.tsx`).

1. Open **Settings → General → Fonts**.
2. Click the **Interface** or **Terminal** field. A list opens with **System default** first, then the installed families (up to 500) drawn in their own face.
3. Allow font access if requested.
4. Type to filter the list. If the text does not match an installed family exactly, the list also offers **Use “…”** to save the typed name as an exact family. While you type, the highlight goes to the family whose name matches exactly, then to one that starts with the text, then to the first that contains it.
5. Click an entry, or use the arrow keys and Enter. The preview line under the field updates.

The field shows the saved family in that font. Enter on a field you have not changed saves nothing. Escape closes the list, restores the saved name, and keeps Settings open. Leaving the field saves what Enter would, except that a row the pointer merely passed over is ignored: only typed text or a row chosen with the arrow keys is saved.

Font discovery runs the first time a list opens in a Settings session; focusing a field opens its list. The app keeps only family names in memory and does not read font files (`src/renderer/fonts/local-font-access.ts:49-60`).

If discovery is unsupported, denied, or fails, the list says so and shows **Retry**; reopening the list also tries again. You can still type an exact installed family name. The status under the field reports availability as unknown until discovery succeeds. If successful discovery does not list a saved family, the status reports that family as unavailable and keeps the saved value. The status line is empty when there is nothing to report.

The list includes all installed families for both preferences; terminal selection does not hide proportional fonts or guess whether a family is a Nerd Font.

## Return to the system default

Choose **System default** at the top of the list, or clear the field and press Enter. This changes only that preference and restores its built-in fallback stack.

For the interface, System default is the desktop's UI font: San Francisco on macOS, Segoe UI on Windows, and the GTK/fontconfig interface font on Linux (`UI_FONT_FALLBACK` in `src/shared/font-settings.ts`).

A font name can contain printable punctuation and non-ASCII characters. The app trims outer whitespace and rejects C0 control characters and names longer than 256 Unicode code points (`src/shared/font-settings.ts:16-32`).
