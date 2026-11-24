/** Classifies a recognised harness terminal (Claude, Codex, opencode) from its live viewport and title. */
import type { AgentKind, AgentState } from '@shared/agent-state';
import { classifyClaudeScreen } from './claude-screen';

/** Rows from the bottom that can hold a harness's live controls; older rows are history. */
const LIVE_ROWS = 14;

// Codex (Rust TUI, inline): "• Working (12s • esc to interrupt)" while a turn runs, and an
// approval modal "Would you like to run the following command?" with "Yes, proceed" choices.
const CODEX_BUSY = /\besc to interrupt\b/i;
const CODEX_QUESTION =
  /Would you like to (?:run the following command|make the following edits|grant these permissions|send input to)/i;
const CODEX_ANSWER = /(?:Yes, proceed|Yes, just this once|No, and tell Codex|Press enter to confirm|esc to cancel)/i;

// opencode (full-screen TUI): footer "esc interrupt" / "esc again to interrupt" while running;
// permission prompts show "Permission required" with "Allow once / Always allow / Reject".
const OPENCODE_BUSY = /\besc\s+(?:again to )?interrupt\b/i;
const OPENCODE_QUESTION = /Permission required/i;
const OPENCODE_ANSWER = /(?:Allow once|Always allow|Reject)/i;

function classifyBottom(rows: readonly string[], busy: RegExp, question: RegExp, answer: RegExp): AgentState {
  const visible = rows.map((row) => row.trimEnd()).filter((row) => row.trim().length > 0);
  const bottom = visible.slice(-LIVE_ROWS);
  if (bottom.some((row) => question.test(row)) && bottom.some((row) => answer.test(row))) return 'blocked';
  if (bottom.some((row) => busy.test(row))) return 'busy';
  return 'idle';
}

/** Unknown content is idle; only visible live controls mark a harness busy or blocked. */
export function classifyAgentScreen(agent: AgentKind, rows: readonly string[], title = ''): AgentState {
  switch (agent) {
    case 'claude':
      return classifyClaudeScreen(rows, title);
    case 'codex':
      return classifyBottom(rows, CODEX_BUSY, CODEX_QUESTION, CODEX_ANSWER);
    case 'opencode':
      return classifyBottom(rows, OPENCODE_BUSY, OPENCODE_QUESTION, OPENCODE_ANSWER);
  }
}
