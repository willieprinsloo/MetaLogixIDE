/**
 * Static check for the icon size scale (AC2a, AC10). Pure and dependency-free,
 * written in erasable-only TypeScript so Node can run it directly from
 * `scripts/check-icon-scale.ts` as well as from the unit tests.
 *
 * Rules, each reported as `<line> <rule> <message>`:
 * - R1: every `<svg>` sets `width` and `height`, neither is a numeric literal
 *   (`"13"` or `{13}`), and the two expressions are textually equal.
 * - R2: an `<svg>` sized by a bare identifier (`{size}`) sits in a component
 *   that types that prop as `IconSize`.
 * - R3: no `<…Icon size={<number>}>` call site; pass `ICON_SIZE.*`.
 * - R4: a literal `strokeWidth` is 2, 2.5 or 3. An svg drawn at `ICON_SIZE.xs`
 *   uses 2.5 (or `ICON_STROKE.xs`), and 2.5 is used nowhere else; 3 (or `ICON_STROKE.check`) only in
 *   `components/CheckIcon.tsx`. Named exceptions are keyed by file and
 *   enclosing component, not by line.
 */

interface StrokeException {
  file: string;
  component: string;
  value: string;
}

const STROKE_EXCEPTIONS: StrokeException[] = [
  { file: 'components/shell-icons.tsx', component: 'StarFilledIcon', value: '1.5' },
  { file: 'components/RootFolderGlyph.tsx', component: 'RootFolderGlyph', value: '1.8' },
];

const CHECK_ICON_FILE = 'components/CheckIcon.tsx';
const XS_WIDTH = 'ICON_SIZE.xs';
const NUMERIC = /^\s*\d+(\.\d+)?\s*$/;
const XS_STROKE = 'icons drawn at ICON_SIZE.xs use stroke 2.5';

interface SvgTag {
  start: number;
  end: number;
  attrs: Map<string, string>;
}

/** Every violation in `source`, a renderer `.tsx` file at `path`. */
export function iconScaleViolations(path: string, source: string): string[] {
  const out: string[] = [];
  const report = (index: number, rule: string, message: string) =>
    out.push(`${lineOf(source, index)} ${rule} ${message}`);
  const svgs = svgTags(source);
  for (const svg of svgs) checkSvgSize(source, svg, report);
  checkCallSites(source, report);
  checkStrokes(path, source, svgs, report);
  return out;
}

type Report = (index: number, rule: string, message: string) => void;

function checkSvgSize(source: string, svg: SvgTag, report: Report): void {
  const width = svg.attrs.get('width');
  const height = svg.attrs.get('height');
  if (width === undefined || height === undefined) {
    report(svg.start, 'R1', 'svg must set both width and height');
    return;
  }
  if (NUMERIC.test(unwrap(width)) || NUMERIC.test(unwrap(height))) {
    report(svg.start, 'R1', `svg size is a numeric literal (${width} x ${height}); use ICON_SIZE`);
    return;
  }
  if (unwrap(width) !== unwrap(height)) {
    report(svg.start, 'R1', `svg width ${width} differs from height ${height}`);
    return;
  }
  const ident = /^[A-Za-z_$][\w$]*$/.exec(unwrap(width).trim())?.[0];
  const scope = source.slice(componentStart(source, svg.start), svg.start);
  if (ident && !new RegExp(`\\b${ident}\\??\\s*:\\s*IconSize\\b`).test(scope)) {
    report(svg.start, 'R2', `svg sized by \`${ident}\`, which is not typed IconSize`);
  }
}

function checkCallSites(source: string, report: Report): void {
  const callSite = /<([A-Z]\w*Icon)\b[^>]*?\bsize=\{\s*\d+(\.\d+)?\s*\}/g;
  for (const m of source.matchAll(callSite)) {
    report(m.index ?? 0, 'R3', `<${m[1] ?? ''}> given a numeric size; pass ICON_SIZE.*`);
  }
}

function checkStrokes(path: string, source: string, svgs: SvgTag[], report: Report): void {
  const stroke = /strokeWidth=(?:"([^"]*)"|\{([^}]*)\})/g;
  for (const m of source.matchAll(stroke)) {
    const index = m.index ?? 0;
    const value = (m[1] ?? m[2] ?? '').trim();
    const problem = strokeProblem(path, source, index, value, enclosingSvg(svgs, index));
    if (problem) report(index, 'R4', problem);
  }
}

function strokeProblem(
  path: string,
  source: string,
  index: number,
  value: string,
  svg: SvgTag | undefined,
): string | null {
  const inXs = svg !== undefined && unwrap(svg.attrs.get('width') ?? '').trim() === XS_WIDTH;
  const inCheckFile = endsWithPath(path, CHECK_ICON_FILE);
  if (value === 'ICON_STROKE.xs') return inXs ? null : 'stroke 2.5 is for icons drawn at ICON_SIZE.xs only';
  if (value === 'ICON_STROKE.check') return inCheckFile ? null : `stroke 3 is for ${CHECK_ICON_FILE} only`;
  if (value === 'ICON_STROKE.outline') return inXs ? XS_STROKE : null;
  if (!NUMERIC.test(value)) return null;
  const n = Number(value);
  if (n === 2) return inXs ? XS_STROKE : null;
  if (n === 2.5) return inXs ? null : 'stroke 2.5 is for icons drawn at ICON_SIZE.xs only';
  if (n === 3) return inCheckFile ? null : `stroke 3 is for ${CHECK_ICON_FILE} only`;
  const component = enclosingComponent(source, index);
  const allowed = STROKE_EXCEPTIONS.some(
    (e) => endsWithPath(path, e.file) && e.component === component && e.value === value,
  );
  return allowed ? null : `stroke ${value} is off the rule (2, 2.5 at xs, 3 for CheckIcon)`;
}

/** Opening `<svg …>` tags with their attributes; braces and quotes are skipped when finding the closing `>`. */
function svgTags(source: string): SvgTag[] {
  const tags: SvgTag[] = [];
  const open = /<svg\b/g;
  for (const m of source.matchAll(open)) {
    const start = m.index ?? 0;
    const end = tagEnd(source, start + 4);
    tags.push({ start, end, attrs: attributes(source.slice(start + 4, end)) });
  }
  return tags;
}

function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return source.length;
}

function attributes(body: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const name = /([A-Za-z][\w-]*)=/g;
  for (const m of body.matchAll(name)) {
    const at = (m.index ?? 0) + m[0].length;
    const value = attributeValue(body, at);
    if (value !== null) attrs.set(m[1] ?? '', value);
  }
  return attrs;
}

function attributeValue(body: string, at: number): string | null {
  const c = body[at];
  if (c === '"') {
    const close = body.indexOf('"', at + 1);
    return close < 0 ? null : body.slice(at, close + 1);
  }
  if (c !== '{') return null;
  let depth = 0;
  for (let i = at; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) return body.slice(at, i + 1);
  }
  return null;
}

/** An attribute value without its `"…"` or `{…}` wrapper. */
function unwrap(value: string): string {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith('{') && v.endsWith('}'))
    ? v.slice(1, -1).trim()
    : v;
}

/** The svg whose tag or body contains `index`: the last svg opened before it that has not closed. */
function enclosingSvg(svgs: SvgTag[], index: number): SvgTag | undefined {
  let found: SvgTag | undefined;
  for (const svg of svgs) if (svg.start < index) found = svg;
  return found;
}

/** Where the component enclosing `index` is declared, or 0 when there is none. */
function componentStart(source: string, index: number): number {
  const decl = /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=)/g;
  let start = 0;
  for (const m of source.slice(0, index).matchAll(decl)) start = m.index ?? 0;
  return start;
}

function enclosingComponent(source: string, index: number): string | null {
  const before = source.slice(0, index);
  const decl = /(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=)/g;
  let name: string | null = null;
  for (const m of before.matchAll(decl)) name = m[1] ?? m[2] ?? null;
  return name;
}

function endsWithPath(path: string, suffix: string): boolean {
  return path.replace(/\\/g, '/').endsWith(suffix);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}
