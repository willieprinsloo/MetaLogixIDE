/** Classifies a recognized Claude terminal from its live viewport and OSC title. */
import type { AgentState } from '@shared/agent-state';

const READY = /^\s*(?:[❯>]\s*(?:$|Ready for another task)|[╭╰]─.*Claude Code)/i;
const APPROVAL = /(?:Allow\s+.+\?|Do you want to\s+.+\?|What would you like to do\?)/i;
const ANSWER = /(?:Esc to cancel|^(?:❯|>)?\s*[12]\.\s*(?:Yes|No|Allow|Continue|Stop))$/i;
const FORM_FOOTER = /enter to (?:confirm|select.*navigate).*esc to cancel/i;
const TITLE_WORKING = /^[\u2800-\u28ff\u25d0-\u25d3] /;
const STATUS_SPINNER = /^\s*[*·✢✳✶✻✽]\s+\S.*…(?:\s+\(\d+[smh](?:\s|·)|\s*$)/i;
const RUNNING_TOOL = /^\s*(?:[⏸⏵].*esc to interrupt|esc to interrupt)/i;
const BACKGROUND_AGENTS = /^\s*[*·✢✶✻✽]\s+Waiting for [1-9]\d* background agents? to finish\s*$/i;

/** Unknown content is idle; only current visible controls may block. */
export function classifyClaudeScreen(rows: readonly string[], title = ''): AgentState {
  const visible = rows.map((row) => row.trimEnd()).filter((row) => row.trim().length > 0);
  const lastReady = visible.findLastIndex((row) => READY.test(row) && !row.includes('Claude Code'));
  const live = visible.slice(lastReady + 1);
  const bottom = live.slice(-6);
  if (
    bottom.some((row) => FORM_FOOTER.test(row)) ||
    (bottom.some((row) => APPROVAL.test(row)) && ANSWER.test(bottom.at(-1) ?? ''))
  )
    return 'blocked';
  if (
    TITLE_WORKING.test(title) ||
    visible.some(
      (row) => STATUS_SPINNER.test(row) || RUNNING_TOOL.test(row) || BACKGROUND_AGENTS.test(row),
    )
  )
    return 'busy';
  return 'idle';
}
