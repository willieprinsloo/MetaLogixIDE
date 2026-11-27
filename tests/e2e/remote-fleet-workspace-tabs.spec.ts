import { expect, test, _electron as electron, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { DIFF_TESTIDS } from '../../src/renderer/diff-tab-copy';
import { ENV_TESTIDS } from '../../src/renderer/project-env-copy';
import { REMOTE_ACTIVE_CHIP_CLASS, REMOTE_PANE_TESTIDS } from '../../src/renderer/remote-pane-contract';
import { MACHINE_TESTIDS } from '../../src/renderer/sidebar-copy';
import { SHELL_TAB_TEST_ID } from '../../src/shared/agent-state';
import type { FleetEntry } from '../../src/shared/p2p-contract';
import { createFrameDecoder, encodeFrame, SignalingTypes as Signal } from '../../src/shared/signaling-wire';
import { baseEnv, closeApp, guardedLaunch, waitForShell, type LaunchScope } from './helpers/claude-harness';
import { commitAll, git, porcelain } from './helpers/git-repo';
import { ipc, project, resize } from './helpers/project-default-agent';
import { terminalProbes } from './helpers/terminal-probe';

const HOST_NAME = 'Fleet Fixture Host';
const VIEWER_NAME = 'Fleet Fixture Viewer';
const HOST_PROJECT = 'fleet-host-project';
const VIEWER_PROJECT = 'fleet-viewer-project';
const NOTES = 'shared-notes.txt';
const HOST_ORIGINAL = 'HOST original workspace text';
const VIEWER_ORIGINAL = 'VIEWER original workspace text';
const HOST_SAVED = 'HOST text saved from the paired viewer';
const HOST_AGENT = 'Host primary fixture agent';
const HOST_ALT = 'Host alternate fixture agent';
const VIEWER_AGENT = 'Viewer only fixture agent';
const ACTIVITY_TARGET = 'host-activity.txt';
const ACTIVITY_CONTENT = 'HOST activity link target';
const LIVE_ACTIVITY = 'HOST activity appended while panel is open';
const VIEWER_ACTIVITY = 'viewer-activity.txt';

const helloSchema = z.object({ role: z.enum(['host', 'viewer']) });
const signalSchema = z.object({
  type: z.string(),
  data: z.object({ session: z.string().optional(), code: z.string().optional() }).optional(),
});

/** Test-only signaling. It brokers real SDP/ICE over TCP and never sees workspace RPC or PTY data. */
async function startLoopbackRelay(): Promise<{
  readonly port: number;
  readonly registered: ReadonlyMap<string, Socket>;
  readonly errors: readonly string[];
  readonly close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const registered = new Map<string, Socket>();
  const sessions = new Map<string, { readonly host: Socket; readonly viewer: Socket }>();
  const errors: string[] = [];
  let nextCode = 100_000_000;
  function send(socket: Socket, message: object): void {
    socket.write(encodeFrame(Buffer.from(JSON.stringify(message))));
  }
  const server = createServer((socket) => {
    sockets.add(socket);
    const decoder = createFrameDecoder();
    let role: 'host' | 'viewer' | undefined;
    let code: string | undefined;
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          const raw: unknown = JSON.parse(Buffer.from(frame).toString('utf8'));
          if (!role) {
            role = helloSchema.parse(raw).role;
            if (role === 'host') {
              code = String(++nextCode);
              send(socket, { type: Signal.AssignCode, data: { code, secret: randomBytes(16).toString('hex') } });
            }
            continue;
          }
          const { type, data } = signalSchema.parse(raw);
          if (role === 'host' && type === Signal.Register && code) {
            registered.set(code, socket);
          } else if (role === 'viewer' && type === Signal.SessionRequest) {
            const host = registered.get(data?.code ?? '');
            if (!host) {
              send(socket, { type: Signal.SessionDenied, data: { reason: 'fixture host not registered' } });
              continue;
            }
            const session = randomUUID();
            sessions.set(session, { host, viewer: socket });
            // Same-machine host candidates only; never supply external STUN/TURN servers.
            const grant = { session, token: randomBytes(16).toString('hex'), ice_servers: [] };
            send(host, { type: Signal.SessionInvite, data: { ...grant, operator: 'e2e', requires_key: false } });
            send(socket, { type: Signal.SessionGranted, data: { ...grant, host: data?.code, host_fingerprint: 'e2e' } });
          } else if (data?.session && (type === Signal.Offer || type === Signal.Answer
              || type === Signal.IceCandidate || type === Signal.SessionClose)) {
            const peers = sessions.get(data.session);
            if (peers && (peers.host === socket || peers.viewer === socket) && typeof raw === 'object' && raw !== null) {
              // Forward the original envelope: the routing schema intentionally strips SDP and candidates.
              send(peers.host === socket ? peers.viewer : peers.host, raw);
              if (type === Signal.SessionClose) sessions.delete(data.session);
            }
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        socket.destroy();
      }
    });
    socket.on('error', (error) => { errors.push(error.message); });
    socket.on('close', () => {
      sockets.delete(socket);
      if (code && registered.get(code) === socket) registered.delete(code);
      for (const [id, peers] of sessions) {
        if (peers.host === socket || peers.viewer === socket) sessions.delete(id);
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP fixture relay address');
  return {
    port: address.port,
    registered,
    errors,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => { if (error) reject(error); else resolveClose(); });
      });
    },
  };
}

/** Set the relay before main starts P2P, not with IPC after the default relay may have been dialed. */
function seedLoopbackSettings(home: string, port: number, name: string): void {
  const metadata = join(home, '.metaide');
  mkdirSync(metadata);
  // The pinned Node 24 runtime has SQLite, but the repo's Node 20 typings do not declare it.
  execFileSync(process.execPath, ['-e', String.raw`
    const { DatabaseSync } = require('node:sqlite');
    const { readFileSync, readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const [path, port, name] = process.argv.slice(1);
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT (datetime('now')))");
      const applied = db.prepare('INSERT INTO schema_version (version) VALUES (?)');
      for (const file of readdirSync('migrations').filter((file) => /^\d+_.*\.sql$/.test(file)).sort()) {
        db.exec(readFileSync(join('migrations', file), 'utf8'));
        applied.run(Number.parseInt(file, 10));
      }
      db.prepare('UPDATE p2p_settings SET relay_url = ?, relay_port = ?, device_name = ? WHERE id = 1')
        .run('127.0.0.1', Number(port), name);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('metaproject_base_url', JSON.stringify('http://127.0.0.1:1'));
    } finally {
      db.close();
    }
  `, join(metadata, 'metaide.db'), String(port), name]);
}

function seedProjectFiles(path: string, side: 'HOST' | 'VIEWER'): void {
  const target = side === 'HOST' ? ACTIVITY_TARGET : VIEWER_ACTIVITY;
  mkdirSync(join(path, '.metaide'), { recursive: true });
  writeFileSync(join(path, '.gitignore'), '.metaide/\n');
  writeFileSync(join(path, NOTES), `${side === 'HOST' ? HOST_ORIGINAL : VIEWER_ORIGINAL}\n`);
  writeFileSync(join(path, target), `${side === 'HOST' ? ACTIVITY_CONTENT : 'VIEWER activity link target'}\n`);
  writeFileSync(join(path, '.metaide', 'activity.jsonl'), `${JSON.stringify({
    id: `${side}-edit`, ts: '2026-11-14T09:00:00.000Z', agent: 'claude', shellIndex: 0,
    kind: 'tool', tool: 'Edit', target, ok: true,
  })}\n`);
  git(path, ['init', '-b', 'main']);
  commitAll(path, 'workspace fixture baseline');
  if (side === 'HOST') {
    writeFileSync(join(path, 'host-staged.txt'), 'HOST staged change\n');
    git(path, ['add', 'host-staged.txt']);
    writeFileSync(join(path, 'host-untracked.txt'), 'HOST untracked change\n');
  } else {
    writeFileSync(join(path, 'viewer-untracked.txt'), 'VIEWER untracked change\n');
  }
}

async function launchPeer(scope: LaunchScope, relayPort: number, side: 'HOST' | 'VIEWER') {
  const isHost = side === 'HOST';
  const name = isHost ? HOST_NAME : VIEWER_NAME;
  const projectName = isHost ? HOST_PROJECT : VIEWER_PROJECT;
  const home = scope.tempDir('metaide-paired-workspace-');
  const root = join(home, 'projects');
  const path = join(root, projectName);
  seedLoopbackSettings(home, relayPort, name);
  seedProjectFiles(path, side);
  const markerScript = join(home, 'shell-marker.sh');
  writeFileSync(markerScript, 'printf "%s\\n" "$1"\nwhile IFS= read -r line; do :; done\n');
  const env = baseEnv();
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = scope.own(await electron.launch({
    args: ['.', `--user-data-dir=${join(home, 'userData')}`, '--disable-background-networking', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    env: {
      ...env,
      HOME: home,
      SHELL: '/bin/bash',
      METAIDE_TEST_MODE: '1',
      METAIDE_CLAUDE_PERMISSION_MODE: 'bypass',
      METAIDE_METAPROJECT_FIXTURE: '1',
    },
  }));
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await resize(app, 1400, 900);
  expect(await ipc(win, 'p2p:settings-get', undefined)).toMatchObject({ relayUrl: '127.0.0.1', relayPort, deviceName: name });
  await ipc(win, 'settings:set', { key: 'activity_log_enabled', value: true });
  await ipc(win, 'settings:set', { key: 'terminal_engine', value: 'xterm' });
  await ipc(win, 'settings:set', { key: 'default_cli_profiles', value: [] });
  await ipc(win, 'roots:add', { path: root });
  const { id } = await project(win, projectName);
  const defaultAgent = isHost ? HOST_AGENT : VIEWER_AGENT;
  const primaryArgv = ['/bin/bash', markerScript, `${side}_PRIMARY_SHELL`];
  const altArgv = ['/bin/bash', markerScript, `${side}_ALTERNATE_SHELL`];
  await ipc(win, 'projects:update-config', {
    id,
    config: {
      cliProfiles: [{ name: defaultAgent, argv: primaryArgv }, ...(isHost ? [{ name: HOST_ALT, argv: altArgv }] : [])],
      defaultCliName: defaultAgent,
      env: { E2E_WORKSPACE_ENV: `${side}-project-environment` },
    },
  });
  return { app, win, home, path, id, altArgv };
}

function destination(pane: Locator, name: 'Shell' | 'Files' | 'Diff' | 'Settings' | 'Activity'): Locator {
  return pane.getByRole('button', { name, exact: true });
}

async function selectDestination(pane: Locator, name: Parameters<typeof destination>[1]): Promise<void> {
  const button = destination(pane, name);
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
}

/** Chips carry no tab role (AC22): select by test id, and read the active state from the shared class. */
function chips(header: Locator): Locator {
  return header.getByTestId(SHELL_TAB_TEST_ID);
}

function chip(header: Locator, shellIndex: number): Locator {
  return header.locator(`[data-testid="${SHELL_TAB_TEST_ID}"][data-shell-index="${shellIndex}"]`);
}

const ACTIVE_CHIP = new RegExp(REMOTE_ACTIVE_CHIP_CLASS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

async function chipIndexes(header: Locator): Promise<number[]> {
  const all = await chips(header).evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-shell-index'))));
  return all.sort((a, b) => a - b);
}

async function expectShellOutput(win: Page, marker: string): Promise<void> {
  await expect.poll(async () => (await terminalProbes(win)).map((probe) => probe.screen).join('\n'),
    { message: `viewer renders host PTY output: ${marker}`, timeout: 15_000 }).toContain(marker);
}

function diffRow(panel: Locator, file: string, group: 'staged' | 'unstaged' | 'untracked'): Locator {
  return panel.getByTestId(DIFF_TESTIDS.row).and(panel.locator(`[data-group="${group}"][data-path="${file}"]`));
}

async function pairedPeer(win: Page, name: string): Promise<FleetEntry> {
  async function lookup(): Promise<FleetEntry | undefined> {
    const { fleet } = await ipc(win, 'p2p:fleet-list', undefined);
    return fleet.find((entry) => entry.name === name);
  }
  await expect.poll(lookup, { message: `paired Fleet entry for ${name}` }).toBeDefined();
  const peer = await lookup();
  if (!peer) throw new Error(`Paired Fleet entry disappeared: ${name}`);
  return peer;
}

test('paired Electron Shell works without a grant; other workspace tabs require host permission', async () => {
  test.skip(process.platform === 'win32', 'Fixture shell markers use /bin/bash, like the POSIX Electron harness');
  test.setTimeout(120_000);
  const relay = await startLoopbackRelay();
  try {
    const { host, viewer } = await guardedLaunch(async (scope) => {
      const host = await launchPeer(scope, relay.port, 'HOST');
      const viewer = await launchPeer(scope, relay.port, 'VIEWER');
      expect(viewer.app.process().pid, 'independent Electron mains despite the single-instance lock').not.toBe(host.app.process().pid);
      expect(viewer.id, 'fixture must catch fallbacks to a local project with the same numeric ID').toBe(host.id);
      await expect.poll(() => relay.registered.size, { timeout: 10_000, message: 'both apps registered with the loopback relay' }).toBe(2);
      const { code } = await ipc(host.win, 'p2p:pair-generate-code', undefined);
      expect(relay.registered.has(code), 'host pair code belongs to this relay').toBe(true);
      expect(await ipc(viewer.win, 'p2p:pair-redeem-code', { code }), 'real desktop pairing over WebRTC and Noise').toEqual({ ok: true });
      return { host, viewer };
    }, 65_000);
    try {
      const win = viewer.win;
      const viewerOnHost = await pairedPeer(host.win, VIEWER_NAME);
      const hostOnViewer = await pairedPeer(win, HOST_NAME);
      expect(viewerOnHost.workspaceAccess, 'pairing does not grant workspace access on the host').toBe(false);
      const readHostNotes = () => ipc(win, 'p2p:rpc-call', {
        deviceId: hostOnViewer.deviceId, method: 'workspace.fileRead', params: { projectId: host.id, relPath: NOTES },
      });
      const localHeader = win.getByTestId(DIFF_TESTIDS.tabBar);
      const localRow = win.getByTestId('project-row').getByText(VIEWER_PROJECT, { exact: true }).first();
      await localRow.click();
      await selectDestination(localHeader, 'Files');
      await win.getByTestId('file-entry').filter({ hasText: NOTES }).click();
      await expect(win.getByTestId('file-preview')).toContainText(VIEWER_ORIGINAL);
      const localConfigBefore = (await project(win, VIEWER_PROJECT)).config;
      const localGitBefore = porcelain(viewer.path);
      const localLogBefore = readFileSync(join(viewer.path, '.metaide', 'activity.jsonl'), 'utf8');
      expect(localConfigBefore).toMatchObject({
        defaultCliName: VIEWER_AGENT,
        cliProfiles: [expect.objectContaining({ name: VIEWER_AGENT })],
      });
      expect(localGitBefore).toContainEqual({ xy: '??', path: 'viewer-untracked.txt' });
      expect(localLogBefore).toContain(VIEWER_ACTIVITY);

      const primary = await ipc(host.win, 'shells:launch', { projectId: host.id });
      const alternate = await ipc(host.win, 'shells:launch-cli', { projectId: host.id, argv: host.altArgv });
      expect(alternate.shellIndex).not.toBe(primary.shellIndex);
      await waitForShell(host.win, host.id, alternate.shellIndex, 'HOST_ALTERNATE_SHELL');

      const machines = win.getByRole('tablist', { name: 'Machines', exact: true });
      await machines.getByRole('tab', { name: /^Fleet Fixture Host(?:,|$)/ }).click({ timeout: 15_000 });
      const machineList = win.getByTestId(MACHINE_TESTIDS.remoteList);
      await expect(machineList.getByTestId(MACHINE_TESTIDS.remoteHeader).getByText('online', { exact: true }))
        .toBeVisible({ timeout: 15_000 });
      const hostRow = machineList.getByTestId(MACHINE_TESTIDS.remoteFolders)
        .getByTestId(MACHINE_TESTIDS.remoteProjectRow).filter({ has: win.getByText(HOST_PROJECT, { exact: true }) });
      await expect(hostRow, 'paired machine lists the host project').toBeVisible({ timeout: 10_000 });
      await hostRow.click();
      // AC1/AC2: identity, Close and destinations live in the header row, not in the pane body.
      const pane = win.getByTestId(REMOTE_PANE_TESTIDS.pane);
      const header = win.getByTestId(REMOTE_PANE_TESTIDS.header);
      await expect(header).toBeVisible();
      await expect(header).toHaveClass(/workspace-header-row/);
      await expect(localHeader, 'local header row is not rendered while a remote pane is open').toBeHidden();
      await expect(header.getByText(`${HOST_PROJECT} @ ${HOST_NAME}`, { exact: true })).toBeVisible();
      await expect(header.locator('.workspace-project-actions')).toContainText(`${HOST_PROJECT} @ ${HOST_NAME}`);
      await expect(pane.getByText(`${HOST_PROJECT} @ ${HOST_NAME}`, { exact: true }), 'identity is not inside the pane').toHaveCount(0);
      await expect(header.locator('.workspace-destinations')).toBeVisible();
      await expect(pane.locator('.workspace-destinations'), 'pane has no destinations of its own in-app').toHaveCount(0);
      await expect(pane.locator('.shell-tabs-bar'), 'pane has no tabs bar of its own in-app').toHaveCount(0);
      const unavailable = pane.getByRole('status').filter({ hasText: 'Workspace access unavailable' });
      const closePane = header.getByRole('button', { name: 'Close remote project', exact: true });
      await expect(closePane).toBeVisible();
      await expect(pane.getByRole('button', { name: 'Close remote project', exact: true })).toHaveCount(0);
      await expect(unavailable).toBeVisible({ timeout: 10_000 });
      await expect(destination(header, 'Activity')).toBeHidden();
      await expect(destination(header, 'Shell')).toHaveAttribute('aria-current', 'page');
      // AC9: the same ShellTabsBar as local, a direct child of the header row, with host chips and no tab roles.
      await expect(header.locator('.shell-tabs-bar')).toBeVisible();
      await expect(header.locator(':scope > .shell-tabs-bar'), 'tabs bar is a direct child of the row').toHaveCount(1);
      await expect(chip(header, alternate.shellIndex)).toBeVisible({ timeout: 10_000 });
      await expect(chip(header, primary.shellIndex)).toBeVisible();
      await expect(header.getByRole('tab'), 'remote chips have no tab role').toHaveCount(0);
      await expectShellOutput(win, 'HOST_PRIMARY_SHELL');
      await expect(readHostNotes()).rejects.toThrow(/workspace access requires a grant from the host/i);

      expect(await ipc(host.win, 'p2p:set-workspace-access', { deviceId: viewerOnHost.deviceId, allowed: true }))
        .toEqual({ ok: true });
      expect((await pairedPeer(host.win, VIEWER_NAME)).workspaceAccess).toBe(true);
      // Reopening requests capabilities now rather than waiting for the denial backoff.
      await closePane.click();
      await expect(pane).toBeHidden();
      await hostRow.click();
      await expect(destination(header, 'Activity')).toBeVisible({ timeout: 10_000 });
      await expect(unavailable).toBeHidden();
      const alternateTab = chip(header, alternate.shellIndex);
      const primaryTab = chip(header, primary.shellIndex);
      await alternateTab.click();
      await expect(alternateTab).toHaveClass(ACTIVE_CHIP);
      await expect(primaryTab, 'positive control: inactive chip lacks the active class').not.toHaveClass(ACTIVE_CHIP);
      await expectShellOutput(win, 'HOST_ALTERNATE_SHELL');

      // AC11: open a tab through + > Terminal. The new chip appears selected without waiting for the host list.
      const before = await chipIndexes(header);
      await header.getByTestId('tabbar-new-shell').click();
      await win.getByRole('button', { name: /^.{0,4}Terminal\s+(Ctrl|⌘)/ }).click();
      await expect.poll(async () => (await chipIndexes(header)).length, { message: 'new chip appears' }).toBe(before.length + 1);
      const opened = (await chipIndexes(header)).find((index) => !before.includes(index));
      if (opened === undefined) throw new Error('No new remote chip found after opening a Terminal');
      const openedTab = chip(header, opened);
      await expect(openedTab).toHaveClass(ACTIVE_CHIP);
      await expect(alternateTab, 'previously active chip is no longer active').not.toHaveClass(ACTIVE_CHIP);
      // Close it with the chip's x. The shown chip goes away and a remaining one takes over.
      await openedTab.hover();
      await openedTab.getByRole('button', { name: /^Close /i }).click();
      await expect(openedTab).toHaveCount(0);
      await expect.poll(() => chipIndexes(header), { message: 'only the original chips remain' }).toEqual(before);
      await alternateTab.click();
      await expect(alternateTab).toHaveClass(ACTIVE_CHIP);
      await expectShellOutput(win, 'HOST_ALTERNATE_SHELL');

      await selectDestination(header, 'Files');
      // AC4: no tabs bar on a non-Shell destination (positive control: it is present on Shell, asserted above).
      await expect(header.locator('.shell-tabs-bar')).toHaveCount(0);
      await expect(pane.getByTestId('file-entry').filter({ hasText: ACTIVITY_TARGET })).toBeVisible();
      await expect(pane.getByTestId('file-entry').filter({ hasText: VIEWER_ACTIVITY })).toHaveCount(0);
      await pane.getByTestId('file-entry').filter({ hasText: NOTES }).click();
      const preview = pane.getByTestId('file-preview');
      await expect(preview).toContainText(HOST_ORIGINAL);
      await expect(preview).not.toContainText(VIEWER_ORIGINAL);
      await preview.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = preview.getByRole('textbox');
      await expect(editor).toHaveValue(`${HOST_ORIGINAL}\n`);
      await editor.fill(`${HOST_SAVED}\n`);
      await preview.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => readFileSync(join(host.path, NOTES), 'utf8'), { message: 'save reaches host disk' }).toBe(`${HOST_SAVED}\n`);

      await selectDestination(header, 'Shell');
      await expect(header.locator('.shell-tabs-bar')).toBeVisible();
      await expect(alternateTab).toHaveClass(ACTIVE_CHIP);
      await expectShellOutput(win, 'HOST_ALTERNATE_SHELL');

      await selectDestination(header, 'Diff');
      const diff = pane.getByTestId(DIFF_TESTIDS.panel);
      await expect(diffRow(diff, 'host-staged.txt', 'staged')).toBeVisible();
      await expect(diffRow(diff, 'host-untracked.txt', 'untracked')).toBeVisible();
      await expect(diffRow(diff, 'viewer-untracked.txt', 'untracked')).toHaveCount(0);
      const savedChange = diffRow(diff, NOTES, 'unstaged');
      await savedChange.click();
      await expect(savedChange).toHaveAttribute('aria-current', /^(?!false$).+/);
      await expect(diff.getByTestId(DIFF_TESTIDS.sideOld)).toContainText(HOST_ORIGINAL);
      await expect(diff.getByTestId(DIFF_TESTIDS.sideNew)).toContainText(HOST_SAVED);
      writeFileSync(join(host.path, 'host-refresh.txt'), 'HOST added while Diff is open\n');
      await diff.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(diffRow(diff, 'host-refresh.txt', 'untracked')).toBeVisible();
      await expect(savedChange).toHaveAttribute('aria-current', /^(?!false$).+/);

      await selectDestination(header, 'Settings');
      const agent = pane.getByRole('combobox', { name: 'Default agent', exact: true });
      await expect(agent.locator('option:checked')).toHaveText(HOST_AGENT);
      await expect(agent.locator('option').filter({ hasText: VIEWER_AGENT })).toHaveCount(0);
      await expect(pane.getByTestId(ENV_TESTIDS.panel)).toHaveCount(0);
      await agent.selectOption({ label: HOST_ALT });
      await expect.poll(async () => (await project(host.win, HOST_PROJECT)).config.defaultCliName,
        { message: 'remote settings write persists in host database' }).toBe(HOST_ALT);

      await selectDestination(header, 'Activity');
      const activity = pane.getByTestId('activity-tab');
      const target = activity.getByRole('button', { name: ACTIVITY_TARGET, exact: true });
      await expect(target).toBeVisible();
      await expect(activity.getByText(VIEWER_ACTIVITY, { exact: true })).toHaveCount(0);
      appendFileSync(join(host.path, '.metaide', 'activity.jsonl'), `${JSON.stringify({
        id: 'host-prompt', ts: '2026-11-14T09:01:00.000Z', agent: 'claude', shellIndex: 0,
        kind: 'prompt', text: LIVE_ACTIVITY,
      })}\n`);
      await expect(activity.getByText(LIVE_ACTIVITY, { exact: true })).toBeVisible({ timeout: 10_000 });
      await target.click();
      await expect(destination(header, 'Files')).toHaveAttribute('aria-current', 'page');
      await expect(preview).toContainText(ACTIVITY_CONTENT);

      await ipc(host.win, 'settings:set', { key: 'activity_log_enabled', value: false });
      await expect(destination(header, 'Activity')).toBeHidden({ timeout: 10_000 });

      // AC15: closing the last tab leaves the empty state; a shell opened on the host later appears and attaches.
      await selectDestination(header, 'Shell');
      const noShells = pane.getByTestId(REMOTE_PANE_TESTIDS.noShells);
      await expect(noShells, 'positive control: empty state absent while chips exist').toHaveCount(0);
      for (const index of await chipIndexes(header)) {
        const target = chip(header, index);
        await target.hover();
        await target.getByRole('button', { name: /^Close /i }).click();
        await expect(target).toHaveCount(0);
      }
      await expect(noShells).toBeVisible({ timeout: 10_000 });
      await expect(noShells).toContainText(`No terminals open on ${HOST_NAME}. Use + to open one.`);
      await expect(chips(header)).toHaveCount(0);
      const relaunchedArgv = [...host.altArgv.slice(0, 2), 'HOST_RELAUNCHED_SHELL'];
      const relaunched = await ipc(host.win, 'shells:launch-cli', { projectId: host.id, argv: relaunchedArgv });
      await expect(chip(header, relaunched.shellIndex)).toBeVisible({ timeout: 15_000 });
      await expect(noShells).toHaveCount(0);
      await expectShellOutput(win, 'HOST_RELAUNCHED_SHELL');

      expect(await ipc(host.win, 'p2p:set-workspace-access', { deviceId: viewerOnHost.deviceId, allowed: false }))
        .toEqual({ ok: true });
      expect((await pairedPeer(host.win, VIEWER_NAME)).workspaceAccess).toBe(false);
      await expect(readHostNotes()).rejects.toThrow(/workspace access requires a grant from the host/i);
      await selectDestination(header, 'Shell');
      await expectShellOutput(win, 'HOST_RELAUNCHED_SHELL');

      await closePane.click();
      await expect(pane).toBeHidden();
      await expect(header).toBeHidden();
      await expect(localHeader).toBeVisible();
      await expect(destination(localHeader, 'Files')).toHaveAttribute('aria-current', 'page');
      await expect(destination(localHeader, 'Activity')).toBeVisible();
      await win.getByTestId('file-entry').filter({ hasText: NOTES }).click();
      await expect(win.getByTestId('file-preview')).toContainText(VIEWER_ORIGINAL);
      expect(readFileSync(join(viewer.path, NOTES), 'utf8')).toBe(`${VIEWER_ORIGINAL}\n`);
      expect(readFileSync(join(viewer.path, '.metaide', 'activity.jsonl'), 'utf8')).toBe(localLogBefore);
      expect(porcelain(viewer.path)).toEqual(localGitBefore);
      expect((await project(win, VIEWER_PROJECT)).config).toEqual(localConfigBefore);
      expect(relay.errors, 'no signaling fixture protocol errors').toEqual([]);
    } finally {
      await Promise.all([closeApp(viewer.app), closeApp(host.app)]);
      for (const home of [viewer.home, host.home]) rmSync(home, { recursive: true, force: true });
    }
  } finally {
    await relay.close();
  }
});
