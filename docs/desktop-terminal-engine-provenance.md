# Desktop Ghostty assets and package verification

The desktop app defaults to xterm.js. If a view selects Ghostty (WASM), it loads a local JavaScript chunk with two embedded WASM modules. Open views keep their renderer when the setting changes. If Ghostty fails, the xterm.js standby can take over without reconnecting the shell.

## Provenance and notices

[`PROVENANCE.json`](../resources/ghostty/PROVENANCE.json) records the reviewed npm releases, lockfile integrities, local patch digests, and two WASM digests. The original `@gespenst/core` and `@gespenst/xterm` archives are `0.2.0`. Their npm attestations identify the Gespenst release workflow and source commit. They do not cover the patched JavaScript or the final app.

- The VT module matches Ghostty's commit-addressed tip asset and detached Minisign signature. It is not the stable `libghostty-vt` 1.0.1 binary.
- The callback module matches the attested Gespenst archive and reviewed release source. It is not signed by Ghostty.
- The build verifies the WASM, scoped stylesheet input and selected vendor JavaScript inputs before bundling. The core loader transform disables the vendor worker and removes the unused default WASM paths.
- The local core patch preserves the primary button state during drag motion. The patch changes JavaScript only and does not change the WASM modules.
- The core patch uses Ghostty's tracked anchor to extend a selection on Shift-click. A plain selection click clears the old range and sets a new anchor.
- The local keyboard patch supplies the unshifted ASCII letter for Ctrl+letter events. Ghostty's encoder retains control of the legacy and Kitty keyboard formats.
- Both provenance and [third-party license notices](../resources/ghostty/THIRD-PARTY-NOTICES.txt) ship inside `app.asar`, under `resources/ghostty/`.

The desktop renderer's `script-src` allows `wasm-unsafe-eval` so it can compile the bundled bytes. This applies to scripts allowed by the desktop document, not just the Ghostty module. It does not enable JavaScript eval or change the separate Fleet worker document's policy.

## Check a local distribution

1. Build from a frozen lockfile. Record the source commit and working-tree status.
2. Build the target distribution. Mount or extract it, then locate `resources/app.asar` (`Contents/Resources/app.asar` on macOS).
3. Run the check with the repo's Electron in Node mode:

   ```sh
   ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/verify-desktop-terminal-artifacts.mjs \
     '/path/to/app.asar' '/path/to/distribution.dmg'
   ```

   Save the JSON output with the source commit, platform, and architecture. The second argument is optional and records the distribution file's SHA-256. Use PowerShell's `$env:ELECTRON_RUN_AS_NODE = '1'` before the command on Windows.

The checker tests the packaged asset manifest and HTML entry references. It compares the notices, decodes the two WASMs, and reports the actual JS, CSS, WASM and ASAR hashes. It does not validate signatures, prove the entire build is reproducible, or replace the browser runtime check.

Run `pnpm test:terminal-artifacts` to exercise the checker against known-good and invalid assemblies without building a distribution.

## Runtime and release evidence

Launch the artifact-derived app with a new profile on the native target. Verify that the default loads no Ghostty code, then select Ghostty and reopen a terminal view. Observe shell input/output and only local asset loads with public egress blocked. Test fallback with the same shell. An Electron request trace does not by itself establish host-level offline operation.

Repeat the static checks for every distribution format. Record native runtime checks separately by OS and architecture. Package checks alone do not satisfy advisory review, interaction parity, the paired-device runs, or release approval.
