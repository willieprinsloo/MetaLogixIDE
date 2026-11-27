/**
 * Prompt builder for the Story feature feed.
 *
 * Takes one commit's git-level facts and produces a prompt that asks
 * Claude to write a three-section handoff note — in plain English, for
 * someone who will OWN the solution later and isn't in the room when it
 * was built. Kept in `shared/` so unit tests can snapshot the prompt
 * without pulling the Electron main side.
 *
 * The prompt mandates a specific markdown shape so the renderer can
 * split it on headings without parsing prose. If a commit genuinely
 * has no user-visible outcome (a pure refactor, a test fix, a CI tweak)
 * the model is told to say so explicitly and label the entry
 * `MAINTENANCE` on its last line — the generator reads that line to
 * tag the stored entry, then strips it before saving the body.
 */

export interface FeaturePromptInput {
  /** Project name — gives the model business framing. */
  projectName: string;
  /** PR number (when the commit was a merge) or null. Included so the
   *  model can say "PR #26" in the prose without fabricating. */
  prNumber: number | null;
  /** First line of the commit message (PR title or direct subject). */
  title: string;
  /** Rest of the commit message body. Usually the PR description for
   *  merges; sometimes empty for direct commits. */
  body: string;
  /** Changed file paths, scope-grouped and capped by the caller. */
  files: string[];
  /** +added / -removed line totals across the commit. */
  lines: { added: number; removed: number };
}

const SECTION_HEADINGS = [
  '## What you can now do',
  '## Why it matters',
  '## Where it lives',
] as const;

export const FEATURE_SECTIONS = SECTION_HEADINGS;

/** Last-line label the model must emit so the generator can tag the
 *  stored entry. The generator strips the line before saving. */
export const KIND_LABEL_FEATURE = 'KIND: FEATURE';
export const KIND_LABEL_MAINTENANCE = 'KIND: MAINTENANCE';

export function buildFeaturePrompt(input: FeaturePromptInput): string {
  const files = input.files.length > 0
    ? input.files.slice(0, 30).map((f) => `  - ${f}`).join('\n')
    : '  (no file list available)';

  const prBadge = input.prNumber === null
    ? 'direct commit on main'
    : `PR #${input.prNumber}`;

  // NOTE: the prose rules below are deliberately prescriptive — the
  // owner this is written for isn't technical, and models love to slip
  // into implementation jargon ("the IPC handler now…") that leaves
  // them none the wiser. Short sentences, concrete user actions,
  // business words beat framework words.
  return [
    `You are writing a short handoff note about ONE change that shipped in a project called "${input.projectName}".`,
    'The reader is the person who will OWN this solution going forward. They are not a software engineer and were not in the room when this was built. They need to understand, in plain English, what the project can now do that it could not do before, and roughly where that capability lives in the codebase in case they need to hand that to a developer.',
    '',
    `## The change (${prBadge})`,
    `Title: ${input.title}`,
    input.body.trim() ? `Description:\n${input.body.trim()}` : 'Description: (none)',
    `Lines changed: +${input.lines.added} / -${input.lines.removed}`,
    'Files touched:',
    files,
    '',
    '## Your task',
    'Write THREE sections in markdown, using exactly these headings, in this order:',
    '',
    SECTION_HEADINGS.map((h) => h).join('\n'),
    '',
    'Rules for each section:',
    '- 2 to 4 short sentences each.',
    '- Write in plain English. Lead with what a human would notice. Avoid framework, API and protocol names unless they are user-visible (URLs, settings, menu items).',
    '- "What you can now do" starts with "You can now…" or "The app now…". Describe the capability, not the code change.',
    '- "Why it matters" is the business / product reason — what problem the user had before, what they can do faster/safer/at-all now.',
    '- "Where it lives" names the one or two files or folders a developer would open to change or debug this. ONE sentence. No long path lists.',
    '',
    `If this change has NO user-visible outcome (it is a refactor, a test fix, a CI tweak, a build bump, a dependency security patch), do NOT invent a user story. Collapse all three sections into a single paragraph that says plainly what kind of maintenance it was and why it was done. Then on the LAST line of your output write "${KIND_LABEL_MAINTENANCE}".`,
    `Otherwise, on the LAST line of your output write "${KIND_LABEL_FEATURE}".`,
    '',
    'Output ONLY the markdown — no preamble, no code fence, no closing remarks.',
  ].join('\n');
}

/** Parse the `KIND: FEATURE|MAINTENANCE` trailer the prompt mandates
 *  and strip it from the body. Falls back to `feature` if the model
 *  forgot the line — a missing label shouldn't drop the entry. */
export function extractKindAndBody(raw: string): { kind: 'feature' | 'maintenance'; body: string } {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/);
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (last === KIND_LABEL_MAINTENANCE) {
    return { kind: 'maintenance', body: lines.slice(0, -1).join('\n').trimEnd() };
  }
  if (last === KIND_LABEL_FEATURE) {
    return { kind: 'feature', body: lines.slice(0, -1).join('\n').trimEnd() };
  }
  return { kind: 'feature', body: trimmed };
}
