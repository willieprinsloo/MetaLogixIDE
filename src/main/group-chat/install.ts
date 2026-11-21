/**
 * Wires group chats into the running app: builds GroupChatService over the real PTYs, Claude hooks,
 * agent status and engine CLIs, attaches it to `services.groupChat`, and returns a handle whose
 * `stop()` (app quit) disposes it.
 *
 * - Which Claude conversation each shell holds comes from its hook events' `session_id`; a spawn
 *   or exit forgets it (the next hook tells us the new one).
 * - Stop hooks reach a Claude member's turn only when they come from that member's session and
 *   their `transcript_path` is a `.jsonl` under `~/.claude/projects`.
 * - Round messages are typed with `writeFromApp`, so they never count as the user's typing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log/main';
import type { Services } from '@main/services';
import type { HookSource } from '@main/claude-hooks/hook-fanout';
import { isClaudeTranscriptPath } from '@main/claude-hooks/hook-event';
import { GroupsRepo, type MemberRecord } from '@main/repos/groups-repo';
import { GroupChatService } from './service';
import { claudeTabTurn, headlessTurn } from './members';
import { readGroupAnswer } from './transcript';
import { npmCli } from './engines/cli';
import { codexArgs, codexProgress, parseCodex } from './engines/codex';
import { geminiArgs, geminiProgress, parseGemini } from './engines/gemini';
import { OLLAMA_BASE, runOllama } from './engines/ollama';
import { runCliTurn } from './engines/run-cli';
import { detectEngines } from './engines/status';
import type { TurnItem, TurnResult } from './engines/types';

type Shell = { projectId: number; shellIndex: number };
type ClaudeRecord = Extract<MemberRecord, { kind: 'claude-tab' }>;
type HeadlessRecord = Extract<MemberRecord, { kind: 'headless' }>;

const VERSION_TIMEOUT_MS = 10_000;
const keyOf = (s: Shell) => `${s.projectId}:${s.shellIndex}`;

export interface InstalledGroupChat { service: GroupChatService; stop(): void }

export function installGroupChat(o: {
  services: Services;
  hooks: HookSource;
  broadcast: (channel: string, payload: unknown) => void;
}): InstalledGroupChat {
  const { services } = o;
  const pty = services.ptyManager;
  const sessions = new Map<string, string>();
  const stopListeners = new Set<{ sid: string; cb: (path: string) => void }>();
  const codexCmd = npmCli('@openai/codex', 'codex');
  const geminiCmd = npmCli('@google/gemini-cli', 'gemini');

  const liveClaudeShells = (projectId: number) =>
    (services.agentStatus?.list() ?? [])
      .filter((e) => e.agent === 'claude' && e.projectId === projectId)
      .map((e) => ({ projectId: e.projectId, shellIndex: e.shellIndex, title: `Claude tab ${e.shellIndex + 1}` }));
  const claudeSessionOf = (s: Shell) => sessions.get(keyOf(s)) ?? null;
  const shellFor = (rec: ClaudeRecord): Shell | null => {
    const sh = liveClaudeShells(rec.projectId).find((s) => claudeSessionOf(s) === rec.claudeSessionId);
    return sh ? { projectId: sh.projectId, shellIndex: sh.shellIndex } : null;
  };

  o.hooks.onHook((hook) => {
    const sid = hook.event.claudeSessionId;
    if (!sid) return;
    sessions.set(keyOf(hook.shell), sid);
    const path = hook.event.transcriptPath;
    if (hook.event.hookEventName !== 'Stop' || !path) return;
    if (!isClaudeTranscriptPath(path, services.homeDir)) { log.warn('[group-chat] ignored a Stop hook with an unexpected transcript path'); return; }
    for (const l of [...stopListeners]) if (l.sid === sid) l.cb(path);
  });

  const runEngine = (rec: HeadlessRecord, cwd: string, item: TurnItem, signal: AbortSignal): Promise<TurnResult> => {
    switch (rec.engine) {
      case 'codex':
        return runCliTurn({ cmd: codexCmd, args: codexArgs(item), cwd, text: item.text, progress: codexProgress(), parse: parseCodex, signal });
      case 'gemini':
        return runCliTurn({ cmd: geminiCmd, args: geminiArgs(item), cwd, text: item.text, progress: geminiProgress(), parse: parseGemini, signal });
      case 'ollama':
        if (!item.model) return Promise.resolve({ ok: false, reply: '', error: 'pick an Ollama model for this member' });
        return runOllama({ ...item, model: item.model }, { signal });
    }
  };

  const execFileAsync = promisify(execFile);
  const version = async (cmd: string[], args: string[]): Promise<string> =>
    (await execFileAsync(cmd[0]!, [...cmd.slice(1), ...args], { timeout: VERSION_TIMEOUT_MS, windowsHide: true })).stdout;

  const service = new GroupChatService({
    repo: new GroupsRepo(services.db),
    userName: () => services.metaproject?.currentUserName?.() || 'You',
    projectName: (id) => services.projects.get(id)?.name ?? `project ${id}`,
    projectPath: (id) => services.projects.get(id)?.path ?? process.cwd(),
    claudeSessionOf,
    liveClaudeShells,
    onChange: (projectId) => o.broadcast('groups:changed', { projectId }),
    engines: () => detectEngines({ ollamaBase: OLLAMA_BASE, codex: codexCmd, gemini: geminiCmd, fetch, version }),
    claudeTurn: (rec) => claudeTabTurn({
      shell: () => shellFor(rec),
      state: (sh) => services.agentStatus?.list().find((e) => e.projectId === sh.projectId && e.shellIndex === sh.shellIndex)?.state ?? null,
      screenRows: (sh) => pty.liveStatus(sh.projectId, sh.shellIndex).then((s) => s.rows, () => []),
      lastUserInputAt: (sh) => pty.lastInputAt(sh.projectId, sh.shellIndex),
      write: (sh, data) => pty.writeFromApp(sh.projectId, sh.shellIndex, data),
      onStop: (cb) => { const l = { sid: rec.claudeSessionId, cb }; stopListeners.add(l); return () => { stopListeners.delete(l); }; },
      readAnswer: readGroupAnswer,
      now: Date.now,
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    }),
    headlessTurn: (rec, cwd) => headlessTurn(
      { run: (item, signal) => runEngine(rec, cwd, item, signal) },
      { model: rec.model, engineSession: rec.engineSession, history: [...rec.history] },
    ),
  });

  const forget = (ev: Shell) => { sessions.delete(keyOf(ev)); };
  const onExit = (ev: Shell) => { forget(ev); service.shellGone(ev); };
  pty.on('spawn', forget);
  pty.on('exit', onExit);
  services.groupChat = service;

  return {
    service,
    stop() {
      pty.off('spawn', forget);
      pty.off('exit', onExit);
      service.dispose();
    },
  };
}
