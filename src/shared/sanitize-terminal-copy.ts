/**
 * Clean up terminal-copied text so pasting into email / markdown / plain
 * editors doesn't produce mojibake or invisible glyphs.
 *
 * xterm's raw getSelection() output is mostly plain text, but several
 * offenders survive and mangle downstream:
 *   - non-breaking space (U+00A0) - email clients render as "A" when the
 *     receiver's editor guesses Latin-1
 *   - zero-width joiners / non-joiners (U+200B..U+200D, U+2060, U+FEFF) -
 *     invisible in the terminal, land as garbage in code blocks
 *   - Nerd Font glyphs in Private Use Areas (U+E000..U+F8FF and the
 *     plane-15/16 PUAs) - render as tofu boxes anywhere without the icon
 *     font
 *   - ANSI escape sequences (usually stripped by xterm, but not always -
 *     progress-bar libraries emit OSC/APC that can survive)
 *   - trailing spaces per line (xterm pads to the wrap column)
 *   - CRLF from Windows-side tools
 *
 * Regexes use the RegExp constructor with explicit \u escapes so the source
 * file stays deterministic (no invisible literal chars to lose in copy).
 */

// Broad ANSI stripper: CSI, OSC, DCS/APC/PM/SOS, single-char ESC.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_^X][^\x1b]*\x1b\\|[@-Z\\-_])/g;

// Private-use-area characters: BMP PUA + supplementary PUA-A / PUA-B.
const PUA_RE = new RegExp('[\\u{E000}-\\u{F8FF}]|[\\u{F0000}-\\u{FFFFD}]|[\\u{100000}-\\u{10FFFD}]', 'gu');

// Zero-width formatters: ZWSP, ZWNJ, ZWJ, WORD JOINER, BOM.
const INVISIBLE_RE = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');

// Non-breaking space -> normal space.
const NBSP_RE = new RegExp('\\u00A0', 'g');

const CRLF_RE = /\r\n?/g;

// Hand-rolled instead of /[ \t]+$/gm: that regex backtracks quadratically on long blank runs
// (TUI padding, wrapped empty rows) and froze the renderer on copy.
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  return line.slice(0, end);
}

export function sanitizeTerminalCopy(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(ANSI_RE, '')
    .replace(CRLF_RE, '\n')
    .replace(NBSP_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(PUA_RE, '')
    .split('\n')
    .map(trimLineEnd)
    .join('\n');
}
