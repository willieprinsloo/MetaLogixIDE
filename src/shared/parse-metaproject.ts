/** Lossless assignment edits for a conservative subset of single-document YAML block mappings. */
import { remoteProjectId, type RemoteProjectId } from './metaproject-contract';

export interface MetaprojectLink {
  projectId: string | null;
  boardUrl: string | null;
}

const KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*(?:#.*)?$/;

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Forgiving legacy display extractor; never use it to authorize an assignment edit. */
export function parseMetaproject(text: string): MetaprojectLink {
  let projectId: string | null = null;
  let boardUrl: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = KEY_RE.exec(rawLine);
    if (!m?.[1]) continue;
    const key = m[1].toLowerCase();
    const value = unquote(m[2] ?? '');
    if (!value) continue;
    if (key === 'project_id')      projectId = value;
    else if (key === 'board_url')  boardUrl = value;
  }
  return { projectId, boardUrl };
}

type Field = 'project_id' | 'metaproject_origin';
type Entry = { field: Field; index: number; prefix: string; value: string; quote: string; suffix: string };
type AssignmentLink = { id: RemoteProjectId; origin: string };
interface AssignmentDocument {
  readonly projectId: RemoteProjectId | null;
  readonly origin: string | null;
  readonly entries: readonly Entry[];
  readonly lines: readonly string[];
  readonly bom: string;
}
const rootKey = /^([a-zA-Z_][a-zA-Z0-9_-]*):(?:[ \t]+|$)/;

/** Canonicalize supported legacy prefixes and safe positive decimal IDs. */
export function parseRemoteProjectId(input: string): RemoteProjectId | null {
  const match = /^(?:[A-Za-z]+-)?([0-9]+)$/.exec(input);
  if (!match) return null;
  const result = remoteProjectId.safeParse(Number(match[1]));
  return result.success ? result.data : null;
}

function fieldOf(key: string): Field | null {
  const lower = key.toLowerCase();
  return lower === 'project_id' || lower === 'metaproject_origin' ? lower : null;
}

function readEntry(field: Field, index: number, prefix: string, remaining: string): Entry | null {
  const parts = /^(?:(["'])([^"'\\\s]+)\1|([^"'\\\s]+))([ \t]*(?:[ \t]#.*)?)$/.exec(remaining);
  const value = parts?.[2] ?? parts?.[3];
  if (!value || /^[!&*|>@`{}[\],#%?:]/.test(value)) return null;
  return { field, index, prefix, value, quote: parts?.[1] ?? '', suffix: parts?.[4] ?? '' };
}

type MappingLine = { indent: number; key: string; prefix: string; value: string; index: number };
type Level = { indent: number; keys: Set<string> };

function tokenize(text: string): MappingLine[] | null {
  const tokens: MappingLine[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (/^[ \t]*(?:#|$)/.test(raw)) continue;
    const line = raw.trimStart();
    const indent = raw.length - line.length;
    if (!/^ *$/.test(raw.slice(0, indent))) return null;
    const match = rootKey.exec(line);
    if (!match?.[1]) return null;
    tokens.push({ indent, key: match[1], prefix: match[0], value: line.slice(match[0].length), index });
  }
  return tokens;
}

function scalar(value: string): 'mapping' | 'scalar' | 'invalid' {
  const text = value.trim();
  if (!text || text.startsWith('#')) return 'mapping';
  if (text.startsWith("'") || text.startsWith('"')) return quotedScalar(text);
  return plainScalar(text);
}

function quotedScalar(text: string): 'scalar' | 'invalid' {
  const quote = text.startsWith("'") ? /^'(?:[^']|'')*'(?:[ \t]+#.*)?$/ : /^"[^"\\]*"(?:[ \t]+#.*)?$/;
  return quote.test(text) ? 'scalar' : 'invalid';
}

function plainScalar(text: string): 'scalar' | 'invalid' {
  const plain = text.split(/[ \t]+#/, 1)[0] ?? '';
  return /^(?:[!&*|>@`{}[\],%]|[-?:](?:[ \t]|$))|:(?:[ \t]|$)/.test(plain) ? 'invalid' : 'scalar';
}

function mappingLevel(levels: Level[], indent: number, parentAllowsChild: boolean): Level | null {
  while ((levels.at(-1)?.indent ?? 0) > indent) {
    levels.pop();
    if (indent > (levels.at(-1)?.indent ?? 0)) return null;
  }
  const parent = levels.at(-1);
  if (parent?.indent === indent) return parent;
  if (!parentAllowsChild) return null;
  const child = { indent, keys: new Set<string>() };
  levels.push(child);
  return child;
}

function assignmentEntries(tokens: MappingLine[]): Entry[] | null {
  const levels: Level[] = [{ indent: 0, keys: new Set() }];
  const entries: Entry[] = [];
  let parentAllowsChild = false;
  for (const { indent, key, prefix, value, index } of tokens) {
    const level = mappingLevel(levels, indent, parentAllowsChild);
    const field = indent === 0 ? fieldOf(key) : null;
    const identity = field ?? key;
    const kind = scalar(value);
    if (!level || level.keys.has(identity) || kind === 'invalid') return null;
    level.keys.add(identity);
    parentAllowsChild = !field && kind === 'mapping';
    if (field) {
      const entry = readEntry(field, index, prefix, value);
      if (!entry) return null;
      entries.push(entry);
    }
  }
  return entries;
}

/** Validate every mapping entry, including unchanged nested fields, before exposing editable bytes. */
export function parseAssignmentDocument(input: string): AssignmentDocument | null {
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = input.slice(bom.length);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0085\u2028\u2029\uFEFF]|\r(?!\n)/.test(text)) return null;
  const tokens = tokenize(text);
  const entries = tokens && assignmentEntries(tokens);
  if (!entries) return null;
  const sourceId = entries.find(entry => entry.field === 'project_id');
  const origin = entries.find(entry => entry.field === 'metaproject_origin')?.value ?? null;
  const projectId = sourceId ? parseRemoteProjectId(sourceId.value) : null;
  if ((sourceId || origin) && projectId === null) return null;
  return { lines: text.match(/[^\n]*\n|[^\n]+$/g) ?? [], entries, origin, projectId, bom };
}

/** Replace/remove just the two assignment fields, retaining unrelated bytes and comment text. */
export function editMetaprojectAssignment(doc: AssignmentDocument, link: AssignmentLink | null): string {
  const lines = [...doc.lines];
  const newline = lines.find(line => line.endsWith('\n'))?.endsWith('\r\n') ? '\r\n' : '\n';
  for (const entry of doc.entries) editAssignmentLine(lines, entry, link);
  const base = lines.join('');
  if (!link) return doc.bom + base;
  const missing = [`project_id: ${link.id}`, `metaproject_origin: ${link.origin}`].filter((_, index) =>
    !doc.entries.some(entry => entry.field === (index === 0 ? 'project_id' : 'metaproject_origin')));
  if (!missing.length) return doc.bom + base;
  return doc.bom + base + (base && !base.endsWith('\n') ? newline : '') + missing.join(newline) + newline;
}

function editAssignmentLine(lines: string[], entry: Entry, link: AssignmentLink | null): void {
  const ending = /\r?\n$/.exec(lines[entry.index] ?? '')?.[0] ?? '';
  if (link) {
    const value = entry.field === 'project_id' ? link.id : link.origin;
    lines[entry.index] = `${entry.prefix}${entry.quote}${value}${entry.quote}${entry.suffix}${ending}`;
    return;
  }
  const comment = entry.suffix.trimStart();
  lines[entry.index] = comment ? `${comment}${ending}` : '';
}
