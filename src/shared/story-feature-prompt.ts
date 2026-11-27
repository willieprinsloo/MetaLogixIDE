/**
 * Prompt builder for the Story feature feed (newsfeed voice).
 *
 * The feed reads like a product changelog: one concrete sentence you
 * can say out loud, then a short paragraph of context. Not a spec,
 * not a doc page — a post. Owner-friendly, release-notes voice.
 *
 * The prompt mandates a specific markdown shape:
 *
 *   # <headline — one sentence, user-visible change, concrete>
 *
 *   <body — 2–3 sentences of context in a single paragraph>
 *
 *   KIND: FEATURE | MAINTENANCE
 *
 * The renderer uses the first `# ` heading as the row's headline and
 * the paragraph beneath as the body. The generator strips the KIND
 * trailer before saving and uses it to tag the stored entry.
 *
 * Kept in shared/ so unit tests can snapshot the prompt without
 * pulling the Electron main side.
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

export const FEATURE_HEADING = '#';

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

  return [
    `You are writing a short post for ${input.projectName}'s feature newsfeed. The reader will scroll through a list of these — like a changelog or a product news feed — so each one needs to be scannable in two seconds.`,
    '',
    `## The change (${prBadge})`,
    `Title: ${input.title}`,
    input.body.trim() ? `Description:\n${input.body.trim()}` : 'Description: (none)',
    `Lines changed: +${input.lines.added} / -${input.lines.removed}`,
    'Files touched:',
    files,
    '',
    '## Your output',
    'Write a markdown post in EXACTLY this shape — no more, no less:',
    '',
    '    # <headline>',
    '    ',
    '    <body>',
    '    ',
    '    KIND: FEATURE',
    '',
    'Rules for the **headline** (the `#` line):',
    '- ONE short sentence. No trailing period.',
    '- Lead with the concrete user-visible change. Name the button, the menu, the keyboard shortcut, the file path a user types, the error that no longer fires.',
    '- Start with a verb when you can: "Pressing ⌘K opens…", "Windows terminals now paste…", "The status bar shows…". Avoid "Added", "Implemented" — those are engineering words, not user words.',
    '- If there is NO user-visible change (a refactor, a test fix, a CI tweak, a build bump), say so plainly, e.g. "Internal cleanup: <what>" or "Security patch: <what>".',
    '',
    'Rules for the **body** (one paragraph, 2–3 sentences):',
    '- Plain English. Think of a short LinkedIn post, not a spec. A human reads it over coffee.',
    '- Sentence 1: what this does for the user, said differently from the headline. Before/after if it fits naturally.',
    '- Sentence 2: why it matters — the problem it solves, the risk it closed, the hand-off friction it removed.',
    '- Sentence 3 (optional): one hint at where this lives for someone who wants to dig in. ONE file or folder, in `backticks`. Never a long path list.',
    '- No section headings inside the body. No bullet points. No tables.',
    '',
    `End the post with the exact trailer "${KIND_LABEL_FEATURE}" on its own last line. If this change is maintenance-only (no user-visible outcome), use "${KIND_LABEL_MAINTENANCE}" instead.`,
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

/** Split a post into its headline (from the first `# ` line) and
 *  everything else. Older entries that were written against the
 *  three-section prompt will have `## What you can now do` instead;
 *  callers render the whole body as-is when no `# ` headline is found.
 *
 *  Returns `null` for the headline when there's no `# ` heading. The
 *  renderer then uses the commit title as the fallback. */
export function splitHeadlineAndBody(markdown: string): { headline: string | null; body: string } {
  const trimmed = markdown.trim();
  const lines = trimmed.split(/\r?\n/);
  const headIdx = lines.findIndex((line) => /^#\s+\S/.test(line));
  if (headIdx === -1) return { headline: null, body: trimmed };
  const headline = lines[headIdx]!.replace(/^#\s+/, '').trim();
  const rest = [...lines.slice(0, headIdx), ...lines.slice(headIdx + 1)].join('\n').trim();
  return { headline, body: rest };
}
