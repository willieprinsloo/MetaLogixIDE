/**
 * Wires group chats into the running app: builds GroupChatService over the real PTYs, Claude hooks,
 * agent status and engine CLIs, attaches it to `services.groupChat`, and returns a handle whose
 * `stop()` (app quit) disposes it.
 *
 * - Which Claude conversation each shell holds comes from its hook events' `session_id`; a spawn
 *   or exit forgets it (the next hook tells us the new one). It's only used when a tab is added
 *   (or refreshed) as a member: that conversation is what the member forks.
 * - A Claude member runs headless (`claude -p`) on its own fork of that conversation, like GPT
 *   runs `codex exec`: nothing is typed into the user's tab, so /clear, a closed tab, a restart
 *   or a half-typed prompt there can't break a round.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Services } from '@main/services';
import type { HookSource } from '@main/claude-hooks/hook-fanout';
import { GroupsRepo, type MemberRecord } from '@main/repos/groups-repo';
import { isClaudePermissionMode } from '@shared/claude-permission-mode';
import { GroupChatService } from './service';
import { headlessTurn } from './members';
import { npmCli } from './engines/cli';
import { claudeArgs, claudeProgress, parseClaude } from './engines/claude';
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
  /** How to start Claude Code (tests pass a stand-in); default: the npm-installed `claude`. */
  claudeCmd?: string[];
}): InstalledGroupChat {
  const { services } = o;
  const pty = services.ptyManager;
  const sessions = new Map<string, string>();
  const claudeCmd = o.claudeCmd ?? npmCli('@anthropic-ai/claude-code', 'claude');
  const codexCmd = npmCli('@openai/codex', 'codex');
  const geminiCmd = npmCli('@google/gemini-cli', 'gemini');

  const liveClaudeShells = (projectId: number) =>
    (services.agentStatus?.list() ?? [])
      .filter((e) => e.agent === 'claude' && e.projectId === projectId)
      .map((e) => ({ projectId: e.projectId, shellIndex: e.shellIndex, title: `Claude tab ${e.shellIndex + 1}` }));
  const claudeSessionOf = (s: Shell) => sessions.get(keyOf(s)) ?? null;

  o.hooks.onHook((hook) => {
    const sid = hook.event.claudeSessionId;
    if (sid) sessions.set(keyOf(hook.shell), sid);
  });

  // the same permission choice the app's Claude tabs use (headless Claude can't ask)
  const permission = () => {
    const m = services.settings.get('claude_permission_mode');
    return isClaudePermissionMode(m) ? m : 'auto';
  };
  const runClaude = (rec: ClaudeRecord, cwd: string, item: TurnItem, signal: AbortSignal): Promise<TurnResult> =>
    runCliTurn({
      cmd: claudeCmd,
      args: claudeArgs({ forkFrom: rec.claudeSessionId, engineSession: rec.groupSession ?? null, permission: permission() }),
      cwd, text: item.text, progress: claudeProgress(), parse: parseClaude, signal,
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
    // Metaproject is no longer a declared field on Services (Frits PR #16 moved it into the shared session
    // service). We still read a `currentUserName()` here when it's been injected (unit tests do), so the group
    // chat's "Martin: …" turn label works. In production the shared session will eventually feed the display
    // name through; for now we fall back to 'You'.
    userName: () => {
      const injected = (services as unknown as { metaproject?: { currentUserName?: () => string | null } }).metaproject;
      return injected?.currentUserName?.() || 'You';
    },
    projectName: (id) => services.projects.get(id)?.name ?? `project ${id}`,
    projectPath: (id) => services.projects.get(id)?.path ?? process.cwd(),
    claudeSessionOf,
    liveClaudeShells,
    onChange: (projectId) => o.broadcast('groups:changed', { projectId }),
    engines: () => detectEngines({ ollamaBase: OLLAMA_BASE, codex: codexCmd, gemini: geminiCmd, fetch, version }),
    claudeTurn: (rec, cwd) => headlessTurn({ run: (item, signal) => runClaude(rec, cwd, item, signal) }, {}),
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
