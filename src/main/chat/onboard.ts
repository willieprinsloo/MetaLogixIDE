/**
 * Project-memory bootstrap. The first time a shell for a supported CLI
 * launches in a project, metaIDE drops a small stanza into that CLI's
 * project-conventions file so the agent knows how to read + reply
 * through the chat bus. Idempotent: the marker `# metaide-chat-bus@v1`
 * gates the write.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER = '# metaide-chat-bus@v2';

const STANZA = [
  '',
  MARKER,
  '## metaIDE chat bus',
  '',
  'When you see a line like `[metaide-chat from=@claude@mymac reply=- ] <body>` arrive on your input, that is a message from another agent or a human in this project. The sender is in the `from=` field (e.g. `@human`, `@codex`, `@claude-reviewer`).',
  '',
  'To reply — to tell the user what you are doing, or to ask another agent for help — append ONE JSON line (no pretty-printing, no code fence) to `.metaide/chat-outbox.jsonl`. metaIDE tails that file and delivers each line to the chat pane and to every `@`-mentioned agent\'s shell.',
  '',
  'Minimal shape:',
  '    {"from":{"agent":"<your-family>","shell":0},"to":[{"agent":"human"}],"body":"on it"}',
  '',
  '- `from.agent` is your CLI family (`claude`, `codex`, `ollama`, …). Use the family metaIDE already shows for you in the Agents pane — do NOT invent names.',
  '- `from.shell` is the shell index of this session; if you don\'t know it, 0 is a safe default.',
  '- `to` is an array of recipients: `{"agent":"human"}` for the user, `{"agent":"claude"}` for every Claude shell, `{"agent":"all"}` for everyone.',
  '- `body` is your message. Keep it short — one or two sentences is ideal.',
  '',
  'Example — append a progress update visible to the user:',
  '    bash: echo \'{"from":{"agent":"claude","shell":0},"to":[{"agent":"human"}],"body":"finished pass 1, starting pass 2"}\' >> .metaide/chat-outbox.jsonl',
  '',
  'Do not read this file back — metaIDE only ever appends; the file is the outbox, not a conversation log. The full history lives in `.metaide/chat.jsonl`, which you may read but should not write.',
  '',
].join('\n');

export type SupportedCli = 'claude' | 'codex' | 'opencode';

function targetFile(projectPath: string, cli: SupportedCli): string {
  switch (cli) {
    case 'claude':   return join(projectPath, 'CLAUDE.md');
    case 'codex':    return join(projectPath, 'AGENTS.md');
    case 'opencode': return join(projectPath, 'AGENTS.md');
  }
}

/**
 * One-line nudge metaIDE injects into a supported CLI's shell the first
 * time the chat-bus stanza is written to that project's conventions file.
 * The agent is already running and has long since read its conventions
 * file; without this push it never learns about the new section.
 *
 * Phrased as a direct instruction to the agent, not framed as an
 * `[metaide-chat …]` protocol line — chat isn't established yet.
 */
export function buildOnboardingNudge(cli: SupportedCli): string {
  const file = cli === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  return `metaIDE just added a "metaIDE chat bus" section to ${file}. Please read that section so you can post status updates back through .metaide/chat-outbox.jsonl.`;
}

export interface NudgePtyDep {
  write(projectId: number, shellIndex: number, data: string): void;
}

/**
 * Deliver the nudge body as one bracketed-paste chunk + a separate CR,
 * exactly like the chat injector. The 40 ms gap lets Ink / Codex register
 * the paste before the Enter keystroke, so the whole line submits on
 * both TUIs. Caller is responsible for the gate (don't double-nudge).
 */
export function nudgeAgentShell(pty: NudgePtyDep, projectId: number, shellIndex: number, body: string): void {
  const bracketed = `\x1b[200~${body}\x1b[201~`;
  pty.write(projectId, shellIndex, bracketed);
  setTimeout(() => { pty.write(projectId, shellIndex, '\r'); }, 40);
}

export function ensureAgentStanza(projectPath: string, cli: SupportedCli): { file: string; appended: boolean } {
  const file = targetFile(projectPath, cli);
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(MARKER)) return { file, appended: false };
      writeFileSync(file, text + (text.endsWith('\n') ? '' : '\n') + STANZA);
      return { file, appended: true };
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, STANZA.trimStart());
    return { file, appended: true };
  } catch (err) {
    console.warn('[chat] onboard write failed', { file, err });
    return { file, appended: false };
  }
}
