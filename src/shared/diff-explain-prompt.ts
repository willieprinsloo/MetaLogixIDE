/**
 * Prompts for the Diff tab's "Explain changes" button and the Git panel's
 * "Suggest commit message" button. Both run through the headless Claude CLI
 * engine the group-chat tabs already use; this module only builds the text.
 *
 * Kept in `shared/` so unit tests can assert the Intent/What-changed/Flags
 * shape the UI renders without pulling in the main-process LLM glue.
 */

export interface ExplainDiffArgs {
  /** The file's current path (after the change). */
  newPath: string;
  /** The file's pre-change path. Equal to newPath for non-renames. */
  oldPath: string;
  /** The unified diff to explain, as `git diff` emits it. */
  diff: string;
}

export function buildExplainDiffPrompt(args: ExplainDiffArgs): string {
  const rename = args.oldPath !== args.newPath
    ? ` (renamed from \`${args.oldPath}\`)`
    : '';
  return [
    `You are helping a developer read a code diff quickly in a review view.`,
    ``,
    `File: \`${args.newPath}\`${rename}`,
    ``,
    `Explain the change in GitHub-flavored **markdown** with exactly these three headings:`,
    ``,
    `## Intent`,
    `One sentence on **why** this change exists — the user-visible or system-visible purpose. Not a line summary.`,
    ``,
    `## What changed`,
    `Bulleted, grouped by concern (not by hunk). Each bullet is one specific change in plain language; identifiers go in backticks. Skip pure formatting noise.`,
    ``,
    `## Flags`,
    `Anything a reviewer would want to catch — risky edits, likely bugs, API breaks, unsafe assumptions, missing tests. One bullet per flag; "None" if there's nothing worth flagging.`,
    ``,
    `Be terse — total length should fit in a side panel. No preamble, no closing remarks. Just the three sections.`,
    ``,
    `The diff:`,
    ``,
    '```diff',
    args.diff,
    '```',
  ].join('\n');
}

export interface CommitMessageArgs {
  /** The combined staged diff (git diff --cached). */
  diff: string;
}

export function buildCommitMessagePrompt(args: CommitMessageArgs): string {
  return [
    `You are drafting a git commit message for a developer. Follow this project's writing style:`,
    `- Lead with what a human would notice — a new button, a fixed error, nothing visible.`,
    `- Plain language, roughly a 10th-grade reading level. No jargon unless the change is technical.`,
    `- First line is the subject: imperative, under 72 characters, no trailing period.`,
    `- Then one blank line, then a short body (2-4 lines) with the *why*, not the *what*.`,
    ``,
    `Return ONLY the commit message text — no preamble, no fenced block, no "Here's a commit message:".`,
    ``,
    `The staged diff:`,
    ``,
    '```diff',
    args.diff,
    '```',
  ].join('\n');
}

/**
 * Trims a diff that would blow the Claude context budget. Keeps the first
 * `maxBytes` of UTF-8 and appends a short marker so the model knows the tail
 * was cut (otherwise it would "complete" the missing part).
 */
export function truncateDiffForPrompt(diff: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, 'utf8') <= maxBytes) return { text: diff, truncated: false };
  // Trim by code-point to the byte budget, then slot in a marker.
  const buf = Buffer.from(diff, 'utf8').subarray(0, maxBytes);
  // Avoid cutting a multi-byte character in half: strip invalid trailing bytes
  // by round-tripping through decoder with 'fatal: false' — Node's default
  // replaces, so we trim any trailing replacement chars.
  const text = buf.toString('utf8').replace(/�+$/, '');
  return { text: `${text}\n…[truncated]`, truncated: true };
}
