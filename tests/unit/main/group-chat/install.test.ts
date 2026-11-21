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
  const pty = new FakePty();
  const states: AgentShellStateEntry[] = [{ projectId: project.id, shellIndex: 0, agent: 'claude', state: 'idle' }];
  const listeners: HookListener[] = [];
  const events: Array<{ ch: string; payload: unknown }> = [];
  const services = {
    db, projects, ptyManager: pty, homeDir: home,
    agentStatus: { list: () => states },
    metaproject: { currentUserName: () => 'Martin' },
  } as unknown as Services;
  const installed = installGroupChat({
    services,
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

  it('a Claude member answers from a Stop hook with a valid transcript; a bad path is ignored', async () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.hook({ claudeSessionId: 'S1' });
    const g = s.svc.create(s.project.id, { claudeShell: { projectId: s.project.id, shellIndex: 0 } });
    s.svc.say(g.id, 'hello group');
    await until(() => s.pty.writes.length === 2);
    const pasted = s.pty.writes[0]!.data;
    expect(pasted.startsWith('\x1b[200~[Group chat "Group chat 1" in shop')).toBe(true);
    expect(s.pty.writes[1]!.data).toBe('\r');

    const header = pasted.slice('\x1b[200~'.length).split('\n')[0]!;
    const transcript = [
      JSON.stringify({ type: 'user', message: { content: `${header}\nrest` } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi from claude' }] } }),
    ].join('\n');
    const outside = join(s.home, 'elsewhere.jsonl');
    writeFileSync(outside, transcript);
    s.hook({ hookEventName: 'Stop', claudeSessionId: 'S1', transcriptPath: outside });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.svc.list(s.project.id)[0]!.log.some((e) => e.kind === 'reply')).toBe(false);

    const dir = join(s.home, '.claude', 'projects', 'shop');
    mkdirSync(dir, { recursive: true });
    const inside = join(dir, 'S1.jsonl');
    writeFileSync(inside, transcript);
    s.hook({ hookEventName: 'Stop', claudeSessionId: 'OTHER', transcriptPath: inside });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.svc.list(s.project.id)[0]!.log.some((e) => e.kind === 'reply')).toBe(false);

    s.hook({ hookEventName: 'Stop', claudeSessionId: 'S1', transcriptPath: inside });
    await until(() => s.svc.list(s.project.id)[0]!.log.some((e) => e.kind === 'reply' && e.text === 'hi from claude'));
  });

  it('PTY exit fails the running Claude turn and forgets the shell’s session', async () => {
    const s = setup();
    cleanup.push(() => s.installed.stop());
    s.hook({ claudeSessionId: 'S1' });
    const g = s.svc.create(s.project.id, { claudeShell: { projectId: s.project.id, shellIndex: 0 } });
    s.svc.say(g.id, 'go');
    await until(() => s.pty.writes.length === 2);
    s.pty.emit('exit', { projectId: s.project.id, shellIndex: 0, code: 0 });
    await until(() => s.svc.list(s.project.id)[0]!.log.some((e) => e.kind === 'fail' && /closed/.test(e.text)));
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
    s.hook({ claudeSessionId: 'S1' });
    const g = s.svc.create(s.project.id, { claudeShell: { projectId: s.project.id, shellIndex: 0 } });
    s.svc.say(g.id, 'hello');
    await until(() => s.pty.writes.length === 2);
    expect(s.pty.writes[0]!.data).toContain('\nMartin: hello\n');
  });
});
