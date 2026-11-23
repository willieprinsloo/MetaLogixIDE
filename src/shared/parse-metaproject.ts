/**
 * Tiny extractor for the two fields we care about in `.metaproject.yaml`:
 *   project_id: PROJ-42
 *   board_url:  https://metaproject.internal
 *
 * We intentionally do NOT pull in a full YAML library. The file is
 * user-authored, small, and only two documented keys. A regex pass is
 * cheap, forgiving of comments/quoting, and can't crash the app on
 * malformed input.
 */
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

export function parseMetaproject(text: string): MetaprojectLink {
  let projectId: string | null = null;
  let boardUrl: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const m = KEY_RE.exec(rawLine);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = unquote(m[2] ?? '');
    if (!value) continue;
    if (key === 'project_id')      projectId = value;
    else if (key === 'board_url')  boardUrl = value;
  }
  return { projectId, boardUrl };
}

type Field = 'project_id' | 'metaproject_origin';
type Entry = { field: Field; index: number; prefix: string; value: string; quote: string; suffix: string };
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

/** Read the lossless single-root scalar subset; reject ambiguous root syntax instead of guessing. */
export function parseAssignmentDocument(input: string): AssignmentDocument | null {
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = input.slice(bom.length);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0085\u2028\u2029]|\r(?!\n)/.test(text)) return null;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const entries: Entry[] = [];
  let previousRoot: Field | null | undefined;
  for (const [index, segment] of lines.entries()) {
    const line = segment.replace(/\r?\n$/, '');
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (line.startsWith(' ')) {
      if (previousRoot !== null) return null;
      continue;
    }
    const key = rootKey.exec(line);
    if (!key?.[1]) return null;
    const field = fieldOf(key[1]);
    previousRoot = field;
    if (!field) continue;
    const entry = readEntry(field, index, key[0], line.slice(key[0].length));
    if (!entry || entries.some(existing => existing.field === field)) return null;
    entries.push(entry);
  }
  const sourceId = entries.find(entry => entry.field === 'project_id');
  const origin = entries.find(entry => entry.field === 'metaproject_origin')?.value ?? null;
  const projectId = sourceId ? parseRemoteProjectId(sourceId.value) : null;
  if ((sourceId || origin) && projectId === null) return null;
  return { lines, entries, origin, projectId, bom };
}

/** Replace/remove just the two assignment fields, retaining unrelated bytes and comment text. */
export function editMetaprojectAssignment(doc: AssignmentDocument, link: { id: RemoteProjectId; origin: string } | null): string {
  const lines = [...doc.lines];
  const newline = lines.find(line => line.endsWith('\n'))?.endsWith('\r\n') ? '\r\n' : '\n';
  for (const entry of doc.entries) {
    const ending = /\r?\n$/.exec(lines[entry.index] ?? '')?.[0] ?? '';
    if (link) {
      const value = entry.field === 'project_id' ? link.id : link.origin;
      lines[entry.index] = `${entry.prefix}${entry.quote}${value}${entry.quote}${entry.suffix}${ending}`;
    } else {
      const comment = entry.suffix.trimStart();
      lines[entry.index] = comment ? `${comment}${ending}` : '';
    }
  }
  const base = lines.join('');
  if (!link) return doc.bom + base;
  const missing = [`project_id: ${link.id}`, `metaproject_origin: ${link.origin}`].filter((_, index) =>
    !doc.entries.some(entry => entry.field === (index === 0 ? 'project_id' : 'metaproject_origin')));
  if (!missing.length) return doc.bom + base;
  return doc.bom + base + (base && !base.endsWith('\n') ? newline : '') + missing.join(newline) + newline;
}
