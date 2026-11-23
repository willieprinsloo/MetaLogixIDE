import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '@main/db/connection';
import { runMigrations } from '@main/db/migrator';
import { RootsRepo } from '@main/repos/roots-repo';
import { ProjectsRepo } from '@main/repos/projects-repo';
import { installGroupChat } from '@main/group-chat/install';
import type { Services } from '@main/services';
import type { ReceivedHook, HookListener } from '@main/claude-hooks/receiver';
import type { AgentShellStateEntry } from '@shared/agent-state';

const migrationsDir = resolve(__dirname, '../../../../migrations');
const FAKE_CLAUDE = [process.execPath, resolve(__dirname, 'engines', 'fake-claude.cjs')];
const TAB_SID = '11111111-2222-4333-8444-555555555555';

class FakePty extends EventEmitter {
  writes: Array<{ projectId: number; shellIndex: number; data: string }> = [];
  rows = ['────', '❯ ', '────'];
  writeFromApp(projectId: number, shellIndex: number, data: string) { this.writes.push({ projectId, shellIndex, data }); }
  lastInputAt() { return 0; }
  async liveStatus() { return { rows: this.rows, title: 'Claude Code' }; }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'gc-home-'));
  const db = openDb(join(home, 'db'));
  runMigrations(db, migrationsDir);
  const root = new RootsRepo(db).add(join(home, 'root'));
  const projects = new ProjectsRepo(db);
  const project = projects.upsert(root.id, join(home, 'root', 'shop'), 'shop');
  mkdirSync(project.path, { recursive: true }); // members run in the project folder
  const pty = new FakePty();
  const states: AgentShellStateEntry[] = [{ projectId: project.id, shellIndex: 0, agent: 'claude', state: 'idle' }];
  const listeners: HookListener[] = [];
  const events: Array<{ ch: string; payload: unknown }> = [];
  const services = {
    db, projects, ptyManager: pty, homeDir: home,
    agentStatus: { list: () => states },
    metaproject: { currentUserName: () => 'Martin' },
    settings: { get: (k: string) => (k === 'claude_permission_mode' ? 'auto' : null) },
  } as unknown as Services;
  const installed = installGroupChat({
    services,
    claudeCmd: FAKE_CLAUDE,
    hooks: { onHook: (l) => { listeners.push(l); } },
    broadcast: (ch, payload) => { events.push({ ch, payload }); },
  });
  const hook = (event: Partial<ReceivedHook['event']>, shellIndex = 0) => {
    const h: ReceivedHook = { sessionId: 'hook-1', shell: { projectId: project.id, shellIndex }, event: { hookEventName: 'UserPromptSubmit', notificationType: null, message: null, backgroundTaskCount: 0, ...event } };
    for (const l of listeners) void l(h);
  };
  return { home, project, pty, states, events, installed, svc: installed.service, hook };
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let cleanup: Array<() => void> = [];
afterEach(() => { for (const c of cleanup) c(); cleanup = []; });

describe('installGroupChat', () => {
  it('attaches the service to services.groupChat', () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    expect((s.installed as { service: unknown }).service).toBeTruthy();
  });

  it('hooks update the shell’s Claude session id', () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    expect(s.svc.joinableClaudeTabs(s.project.id)[0]).toMatchObject({ joinable: false });
    s.hook({ claudeSessionId: 'S1' });
    expect(s.svc.joinableClaudeTabs(s.project.id)[0]).toMatchObject({ joinable: true, title: 'Claude tab 1' });
  });

  const replies = (s: ReturnType<typeof setup>) => s.svc.list(s.project.id)[0]!.log.filter((e) => e.kind === 'reply');

  it('a Claude member answers through headless claude on a fork of the tab’s conversation; nothing is typed into the tab', async () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.hook({ claudeSessionId: TAB_SID });
    const g = s.svc.create(s.project.id, { claudeShell: { projectId: s.project.id, shellIndex: 0 } });
    s.svc.say(g.id, 'hello group');
    await until(() => replies(s).length === 1);
    const first = replies(s)[0]!.text;
    expect(first).toContain(`args: -p --output-format json --resume ${TAB_SID} --fork-session --permission-mode auto`);
    expect(first).toContain('input: [Group chat "Group chat 1" in shop');
    expect(s.pty.writes).toEqual([]);
  });

  it('later turns resume the group’s own copy, even after /clear in the tab', async () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.hook({ claudeSessionId: TAB_SID });
    const g = s.svc.create(s.project.id, { claudeShell: { projectId: s.project.id, shellIndex: 0 } });
    s.svc.say(g.id, 'one');
    await until(() => replies(s).length === 1);
    s.hook({ claudeSessionId: '99999999-0000-4000-8000-000000000000' }); // /clear in the tab
    s.svc.say(g.id, 'two');
    await until(() => replies(s).length === 2);
    expect(replies(s)[1]!.text).toContain('--resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --permission-mode auto');
    expect(replies(s)[1]!.text).not.toContain('--fork-session');
  });

  it('PTY exit forgets the shell’s session', () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.hook({ claudeSessionId: TAB_SID });
    s.pty.emit('exit', { projectId: s.project.id, shellIndex: 0, code: 0 });
    expect(s.svc.joinableClaudeTabs(s.project.id)[0]).toMatchObject({ joinable: false });
  });

  it('changes broadcast groups:changed with the project id', () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.svc.create(s.project.id, {});
    expect(s.events).toContainEqual({ ch: 'groups:changed', payload: { projectId: s.project.id } });
  });

  it('uses the signed-in user’s name in round messages', async () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.hook({ claudeSessionId: TAB_SID });
    const g = s.svc.create(s.project.id, { claudeShell: { projectId: s.project.id, shellIndex: 0 } });
    s.svc.say(g.id, 'hello');
    await until(() => replies(s).length === 1);
    expect(replies(s)[0]!.text).toContain('\nMartin: hello\n');
  });
});
