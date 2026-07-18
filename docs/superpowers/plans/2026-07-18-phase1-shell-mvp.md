# metaIDE Phase 1 — Shell-First MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runnable Electron desktop app that lets a user add root directories, discover projects inside them, and launch a persistent Claude Code shell per project — up to a configurable keep-alive cap — with a Slack-metaphor sidebar and a typed IPC contract.

**Architecture:** Electron main + preload + renderer split. Main owns `node-pty` PTYs, SQLite, config, filesystem. Renderer is React + Tailwind, uses xterm.js (WebGL) for the shell viewport. Preload exposes a typed API generated from a single shared IPC contract module. Every non-trivial function is TDD.

**Tech Stack:** Electron 30+, electron-vite, React 18, TypeScript strict, Tailwind CSS, xterm.js (WebGL + unicode + link + search addons), node-pty, better-sqlite3, chokidar, keytar, Vitest, Playwright, ESLint + Prettier, pnpm, Node 20 LTS.

## Global Constraints

- **Package manager**: `pnpm` (10.x). Lockfile committed.
- **Node**: v20 LTS. Enforced via `"engines"` in package.json and CI matrix.
- **Language**: TypeScript strict (`"strict": true`, `"noUncheckedIndexedAccess": true`). No `any`.
- **Electron security**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, strict CSP in renderer.
- **PTY spawn**: argv arrays only. `node-pty.spawn(command, args, opts)`. Never a shell string.
- **SQLite PRAGMAs on open**: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.
- **Migrations**: forward-only, numbered `.sql` files in `migrations/`, applied in order, tracked in `schema_version` table.
- **DB path**: `~/.metaide/metaide.db`. Backups: `~/.metaide/backups/metaide-YYYYMMDD.db`, keep 7.
- **Watched-path cap**: `settings.max_watched_paths` default 500.
- **Keep-alive cap**: `settings.keep_alive_cap` default 5.
- **Default launch cmds**: first = `["claude", "--dangerously-skip-permissions"]`, subsequent = `["claude", "--dangerously-skip-permissions", "--continue"]`.
- **IPC**: only channels declared in `src/shared/ipc-contract.ts`. Lint rule (`no-restricted-imports`) forbids raw `ipcRenderer.invoke` in renderer code.
- **Testing**: Vitest for unit (main + shared modules) and component (renderer), Playwright for E2E against packaged Electron. Every module ships with its tests.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). One task = one commit unless a task explicitly says otherwise.
- **Explicitly OUT of Phase 1**: no editor, no chat, no board, no docs tab, no metaproject integration, no auto-updater, no pop-out/Wall mode, no model switcher, no upgrade flow. See spec §14 for phase boundaries.

## File Structure

```
metaIDE/
├── docs/superpowers/{specs,plans}/          # already committed
├── package.json                              # pnpm workspace root, single package
├── pnpm-lock.yaml
├── tsconfig.json                             # base
├── tsconfig.node.json                        # for main/preload/vite config
├── tsconfig.web.json                         # for renderer
├── electron.vite.config.ts                   # electron-vite entry
├── .eslintrc.cjs                             # includes no-restricted-imports rule
├── .prettierrc
├── .github/workflows/ci.yml
├── migrations/
│   └── 0001_initial.sql                      # schema_version, roots, projects, recent_projects, shells, settings
├── src/
│   ├── shared/
│   │   ├── ipc-contract.ts                   # THE typed IPC surface
│   │   ├── types.ts                          # Project, Root, ShellRow, Settings, LaunchCmd, etc.
│   │   └── interpolate.ts                    # ${HOME} / ${PROJECT_PATH} / ${env.X} argv interpolation
│   ├── main/
│   │   ├── index.ts                          # app boot, window creation, wire-up
│   │   ├── db/
│   │   │   ├── connection.ts                 # better-sqlite3 open with PRAGMAs
│   │   │   ├── migrator.ts                   # apply numbered migrations, track schema_version
│   │   │   └── backup.ts                     # daily backup, 7-day rotation
│   │   ├── repos/
│   │   │   ├── roots-repo.ts
│   │   │   ├── projects-repo.ts
│   │   │   ├── shells-repo.ts
│   │   │   └── settings-repo.ts
│   │   ├── domain/
│   │   │   ├── discovery.ts                  # project discovery rules
│   │   │   ├── watcher.ts                    # chokidar with path cap
│   │   │   └── launch.ts                     # variant resolution + interpolation call
│   │   ├── pty/
│   │   │   ├── manager.ts                    # PtyManager: spawn, kill, resize, backpressure
│   │   │   └── keep-alive.ts                 # LRU eviction policy
│   │   └── ipc/
│   │       └── register.ts                   # binds contract → handlers
│   ├── preload/
│   │   └── index.ts                          # exposes typed API to renderer via contextBridge
│   └── renderer/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts                            # thin wrapper around window.api
│       ├── styles.css                        # Tailwind entry
│       ├── components/
│       │   ├── Sidebar.tsx                   # roots + projects + recents
│       │   ├── ProjectSwitcher.tsx           # Cmd+K fuzzy
│       │   ├── StatusBar.tsx
│       │   ├── ShellTab.tsx                  # xterm.js host
│       │   ├── FilesTab.tsx                  # read-only tree
│       │   ├── AliveShellsPanel.tsx
│       │   └── SettingsWindow.tsx
│       └── hooks/
│           ├── useProjects.ts
│           ├── useRoots.ts
│           └── useShellStream.ts
├── tests/
│   ├── unit/                                 # mirrors src/ layout
│   └── e2e/
│       ├── smoke.spec.ts
│       └── project-lifecycle.spec.ts
└── scripts/
    └── mock-claude.mjs                       # deterministic fake claude CLI for tests
```

---

## Task 1: Project Scaffold + Toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml` (empty — single-package), `.gitignore`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `electron.vite.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`, `tailwind.config.js`, `postcss.config.js`, `.eslintrc.cjs`, `.prettierrc`, `.nvmrc`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm dev` opens an Electron window rendering an empty React app; `pnpm test` runs Vitest with 0 tests passing; `pnpm typecheck` succeeds.

- [ ] **Step 1: Initialize repo scaffolding files**

Create `package.json`:
```json
{
  "name": "metaide",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0", "pnpm": ">=9.0.0" },
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "chokidar": "^3.6.0",
    "node-pty": "^1.0.0",
    "keytar": "^7.9.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "xterm": "^5.3.0",
    "xterm-addon-webgl": "^0.16.0",
    "xterm-addon-unicode11": "^0.7.0",
    "xterm-addon-web-links": "^0.10.0",
    "xterm-addon-search": "^0.14.0",
    "fuse.js": "^7.0.0"
  },
  "devDependencies": {
    "electron": "^32.0.0",
    "electron-vite": "^2.3.0",
    "electron-builder": "^24.0.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/better-sqlite3": "^7.6.0",
    "vitest": "^2.0.0",
    "@vitest/ui": "^2.0.0",
    "@playwright/test": "^1.47.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "eslint-plugin-react": "^7.35.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "prettier": "^3.3.0"
  }
}
```

Create `.gitignore`:
```
node_modules/
out/
dist/
.DS_Store
*.log
.metaide/
coverage/
playwright-report/
test-results/
```

Create `.nvmrc`: `20`

Create `tsconfig.json` (base):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@main/*": ["src/main/*"],
      "@renderer/*": ["src/renderer/*"]
    }
  }
}
```

Create `tsconfig.node.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "types": ["node", "vitest/globals"] },
  "include": ["src/main/**/*", "src/preload/**/*", "src/shared/**/*", "tests/unit/**/*"]
}
```

Create `tsconfig.web.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vitest/globals"] },
  "include": ["src/renderer/**/*", "src/shared/**/*"]
}
```

Create `electron.vite.config.ts`:
```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main:     { build: { rollupOptions: { external: ['better-sqlite3', 'node-pty', 'keytar', 'chokidar'] } } },
  preload:  {},
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer') } }
  }
});
```

Also add `@vitejs/plugin-react` to `devDependencies`.

Create `.eslintrc.cjs`:
```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/strict',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended'
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    '@typescript-eslint/no-explicit-any': 'error'
  },
  overrides: [{
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'electron', importNames: ['ipcRenderer'], message: 'Use window.api from src/renderer/api.ts — see src/shared/ipc-contract.ts' }]
      }]
    }
  }]
};
```

Create `.prettierrc`:
```json
{ "semi": true, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

Create `tailwind.config.js`:
```js
export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: { extend: {} },
  plugins: []
};
```

Create `postcss.config.js`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

Create `src/renderer/styles.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
html, body, #root { height: 100%; margin: 0; background: #0d1117; color: #e6edf3; font-family: system-ui, sans-serif; }
```

Create `src/renderer/index.html`:
```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';" />
    <title>metaIDE</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

Create `src/renderer/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
```

Create `src/renderer/App.tsx`:
```tsx
export function App() {
  return <div className="h-screen flex items-center justify-center text-xl">metaIDE — Phase 1 scaffold</div>;
}
```

Create `src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
```

Create `src/preload/index.ts`:
```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('api', {
  ping: () => 'pong',
});
```

Create `.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

- [ ] **Step 2: Install dependencies**

Run: `pnpm install`
Expected: lockfile generated, no errors. Native modules (`better-sqlite3`, `node-pty`, `keytar`) rebuild against Electron's Node ABI is handled at electron-vite dev time.

- [ ] **Step 3: Verify typecheck & lint pass on empty project**

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm lint`
Expected: exit 0.

- [ ] **Step 4: Add a Vitest smoke test to prove the harness works**

Create `tests/unit/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('runs vitest', () => {
    expect(2 + 2).toBe(4);
  });
});
```

Run: `pnpm test`
Expected: 1 test passing.

- [ ] **Step 5: Verify `pnpm dev` boots the Electron window**

Run: `pnpm dev`
Expected: Electron window opens showing "metaIDE — Phase 1 scaffold". Close it.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: scaffold Electron + React + TypeScript + Vitest + Playwright"
```

---

## Task 2: Shared Types + IPC Contract Module

**Files:**
- Create: `src/shared/types.ts`, `src/shared/ipc-contract.ts`, `tests/unit/shared/ipc-contract.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `Project`, `Root`, `ShellRow`, `SettingsRow`, `LaunchCmdTemplate`, `LaunchVariant` types.
  - `IpcContract` type — a mapped record of `channel → { request; response }`.
  - `IpcChannelName` union type.
  - `assertContract<C extends IpcContract>` compile-time helper (no runtime).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/ipc-contract.test.ts`:
```ts
import { describe, it, expectTypeOf } from 'vitest';
import type { IpcContract, IpcChannelName } from '@shared/ipc-contract';

describe('IpcContract', () => {
  it('exposes named channels with request/response shapes', () => {
    expectTypeOf<IpcChannelName>().toMatchTypeOf<string>();
  });

  it('contains projects:list channel with expected response', () => {
    type ListReq = IpcContract['projects:list']['request'];
    type ListRes = IpcContract['projects:list']['response'];
    expectTypeOf<ListReq>().toEqualTypeOf<void>();
    expectTypeOf<ListRes>().toMatchTypeOf<{ projects: unknown[] }>();
  });
});
```

Run: `pnpm test tests/unit/shared/ipc-contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Create shared types**

Create `src/shared/types.ts`:
```ts
export interface Root {
  id: number;
  path: string;
  addedAt: string; // ISO
  sortOrder: number;
}

export type LaunchVariant = 'first' | 'subsequent';

export interface LaunchCmd {
  argv: string[];
  env: Record<string, string>;
}

export interface LaunchCmdTemplate {
  first: LaunchCmd;
  subsequent: LaunchCmd;
}

export interface ProjectConfig {
  launchCmd?: Partial<LaunchCmdTemplate> | null;
  cwdOverride?: string | null;
  env?: Record<string, string>;
  model?: string | null;
  linkedMetaprojectProjectId?: string | null;
  notes?: string;
}

export interface Project {
  id: number;
  rootId: number;
  path: string;
  name: string;
  metaprojectProjectId: string | null;
  linkedChatChannelId: string | null;
  lastOpenedAt: string | null;
  pinned: boolean;
  hidden: boolean;
  firstLaunchedAt: string | null;
  config: ProjectConfig;
}

export interface ShellRow {
  projectId: number;
  shellIndex: number;
  model: string | null;
  launchArgv: string[];
  startedAt: string;
  lastActiveAt: string;
  pinned: boolean;
}

export interface AliveShellSummary extends ShellRow {
  projectName: string;
  projectPath: string;
}

export type SettingsMap = {
  'default_launch_cmd.first':      LaunchCmd;
  'default_launch_cmd.subsequent': LaunchCmd;
  'keep_alive_cap':                number;
  'scan_depth':                    number;
  'scrollback_lines':              number;
  'max_watched_paths':             number;
  'theme':                         'dark' | 'light' | 'system';
};
```

- [ ] **Step 3: Create the IPC contract**

Create `src/shared/ipc-contract.ts`:
```ts
import type { Project, Root, AliveShellSummary, SettingsMap, LaunchCmd } from './types';

export interface IpcContract {
  // roots
  'roots:list':    { request: void;                       response: { roots: Root[] } };
  'roots:add':     { request: { path: string };           response: { root: Root } };
  'roots:remove':  { request: { id: number };             response: { ok: true } };
  'roots:rescan':  { request: { id: number };             response: { discovered: number } };

  // projects
  'projects:list':          { request: void;                                    response: { projects: Project[] } };
  'projects:open':          { request: { id: number };                          response: { project: Project } };
  'projects:pin':           { request: { id: number; pinned: boolean };         response: { ok: true } };
  'projects:hide':          { request: { id: number; hidden: boolean };         response: { ok: true } };
  'projects:update-config': { request: { id: number; config: Project['config'] }; response: { project: Project } };
  'projects:recents':       { request: { limit?: number };                      response: { projects: Project[] } };

  // shells
  'shells:launch':      { request: { projectId: number };                       response: { shellIndex: number } };
  'shells:kill':        { request: { projectId: number; shellIndex: number };   response: { ok: true } };
  'shells:resize':      { request: { projectId: number; shellIndex: number; cols: number; rows: number }; response: { ok: true } };
  'shells:write':       { request: { projectId: number; shellIndex: number; data: string }; response: { ok: true } };
  'shells:alive-list':  { request: void;                                        response: { shells: AliveShellSummary[] } };
  'shells:pin':         { request: { projectId: number; shellIndex: number; pinned: boolean }; response: { ok: true } };

  // settings
  'settings:get': { request: { key: keyof SettingsMap };                        response: { value: SettingsMap[keyof SettingsMap] } };
  'settings:set': { request: { key: keyof SettingsMap; value: SettingsMap[keyof SettingsMap] }; response: { ok: true } };

  // files (read-only)
  'files:tree':  { request: { projectId: number; relPath?: string };            response: { entries: Array<{ name: string; isDir: boolean; relPath: string }> } };

  // health / dev
  'app:ping':    { request: void; response: 'pong' };
}

export type IpcChannelName = keyof IpcContract;
export type IpcRequest<C extends IpcChannelName>  = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannelName> = IpcContract[C]['response'];

// Streaming (main → renderer) event channels — separate from request/response.
export interface IpcEvents {
  'pty:data':               { projectId: number; shellIndex: number; data: string };
  'pty:exit':               { projectId: number; shellIndex: number; code: number | null };
  'pty:input-owner-changed':{ projectId: number; shellIndex: number; ownerWindowId: number };
  'projects:changed':       { kind: 'added' | 'removed' | 'updated'; projectId?: number };
  'settings:changed':       { key: keyof SettingsMap };
  'alive-shells:changed':   Record<string, never>;
}
export type IpcEventName = keyof IpcEvents;
```

- [ ] **Step 4: Run test to verify PASS**

Run: `pnpm test tests/unit/shared/ipc-contract.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/shared tests/unit/shared
git commit -m "feat(shared): add typed IPC contract and domain types"
```

---

## Task 3: SQLite Connection + Migrations

**Files:**
- Create: `src/main/db/connection.ts`, `src/main/db/migrator.ts`, `migrations/0001_initial.sql`, `tests/unit/main/db/migrator.test.ts`, `tests/unit/main/db/connection.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `openDb(path: string): Database` — returns a `better-sqlite3` Database with WAL/foreign_keys enabled.
  - `runMigrations(db: Database, migrationsDir: string): { applied: number[] }`.

- [ ] **Step 1: Write failing test for `openDb`**

Create `tests/unit/main/db/connection.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('openDb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-'));
  const dbPath = join(dir, 'test.db');

  it('enables WAL, foreign keys, and NORMAL synchronous', () => {
    const db = openDb(dbPath);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    db.close();
  });
});
```

Run: `pnpm test tests/unit/main/db/connection.test.ts` — FAIL (module missing).

- [ ] **Step 2: Implement `openDb`**

Create `src/main/db/connection.ts`:
```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}
```

Run: `pnpm test tests/unit/main/db/connection.test.ts` — PASS.

- [ ] **Step 3: Write failing test for `runMigrations`**

Create `migrations/0001_initial.sql`:
```sql
CREATE TABLE schema_version (
  version    INTEGER NOT NULL PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE roots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  added_at   DATETIME NOT NULL DEFAULT (datetime('now')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id                     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  path                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  metaproject_project_id      TEXT,
  linked_chat_channel_id      TEXT,
  last_opened_at              DATETIME,
  pinned                      INTEGER NOT NULL DEFAULT 0,
  hidden                      INTEGER NOT NULL DEFAULT 0,
  first_launched_at           DATETIME,
  config_json                 TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_projects_root ON projects(root_id);

CREATE TABLE recent_projects (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  opened_at   DATETIME NOT NULL
);

CREATE TABLE shells (
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shell_index      INTEGER NOT NULL DEFAULT 0,
  model            TEXT,
  launch_argv_json TEXT NOT NULL,
  started_at       DATETIME NOT NULL,
  last_active_at   DATETIME NOT NULL,
  pinned           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, shell_index)
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
```

Create `tests/unit/main/db/migrator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('runMigrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-mig-'));
  const migrationsDir = resolve(__dirname, '../../../../migrations');

  it('applies pending migrations and records version', () => {
    const db = openDb(join(dir, 'a.db'));
    const result = runMigrations(db, migrationsDir);
    expect(result.applied).toEqual([1]);
    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all();
    expect(versions).toEqual([{ version: 1 }]);
    db.close();
  });

  it('is idempotent — running again applies nothing', () => {
    const dbPath = join(dir, 'b.db');
    const db1 = openDb(dbPath); runMigrations(db1, migrationsDir); db1.close();
    const db2 = openDb(dbPath);
    const result = runMigrations(db2, migrationsDir);
    expect(result.applied).toEqual([]);
    db2.close();
  });

  it('creates all expected tables', () => {
    const db = openDb(join(dir, 'c.db'));
    runMigrations(db, migrationsDir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('schema_version');
    expect(names).toContain('roots');
    expect(names).toContain('projects');
    expect(names).toContain('recent_projects');
    expect(names).toContain('shells');
    expect(names).toContain('settings');
    db.close();
  });
});
```

Run: FAIL — migrator missing.

- [ ] **Step 4: Implement `runMigrations`**

Create `src/main/db/migrator.ts`:
```ts
import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationResult { applied: number[] }

export function runMigrations(db: Database, migrationsDir: string): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT (datetime('now')))`);
  const files = readdirSync(migrationsDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const appliedRows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
  const alreadyApplied = new Set(appliedRows.map(r => r.version));
  const applied: number[] = [];

  for (const file of files) {
    const version = parseInt(file.split('_')[0]!, 10);
    if (alreadyApplied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
    tx();
    applied.push(version);
  }
  return { applied };
}
```

Run: `pnpm test tests/unit/main/db/migrator.test.ts` — PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/main/db migrations tests/unit/main/db
git commit -m "feat(db): SQLite connection with WAL + forward-only migrations"
```

---

## Task 4: Daily Backup Rotation

**Files:**
- Create: `src/main/db/backup.ts`, `tests/unit/main/db/backup.test.ts`

**Interfaces:**
- Consumes: `openDb`
- Produces: `backupDb(db, backupsDir, today: Date): { created: string; pruned: string[] }`.

- [ ] **Step 1: Write failing test**

Create `tests/unit/main/db/backup.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { backupDb } from '@main/db/backup';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('backupDb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-bk-'));

  it('creates a dated backup file', async () => {
    const db = openDb(join(dir, 'main.db'));
    const backupsDir = join(dir, 'backups');
    const result = await backupDb(db, backupsDir, new Date('2026-07-18'));
    expect(result.created).toMatch(/metaide-20260718\.db$/);
    expect(readdirSync(backupsDir)).toContain('metaide-20260718.db');
    db.close();
  });

  it('prunes backups older than 7 days', async () => {
    const db = openDb(join(dir, 'main2.db'));
    const backupsDir = join(dir, 'backups2');
    // Prime 10 daily backups spanning 10 days.
    for (let i = 0; i < 10; i++) {
      const d = new Date('2026-07-01'); d.setDate(d.getDate() + i);
      await backupDb(db, backupsDir, d);
    }
    const files = readdirSync(backupsDir).sort();
    expect(files.length).toBe(7);
    expect(files[0]).toBe('metaide-20260704.db');
    expect(files[6]).toBe('metaide-20260710.db');
    db.close();
  });
});
```

Run: FAIL.

- [ ] **Step 2: Implement `backupDb`**

Create `src/main/db/backup.ts`:
```ts
import type { Database } from 'better-sqlite3';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function backupDb(db: Database, backupsDir: string, today: Date, keep = 7): Promise<{ created: string; pruned: string[] }> {
  mkdirSync(backupsDir, { recursive: true });
  const created = join(backupsDir, `metaide-${fmt(today)}.db`);
  await db.backup(created);
  const files = readdirSync(backupsDir).filter(f => /^metaide-\d{8}\.db$/.test(f)).sort();
  const pruned: string[] = [];
  while (files.length > keep) {
    const oldest = files.shift()!;
    unlinkSync(join(backupsDir, oldest));
    pruned.push(oldest);
  }
  return { created, pruned };
}
```

Run: `pnpm test tests/unit/main/db/backup.test.ts` — PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/db/backup.ts tests/unit/main/db/backup.test.ts
git commit -m "feat(db): daily backup with 7-day rotation"
```

---

## Task 5: Repositories (roots, projects, shells, settings)

**Files:**
- Create: `src/main/repos/roots-repo.ts`, `src/main/repos/projects-repo.ts`, `src/main/repos/shells-repo.ts`, `src/main/repos/settings-repo.ts`, matching test files under `tests/unit/main/repos/`.

**Interfaces:**
- Consumes: `openDb`, `runMigrations`, `Root`, `Project`, `ShellRow` types.
- Produces:
  - `RootsRepo`: `add(path)`, `list()`, `remove(id)`, `reorder(order)`.
  - `ProjectsRepo`: `upsert(rootId, path, name)`, `list()`, `get(id)`, `setPinned`, `setHidden`, `updateConfig`, `markLastOpened`, `setFirstLaunched(id, when: Date)`, `listRecents(limit)`.
  - `ShellsRepo`: `upsert(row)`, `remove(projectId, shellIndex)`, `list()`, `touch(projectId, shellIndex)`, `setPinned(...)`, `getLastModel(projectId)`.
  - `SettingsRepo`: `get<K extends keyof SettingsMap>(k)`, `set<K>(k, v)`, `getAll()`, and a `seedDefaults()` idempotent primer.

For brevity, tests exercise one representative behavior each; every method has a happy-path test and at least one edge case (unique constraint violation, missing row → null).

- [ ] **Step 1: Roots repo — write tests**

Create `tests/unit/main/repos/roots-repo.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function freshRepo(): RootsRepo {
  const dir = mkdtempSync(join(tmpdir(), 'metaide-r-'));
  const db = openDb(join(dir, 'x.db'));
  runMigrations(db, migrationsDir);
  return new RootsRepo(db);
}

describe('RootsRepo', () => {
  it('adds and lists roots', () => {
    const repo = freshRepo();
    const r = repo.add('/tmp/a');
    expect(r.id).toBeGreaterThan(0);
    expect(repo.list()).toHaveLength(1);
  });

  it('rejects duplicate paths', () => {
    const repo = freshRepo();
    repo.add('/tmp/x');
    expect(() => repo.add('/tmp/x')).toThrow();
  });

  it('removes a root by id', () => {
    const repo = freshRepo();
    const r = repo.add('/tmp/y');
    repo.remove(r.id);
    expect(repo.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implement `RootsRepo`**

Create `src/main/repos/roots-repo.ts`:
```ts
import type { Database } from 'better-sqlite3';
import type { Root } from '@shared/types';

interface Row { id: number; path: string; added_at: string; sort_order: number }

const toRoot = (r: Row): Root => ({ id: r.id, path: r.path, addedAt: r.added_at, sortOrder: r.sort_order });

export class RootsRepo {
  constructor(private readonly db: Database) {}

  add(path: string): Root {
    const info = this.db.prepare('INSERT INTO roots (path) VALUES (?)').run(path);
    const row = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(info.lastInsertRowid) as Row;
    return toRoot(row);
  }

  list(): Root[] {
    return (this.db.prepare('SELECT * FROM roots ORDER BY sort_order, added_at').all() as Row[]).map(toRoot);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM roots WHERE id = ?').run(id);
  }
}
```

Run: `pnpm test tests/unit/main/repos/roots-repo.test.ts` — PASS (3/3).

- [ ] **Step 3: Projects repo — write tests**

Create `tests/unit/main/repos/projects-repo.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function fresh() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'p-')), 'db'));
  runMigrations(db, migrationsDir);
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const root = roots.add('/tmp/root');
  return { db, projects, root };
}

describe('ProjectsRepo', () => {
  it('upserts and lists projects', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/alpha', 'alpha');
    expect(p.name).toBe('alpha');
    expect(projects.list()).toHaveLength(1);
  });

  it('upsert is idempotent by path', () => {
    const { projects, root } = fresh();
    const p1 = projects.upsert(root.id, '/tmp/root/alpha', 'alpha');
    const p2 = projects.upsert(root.id, '/tmp/root/alpha', 'alpha-renamed');
    expect(p2.id).toBe(p1.id);
    expect(p2.name).toBe('alpha-renamed');
  });

  it('setFirstLaunched persists a timestamp', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/x', 'x');
    projects.setFirstLaunched(p.id, new Date('2026-07-18T10:00:00Z'));
    expect(projects.get(p.id)!.firstLaunchedAt).toBe('2026-07-18 10:00:00');
  });

  it('updateConfig merges JSON', () => {
    const { projects, root } = fresh();
    const p = projects.upsert(root.id, '/tmp/root/y', 'y');
    const updated = projects.updateConfig(p.id, { model: 'opus' });
    expect(updated.config.model).toBe('opus');
  });

  it('listRecents returns latest N by last_opened_at', () => {
    const { projects, root } = fresh();
    const a = projects.upsert(root.id, '/tmp/root/a', 'a');
    const b = projects.upsert(root.id, '/tmp/root/b', 'b');
    projects.markLastOpened(a.id, new Date('2026-07-17'));
    projects.markLastOpened(b.id, new Date('2026-07-18'));
    const recents = projects.listRecents(10);
    expect(recents[0]!.id).toBe(b.id);
    expect(recents[1]!.id).toBe(a.id);
  });
});
```

- [ ] **Step 4: Implement `ProjectsRepo`**

Create `src/main/repos/projects-repo.ts`:
```ts
import type { Database } from 'better-sqlite3';
import type { Project, ProjectConfig } from '@shared/types';

interface Row {
  id: number; root_id: number; path: string; name: string;
  metaproject_project_id: string | null; linked_chat_channel_id: string | null;
  last_opened_at: string | null; pinned: number; hidden: number;
  first_launched_at: string | null; config_json: string;
}

function toProject(r: Row): Project {
  return {
    id: r.id, rootId: r.root_id, path: r.path, name: r.name,
    metaprojectProjectId: r.metaproject_project_id,
    linkedChatChannelId: r.linked_chat_channel_id,
    lastOpenedAt: r.last_opened_at,
    pinned: !!r.pinned, hidden: !!r.hidden,
    firstLaunchedAt: r.first_launched_at,
    config: JSON.parse(r.config_json) as ProjectConfig,
  };
}

function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export class ProjectsRepo {
  constructor(private readonly db: Database) {}

  upsert(rootId: number, path: string, name: string): Project {
    const existing = this.db.prepare('SELECT id FROM projects WHERE path = ?').get(path) as { id: number } | undefined;
    if (existing) {
      this.db.prepare('UPDATE projects SET name = ?, root_id = ? WHERE id = ?').run(name, rootId, existing.id);
      return this.get(existing.id)!;
    }
    const info = this.db.prepare('INSERT INTO projects (root_id, path, name) VALUES (?, ?, ?)').run(rootId, path, name);
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return (this.db.prepare('SELECT * FROM projects WHERE hidden = 0 ORDER BY pinned DESC, last_opened_at DESC, name').all() as Row[]).map(toProject);
  }

  setPinned(id: number, pinned: boolean): void {
    this.db.prepare('UPDATE projects SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  setHidden(id: number, hidden: boolean): void {
    this.db.prepare('UPDATE projects SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  }

  updateConfig(id: number, patch: Partial<ProjectConfig>): Project {
    const cur = this.get(id);
    if (!cur) throw new Error(`no project ${id}`);
    const merged = { ...cur.config, ...patch };
    this.db.prepare('UPDATE projects SET config_json = ? WHERE id = ?').run(JSON.stringify(merged), id);
    return this.get(id)!;
  }

  markLastOpened(id: number, when: Date): void {
    const ts = iso(when);
    this.db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(ts, id);
    this.db.prepare('INSERT OR REPLACE INTO recent_projects (project_id, opened_at) VALUES (?, ?)').run(id, ts);
  }

  setFirstLaunched(id: number, when: Date): void {
    this.db.prepare('UPDATE projects SET first_launched_at = ? WHERE id = ?').run(iso(when), id);
  }

  listRecents(limit: number): Project[] {
    return (this.db.prepare(`
      SELECT p.* FROM recent_projects r
      JOIN projects p ON p.id = r.project_id
      WHERE p.hidden = 0
      ORDER BY r.opened_at DESC
      LIMIT ?`).all(limit) as Row[]).map(toProject);
  }
}
```

Run: PASS (5/5).

- [ ] **Step 5: Shells repo — write tests + implementation**

Create `tests/unit/main/repos/shells-repo.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { ShellsRepo } from '@main/repos/shells-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 's-')), 'db'));
  runMigrations(db, migrationsDir);
  const root = new RootsRepo(db).add('/r');
  const proj = new ProjectsRepo(db).upsert(root.id, '/r/one', 'one');
  return { db, projectId: proj.id, shells: new ShellsRepo(db) };
}

describe('ShellsRepo', () => {
  it('upserts and lists', () => {
    const { shells, projectId } = seed();
    shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: ['claude'], startedAt: '2026-07-18 10:00:00', lastActiveAt: '2026-07-18 10:00:00', pinned: false });
    expect(shells.list()).toHaveLength(1);
  });

  it('touches last_active_at', () => {
    const { shells, projectId } = seed();
    shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: ['claude'], startedAt: '2026-07-18 10:00:00', lastActiveAt: '2026-07-18 10:00:00', pinned: false });
    shells.touch(projectId, 0, new Date('2026-07-18T10:05:00Z'));
    expect(shells.list()[0]!.lastActiveAt).toBe('2026-07-18 10:05:00');
  });

  it('remove deletes by composite key', () => {
    const { shells, projectId } = seed();
    shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: ['claude'], startedAt: '2026-07-18 10:00:00', lastActiveAt: '2026-07-18 10:00:00', pinned: false });
    shells.remove(projectId, 0);
    expect(shells.list()).toHaveLength(0);
  });
});
```

Create `src/main/repos/shells-repo.ts`:
```ts
import type { Database } from 'better-sqlite3';
import type { ShellRow } from '@shared/types';

interface Row {
  project_id: number; shell_index: number; model: string | null;
  launch_argv_json: string; started_at: string; last_active_at: string; pinned: number;
}
const to = (r: Row): ShellRow => ({
  projectId: r.project_id, shellIndex: r.shell_index, model: r.model,
  launchArgv: JSON.parse(r.launch_argv_json), startedAt: r.started_at,
  lastActiveAt: r.last_active_at, pinned: !!r.pinned,
});
function iso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export class ShellsRepo {
  constructor(private readonly db: Database) {}
  upsert(row: ShellRow): void {
    this.db.prepare(`
      INSERT INTO shells (project_id, shell_index, model, launch_argv_json, started_at, last_active_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, shell_index) DO UPDATE SET
        model = excluded.model, launch_argv_json = excluded.launch_argv_json,
        last_active_at = excluded.last_active_at, pinned = excluded.pinned
    `).run(row.projectId, row.shellIndex, row.model, JSON.stringify(row.launchArgv), row.startedAt, row.lastActiveAt, row.pinned ? 1 : 0);
  }
  remove(projectId: number, shellIndex: number): void {
    this.db.prepare('DELETE FROM shells WHERE project_id = ? AND shell_index = ?').run(projectId, shellIndex);
  }
  list(): ShellRow[] {
    return (this.db.prepare('SELECT * FROM shells ORDER BY last_active_at DESC').all() as Row[]).map(to);
  }
  touch(projectId: number, shellIndex: number, when: Date): void {
    this.db.prepare('UPDATE shells SET last_active_at = ? WHERE project_id = ? AND shell_index = ?').run(iso(when), projectId, shellIndex);
  }
  setPinned(projectId: number, shellIndex: number, pinned: boolean): void {
    this.db.prepare('UPDATE shells SET pinned = ? WHERE project_id = ? AND shell_index = ?').run(pinned ? 1 : 0, projectId, shellIndex);
  }
  getLastModel(projectId: number): string | null {
    const r = this.db.prepare('SELECT model FROM shells WHERE project_id = ? ORDER BY last_active_at DESC LIMIT 1').get(projectId) as { model: string | null } | undefined;
    return r?.model ?? null;
  }
}
```

Run PASS (3/3).

- [ ] **Step 6: Settings repo — tests + impl**

Create `tests/unit/main/repos/settings-repo.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo, DEFAULT_SETTINGS } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const migrationsDir = resolve(__dirname, '../../../../migrations');

function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'st-')), 'db'));
  runMigrations(db, migrationsDir);
  const repo = new SettingsRepo(db);
  repo.seedDefaults();
  return repo;
}

describe('SettingsRepo', () => {
  it('seeds all defaults', () => {
    const repo = seed();
    expect(repo.get('keep_alive_cap')).toBe(DEFAULT_SETTINGS.keep_alive_cap);
    expect(repo.get('default_launch_cmd.first')).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first']);
  });
  it('set updates and get reflects', () => {
    const repo = seed();
    repo.set('keep_alive_cap', 10);
    expect(repo.get('keep_alive_cap')).toBe(10);
  });
  it('seedDefaults is idempotent', () => {
    const repo = seed();
    repo.set('keep_alive_cap', 3);
    repo.seedDefaults();
    expect(repo.get('keep_alive_cap')).toBe(3);
  });
});
```

Create `src/main/repos/settings-repo.ts`:
```ts
import type { Database } from 'better-sqlite3';
import type { SettingsMap } from '@shared/types';

export const DEFAULT_SETTINGS: SettingsMap = {
  'default_launch_cmd.first':      { argv: ['claude', '--dangerously-skip-permissions'], env: {} },
  'default_launch_cmd.subsequent': { argv: ['claude', '--dangerously-skip-permissions', '--continue'], env: {} },
  'keep_alive_cap':                5,
  'scan_depth':                    1,
  'scrollback_lines':              10000,
  'max_watched_paths':             500,
  'theme':                         'dark',
};

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  seedDefaults(): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      ins.run(k, JSON.stringify(v));
    }
  }

  get<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return DEFAULT_SETTINGS[key];
    return JSON.parse(row.value) as SettingsMap[K];
  }

  set<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
}
```

Run PASS (3/3).

- [ ] **Step 7: Commit all repos together**

```bash
git add src/main/repos tests/unit/main/repos
git commit -m "feat(main): roots, projects, shells, settings repositories with tests"
```

---

## Task 6: Launch Command Interpolation

**Files:**
- Create: `src/shared/interpolate.ts`, `tests/unit/shared/interpolate.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `interpolateArgv(argv: string[], ctx: InterpolationContext): string[]` and `interpolateEnv(env: Record<string,string>, ctx): Record<string,string>`. Tokens: `${HOME}`, `${PROJECT_PATH}`, `${PROJECT_NAME}`, `${env.NAME}`. Per-element substitution — cannot introduce new argv elements.

- [ ] **Step 1: Write failing tests**

Create `tests/unit/shared/interpolate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { interpolateArgv, interpolateEnv } from '@shared/interpolate';

const ctx = { home: '/Users/w', projectPath: '/r/p', projectName: 'p', env: { FOO: 'bar' } };

describe('interpolateArgv', () => {
  it('substitutes HOME, PROJECT_PATH, PROJECT_NAME', () => {
    expect(interpolateArgv(['${HOME}/x', '--path=${PROJECT_PATH}', '--name=${PROJECT_NAME}'], ctx))
      .toEqual(['/Users/w/x', '--path=/r/p', '--name=p']);
  });
  it('substitutes ${env.X}', () => {
    expect(interpolateArgv(['--foo=${env.FOO}'], ctx)).toEqual(['--foo=bar']);
  });
  it('missing env var interpolates to empty string', () => {
    expect(interpolateArgv(['${env.MISSING}'], ctx)).toEqual(['']);
  });
  it('never splits into new argv elements even if substitution contains spaces', () => {
    const c = { ...ctx, env: { PATH: 'a b c' } };
    expect(interpolateArgv(['${env.PATH}'], c)).toEqual(['a b c']);
    expect(interpolateArgv(['${env.PATH}'], c)).toHaveLength(1);
  });
});

describe('interpolateEnv', () => {
  it('substitutes recursively but keeps keys intact', () => {
    expect(interpolateEnv({ CFG: '${HOME}/.cfg' }, ctx)).toEqual({ CFG: '/Users/w/.cfg' });
  });
});
```

Run: FAIL.

- [ ] **Step 2: Implement**

Create `src/shared/interpolate.ts`:
```ts
export interface InterpolationContext {
  home: string;
  projectPath: string;
  projectName: string;
  env: Record<string, string>;
}

const TOKEN = /\$\{(HOME|PROJECT_PATH|PROJECT_NAME|env\.[A-Za-z_][A-Za-z0-9_]*)\}/g;

function replace(input: string, ctx: InterpolationContext): string {
  return input.replace(TOKEN, (_m, key: string) => {
    if (key === 'HOME') return ctx.home;
    if (key === 'PROJECT_PATH') return ctx.projectPath;
    if (key === 'PROJECT_NAME') return ctx.projectName;
    if (key.startsWith('env.')) return ctx.env[key.slice(4)] ?? '';
    return '';
  });
}

export function interpolateArgv(argv: string[], ctx: InterpolationContext): string[] {
  return argv.map(a => replace(a, ctx));
}

export function interpolateEnv(env: Record<string, string>, ctx: InterpolationContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = replace(v, ctx);
  return out;
}
```

Run PASS (5/5).

- [ ] **Step 3: Commit**

```bash
git add src/shared/interpolate.ts tests/unit/shared/interpolate.test.ts
git commit -m "feat(shared): argv interpolation for launch templates"
```

---

## Task 7: Project Discovery

**Files:**
- Create: `src/main/domain/discovery.ts`, `tests/unit/main/domain/discovery.test.ts`

**Interfaces:**
- Consumes: nothing (filesystem)
- Produces: `discoverProjects(rootPath, scanDepth): Array<{ path: string; name: string; markers: string[] }>` — a folder is a project if it contains `.git`, `.metaproject.yaml`, `package.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`.

- [ ] **Step 1: Write failing tests**

Create `tests/unit/main/domain/discovery.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { discoverProjects } from '@main/domain/discovery';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupRoot() {
  const root = mkdtempSync(join(tmpdir(), 'disc-'));
  mkdirSync(join(root, 'proj-git'));      mkdirSync(join(root, 'proj-git/.git'));
  mkdirSync(join(root, 'proj-node'));     writeFileSync(join(root, 'proj-node/package.json'), '{}');
  mkdirSync(join(root, 'proj-py'));       writeFileSync(join(root, 'proj-py/pyproject.toml'), '');
  mkdirSync(join(root, 'proj-go'));       writeFileSync(join(root, 'proj-go/go.mod'), '');
  mkdirSync(join(root, 'proj-rust'));     writeFileSync(join(root, 'proj-rust/Cargo.toml'), '');
  mkdirSync(join(root, 'proj-mp'));       writeFileSync(join(root, 'proj-mp/.metaproject.yaml'), '');
  mkdirSync(join(root, 'not-a-project')); // no markers
  return root;
}

describe('discoverProjects', () => {
  it('identifies projects by any marker', () => {
    const root = setupRoot();
    const projects = discoverProjects(root, 1);
    const names = projects.map(p => p.name).sort();
    expect(names).toEqual(['proj-git', 'proj-go', 'proj-mp', 'proj-node', 'proj-py', 'proj-rust']);
  });

  it('ignores folders without markers', () => {
    const root = setupRoot();
    const projects = discoverProjects(root, 1);
    expect(projects.map(p => p.name)).not.toContain('not-a-project');
  });

  it('reports which markers matched', () => {
    const root = setupRoot();
    const p = discoverProjects(root, 1).find(x => x.name === 'proj-git')!;
    expect(p.markers).toContain('.git');
  });

  it('depth=2 recurses one extra level', () => {
    const root = mkdtempSync(join(tmpdir(), 'disc2-'));
    mkdirSync(join(root, 'monorepo'));
    mkdirSync(join(root, 'monorepo/packages'));
    mkdirSync(join(root, 'monorepo/packages/a'));
    writeFileSync(join(root, 'monorepo/packages/a/package.json'), '{}');
    const projects = discoverProjects(root, 2);
    expect(projects.map(p => p.name)).toContain('a');
  });
});
```

- [ ] **Step 2: Implement**

Create `src/main/domain/discovery.ts`:
```ts
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const MARKERS = ['.git', '.metaproject.yaml', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

function matchedMarkers(dir: string): string[] {
  return MARKERS.filter(m => existsSync(join(dir, m)));
}

export interface DiscoveredProject { path: string; name: string; markers: string[]; }

export function discoverProjects(rootPath: string, scanDepth: number): DiscoveredProject[] {
  const results: DiscoveredProject[] = [];
  function walk(dir: string, depth: number) {
    if (depth > scanDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch { continue; }
      const markers = matchedMarkers(full);
      if (markers.length > 0) {
        results.push({ path: full, name: basename(full), markers });
      } else {
        walk(full, depth + 1);
      }
    }
  }
  walk(rootPath, 1);
  return results;
}
```

Run PASS (4/4).

- [ ] **Step 3: Commit**

```bash
git add src/main/domain/discovery.ts tests/unit/main/domain/discovery.test.ts
git commit -m "feat(main): project discovery by marker files"
```

---

## Task 8: Filesystem Watcher with Path Cap

**Files:**
- Create: `src/main/domain/watcher.ts`, `tests/unit/main/domain/watcher.test.ts`

**Interfaces:**
- Consumes: `chokidar`
- Produces: `RootWatcher` class with methods `watch(rootPath)`, `unwatch(rootPath)`, `getWatchedCount()`, `getCap()`, `setCap(n)`. Emits `'add'` / `'remove'` events with directory paths.

- [ ] **Step 1: Write tests**

Create `tests/unit/main/domain/watcher.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { RootWatcher } from '@main/domain/watcher';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeChokidar() {
  const listeners: Record<string, Array<(p: string) => void>> = {};
  const closed: string[] = [];
  return {
    watch: vi.fn((_paths: string[]) => ({
      on(evt: string, cb: (p: string) => void) { (listeners[evt] ??= []).push(cb); return this; },
      close: vi.fn(async () => { closed.push('w'); }),
    })),
    listeners,
    closed,
  };
}

describe('RootWatcher', () => {
  it('respects cap and skips new roots beyond it', async () => {
    const w = new RootWatcher({ cap: 2 });
    const r1 = mkdtempSync(join(tmpdir(), 'w1-'));
    const r2 = mkdtempSync(join(tmpdir(), 'w2-'));
    const r3 = mkdtempSync(join(tmpdir(), 'w3-'));
    mkdirSync(join(r1, 'a')); mkdirSync(join(r2, 'a')); mkdirSync(join(r3, 'a'));
    expect(w.watch(r1)).toBe(true);
    expect(w.watch(r2)).toBe(true);
    expect(w.watch(r3)).toBe(false); // cap hit
    expect(w.getWatchedCount()).toBeGreaterThan(0);
    await w.closeAll();
  });
});
```

- [ ] **Step 2: Implement**

Create `src/main/domain/watcher.ts`:
```ts
import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';

interface Options { cap: number }

export class RootWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private cap: number;
  constructor(opts: Options) { super(); this.cap = opts.cap; }

  getCap(): number { return this.cap; }
  setCap(n: number): void { this.cap = n; }
  getWatchedCount(): number { return this.watchers.size; }

  watch(rootPath: string): boolean {
    if (this.watchers.has(rootPath)) return true;
    if (this.watchers.size >= this.cap) return false;
    const w = chokidar.watch(rootPath, { depth: 1, ignoreInitial: true, persistent: true });
    w.on('addDir',    (p: string) => this.emit('add', p));
    w.on('unlinkDir', (p: string) => this.emit('remove', p));
    this.watchers.set(rootPath, w);
    return true;
  }

  async unwatch(rootPath: string): Promise<void> {
    const w = this.watchers.get(rootPath);
    if (!w) return;
    await w.close();
    this.watchers.delete(rootPath);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.watchers.values()].map(w => w.close()));
    this.watchers.clear();
  }
}
```

Run PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/domain/watcher.ts tests/unit/main/domain/watcher.test.ts
git commit -m "feat(main): root filesystem watcher with cap"
```

---

## Task 9: Launch Resolver

**Files:**
- Create: `src/main/domain/launch.ts`, `tests/unit/main/domain/launch.test.ts`

**Interfaces:**
- Consumes: `SettingsRepo`, `ProjectsRepo`, `interpolateArgv`, `interpolateEnv`.
- Produces: `resolveLaunch(project, settingsRepo, homeDir): { argv: string[]; env: Record<string,string>; cwd: string; variant: 'first' | 'subsequent' }`.

- [ ] **Step 1: Tests**

Create `tests/unit/main/domain/launch.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { resolveLaunch } from '@main/domain/launch';
import type { Project } from '@shared/types';
import { DEFAULT_SETTINGS } from '@main/repos/settings-repo';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, rootId: 1, path: '/r/x', name: 'x',
    metaprojectProjectId: null, linkedChatChannelId: null,
    lastOpenedAt: null, pinned: false, hidden: false,
    firstLaunchedAt: null, config: {}, ...overrides,
  };
}

const fakeSettings = { get: (k: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[k] } as any;

describe('resolveLaunch', () => {
  it('uses first variant when project has never launched', () => {
    const r = resolveLaunch(project(), fakeSettings, '/home/u');
    expect(r.variant).toBe('first');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.first'].argv);
    expect(r.cwd).toBe('/r/x');
  });

  it('uses subsequent variant once first_launched_at is set', () => {
    const r = resolveLaunch(project({ firstLaunchedAt: '2026-07-18 10:00:00' }), fakeSettings, '/home/u');
    expect(r.variant).toBe('subsequent');
    expect(r.argv).toEqual(DEFAULT_SETTINGS['default_launch_cmd.subsequent'].argv);
  });

  it('project override wins over global default', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['echo', 'hello'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u');
    expect(r.argv).toEqual(['echo', 'hello']);
  });

  it('interpolates PROJECT_PATH', () => {
    const p = project({ config: { launchCmd: { first: { argv: ['run', '${PROJECT_PATH}'], env: {} } } } });
    const r = resolveLaunch(p, fakeSettings, '/home/u');
    expect(r.argv).toEqual(['run', '/r/x']);
  });

  it('respects cwd_override', () => {
    const p = project({ config: { cwdOverride: '/r/x/sub' } });
    const r = resolveLaunch(p, fakeSettings, '/home/u');
    expect(r.cwd).toBe('/r/x/sub');
  });
});
```

- [ ] **Step 2: Implement**

Create `src/main/domain/launch.ts`:
```ts
import type { Project, LaunchCmd, LaunchVariant } from '@shared/types';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { interpolateArgv, interpolateEnv } from '@shared/interpolate';
import { basename } from 'node:path';

export interface ResolvedLaunch { argv: string[]; env: Record<string, string>; cwd: string; variant: LaunchVariant }

export function resolveLaunch(project: Project, settings: SettingsRepo, homeDir: string): ResolvedLaunch {
  const variant: LaunchVariant = project.firstLaunchedAt ? 'subsequent' : 'first';
  const template: LaunchCmd =
    project.config.launchCmd?.[variant] ??
    settings.get(variant === 'first' ? 'default_launch_cmd.first' : 'default_launch_cmd.subsequent');

  const ctx = {
    home: homeDir,
    projectPath: project.path,
    projectName: basename(project.path),
    env: { ...(project.config.env ?? {}), ...(template.env ?? {}) },
  };

  return {
    argv: interpolateArgv(template.argv, ctx),
    env: interpolateEnv({ ...(template.env ?? {}), ...(project.config.env ?? {}) }, ctx),
    cwd: project.config.cwdOverride ?? project.path,
    variant,
  };
}
```

Run PASS (5/5).

- [ ] **Step 3: Commit**

```bash
git add src/main/domain/launch.ts tests/unit/main/domain/launch.test.ts
git commit -m "feat(main): launch command resolver with variant + override + interpolation"
```

---

## Task 10: PTY Manager

**Files:**
- Create: `src/main/pty/manager.ts`, `tests/unit/main/pty/manager.test.ts`, `scripts/mock-claude.mjs`

**Interfaces:**
- Consumes: `node-pty`, `ResolvedLaunch`.
- Produces: `PtyManager` with:
  - `spawn(projectId, shellIndex, launch): Promise<{ pid: number }>`
  - `write(projectId, shellIndex, data)`
  - `resize(projectId, shellIndex, cols, rows)`
  - `kill(projectId, shellIndex)`
  - `isAlive(projectId, shellIndex): boolean`
  - `list(): Array<{ projectId, shellIndex, pid, cols, rows, startedAt }>`
  - Events: `'data'`, `'exit'`.

- [ ] **Step 1: Create the mock claude script (used in tests + E2E)**

Create `scripts/mock-claude.mjs`:
```js
#!/usr/bin/env node
// Deterministic fake `claude` CLI used in tests. Echoes stdin lines and
// responds to /model. On --continue, prints a "resumed" banner.
const args = process.argv.slice(2);
const isContinue = args.includes('--continue');
process.stdout.write(isContinue ? 'mock-claude resumed\n> ' : 'mock-claude ready\n> ');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const line = String(chunk).trim();
  if (line.startsWith('/model ')) {
    process.stdout.write(`model set to ${line.slice(7)}\n> `);
  } else if (line === 'exit' || line === '/quit') {
    process.exit(0);
  } else {
    process.stdout.write(`echo: ${line}\n> `);
  }
});
```

Add to package.json scripts: `"mock-claude": "node scripts/mock-claude.mjs"`.

Make it executable: `chmod +x scripts/mock-claude.mjs`

- [ ] **Step 2: Tests**

Create `tests/unit/main/pty/manager.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PtyManager } from '@main/pty/manager';
import { resolve } from 'node:path';

const MOCK = resolve(__dirname, '../../../../scripts/mock-claude.mjs');

function launch(extraArgs: string[] = []) {
  return { argv: ['node', MOCK, ...extraArgs], env: {}, cwd: process.cwd(), variant: 'first' as const };
}

async function untilData(mgr: PtyManager, projectId: number, match: string, timeoutMs = 3000): Promise<string> {
  let buf = '';
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`timeout waiting for ${match}; got ${buf}`)), timeoutMs);
    mgr.on('data', ({ projectId: pid, data }) => {
      if (pid !== projectId) return;
      buf += data;
      if (buf.includes(match)) { clearTimeout(timer); resolveP(buf); }
    });
  });
}

describe('PtyManager', () => {
  it('spawns a PTY and receives initial banner', async () => {
    const mgr = new PtyManager();
    const p = untilData(mgr, 1, 'mock-claude ready');
    await mgr.spawn(1, 0, launch());
    await p;
    expect(mgr.isAlive(1, 0)).toBe(true);
    await mgr.kill(1, 0);
  });

  it('write echoes back through data event', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(2, 0, launch());
    // Wait for initial banner.
    await untilData(mgr, 2, '> ');
    const p = untilData(mgr, 2, 'echo: hello');
    mgr.write(2, 0, 'hello\n');
    await p;
    await mgr.kill(2, 0);
  });

  it('kill removes the entry from list', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(3, 0, launch());
    await mgr.kill(3, 0);
    expect(mgr.list().find(s => s.projectId === 3)).toBeUndefined();
  });

  it('rejects duplicate spawn for same (project, index)', async () => {
    const mgr = new PtyManager();
    await mgr.spawn(4, 0, launch());
    await expect(mgr.spawn(4, 0, launch())).rejects.toThrow();
    await mgr.kill(4, 0);
  });
});
```

- [ ] **Step 3: Implement**

Create `src/main/pty/manager.ts`:
```ts
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import type { ResolvedLaunch } from '@main/domain/launch';

interface Entry {
  projectId: number; shellIndex: number;
  pty: IPty; pid: number;
  cols: number; rows: number;
  startedAt: number;
}

const key = (p: number, s: number) => `${p}:${s}`;

export class PtyManager extends EventEmitter {
  private entries = new Map<string, Entry>();

  async spawn(projectId: number, shellIndex: number, launch: ResolvedLaunch, cols = 100, rows = 30): Promise<{ pid: number }> {
    const k = key(projectId, shellIndex);
    if (this.entries.has(k)) throw new Error(`already spawned: ${k}`);
    const [command, ...args] = launch.argv;
    if (!command) throw new Error('empty argv');
    const pty = ptySpawn(command, args, {
      name: 'xterm-256color',
      cols, rows,
      cwd: launch.cwd,
      env: { ...process.env, ...launch.env } as { [k: string]: string },
    });
    const entry: Entry = { projectId, shellIndex, pty, pid: pty.pid, cols, rows, startedAt: Date.now() };
    this.entries.set(k, entry);
    pty.onData((data: string) => this.emit('data', { projectId, shellIndex, data }));
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.entries.delete(k);
      this.emit('exit', { projectId, shellIndex, code: exitCode });
    });
    return { pid: pty.pid };
  }

  write(projectId: number, shellIndex: number, data: string): void {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.write(data);
  }

  resize(projectId: number, shellIndex: number, cols: number, rows: number): void {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.resize(cols, rows);
    e.cols = cols; e.rows = rows;
  }

  async kill(projectId: number, shellIndex: number): Promise<void> {
    const e = this.entries.get(key(projectId, shellIndex));
    if (!e) return;
    e.pty.kill();
    this.entries.delete(key(projectId, shellIndex));
  }

  isAlive(projectId: number, shellIndex: number): boolean {
    return this.entries.has(key(projectId, shellIndex));
  }

  list(): Array<{ projectId: number; shellIndex: number; pid: number; cols: number; rows: number; startedAt: number }> {
    return [...this.entries.values()].map(e => ({
      projectId: e.projectId, shellIndex: e.shellIndex, pid: e.pid, cols: e.cols, rows: e.rows, startedAt: e.startedAt,
    }));
  }
}
```

Run PASS (4/4). Note: tests require `node-pty` native module built for the local Node ABI — `pnpm install` triggers this automatically.

- [ ] **Step 4: Commit**

```bash
git add scripts/mock-claude.mjs src/main/pty/manager.ts tests/unit/main/pty/manager.test.ts
git commit -m "feat(pty): PtyManager with spawn/write/resize/kill + tests via mock-claude"
```

---

## Task 11: Keep-Alive Eviction Policy

**Files:**
- Create: `src/main/pty/keep-alive.ts`, `tests/unit/main/pty/keep-alive.test.ts`

**Interfaces:**
- Consumes: nothing directly (pure function over shell metadata).
- Produces: `chooseEvictee(shells, cap, justSpawnedProjectId, now): { evictee: {projectId, shellIndex} | null; reason: 'lru' | 'lru-busy' | 'all-pinned' | 'ok' }`. Busy = `lastActiveAt` within 60s.

- [ ] **Step 1: Tests**

Create `tests/unit/main/pty/keep-alive.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { chooseEvictee } from '@main/pty/keep-alive';
import type { ShellRow } from '@shared/types';

function s(projectId: number, lastActiveAt: string, pinned = false): ShellRow {
  return { projectId, shellIndex: 0, model: null, launchArgv: [], startedAt: lastActiveAt, lastActiveAt, pinned };
}

describe('chooseEvictee', () => {
  const now = new Date('2026-07-18T12:00:00Z');

  it('returns ok when under cap', () => {
    expect(chooseEvictee([s(1, '2026-07-18 11:00:00')], 5, 2, now).reason).toBe('ok');
  });

  it('picks LRU when at cap', () => {
    const shells = [s(1, '2026-07-18 11:00:00'), s(2, '2026-07-18 11:30:00'), s(3, '2026-07-18 11:55:00')];
    const r = chooseEvictee(shells, 3, 4, now);
    expect(r.reason).toBe('lru');
    expect(r.evictee?.projectId).toBe(1);
  });

  it('marks LRU as busy if activity within 60s', () => {
    const shells = [s(1, '2026-07-18 11:59:30'), s(2, '2026-07-18 11:00:00')];
    // shells sorted by last_active_at: proj 2 is older → LRU is 2, not busy → 'lru'.
    // Now flip: proj 1 is older.
    const shells2 = [s(1, '2026-07-18 11:59:30'), s(2, '2026-07-18 11:59:45')];
    const r = chooseEvictee(shells2, 2, 3, now);
    expect(r.reason).toBe('lru-busy'); // both busy; oldest still LRU but busy
  });

  it('never evicts the just-spawned project', () => {
    const shells = [s(4, '2026-07-18 11:00:00'), s(5, '2026-07-18 11:30:00')];
    const r = chooseEvictee(shells, 2, 4, now);
    expect(r.evictee?.projectId).not.toBe(4);
  });

  it('returns all-pinned when every candidate is pinned', () => {
    const shells = [s(1, '2026-07-18 11:00:00', true), s(2, '2026-07-18 11:30:00', true)];
    const r = chooseEvictee(shells, 2, 3, now);
    expect(r.reason).toBe('all-pinned');
    expect(r.evictee).toBeNull();
  });
});
```

- [ ] **Step 2: Implement**

Create `src/main/pty/keep-alive.ts`:
```ts
import type { ShellRow } from '@shared/types';

export type EvictReason = 'ok' | 'lru' | 'lru-busy' | 'all-pinned';

export interface EvictionDecision {
  evictee: { projectId: number; shellIndex: number } | null;
  reason: EvictReason;
}

function toMs(iso: string): number {
  // stored as 'YYYY-MM-DD HH:mm:ss' UTC
  return new Date(iso.replace(' ', 'T') + 'Z').getTime();
}

export function chooseEvictee(shells: ShellRow[], cap: number, justSpawnedProjectId: number, now: Date): EvictionDecision {
  if (shells.length < cap) return { evictee: null, reason: 'ok' };
  const candidates = shells
    .filter(s => !s.pinned && s.projectId !== justSpawnedProjectId)
    .sort((a, b) => toMs(a.lastActiveAt) - toMs(b.lastActiveAt));
  if (candidates.length === 0) return { evictee: null, reason: 'all-pinned' };
  const oldest = candidates[0]!;
  const ageMs = now.getTime() - toMs(oldest.lastActiveAt);
  const reason: EvictReason = ageMs < 60_000 ? 'lru-busy' : 'lru';
  return { evictee: { projectId: oldest.projectId, shellIndex: oldest.shellIndex }, reason };
}
```

Run PASS (5/5).

- [ ] **Step 3: Commit**

```bash
git add src/main/pty/keep-alive.ts tests/unit/main/pty/keep-alive.test.ts
git commit -m "feat(pty): LRU keep-alive eviction with busy detection"
```

---

## Task 12: IPC Handler Registration

**Files:**
- Create: `src/main/ipc/register.ts`, `src/main/services.ts` (wires repos + PTY manager into a service container), `tests/unit/main/ipc/register.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `Services` class holding `db`, `roots`, `projects`, `shells`, `settings`, `ptyManager`, `watcher`, `homeDir`.
  - `registerIpc(ipcMain, services, sendEvent)` — binds every channel in `IpcContract` to a handler. `sendEvent` is a `(channel, payload) => void` used for streaming events. All handlers use `ipcMain.handle` (invoke/response) except events, which are `webContents.send`.

- [ ] **Step 1: Write test**

Create `tests/unit/main/ipc/register.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '@main/ipc/register';

function fakeIpcMain(): IpcMain & { handlers: Map<string, (e: unknown, req: unknown) => Promise<unknown>> } {
  const handlers = new Map<string, (e: unknown, req: unknown) => Promise<unknown>>();
  return {
    handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    handlers,
  } as unknown as ReturnType<typeof fakeIpcMain>;
}

describe('registerIpc', () => {
  it('registers every declared channel', async () => {
    const ipc = fakeIpcMain();
    const services = {} as any; // handlers are not invoked in this test
    registerIpc(ipc as any, services, () => {});
    const expected = [
      'roots:list', 'roots:add', 'roots:remove', 'roots:rescan',
      'projects:list', 'projects:open', 'projects:pin', 'projects:hide',
      'projects:update-config', 'projects:recents',
      'shells:launch', 'shells:kill', 'shells:resize', 'shells:write',
      'shells:alive-list', 'shells:pin',
      'settings:get', 'settings:set',
      'files:tree', 'app:ping',
    ];
    for (const c of expected) expect(ipc.handlers.has(c)).toBe(true);
  });
});
```

- [ ] **Step 2: Build the services container**

Create `src/main/services.ts`:
```ts
import type { Database } from 'better-sqlite3';
import { openDb } from './db/connection';
import { runMigrations } from './db/migrator';
import { RootsRepo } from './repos/roots-repo';
import { ProjectsRepo } from './repos/projects-repo';
import { ShellsRepo } from './repos/shells-repo';
import { SettingsRepo } from './repos/settings-repo';
import { PtyManager } from './pty/manager';
import { RootWatcher } from './domain/watcher';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Services {
  db: Database;
  roots: RootsRepo;
  projects: ProjectsRepo;
  shells: ShellsRepo;
  settings: SettingsRepo;
  ptyManager: PtyManager;
  watcher: RootWatcher;
  homeDir: string;
  migrationsDir: string;
}

export function buildServices(opts: { dbPath?: string; migrationsDir?: string } = {}): Services {
  const home = homedir();
  const dbPath = opts.dbPath ?? join(home, '.metaide', 'metaide.db');
  const migrationsDir = opts.migrationsDir ?? resolve(process.cwd(), 'migrations');
  const db = openDb(dbPath);
  runMigrations(db, migrationsDir);
  const settings = new SettingsRepo(db);
  settings.seedDefaults();
  const roots = new RootsRepo(db);
  const projects = new ProjectsRepo(db);
  const shells = new ShellsRepo(db);
  const ptyManager = new PtyManager();
  const watcher = new RootWatcher({ cap: settings.get('max_watched_paths') });
  return { db, roots, projects, shells, settings, ptyManager, watcher, homeDir: home, migrationsDir };
}
```

- [ ] **Step 3: Implement IPC registration**

Create `src/main/ipc/register.ts`:
```ts
import type { IpcMain } from 'electron';
import type { Services } from '@main/services';
import type { IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '@shared/ipc-contract';
import { discoverProjects } from '@main/domain/discovery';
import { resolveLaunch } from '@main/domain/launch';
import { chooseEvictee } from '@main/pty/keep-alive';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

type Handler<C extends IpcChannelName> = (services: Services, req: IpcRequest<C>) => Promise<IpcResponse<C>>;
type SendEvent = <E extends IpcEventName>(channel: E, payload: IpcEvents[E]) => void;

const handlers: { [C in IpcChannelName]: Handler<C> } = {
  'app:ping': async () => 'pong',

  'roots:list':   async (s) => ({ roots: s.roots.list() }),
  'roots:add':    async (s, { path }) => {
    const root = s.roots.add(path);
    s.watcher.watch(path);
    for (const disc of discoverProjects(path, s.settings.get('scan_depth'))) {
      s.projects.upsert(root.id, disc.path, disc.name);
    }
    return { root };
  },
  'roots:remove': async (s, { id }) => { s.roots.remove(id); return { ok: true } as const; },
  'roots:rescan': async (s, { id }) => {
    const root = s.roots.list().find(r => r.id === id);
    if (!root) return { discovered: 0 };
    let n = 0;
    for (const disc of discoverProjects(root.path, s.settings.get('scan_depth'))) {
      s.projects.upsert(root.id, disc.path, disc.name); n++;
    }
    return { discovered: n };
  },

  'projects:list':    async (s) => ({ projects: s.projects.list() }),
  'projects:open':    async (s, { id }) => {
    const p = s.projects.get(id);
    if (!p) throw new Error(`no project ${id}`);
    s.projects.markLastOpened(id, new Date());
    return { project: s.projects.get(id)! };
  },
  'projects:pin':          async (s, { id, pinned }) => { s.projects.setPinned(id, pinned); return { ok: true } as const; },
  'projects:hide':         async (s, { id, hidden }) => { s.projects.setHidden(id, hidden); return { ok: true } as const; },
  'projects:update-config':async (s, { id, config }) => ({ project: s.projects.updateConfig(id, config) }),
  'projects:recents':      async (s, { limit }) => ({ projects: s.projects.listRecents(limit ?? 10) }),

  'shells:launch': async (s, { projectId }) => {
    const project = s.projects.get(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    const cap = s.settings.get('keep_alive_cap');
    const alive = s.shells.list();
    if (alive.length >= cap) {
      const decision = chooseEvictee(alive, cap, projectId, new Date());
      if (decision.evictee) {
        await s.ptyManager.kill(decision.evictee.projectId, decision.evictee.shellIndex);
        s.shells.remove(decision.evictee.projectId, decision.evictee.shellIndex);
      } else if (decision.reason === 'all-pinned') {
        throw new Error('all shells are pinned — unpin one or raise cap');
      }
    }
    const launch = resolveLaunch(project, s.settings, s.homeDir);
    await s.ptyManager.spawn(projectId, 0, launch);
    if (!project.firstLaunchedAt) s.projects.setFirstLaunched(projectId, new Date());
    const now = new Date();
    const nowIso = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')} ${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}:${String(now.getUTCSeconds()).padStart(2,'0')}`;
    s.shells.upsert({ projectId, shellIndex: 0, model: null, launchArgv: launch.argv, startedAt: nowIso, lastActiveAt: nowIso, pinned: false });
    return { shellIndex: 0 };
  },
  'shells:kill':   async (s, { projectId, shellIndex }) => { await s.ptyManager.kill(projectId, shellIndex); s.shells.remove(projectId, shellIndex); return { ok: true } as const; },
  'shells:resize': async (s, { projectId, shellIndex, cols, rows }) => { s.ptyManager.resize(projectId, shellIndex, cols, rows); return { ok: true } as const; },
  'shells:write':  async (s, { projectId, shellIndex, data }) => { s.ptyManager.write(projectId, shellIndex, data); s.shells.touch(projectId, shellIndex, new Date()); return { ok: true } as const; },
  'shells:alive-list': async (s) => {
    const rows = s.shells.list();
    const projects = new Map(s.projects.list().map(p => [p.id, p]));
    const alive = rows
      .filter(r => s.ptyManager.isAlive(r.projectId, r.shellIndex))
      .map(r => {
        const p = projects.get(r.projectId);
        return { ...r, projectName: p?.name ?? '', projectPath: p?.path ?? '' };
      });
    return { shells: alive };
  },
  'shells:pin':   async (s, { projectId, shellIndex, pinned }) => { s.shells.setPinned(projectId, shellIndex, pinned); return { ok: true } as const; },

  'settings:get': async (s, { key }) => ({ value: s.settings.get(key) }),
  'settings:set': async (s, { key, value }) => { s.settings.set(key, value as never); return { ok: true } as const; },

  'files:tree':   async (s, { projectId, relPath }) => {
    const p = s.projects.get(projectId);
    if (!p) throw new Error(`no project ${projectId}`);
    const abs = relPath ? join(p.path, relPath) : p.path;
    const entries = readdirSync(abs).map(name => {
      const full = join(abs, name);
      let isDir = false; try { isDir = statSync(full).isDirectory(); } catch {}
      return { name, isDir, relPath: relative(p.path, full) };
    });
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { entries };
  },
};

export function registerIpc(ipcMain: IpcMain, services: Services, sendEvent: SendEvent): void {
  // Wire PTY data/exit events to renderer.
  services.ptyManager.on('data', (ev: IpcEvents['pty:data']) => sendEvent('pty:data', ev));
  services.ptyManager.on('exit', (ev: IpcEvents['pty:exit']) => sendEvent('pty:exit', ev));

  for (const channel of Object.keys(handlers) as IpcChannelName[]) {
    ipcMain.handle(channel, async (_e, req) => {
      const fn = handlers[channel] as (s: Services, req: unknown) => Promise<unknown>;
      return fn(services, req);
    });
  }
}
```

Run test in Step 1: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/services.ts src/main/ipc/register.ts tests/unit/main/ipc/register.test.ts
git commit -m "feat(main): service container + typed IPC handler registration"
```

---

## Task 13: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts`
- Create: `src/renderer/api.ts`, `tests/unit/preload/bridge.test.ts` (unit test on the shape via a mock)

**Interfaces:**
- Consumes: `IpcContract`, `IpcEvents`.
- Produces: `window.api` typed as:
  ```ts
  interface Api {
    invoke: <C extends IpcChannelName>(channel: C, req: IpcRequest<C>) => Promise<IpcResponse<C>>;
    on:     <E extends IpcEventName>(channel: E, cb: (payload: IpcEvents[E]) => void) => () => void;
  }
  ```

- [ ] **Step 1: Replace preload**

Replace `src/preload/index.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannelName, IpcRequest, IpcResponse, IpcEventName, IpcEvents } from '../shared/ipc-contract';

const api = {
  invoke<C extends IpcChannelName>(channel: C, req: IpcRequest<C>): Promise<IpcResponse<C>> {
    return ipcRenderer.invoke(channel, req) as Promise<IpcResponse<C>>;
  },
  on<E extends IpcEventName>(channel: E, cb: (payload: IpcEvents[E]) => void): () => void {
    const listener = (_e: unknown, payload: IpcEvents[E]) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
```

- [ ] **Step 2: Add renderer-side typed wrapper**

Create `src/renderer/api.ts`:
```ts
import type { Api } from '../preload';

declare global { interface Window { api: Api } }
export const api: Api = window.api;
```

- [ ] **Step 3: Wire IPC into main process at boot**

Modify `src/main/index.ts`:
```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildServices } from './services';
import { registerIpc } from './ipc/register';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(async () => {
  const services = buildServices({ migrationsDir: resolve(app.getAppPath(), 'migrations') });
  mainWindow = await createWindow();
  registerIpc(ipcMain, services, (channel, payload) => {
    mainWindow?.webContents.send(channel, payload);
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', async () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createWindow(); });
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/preload src/renderer/api.ts src/main/index.ts
git commit -m "feat: typed preload bridge and main-process IPC wiring"
```

---

## Task 14: Renderer — Sidebar, Project Switcher, Status Bar

**Files:**
- Create: `src/renderer/components/Sidebar.tsx`, `src/renderer/components/ProjectSwitcher.tsx`, `src/renderer/components/StatusBar.tsx`, `src/renderer/hooks/useProjects.ts`, `src/renderer/hooks/useRoots.ts`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `window.api`.
- Produces: components consumed by `App.tsx` with props documented in each file.

- [ ] **Step 1: Hooks**

Create `src/renderer/hooks/useProjects.ts`:
```ts
import { useEffect, useState, useCallback } from 'react';
import type { Project } from '@shared/types';
import { api } from '@renderer/api';

export function useProjects(): { projects: Project[]; refresh: () => Promise<void> } {
  const [projects, setProjects] = useState<Project[]>([]);
  const refresh = useCallback(async () => {
    const { projects } = await api.invoke('projects:list', undefined as never);
    setProjects(projects);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { projects, refresh };
}
```

Create `src/renderer/hooks/useRoots.ts`:
```ts
import { useEffect, useState, useCallback } from 'react';
import type { Root } from '@shared/types';
import { api } from '@renderer/api';

export function useRoots(): { roots: Root[]; refresh: () => Promise<void> } {
  const [roots, setRoots] = useState<Root[]>([]);
  const refresh = useCallback(async () => {
    const { roots } = await api.invoke('roots:list', undefined as never);
    setRoots(roots);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { roots, refresh };
}
```

- [ ] **Step 2: Sidebar**

Create `src/renderer/components/Sidebar.tsx`:
```tsx
import { useMemo, useState } from 'react';
import { useRoots } from '@renderer/hooks/useRoots';
import { useProjects } from '@renderer/hooks/useProjects';
import type { Project, Root } from '@shared/types';
import { api } from '@renderer/api';

interface Props {
  selectedProjectId: number | null;
  onSelect: (p: Project) => void;
}

export function Sidebar({ selectedProjectId, onSelect }: Props) {
  const { roots, refresh: refreshRoots } = useRoots();
  const { projects, refresh: refreshProjects } = useProjects();
  const [filter, setFilter] = useState('');

  const grouped = useMemo(() => {
    const byRoot = new Map<number, Project[]>();
    for (const p of projects) {
      if (filter && !p.name.toLowerCase().includes(filter.toLowerCase())) continue;
      if (!byRoot.has(p.rootId)) byRoot.set(p.rootId, []);
      byRoot.get(p.rootId)!.push(p);
    }
    return byRoot;
  }, [projects, filter]);

  async function addRoot() {
    // Use OS-native folder picker via IPC event (not in Phase 1's minimal contract — prompt via window.prompt for MVP).
    const path = window.prompt('Root directory path (absolute):');
    if (!path) return;
    await api.invoke('roots:add', { path });
    await refreshRoots();
    await refreshProjects();
  }

  return (
    <aside className="w-72 h-full border-r border-neutral-800 flex flex-col">
      <div className="p-2 border-b border-neutral-800">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full bg-neutral-900 text-sm px-2 py-1 rounded"
        />
        <button onClick={addRoot} className="mt-2 w-full text-xs bg-blue-600 hover:bg-blue-500 rounded py-1">
          + Add root
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {roots.map(r => (
          <RootBlock key={r.id} root={r} projects={grouped.get(r.id) ?? []} selectedProjectId={selectedProjectId} onSelect={onSelect} />
        ))}
      </div>
    </aside>
  );
}

function RootBlock({ root, projects, selectedProjectId, onSelect }: { root: Root; projects: Project[]; selectedProjectId: number | null; onSelect: (p: Project) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="w-full text-left px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900">
        {open ? '▾' : '▸'} {root.path} ({projects.length})
      </button>
      {open && projects.map(p => (
        <button
          key={p.id}
          onClick={() => onSelect(p)}
          className={`w-full text-left px-4 py-1 text-sm ${selectedProjectId === p.id ? 'bg-blue-700' : 'hover:bg-neutral-900'}`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Project Switcher (Cmd+K)**

Create `src/renderer/components/ProjectSwitcher.tsx`:
```tsx
import Fuse from 'fuse.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjects } from '@renderer/hooks/useProjects';
import type { Project } from '@shared/types';

export function ProjectSwitcher({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (p: Project) => void }) {
  const { projects } = useProjects();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const fuse = useMemo(() => new Fuse(projects, { keys: ['name', 'path'], threshold: 0.4 }), [projects]);
  const results = useMemo(() => (query ? fuse.search(query).map(r => r.item) : projects), [query, fuse, projects]);

  useEffect(() => { if (open) inputRef.current?.focus(); else setQuery(''); }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-32 z-50" onClick={onClose}>
      <div className="bg-neutral-900 w-[600px] rounded shadow-lg border border-neutral-700" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Switch to project…"
          onKeyDown={e => { if (e.key === 'Enter' && results[0]) { onPick(results[0]); onClose(); } if (e.key === 'Escape') onClose(); }}
          className="w-full bg-transparent p-3 border-b border-neutral-800 outline-none"
        />
        <ul className="max-h-96 overflow-y-auto">
          {results.slice(0, 20).map(p => (
            <li key={p.id}>
              <button onClick={() => { onPick(p); onClose(); }} className="w-full text-left px-3 py-2 hover:bg-neutral-800">
                <div className="text-sm">{p.name}</div>
                <div className="text-xs text-neutral-500">{p.path}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Status Bar**

Create `src/renderer/components/StatusBar.tsx`:
```tsx
import type { Project } from '@shared/types';

export function StatusBar({ project, aliveCount }: { project: Project | null; aliveCount: number }) {
  return (
    <div className="h-6 border-t border-neutral-800 px-3 text-xs text-neutral-400 flex items-center gap-4">
      <span>{project ? `● ${project.name}` : 'no project'}</span>
      <span>alive shells: {aliveCount}</span>
    </div>
  );
}
```

- [ ] **Step 5: Update App shell to compose them**

Replace `src/renderer/App.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { StatusBar } from './components/StatusBar';
import type { Project } from '@shared/types';
import { api } from './api';

export function App() {
  const [selected, setSelected] = useState<Project | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [aliveCount, setAliveCount] = useState(0);

  const refreshAlive = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setAliveCount(shells.length);
  }, []);

  useEffect(() => { void refreshAlive(); }, [refreshAlive]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSwitcherOpen(true); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function pick(p: Project) {
    const { project } = await api.invoke('projects:open', { id: p.id });
    setSelected(project);
    // Launch shell — Phase 1 UI is placeholder; ShellTab component in Task 15.
    try { await api.invoke('shells:launch', { projectId: project.id }); } catch (e) { console.error(e); }
    await refreshAlive();
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 flex">
        <Sidebar selectedProjectId={selected?.id ?? null} onSelect={pick} />
        <main className="flex-1 p-4">
          {selected ? <div className="text-lg">{selected.name}</div> : <div className="text-neutral-500">Select a project</div>}
        </main>
      </div>
      <StatusBar project={selected} aliveCount={aliveCount} />
      <ProjectSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} onPick={pick} />
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add src/renderer
git commit -m "feat(renderer): sidebar, project switcher, status bar wired to IPC"
```

---

## Task 15: Shell Tab (xterm.js + PTY stream)

**Files:**
- Create: `src/renderer/components/ShellTab.tsx`, `src/renderer/hooks/useShellStream.ts`
- Modify: `src/renderer/App.tsx` to render `ShellTab` when a project is selected.

**Interfaces:**
- Consumes: `window.api` events `'pty:data'`, `'pty:exit'`.
- Produces: `ShellTab` component that hosts xterm.js, wires input to `shells:write`, resizes to `shells:resize`, subscribes to data events.

- [ ] **Step 1: Stream hook**

Create `src/renderer/hooks/useShellStream.ts`:
```ts
import { useEffect, useRef } from 'react';
import { api } from '@renderer/api';

export function useShellStream(projectId: number | null, shellIndex: number, onData: (data: string) => void, onExit: (code: number | null) => void) {
  const cbData = useRef(onData); cbData.current = onData;
  const cbExit = useRef(onExit); cbExit.current = onExit;
  useEffect(() => {
    if (projectId == null) return;
    const offData = api.on('pty:data', ev => { if (ev.projectId === projectId && ev.shellIndex === shellIndex) cbData.current(ev.data); });
    const offExit = api.on('pty:exit', ev => { if (ev.projectId === projectId && ev.shellIndex === shellIndex) cbExit.current(ev.code); });
    return () => { offData(); offExit(); };
  }, [projectId, shellIndex]);
}
```

- [ ] **Step 2: Shell component**

Create `src/renderer/components/ShellTab.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { WebglAddon } from 'xterm-addon-webgl';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { SearchAddon } from 'xterm-addon-search';
import 'xterm/css/xterm.css';
import { api } from '@renderer/api';
import { useShellStream } from '@renderer/hooks/useShellStream';

export function ShellTab({ projectId, shellIndex }: { projectId: number; shellIndex: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({ scrollback: 10000, fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, theme: { background: '#0d1117' } });
    try { term.loadAddon(new WebglAddon()); } catch { /* fallback to canvas */ }
    term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.open(hostRef.current);
    term.onData((data) => { void api.invoke('shells:write', { projectId, shellIndex, data }); });
    termRef.current = term;

    // Initial resize.
    const cols = Math.max(20, Math.floor(hostRef.current.clientWidth / 8));
    const rows = Math.max(5, Math.floor(hostRef.current.clientHeight / 17));
    term.resize(cols, rows);
    void api.invoke('shells:resize', { projectId, shellIndex, cols, rows });

    const ro = new ResizeObserver(() => {
      if (!hostRef.current) return;
      const cols = Math.max(20, Math.floor(hostRef.current.clientWidth / 8));
      const rows = Math.max(5, Math.floor(hostRef.current.clientHeight / 17));
      term.resize(cols, rows);
      void api.invoke('shells:resize', { projectId, shellIndex, cols, rows });
    });
    ro.observe(hostRef.current);

    return () => { ro.disconnect(); term.dispose(); termRef.current = null; };
  }, [projectId, shellIndex]);

  useShellStream(projectId, shellIndex, (data) => termRef.current?.write(data), () => {
    termRef.current?.write('\r\n[shell exited]\r\n');
  });

  return <div ref={hostRef} className="w-full h-full" />;
}
```

- [ ] **Step 3: Mount `ShellTab` in App**

Update `src/renderer/App.tsx` main pane:
```tsx
// replace <main> content:
<main className="flex-1 relative">
  {selected ? <ShellTab projectId={selected.id} shellIndex={0} /> : <div className="p-4 text-neutral-500">Select a project</div>}
</main>
```

And add `import { ShellTab } from './components/ShellTab';` at the top.

- [ ] **Step 4: Verify by running the app**

Run: `pnpm dev`
Expected:
1. Window opens.
2. Click "+ Add root", enter `/tmp/metaide-demo`, cancel; instead first make a demo:
   ```
   mkdir -p /tmp/metaide-demo/proj1 && (cd /tmp/metaide-demo/proj1 && git init)
   ```
3. Click "+ Add root", enter `/tmp/metaide-demo`. Sidebar shows `proj1`.
4. Click `proj1`. Shell tab shows Claude prompt (or `command not found: claude` — verify default flow error surfaces).
5. To test end-to-end without `claude` installed: set `settings.default_launch_cmd.first` to `["node", "scripts/mock-claude.mjs"]` via a temporary hack, or wait for the E2E tests below which do exactly that.

Do NOT commit if the app crashes. Fix crashes first.

- [ ] **Step 5: Commit**

```bash
git add src/renderer
git commit -m "feat(renderer): xterm.js shell tab with PTY streaming and resize"
```

---

## Task 16: Alive Shells Panel

**Files:**
- Create: `src/renderer/components/AliveShellsPanel.tsx`
- Modify: `src/renderer/App.tsx` to open the panel with Cmd+Shift+A.

**Interfaces:**
- Consumes: `shells:alive-list`, `shells:pin`, `shells:kill`.
- Produces: Panel component displaying alive shells and letting the user pin/close each.

- [ ] **Step 1: Component**

Create `src/renderer/components/AliveShellsPanel.tsx`:
```tsx
import { useEffect, useState, useCallback } from 'react';
import type { AliveShellSummary } from '@shared/types';
import { api } from '@renderer/api';

export function AliveShellsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<AliveShellSummary[]>([]);
  const refresh = useCallback(async () => {
    const { shells } = await api.invoke('shells:alive-list', undefined as never);
    setRows(shells);
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  if (!open) return null;
  return (
    <div className="fixed right-0 top-0 h-full w-96 bg-neutral-900 border-l border-neutral-800 z-40 flex flex-col">
      <div className="p-3 border-b border-neutral-800 flex items-center justify-between">
        <div className="font-semibold text-sm">Alive shells</div>
        <button onClick={onClose} className="text-xs text-neutral-400 hover:text-white">close</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && <div className="p-4 text-sm text-neutral-500">No shells alive.</div>}
        {rows.map(r => (
          <div key={`${r.projectId}:${r.shellIndex}`} className="p-3 border-b border-neutral-800">
            <div className="text-sm">{r.projectName}</div>
            <div className="text-xs text-neutral-500">last active: {r.lastActiveAt}</div>
            <div className="mt-2 flex gap-2">
              <button onClick={async () => { await api.invoke('shells:pin', { projectId: r.projectId, shellIndex: r.shellIndex, pinned: !r.pinned }); await refresh(); }} className="text-xs px-2 py-0.5 bg-neutral-800 rounded">
                {r.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button onClick={async () => { await api.invoke('shells:kill', { projectId: r.projectId, shellIndex: r.shellIndex }); await refresh(); }} className="text-xs px-2 py-0.5 bg-red-800 rounded">
                Close
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire Cmd+Shift+A in App**

In `App.tsx`, add state and handler:
```tsx
const [alivePanelOpen, setAlivePanelOpen] = useState(false);
// inside the keydown effect:
if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); setAlivePanelOpen(v => !v); }
// render:
<AliveShellsPanel open={alivePanelOpen} onClose={() => setAlivePanelOpen(false)} />
```

Import at top: `import { AliveShellsPanel } from './components/AliveShellsPanel';`

- [ ] **Step 3: Commit**

```bash
git add src/renderer
git commit -m "feat(renderer): alive shells panel"
```

---

## Task 17: Files Tab (Read-Only)

**Files:**
- Create: `src/renderer/components/FilesTab.tsx`
- Modify: `src/renderer/App.tsx` to add a tab switcher between Shell and Files.

**Interfaces:**
- Consumes: `files:tree`.
- Produces: Read-only file tree.

- [ ] **Step 1: Component**

Create `src/renderer/components/FilesTab.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';

interface Entry { name: string; isDir: boolean; relPath: string; }

export function FilesTab({ projectId }: { projectId: number }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [path, setPath] = useState<string | undefined>(undefined);

  const load = useCallback(async (relPath?: string) => {
    const { entries } = await api.invoke('files:tree', { projectId, relPath });
    setEntries(entries);
    setPath(relPath);
  }, [projectId]);

  useEffect(() => { void load(undefined); }, [load]);

  return (
    <div className="p-3 h-full overflow-y-auto">
      <div className="text-xs text-neutral-500 mb-2">{path ?? '/'}</div>
      {path && <button onClick={() => load(undefined)} className="text-xs mb-2 text-blue-400">← root</button>}
      <ul className="text-sm">
        {entries.map(e => (
          <li key={e.relPath}>
            <button onClick={() => e.isDir && load(e.relPath)} className="hover:underline">
              {e.isDir ? '📁' : '📄'} {e.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Add tab switcher in App**

Replace the main pane block in `App.tsx`:
```tsx
const [mainTab, setMainTab] = useState<'shell' | 'files'>('shell');
// ...
<main className="flex-1 flex flex-col">
  <div className="flex border-b border-neutral-800 text-xs">
    <button onClick={() => setMainTab('shell')} className={`px-3 py-1 ${mainTab === 'shell' ? 'bg-neutral-800' : ''}`}>Shell</button>
    <button onClick={() => setMainTab('files')} className={`px-3 py-1 ${mainTab === 'files' ? 'bg-neutral-800' : ''}`}>Files</button>
  </div>
  <div className="flex-1 relative">
    {selected ? (
      mainTab === 'shell' ? <ShellTab projectId={selected.id} shellIndex={0} /> : <FilesTab projectId={selected.id} />
    ) : <div className="p-4 text-neutral-500">Select a project</div>}
  </div>
</main>
```

Import at top: `import { FilesTab } from './components/FilesTab';`

- [ ] **Step 3: Commit**

```bash
git add src/renderer
git commit -m "feat(renderer): read-only files tab"
```

---

## Task 18: E2E Test — Full Lifecycle

**Files:**
- Create: `tests/e2e/project-lifecycle.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Consumes: packaged app under `out/`.
- Produces: An E2E test that: launches the Electron app, adds a temp root containing a demo project with a `.git`, waits for it to appear in the sidebar, clicks it, verifies a shell launches (using an ENV override to swap the default launch cmd to the mock script), types `hello\n`, and asserts `echo: hello` appears in the terminal.

- [ ] **Step 1: Add Playwright config**

Create `playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  use: { trace: 'retain-on-failure' },
  reporter: [['list']],
});
```

- [ ] **Step 2: Add settings-override env hook to main**

To keep the E2E deterministic without shipping test-mode code paths in prod, allow overriding the default launch cmd via env vars applied inside `SettingsRepo.seedDefaults`:

Modify `src/main/repos/settings-repo.ts` `seedDefaults` — replace the loop body with:
```ts
    const override = process.env.METAIDE_DEFAULT_LAUNCH_FIRST;
    const overrideSub = process.env.METAIDE_DEFAULT_LAUNCH_SUBSEQUENT;
    const effective: SettingsMap = { ...DEFAULT_SETTINGS };
    if (override)    effective['default_launch_cmd.first']      = JSON.parse(override) as SettingsMap['default_launch_cmd.first'];
    if (overrideSub) effective['default_launch_cmd.subsequent'] = JSON.parse(overrideSub) as SettingsMap['default_launch_cmd.subsequent'];
    for (const [k, v] of Object.entries(effective)) {
      ins.run(k, JSON.stringify(v));
    }
```

Add unit test `tests/unit/main/repos/settings-repo-override.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { SettingsRepo } from '@main/repos/settings-repo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('SettingsRepo env override', () => {
  afterEach(() => { delete process.env.METAIDE_DEFAULT_LAUNCH_FIRST; });
  it('reads default_launch_cmd.first from env', () => {
    process.env.METAIDE_DEFAULT_LAUNCH_FIRST = JSON.stringify({ argv: ['echo', 'x'], env: {} });
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'o-')), 'db'));
    runMigrations(db, resolve(__dirname, '../../../../migrations'));
    const s = new SettingsRepo(db); s.seedDefaults();
    expect(s.get('default_launch_cmd.first').argv).toEqual(['echo', 'x']);
  });
});
```

Run: PASS.

- [ ] **Step 3: E2E test**

Create `tests/e2e/project-lifecycle.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

test('full lifecycle: add root → discover → launch shell → echo', async () => {
  const mockClaude = resolve(process.cwd(), 'scripts/mock-claude.mjs');
  const isolatedHome = mkdtempSync(join(tmpdir(), 'metaide-home-'));
  const demoRoot     = mkdtempSync(join(tmpdir(), 'metaide-demo-'));
  const proj         = join(demoRoot, 'demo');
  mkdirSync(proj); mkdirSync(join(proj, '.git'));

  const app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      HOME: isolatedHome,               // isolate SQLite path
      METAIDE_DEFAULT_LAUNCH_FIRST:      JSON.stringify({ argv: ['node', mockClaude],              env: {} }),
      METAIDE_DEFAULT_LAUNCH_SUBSEQUENT: JSON.stringify({ argv: ['node', mockClaude, '--continue'],env: {} }),
    },
  });
  const win = await app.firstWindow();

  // Add root — the prompt() dialog is intercepted.
  await win.evaluate((path: string) => { (window as any).prompt = () => path; }, demoRoot);
  await win.getByRole('button', { name: '+ Add root' }).click();

  // Wait for demo to appear.
  await expect(win.getByRole('button', { name: 'demo' })).toBeVisible({ timeout: 5000 });

  // Click project → launches shell.
  await win.getByRole('button', { name: 'demo' }).click();

  // xterm renders text into canvas / DOM. The banner text is written to
  // hidden accessibility layer (`.xterm-accessibility` div).
  await expect(win.locator('.xterm')).toBeVisible({ timeout: 5000 });

  // Type "hello" then Enter — xterm captures via focused terminal.
  await win.locator('.xterm').click();
  await win.keyboard.type('hello');
  await win.keyboard.press('Enter');

  // Assert echo appears in the accessibility text (xterm mirrors output there).
  await expect(win.locator('.xterm-accessibility')).toContainText('echo: hello', { timeout: 5000 });

  await app.close();
  rmSync(isolatedHome, { recursive: true, force: true });
  rmSync(demoRoot, { recursive: true, force: true });
});
```

- [ ] **Step 4: Add build step so `electron .` finds compiled `out/`**

Add to `package.json` scripts: `"test:e2e:full": "electron-vite build && playwright test"`.

- [ ] **Step 5: Run E2E**

Run: `pnpm test:e2e:full`
Expected: 1 test passing (60s budget).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e playwright.config.ts src/main/repos/settings-repo.ts tests/unit/main/repos/settings-repo-override.test.ts package.json
git commit -m "test(e2e): full-lifecycle Playwright test with mock claude"
```

---

## Task 19: Final Verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run:
```
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e:full
```
Expected: all green.

- [ ] **Step 2: Manual smoke exercise**

Run: `pnpm dev`
Steps:
1. Add `~/Documents/my projects/` as a root.
2. Verify sidebar populates with the real projects.
3. Cmd+K → type "metaIDE" → Enter. Verify shell tab opens.
4. If real `claude` is installed, verify the prompt appears; else expect a clear "command not found" error surfaced through xterm.
5. Open Alive Shells panel (Cmd+Shift+A) — verify the shell shows up.
6. Click another project → verify keep-alive count grows.
7. Add 4 more projects (total 6 alive), verify LRU eviction toast appears and oldest shell closes.
8. Pin a shell, add another, verify pinned shell survives eviction.
9. Switch to Files tab — verify project files listed.
10. Quit app — verify clean exit (no lingering PTY processes).

- [ ] **Step 3: Tag the Phase 1 release**

```bash
git tag phase-1-mvp
```

- [ ] **Step 4: Commit if any polish edits were made**

Nothing to commit if the smoke exercise passed unchanged.

---

## Coverage Map (spec → task)

| Spec section                       | Implemented in            |
| ---------------------------------- | ------------------------- |
| §2 Foundational Decisions          | Task 1                    |
| §3.1 Window layout                 | Tasks 14, 15, 17 (subset) |
| §3.3 Cmd+K project switcher        | Task 14                   |
| §4.1 SQLite schema + WAL           | Tasks 3, 4                |
| §4.2 Per-project config            | Tasks 2, 5                |
| §4.3 Global settings               | Task 5                    |
| §5.1 PTY layer                     | Task 10                   |
| §5.2 Launch flow                   | Tasks 6, 9, 12            |
| §5.3 Keep-alive & eviction         | Tasks 11, 12, 16          |
| §5.4 Shell UI (xterm.js)           | Task 15                   |
| §6.1 Root directories              | Tasks 5, 8, 12            |
| §6.2 Project discovery rules       | Task 7                    |
| §6.3 Sidebar                       | Task 14                   |
| §6.4 Recents                       | Task 5 (repo), 14 (UI)    |
| §7.4 Files tab (read-only)         | Task 17                   |
| §11.7 Typed IPC contract           | Tasks 2, 12, 13           |
| §11.6 Security (argv, sandbox)     | Tasks 1, 13, 6            |
| §11.4 Testing (Vitest + Playwright)| Throughout                |
| Phase 1 exclusions                 | Not implemented, verified by scope check in §Global Constraints |

## Explicit v0 Compromises

- **Root path picker** uses `window.prompt()` in Phase 1. Native OS folder picker is Phase 5 polish.
- **Multi-viewport arbitration** (§5.1 spec) is not implemented — Phase 1 has only one viewport per shell (main window). Pop-out and Wall Mode wait for Phase 5.
- **Config-file watcher for `~/.claude.json`** is Phase 3 (metaproject).
- **`chokidar` events** are tracked in the watcher but not yet propagated to auto-discover new projects while running. Phase 1 requires manual "Add root" (which triggers a scan) or `roots:rescan`. Auto-add on new folder event is a follow-up.
