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
