/**
 * Detects potential file-path references inside a line of terminal output.
 *
 *  - Absolute POSIX paths starting at `/` with at least two segments and
 *    a plausible file extension.
 *  - Project-relative paths like `src/main/index.ts`, `tests/e2e/foo.spec.ts`,
 *    `docs/notes.md` — at least one path separator and a known-ish
 *    extension so we don't chase every bare word.
 *  - Optional trailing `:line` or `:line:col` (grep / editor style).
 *
 * The regex is intentionally loose: the main process double-checks each
 * hit against the actual filesystem via files:peek. Terminal detection is
 * a heuristic, not a security boundary.
 */

// Any path segment character except whitespace and shell metacharacters
// that reliably terminate a path in normal terminal output.
const PATH_SEGMENT = "[A-Za-z0-9._\\-@+]";

// Extensions we care about — this list mirrors the file-icon palette.
// Sorted longest-first so JS regex alternation picks the specific
// extension (tsx / jsx / mjs / cjs) instead of stopping at the shorter
// prefix (ts / js / ...).
const EXT = [
  'markdown', 'jsonc', 'html', 'yaml',
  'tsx', 'jsx', 'mjs', 'cjs', 'mdx',
  'cpp', 'hpp', 'scss', 'jpeg', 'webp',
  'bash', 'zsh', 'toml', 'sql', 'log', 'csv', 'txt', 'svg', 'gif', 'jpg', 'png', 'xml', 'htm', 'yml', 'json', 'css',
  'ts', 'js', 'md',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cs', 'sh',
].join('|');

// Full match:  (path/with/segments.ext)(:line(:col)?)?
const PATH_RE = new RegExp(
  `(?:\\/|(?<![A-Za-z0-9._\\-@/]))` +                           // start of path (leading slash OR a boundary — not mid-word)
  `${PATH_SEGMENT}+(?:\\/${PATH_SEGMENT}+)+\\.(?:${EXT})` +      // at least one slash + known extension
  `(?::\\d+(?::\\d+)?)?`,                                        // optional :line:col
  'g',
);

export interface DetectedPath {
  raw: string;         // the full match including :line:col
  path: string;        // just the path portion
  line: number | null;
  col: number | null;
  startIndex: number;
  endIndex: number;    // exclusive
}

export function detectPaths(text: string): DetectedPath[] {
  const out: DetectedPath[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    const raw = m[0];
    // Split off :line:col
    let path = raw;
    let line: number | null = null;
    let col: number | null = null;
    const lc = /:(\d+)(?::(\d+))?$/.exec(raw);
    if (lc) {
      path = raw.slice(0, raw.length - lc[0].length);
      line = Number(lc[1]);
      col = lc[2] ? Number(lc[2]) : null;
    }
    // Trim trailing punctuation that terminal messages often add.
    while (path.length > 0 && /[.,;:)\]]/.test(path.at(-1) ?? '')) {
      path = path.slice(0, -1);
    }
    if (!path) continue;
    out.push({
      raw: raw.slice(0, raw.length - (raw.length - path.length)) + (line != null ? `:${line}${col != null ? `:${col}` : ''}` : ''),
      path,
      line,
      col,
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
    if (m.index === PATH_RE.lastIndex) PATH_RE.lastIndex++;
  }
  return out;
}
