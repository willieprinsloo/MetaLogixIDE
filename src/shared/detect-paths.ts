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
// that reliably terminate a path in normal terminal output. `~` so a
// home-relative path's first segment is matchable.
const PATH_SEGMENT = "[A-Za-z0-9._\\-@+~]";

// Extensions we care about — this list mirrors the file-icon palette plus
// the viewers' formats (pdf) and agent-adjacent dotfiles (jsonl, env, …).
const EXT_LIST = [
  'markdown', 'jsonc', 'html', 'yaml',
  'tsx', 'jsx', 'mjs', 'cjs', 'mdx',
  'cpp', 'hpp', 'scss', 'jpeg', 'webp', 'avif', 'tiff', 'graphql',
  'properties',
  'bash', 'zsh', 'toml', 'sql', 'log', 'csv', 'txt', 'svg', 'gif', 'jpg', 'png', 'xml', 'htm', 'yml', 'json', 'css',
  'ts', 'js', 'md',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cs', 'sh',
  'pdf', 'jsonl', 'env', 'plist', 'ini', 'conf', 'lock', 'bmp', 'ico', 'proto', 'tf',
];

// Longest-first alternation is REQUIRED: without it JS regex alternation
// stops at the shorter prefix (ts before tsx, js before jsonl) and the
// match loses its real extension. Sorting guarantees it as the list grows.
const EXT = [...EXT_LIST].sort((a, b) => b.length - a.length).join('|');

// Full match:  (path/leading/segments)/final(.ext)? — where the final
// component is either name.ext (notes.md) or a bare dotfile (.env), then
// an optional :line:col. At least one slash before the final component,
// so bare filenames never match.
const PATH_RE = new RegExp(
  `(?:\\/|~\\/|(?<![A-Za-z0-9._\\-@+/]))` +                              // start of path (leading slash, ~/, OR a boundary — not mid-word)
  `${PATH_SEGMENT}+(?:\\/${PATH_SEGMENT}+)*` +                       // leading segments (≥ 0 after the boundary)
  `\\/(?:${PATH_SEGMENT}*\\.)?(?:${EXT})` +                          // final component: name.ext, or a bare dotfile (.env = empty name + dot + ext)
  `(?::\\d+(?::\\d+)?)?`,                                            // optional :line:col
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

/**
 * Like {@link detectPaths} but for BARE filenames — `review.jpg`,
 * `README.md:3`, `report.pdf` — with no path separator at all.
 *
 * These matches are ambiguous. English prose like "the readme.md file"
 * or "download foo.txt" looks identical to a real reference, and random
 * sentences also end in `.log` or `.txt`. Callers MUST verify each hit
 * exists on disk (via `files:peek` or similar) before surfacing it to
 * the user as a clickable link — otherwise half the agent's chatter
 * lights up blue and clicks go nowhere.
 *
 * The regex itself is defensive: word-boundary gated at both ends so
 * `name.ts` inside `fullname.ts` or `the.name.txt.backup` is never
 * matched; leading dotfiles (`.env`, `.metaide`) are skipped since the
 * strict detector above already handles those with context.
 */
// (?<=…) lookbehind + (?=…) lookahead so the match is just the filename,
// start index aligns with the first character of the name itself. The
// boundary set is "start of text, whitespace, open brackets, or quote /
// common punctuation" — tight enough to reject mid-word, loose enough
// to catch what agents actually write ("open `review.jpg`", "see
// review.jpg.", "[review.jpg]").
const BARE_FILENAME_RE = new RegExp(
  `(?<=^|[\\s(\\[{,;:'"\`])` +
  `[A-Za-z0-9][A-Za-z0-9._\\-]*\\.(?:${EXT})` +
  `(?::\\d+(?::\\d+)?)?` +
  // Trailing boundary: whitespace / brackets / sentence punctuation,
  // or end of string. Period is included so "review.jpg." at the end of
  // a sentence still matches; the output function trims a trailing `.`
  // off `path` before surfacing it, so the link target stays clean.
  `(?=$|[\\s)\\]},;:!?'"\`.])`,
  'g',
);

export function detectBareFilenames(text: string): DetectedPath[] {
  const out: DetectedPath[] = [];
  BARE_FILENAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_FILENAME_RE.exec(text))) {
    const raw = m[0];
    let path = raw;
    let line: number | null = null;
    let col: number | null = null;
    const lc = /:(\d+)(?::(\d+))?$/.exec(raw);
    if (lc) {
      path = raw.slice(0, raw.length - lc[0].length);
      line = Number(lc[1]);
      col = lc[2] ? Number(lc[2]) : null;
    }
    while (path.length > 0 && /[.,;:)\]]/.test(path.at(-1) ?? '')) {
      path = path.slice(0, -1);
    }
    if (!path) continue;
    out.push({
      raw: path + (line != null ? `:${line}${col != null ? `:${col}` : ''}` : ''),
      path,
      line,
      col,
      startIndex: m.index,
      endIndex: m.index + m[0].length,
    });
    if (m.index === BARE_FILENAME_RE.lastIndex) BARE_FILENAME_RE.lastIndex++;
  }
  return out;
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
