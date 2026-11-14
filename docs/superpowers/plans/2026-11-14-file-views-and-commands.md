# File Views, Agent Follow & Custom-Command Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the silently-dropped custom-command save, make agent-touched files reachable (clickable Activity targets, a follow mode, better terminal path detection), and add a rendered HTML preview.

**Architecture:** Everything renderer-facing reuses two existing highways: the `openInFiles` request (`FilesTab`'s `openRelPath`/`openLine`/`onOpenRelPathConsumed` props) and the `files:peek` IPC (which already resolves absolute-or-relative paths against real filesystem roots and returns a project-relative path). HTML rendering gets a new privileged `metafile://` protocol in the main process that serves files from inside a project root, so relative CSS/images resolve naturally inside a sandboxed iframe.

**Tech Stack:** Electron (protocol.handle), React + xterm.js, TypeScript, vitest (run via `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs`).

**Spec:** This conversation's diagnosis (2026-11-14): installed app is a stale Oct-29 build (verified against its asar — no pdf/viewer files); custom-command save silently drops when the Name field is blank (`ShellTabsBar.tsx:120`); `.html` opens as source only; Activity targets are plain text; `detect-paths.ts` misses `pdf`/`jsonl`/`env` extensions and `~/` paths. User chose: dev-only verification (no dist install), auto-name fix, and all four file-view improvements.

## Global Constraints

- Test runner: `pnpm test` (full suite) or `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run <file>` for one file.
- No new npm dependencies.
- Path aliases: `@renderer/*`, `@shared/*` as used across the codebase.
- Copy/UI text follows existing sentence-case style in the components touched.
- Commits: one per task, message ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

1. Custom command with blank name + Save checked must never clobber an existing profile that already owns the derived name (dedupe suffix) — pinned in Task 1's test.
2. Activity target that is missing on disk, a directory, or inside a different project root must not open garbage — `resolveFileTarget` returns null and the click toasts — pinned in Task 2's tests.
3. Follow mode must react to PostToolUse only (`ok` present and not `false`), and rapid successive edits replace the pending open rather than queueing — pinned in Task 3's tests.
4. Terminal detection of new extensions, `~/…` paths, and trailing punctuation (`src/foo.ts:`) must link; prose must not — pinned in Task 4's tests.
5. `metafile://1/../../etc/passwd`, a directory URL, and an unknown project id must 404 — never serve outside a project root; the app CSP must list `frame-src metafile:` or the iframe silently fails — pinned in Task 5's tests.

---

### Task 1: Auto-name the custom-command save

**Files:**
- Create: `src/renderer/cli-profile-name.ts`
- Modify: `src/renderer/components/ShellTabsBar.tsx` (Run button, currently line 117–123)
- Test: `tests/unit/renderer/cli-profile-name.test.ts`

**Interfaces:**
- Produces: `deriveProfileName(cmdLine: string, existing: readonly string[]): string` — first whitespace token of `cmdLine`, last `/`-segment of that token (e.g. `/usr/local/bin/llama` → `llama`), fallback `'cmd'` for empty input; if the result is in `existing`, append `-2`, `-3`, … until unique.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { deriveProfileName } from '@renderer/cli-profile-name';

describe('deriveProfileName', () => {
  it('derives from the first token', () => {
    expect(deriveProfileName('ollama launch claude --model x', [])).toBe('ollama');
  });
  it('takes the basename of a path-like first token', () => {
    expect(deriveProfileName('/usr/local/bin/llama chat', [])).toBe('llama');
  });
  it('dedupes against existing profile names', () => {
    expect(deriveProfileName('ollama launch', ['ollama', 'ollama-2'])).toBe('ollama-3');
  });
  it('falls back to cmd for empty input', () => {
    expect(deriveProfileName('   ', [])).toBe('cmd');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run tests/unit/renderer/cli-profile-name.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `deriveProfileName` in `src/renderer/cli-profile-name.ts`**

Pure function per the Interfaces block. Split `cmdLine.trim()` on whitespace, take `[0]`, take the substring after the last `/` (and `\` for Windows-style), lowercase it, clamp length to 24 chars, then dedupe with the `-N` suffix scanning N = 2, 3, …

- [ ] **Step 4: Run test to verify it passes**

Run: same command. Expected: PASS.

- [ ] **Step 5: Wire into the Run button in `ShellTabsBar.tsx`**

Replace the `onClick` on the Run button (currently `onLaunchCustom(customName.trim(), customCmd.trim(), customSave && !!customName.trim())`) with:

```tsx
onClick={() => {
  const name = customName.trim() || (customSave
    ? deriveProfileName(customCmd.trim(), profiles.map((p) => p.name))
    : '');
  onLaunchCustom(name, customCmd.trim(), customSave);
}}
```

Add the import. No other behavior changes — `customSave &&` name-gate is gone (the silent-drop root cause).

- [ ] **Step 6: Run the full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/cli-profile-name.ts src/renderer/components/ShellTabsBar.tsx tests/unit/renderer/cli-profile-name.test.ts
git commit -m "fix(shell): save custom commands without a typed name by deriving one"
```

---

### Task 2: Clickable file targets in the Activity tab

**Files:**
- Create: `src/renderer/agent-file-targets.ts`
- Modify: `src/renderer/components/ActivityTab.tsx` (ActivityRow + Props)
- Modify: `src/renderer/App.tsx` (`case 'activity'`, currently line 662)
- Test: `tests/unit/renderer/agent-file-targets.test.ts`

**Interfaces:**
- Consumes: `files:peek` IPC — `{ projectId, relPath, maxLines }` → `{ relPath, projectId, found, … }` (already resolves absolute or project-relative paths against real roots).
- Consumes: `ActivityEntry` from `@shared/activity`.
- Produces:
  - `FILE_TOOLS: ReadonlySet<string>` = `new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'])`
  - `isFileToolActivity(entry: ActivityEntry): boolean` — `entry.kind === 'tool' && entry.tool != null && FILE_TOOLS.has(entry.tool) && !!entry.target`
  - `resolveFileTarget(projectId: number, target: string): Promise<{ relPath: string; projectId: number } | null>` — invokes `files:peek` with `maxLines: 1`; returns `{ relPath, projectId }` when `found` and the peek's `projectId` equals the requested one, else `null`.
- Produces (ActivityTab): new optional prop `onOpenTarget?: (target: string) => void`; when present and `isFileToolActivity(entry)`, the target span renders as a `<button>` (same truncate styles + `hover:underline`), click calls `onOpenTarget(entry.target)`.

- [ ] **Step 1: Write the failing test**

`tests/unit/renderer/agent-file-targets.test.ts`: unit-test `isFileToolActivity` (true for `Edit` with target; false for `Bash`, for tool without target, for `kind: 'prompt'`) and `resolveFileTarget` with a mocked `@renderer/api` (`vi.mock`) returning `found: true, relPath: 'src/a.ts', projectId: 7` → resolves `{ relPath: 'src/a.ts', projectId: 7 }`; `found: false` → `null`. Follow the api-mocking pattern already used in `tests/unit/renderer/activity-bar.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run tests/unit/renderer/agent-file-targets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/renderer/agent-file-targets.ts`**

Per the Interfaces block; both functions exported.

- [ ] **Step 4: Run test to verify it passes**

Run: same command. Expected: PASS.

- [ ] **Step 5: Make ActivityRow targets clickable**

In `ActivityTab.tsx`: extend `ActivityTab` props with `onOpenTarget?`; pass down to `ActivityRow`; in `ActivityRow`, when `onOpenTarget && isFileToolActivity(entry)` render the target `<span>` as a `<button type="button">` with `className="flex-1 min-w-0 truncate text-left text-[--text] hover:underline cursor-pointer"` and `title={target}`; keep the plain span otherwise.

- [ ] **Step 6: Wire App.tsx**

In `App.tsx`, add a helper near the other files-tab wiring:

```ts
async function openFileTarget(target: string) {
  if (!selected) return;
  const hit = await resolveFileTarget(selected.id, target);
  if (!hit) { toast('Could not resolve that file', { kind: 'info' }); return; }
  setMainTab('files');
  setOpenInFiles({ relPath: hit.relPath, line: null });
}
```

and pass `onOpenTarget={(t) => void openFileTarget(t)}` in the `case 'activity':` render. `resolveFileTarget` returning `null` for foreign-project files (its projectId mismatch rule) means those toast instead of opening the wrong project's viewer.

- [ ] **Step 7: Run full suite + typecheck; manual smoke**

Run: `pnpm test && pnpm typecheck`. Then `pnpm dev`: open a project with an agent, do an Edit in the Activity log, click it — file opens in the Files tab.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/agent-file-targets.ts src/renderer/components/ActivityTab.tsx src/renderer/App.tsx tests/unit/renderer/agent-file-targets.test.ts
git commit -m "feat(activity): click Edit/Write/Read targets to open the file in the viewer"
```

---

### Task 3: Agent file-follow mode

**Files:**
- Create: `src/renderer/hooks/useAgentFileFollow.ts`
- Modify: `src/renderer/hooks/useAgentFileFollow` consumer: `src/renderer/App.tsx`
- Modify: `src/renderer/components/ActivityTab.tsx` (header toggle)
- Test: `tests/unit/renderer/use-agent-file-follow.test.ts`

**Interfaces:**
- Consumes: Task 2's `FILE_TOOLS`; the `activity:changed` event (`{ projectId, entry: ActivityEntry }`); App's `openFileTarget(target: string): Promise<void>` (from Task 2, Step 6).
- Produces: `useAgentFileFollow(projectId: number | null, enabled: boolean, onFile: (target: string) => void): void` — subscribes `api.on('activity:changed')`; fires `onFile(entry.target)` only when `ev.projectId === projectId && entry.kind === 'tool' && entry.ok === true && entry.tool != null && FILE_TOOLS.has(entry.tool) && !!entry.target`. (`ok === true` selects PostToolUse successes; PreToolUse has `ok: undefined`.)
- Produces (App): persisted boolean state via `usePersistedState('metaide.followFiles', false, (v): v is boolean => typeof v === 'boolean')`, passed to `useAgentFileFollow(selected?.id ?? null, followFiles, (t) => void openFileTarget(t))`.
- Produces (ActivityTab): new props `followFiles: boolean; onFollowFilesChange: (v: boolean) => void`, rendered in the header as a second checkbox `Follow files` next to the existing `Follow` tail checkbox, same label styling.

- [ ] **Step 1: Write the failing test**

`tests/unit/renderer/use-agent-file-follow.test.ts` with mocked `@renderer/api` capturing the `api.on('activity:changed', cb)` callback: (a) a PostToolUse Edit entry with `ok: true` fires `onFile` with the target; (b) a PreToolUse Edit entry (`ok: undefined`) does not; (c) a failed PostToolUse (`ok: false`) does not; (d) an event for another projectId does not; (e) `enabled: false` subscribes nothing / never fires. Assert `api.on` unsubscribed on unmount.

- [ ] **Step 2: Run test to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run tests/unit/renderer/use-agent-file-follow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the hook**

Per the Interfaces block. Because each event may open a file, the hook calls `onFile` synchronously per matching event — App's `openInFiles` mechanism already replaces any pending open, so a rapid-edit burst collapses to the newest file (no queueing).

- [ ] **Step 4: Run test to verify it passes**

Run: same command. Expected: PASS.

- [ ] **Step 5: Wire App + ActivityTab toggle**

App: `const [followFiles, setFollowFiles] = usePersistedState(...)` + `useAgentFileFollow(selected?.id ?? null, followFiles, (t) => void openFileTarget(t))`; pass `followFiles`/`onFollowFilesChange={setFollowFiles}` to `ActivityTab` in `case 'activity'`. ActivityTab: add the header checkbox.

- [ ] **Step 6: Run full suite + typecheck; manual smoke**

Run: `pnpm test && pnpm typecheck`. Then `pnpm dev`: enable Follow files, have Claude edit a markdown file — the Files tab opens it live.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/hooks/useAgentFileFollow.ts src/renderer/App.tsx src/renderer/components/ActivityTab.tsx tests/unit/renderer/use-agent-file-follow.test.ts
git commit -m "feat(activity): follow mode that live-opens agent-edited files"
```

---

### Task 4: Better terminal path detection

**Files:**
- Modify: `src/shared/detect-paths.ts`
- Test: `tests/unit/shared/detect-paths.test.ts` (extend)

**Interfaces:**
- Consumes: existing `PATH_RE` structure and `detectPaths(text)`. The main process double-checks hits via `files:peek`, so false positives are safe (no preview).
- Produces: same exported API; new coverage: extensions `pdf`, `jsonl`, `env`, `plist`, `ini`, `conf`, `lock`, `avif`, `bmp`, `ico`, `tiff`, `graphql`, `proto`, `tf`, `properties`; and paths beginning `~/`.

- [ ] **Step 1: Write the failing tests (extend the existing file)**

Cases: `report-2026.pdf` in `docs/report-2026.pdf` detected with `path` and no `:line`; `~/Documents/dev/foo.ts` detected with `path === '~/Documents/dev/foo.ts'`; `.metaide/activity.jsonl` detected; `.metaide/.env` detected; existing cases still pass (read the file first; don't weaken current assertions).

- [ ] **Step 2: Run tests to verify they fail**

Run: `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run tests/unit/shared/detect-paths.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

In `detect-paths.ts`: (a) replace the hand-ordered `EXT` join with `[...EXT_LIST].sort((a, b) => b.length - a.length).join('|')` so longest-first alternation is guaranteed as the list grows; (b) add the extensions above to the list; (c) extend the leading-boundary alternation to accept `~/` — `(?:\\/|~\\/|(?<![A-Za-z0-9._\\-@/]))` — and allow `~` as a first segment character (add `~` to `PATH_SEGMENT`). No whitespace-in-path support (documented heuristic; peek double-check covers it).

- [ ] **Step 4: Run tests to verify they pass**

Run: same command. Expected: PASS (new + all existing).

- [ ] **Step 5: Run full suite + typecheck; manual smoke**

Run: `pnpm test && pnpm typecheck`. Then `pnpm dev`: in a shell print a path with `~/` and one ending `.jsonl` — hover preview appears, click opens.

- [ ] **Step 6: Commit**

```bash
git add src/shared/detect-paths.ts tests/unit/shared/detect-paths.test.ts
git commit -m "feat(terminal): detect pdf/jsonl/dotfile paths and ~ paths in terminal output"
```

---

### Task 5: Rendered HTML preview

**Files:**
- Create: `src/main/protocol/metafile.ts`
- Modify: `src/main/index.ts` (scheme registration before ready; handler in `startApp`)
- Modify: `src/renderer/index.html` (CSP meta, line 5)
- Modify: `src/renderer/components/FilesTab.tsx` (HTML_EXT set, isHtml branch, toggle button)
- Test: `tests/unit/main/protocol/metafile.test.ts`, `tests/unit/renderer/files-html-preview.test.tsx`

**Interfaces:**
- Consumes: `resolveInsideRoot` (already used by `files:read-bytes`, exported from wherever it lives today — `grep -n "resolveInsideRoot" src/main`), `MIME_BY_EXT` (currently `src/main/ipc/register.ts:54` — move it to `src/shared/mime.ts` and re-import in register.ts so both users share it; keep the export shape `Record<string, string>`).
- Produces:
  - `src/shared/mime.ts`: `export const MIME_BY_EXT: Record<string, string>` (moved verbatim).
  - `src/main/protocol/metafile.ts`:
    - `export const METAFILE_SCHEME = 'metafile';`
    - `export function registerMetafileScheme(): void` — calls `protocol.registerSchemesAsPrivileged([{ scheme: METAFILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])`. Must run before `app.whenReady()` (module import time in `src/main/index.ts`).
    - `export function handleMetafileProtocol(getProjectPath: (projectId: number) => string | null): void` — calls `protocol.handle(METAFILE_SCHEME, …)`. URL shape: `metafile://<projectId>/<relPath with URL-encoding>`. Resolves via the exported pure `resolveMetafileUrl` (below), then `statSync`: null result, missing file, or directory → `new Response('not found', { status: 404 })`; otherwise `new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { headers: { 'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream' } })` with `const buf = readFileSync(abs)` — the same Uint8Array wrap pattern as `files:read-bytes` at `register.ts:1503`. `ext` is the lowercased substring after the last `.` of the decoded relPath. Deterministic content-type via the shared mime map; no `net.fetch`.
  - `FilesTab`: `const HTML_EXT = new Set(['html', 'htm'])`; `const isHtml = HTML_EXT.has(ext)`; in `FilePreview`, when `isHtml` render `<HtmlPreview>` (new small component in `FilesTab.tsx`): `<iframe src={\`metafile://${projectId}/${encodePath(file.relPath)}\`} sandbox="" className="w-full h-full border-0 bg-white" title={file.relPath} />` where `encodePath` encodes each `/`-segment with `encodeURIComponent` joined by `/`. The existing Edit toggle stays (source view), and a `Preview`/`Source` pair of buttons mirrors the markdown isMd toolbar (when editing is on, show source; when off, show the iframe). `editable` stays `file.kind === 'text'` (html is text).
  - CSP: append ` frame-src metafile:` to the existing meta tag content.

- [ ] **Step 1: Write the failing main-process test**

`tests/unit/main/protocol/metafile.test.ts`: spin the URL-resolution logic as a pure function — extract `resolveMetafileUrl(url: string, getProjectPath: (id: number) => string | null): { abs: string } | null` inside `metafile.ts` and export it for tests. Assert: `metafile://1/src/index.html` → abs inside root 1's path; `metafile://1/../../etc/passwd` → `null`; `metafile://999/x.html` (unknown project) → `null`; `metafile://1` with empty pathname → `null`; URL-encoded segments decode.

- [ ] **Step 2: Run test to verify it fails**

Run: `ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run tests/unit/main/protocol/metafile.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the protocol module**

`src/main/protocol/metafile.ts` per the Interfaces block: `registerMetafileScheme`, `handleMetafileProtocol` (uses `resolveMetafileUrl`, `statSync`, `net.fetch(pathToFileURL(abs))`, 404 Response on null/dir/missing) and the exported pure `resolveMetafileUrl`. Move `MIME_BY_EXT` to `src/shared/mime.ts` and update `register.ts` import. In `src/main/index.ts`: import `registerMetafileScheme` and call it at module top-level (before `app.whenReady()`), and call `handleMetafileProtocol((id) => services?.projects.get(id)?.path ?? null)` inside `startApp` after services exist (check how `services` is instantiated there and follow that pattern).

- [ ] **Step 4: Run test to verify it passes**

Run: same command. Expected: PASS.

- [ ] **Step 5: CSP + FilesTab renderer changes**

`src/renderer/index.html`: add ` frame-src metafile:` to the CSP meta. `FilesTab.tsx`: `HTML_EXT` set next to `MD_EXT`; `isHtml` branch in `FilePreview` before the default return (after the `isPdf` branch): when not editing, render `<HtmlPreview projectId={projectId} relPath={file.relPath} />` inside the existing preview container (keep the toolbar row: Breadcrumbs + Edit/Done button + fullscreen); when editing, the normal text editor shows. `HtmlPreview` lives in `FilesTab.tsx` with the iframe markup from the Interfaces block.

- [ ] **Step 6: Write the renderer test**

`tests/unit/renderer/files-html-preview.test.tsx`: render the preview component (or `FilePreview` via existing test patterns in `tests/unit/renderer`) with an `openFile`-shaped fixture `{ relPath: 'index.html', kind: 'text', … }` and assert an iframe with `src` starting `metafile://` and `sandbox=""` is present; with `editing: true` assert no iframe.

- [ ] **Step 7: Run full suite + typecheck; end-to-end smoke**

Run: `pnpm test && pnpm typecheck`. Then `pnpm dev`: open a project containing an `.html` file with a relative `<link>`/`<img>` — rendered preview shows with assets; Edit/Done toggles source; a `metafile://1/../…` URL typed into the iframe dev-tools console 404s.

- [ ] **Step 8: Commit**

```bash
git add src/main/protocol/metafile.ts src/shared/mime.ts src/main/index.ts src/main/ipc/register.ts src/renderer/index.html src/renderer/components/FilesTab.tsx tests/unit/main/protocol/metafile.test.ts tests/unit/renderer/files-html-preview.test.tsx
git commit -m "feat(files): rendered HTML preview via sandboxed metafile:// protocol"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the complete suite + typecheck + lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 2: End-to-end dev smoke of all five behaviors**

Run `pnpm dev`, then in one sitting verify: (1) add a custom command with NO name and Save checked → reopens with a derived name and `saved` badge; (2) click an Edit target in Activity → file opens; (3) Follow files on → agent edit live-opens; (4) `echo ~/x.jsonl` style paths hover-preview; (5) an .html file renders, Edit shows source, Done re-renders.

- [ ] **Step 3: Final commit if anything drifted; report**

Report back: what was verified live, and remind that the installed /Applications app is still the stale Oct-29 build — installing needs a dist build + quitting the app (user chose dev-only for now).
