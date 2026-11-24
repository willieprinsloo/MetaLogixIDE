/**
 * Project-memory bootstrap. The first time a shell for a supported CLI
 * launches in a project, metaIDE drops a stanza into that CLI's
 * project-conventions file so the agent knows how to read + reply
 * through the chat bus, post its "what I'm doing" status, and follow
 * the newsroom writing rule.
 *
 * The marker `# metaide-chat-bus@vN` gates the write. When the file
 * already carries an older marker, the whole stanza below it is
 * replaced in-place — users get the latest wiring without duplicate
 * sections stacking up over time.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARKER = '# metaide-chat-bus@v3';
/** Matches any prior marker so the upgrade path can find + replace the
 *  old stanza block regardless of which version wrote it. */
const MARKER_ANY_RE = /^# metaide-chat-bus@v\d+\s*$/m;

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
  '## Status badge',
  '',
  'metaIDE shows a short "what I\'m doing" badge next to your name in the Agents pane. Update yours whenever your current task shifts, so a human scanning the window knows what you are on without opening the chat.',
  '',
  'Append ONE JSON line to `.metaide/intent-outbox.jsonl`:',
  '',
  '    {"from":{"agent":"claude","shell":0},"text":"writing tests for the rate badge"}',
  '',
  '- `text` is a short label — six words or so. The latest line per shell wins.',
  '- No `to` field: the badge is ambient, not addressed to anyone.',
  '- Send one when you START a chunk of work, not on every tool call. One update per minute is plenty.',
  '',
  'Example:',
  '    bash: echo \'{"from":{"agent":"claude","shell":0},"text":"refactoring auth middleware"}\' >> .metaide/intent-outbox.jsonl',
  '',
  '## Writing style',
  '',
  'When you post to the chat bus, or when you write a git commit message:',
  '',
  '- Lead with what a human would notice — a new button, a fixed error, nothing visible.',
  '- Plain language, roughly a 10th-grade reading level. No jargon unless the human asked a technical question.',
  '- One or two sentences is enough. "Invisible refactor" is a valid answer.',
  '- The commit\'s first line follows this rule; the body below the first blank line can be as technical as you like.',
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
 * time the chat-bus stanza is written OR when a version bump replaces an
 * older one. The agent is already running and has long since read its
 * conventions file; without this push it never learns about the new
 * section.
 *
 * Phrased as a direct instruction to the agent, not framed as an
 * `[metaide-chat …]` protocol line — chat isn't established yet.
 */
export function buildOnboardingNudge(cli: SupportedCli): string {
  const file = cli === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
  return `metaIDE just updated the "metaIDE chat bus" section in ${file}. Please re-read that section — it now covers a status-badge file (.metaide/intent-outbox.jsonl) and a writing-style rule for your chat and commit messages.`;
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

/**
 * Write-or-upgrade the chat-bus stanza. Three branches:
 *
 * 1. File missing — write STANZA (trimmed leading newline).
 * 2. File carries the CURRENT marker — no-op.
 * 3. File carries an older `metaide-chat-bus@v<N>` marker — truncate
 *    the file at that marker line and append the fresh STANZA. This
 *    assumes nothing user-authored follows the stanza; metaIDE only
 *    ever appends it, so that holds for every project it has seeded.
 *    A user who has hand-edited content AFTER the old stanza will see
 *    that content replaced on upgrade — rare, and recoverable from git.
 *
 * Returns `appended: true` for both a fresh write AND an upgrade, so the
 * caller fires the nudge in both cases (an agent running against the old
 * stanza doesn't know about the new sections otherwise).
 */
export function ensureAgentStanza(projectPath: string, cli: SupportedCli): { file: string; appended: boolean } {
  const file = targetFile(projectPath, cli);
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(MARKER)) return { file, appended: false };
      const m = MARKER_ANY_RE.exec(text);
      if (m && m.index !== undefined) {
        // Upgrade: cut everything from the old marker line onward, then
        // append the fresh stanza. Trim trailing blank line before the
        // marker so we don't leave a widening gap after each bump.
        const before = text.slice(0, m.index).replace(/\n+$/, '\n');
        writeFileSync(file, before + STANZA);
        return { file, appended: true };
      }
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

export const __test__ = { MARKER, MARKER_ANY_RE };
